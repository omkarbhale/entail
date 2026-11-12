import { createHash } from "node:crypto";
import { precedentsFor, renderIssue, type Case } from "./case-book.ts";
import { ChangeDeduplicator } from "./changes.ts";
import { composeComment, markedTickets } from "./comment-rules.ts";
import type { CursorStore } from "./cursors.ts";
import { projectKey, RateLimitedError, type Change, type Forge, type Issue } from "./forge/forge.ts";
import { formatCall, judge, JUDGMENT_PROMPT_VERSION } from "./judgment.ts";
import { forgeRemote, Mirror } from "./mirror.ts";
import type { ModelRunner } from "./model-runner.ts";
import type { OperationalLog } from "./operational-log.ts";
import { runSettings } from "./owner.ts";
import { readPins } from "./pins.ts";
import { postFor } from "./posts.ts";
import {
  appendEntry,
  HOST,
  judgedMentions,
  latestCalls,
  loggedRepos,
  mentionKey,
  newEntryId,
  pendingWork,
  readLog,
  repoState,
  type CallEntry,
  type Entry,
  type GlobalSettings,
  type Mention,
  type NewEntry,
  type OwnerWord,
  type Pending,
  type RepoState,
  type Trigger,
} from "./records.ts";
import { readVision } from "./vision.ts";

/**
 * One pass over the enrolled repos: read what changed on each since the last
 * pass, make the call once on each new or edited issue and on each `/entail`
 * mention, run the judgment again where the owner answered go, and act on
 * GitHub for everything not yet acted on: post each call, close on a no
 * (unless the repo is in confirm mode), and post what the owner decided on
 * the board.
 *
 * Every call and every act is appended to the repo's log. With `dryRun` the
 * pass changes nothing: no log entry, no cursor, no comment and no close; it
 * prints what it would post instead.
 */

/** What a pass needs of a forge. */
export type WatchForge = Pick<Forge, "setting" | "project" | "changesSince" | "issue" | "comments" | "postComment" | "closeIssue" | "reopenIssue">;

/** A repo read at its default branch's head, for the judgment. */
export interface RepoReading {
  checkout: string;
  sha: string;
  vision: { text: string; commit: string } | null;
  pins: string[];
}

/** Reads a repo for the judgment: once per pass and repo, and only when something there is judged. */
export type RepoReader = (repo: string, forge: WatchForge) => Promise<RepoReading>;

export interface PassOptions {
  dataDirectory: string;
  /** The owner's display name, for the attribution line and the owner's word. */
  owner: string;
  settings: GlobalSettings;
  forgeFor: (repo: string) => WatchForge;
  reader: RepoReader;
  runner: ModelRunner;
  cursors: CursorStore;
  /** Changes already seen, per repo, kept across the passes of one run. */
  seen: Map<string, ChangeDeduplicator>;
  /** The case book: the shipped one and the owner's. */
  book: () => Promise<Case[]>;
  log: OperationalLog | null;
  dryRun: boolean;
  /** Where the pass reports, line by line, for the owner to read. */
  print: (text: string) => void;
  now?: () => Date;
  signal?: AbortSignal;
}

export interface PassReport {
  repos: number;
  judged: number;
  posted: number;
  /** Repos the pass could not finish: their changes are read again next pass. */
  failed: string[];
}

/** Whether a comment is an `/entail` mention: a line that starts with `/entail`. */
export function isMention(body: string): boolean {
  return /^[ \t]*\/entail\b/mu.test(body);
}

/** The issue's title and body, hashed: what an edit changes and a comment does not. */
export function contentHash(issue: Pick<Issue, "title" | "body">): string {
  return createHash("sha256").update(JSON.stringify([issue.title.trim(), issue.body.trim()])).digest("hex").slice(0, 16);
}

export async function runPass(options: PassOptions): Promise<PassReport> {
  const report: PassReport = { repos: 0, judged: 0, posted: 0, failed: [] };
  for (const repo of loggedRepos(options.dataDirectory)) {
    options.signal?.throwIfAborted();
    const entries = readLog(options.dataDirectory, repo);
    const state = repoState(repo, entries);
    if (!state.enrolled) continue;
    report.repos++;
    try {
      const outcome = await passRepo(options, state, entries);
      report.judged += outcome.judged;
      report.posted += outcome.posted;
      if (!outcome.ok) report.failed.push(repo);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      report.failed.push(repo);
      // Forget what was seen, so the changes are read and weighed again next pass.
      options.seen.delete(repo);
      const message = error instanceof Error ? error.message : String(error);
      options.log?.warn("pass-failed", { repo, error: message, ...(error instanceof RateLimitedError ? { resetAt: error.resetAt.toISOString() } : {}) });
      options.print(`${repo}: the pass stopped: ${message}`);
    }
  }
  return report;
}

/** What waits to be judged on one issue in a pass. */
interface IssueWork {
  number: number;
  issue: Issue | null;
  mentions: Mention[];
}

async function passRepo(options: PassOptions, state: RepoState, entries: Entry[]): Promise<{ ok: boolean; judged: number; posted: number }> {
  const { repo } = state;
  const forge = options.forgeFor(repo);
  const project = await forge.project();
  const key = projectKey(project);
  const batch = await forge.changesSince(options.cursors.get(key));
  let seen = options.seen.get(repo);
  if (seen === undefined) options.seen.set(repo, (seen = new ChangeDeduplicator()));
  const fresh = seen.fresh(batch.changes);

  let reading: Promise<RepoReading> | null = null;
  const context: JudgeContext = {
    options,
    state,
    forge,
    reading: () => (reading ??= options.reader(repo, forge)),
  };
  const planned: Entry[] = [];
  const record = (entry: NewEntry): Entry => {
    const now = options.now?.() ?? new Date();
    if (options.dryRun) {
      const written = { id: newEntryId(), at: now.toISOString(), ...entry } as Entry;
      planned.push(written);
      return written;
    }
    return appendEntry(options.dataDirectory, repo, entry, now) as Entry;
  };

  let ok = true;
  let judged = 0;
  for (const work of issueWork(fresh, entries, state)) {
    options.signal?.throwIfAborted();
    const issue = work.issue ?? (await forge.issue(work.number));
    if (issue === null) continue;
    const trigger = triggerFor(issue, work, entries, state);
    if (trigger === null) continue;
    const entry = await judgeIssue(context, issue, trigger, work.mentions, null);
    if (entry === null) {
      ok = false;
      continue;
    }
    record(entry);
    judged++;
  }

  // The owner said go on the board: the judgment runs again with their word, for the criteria.
  for (const pending of pendingWork([...readLog(options.dataDirectory, repo), ...planned])) {
    if (pending.kind !== "rerun") continue;
    options.signal?.throwIfAborted();
    const issue = await forge.issue(pending.call.issue.number);
    if (issue === null) continue;
    const { action } = pending;
    const word: OwnerWord = {
      action: action.id,
      kind: action.type === "overridden" ? "override" : "answer",
      call: action.to,
      words: action.type === "overridden" ? action.reason : action.answer,
    };
    const entry = await judgeIssue(context, issue, "owner", [], { word, by: action.by, at: action.at, previous: pending.call });
    if (entry === null) {
      ok = false;
      continue;
    }
    record(entry);
    judged++;
  }

  let posted = 0;
  for (const pending of pendingWork([...readLog(options.dataDirectory, repo), ...planned])) {
    options.signal?.throwIfAborted();
    if (await act(options, repo, forge, pending, record)) posted++;
  }

  if (ok && !options.dryRun) options.cursors.set(key, batch.cursor);
  // A judgment that did not run is tried again: the changes are read again from the old cursor.
  if (!ok) options.seen.delete(repo);
  return { ok, judged, posted };
}

/** The issues a batch of changes asks to weigh: each changed issue, and each issue with a new `/entail` mention. */
function issueWork(changes: readonly Change[], entries: readonly Entry[], state: RepoState): IssueWork[] {
  const judged = judgedMentions(entries);
  const since = Date.parse(state.since ?? "");
  const work = new Map<number, IssueWork>();
  const of = (number: number): IssueWork => {
    let item = work.get(number);
    if (item === undefined) work.set(number, (item = { number, issue: null, mentions: [] }));
    return item;
  };
  for (const change of changes) {
    if (change.kind === "issue") {
      const item = of(change.issue.number);
      if (item.issue === null || Date.parse(change.issue.updatedAt) > Date.parse(item.issue.updatedAt)) item.issue = change.issue;
    } else if (change.kind === "issue-comment") {
      const { comment } = change;
      if (!isMention(comment.body) || Date.parse(comment.updatedAt) < since) continue;
      const mention: Mention = { id: comment.id, updatedAt: comment.updatedAt, author: comment.author.username, url: comment.url };
      if (!judged.has(mentionKey(mention))) of(comment.issueNumber).mentions.push(mention);
    }
  }
  return [...work.values()].sort((a, b) => a.number - b.number);
}

/**
 * Why an issue is judged now, or null when it is not: a new `/entail`
 * mention always; otherwise an open issue whose title or body changed since
 * its last call, or one filed since the repo was enrolled that has none.
 */
function triggerFor(issue: Issue, work: IssueWork, entries: readonly Entry[], state: RepoState): Trigger | null {
  if (work.mentions.length > 0) return "mention";
  if (issue.state !== "open") return null;
  const last = latestCalls(entries).get(issue.number);
  if (last !== undefined) return last.content === contentHash(issue) ? null : "edit";
  return Date.parse(issue.createdAt) >= Date.parse(state.since ?? "") ? "new" : null;
}

interface JudgeContext {
  options: PassOptions;
  state: RepoState;
  forge: WatchForge;
  reading: () => Promise<RepoReading>;
}

/** The owner's word a judgment runs again on, with the call it answers. */
interface OwnerRun {
  word: OwnerWord;
  by: string;
  at: string;
  previous: CallEntry;
}

/** Makes the call on one issue; null when the run gave none, which is logged and tried again next pass. */
async function judgeIssue(context: JudgeContext, issue: Issue, trigger: Trigger, mentions: Mention[], owner: OwnerRun | null): Promise<NewEntry | null> {
  const { options, state, forge } = context;
  const { repo } = state;
  const comments = await forge.comments("issue", issue.number);
  const rendered = comments.map((comment) => ({ author: comment.author.username, createdAt: comment.createdAt, body: comment.body }));
  if (owner !== null) rendered.push(ownerComment(owner));
  const issueText = renderIssue({ title: issue.title, body: issue.body, comments: rendered });
  const reading = await context.reading();
  const book = await options.book();
  const { model, effort } = runSettings(state, options.settings);
  const judgment = await judge(
    options.runner,
    {
      repo,
      issueNumber: issue.number,
      issueText,
      vision: reading.vision,
      pins: reading.pins,
      precedents: precedentsFor(book, repo, issueText),
      checkout: reading.checkout,
      sha: reading.sha,
    },
    { model, effort, ...(options.signal === undefined ? {} : { signal: options.signal }) },
  );
  const name = `${repo}#${issue.number}`;
  if (!judgment.ok) {
    options.log?.warn("judgment-failed", { repo, issue: issue.number, failure: judgment.failure.kind, message: judgment.failure.message });
    options.print(`${name}: the judgment gave no call (${judgment.failure.kind}): ${judgment.failure.message}; it is tried again next pass`);
    return null;
  }
  options.log?.info("judged", { repo, issue: issue.number, trigger, call: judgment.call.call, model: judgment.facts.model, costUsd: judgment.facts.estimatedCostUsd });
  const why = owner === null ? trigger : `the owner's ${owner.word.kind}, ${owner.word.call}`;
  options.print(`${name} (${why}): ${issue.title}\n${indent(formatCall(judgment.call))}`);
  return {
    type: "call",
    issue: { number: issue.number, title: issue.title, url: issue.url, author: issue.author.username },
    trigger,
    mentions,
    content: contentHash(issue),
    issueText,
    vision: reading.vision,
    sha: reading.sha,
    call: judgment.call,
    confirm: state.confirm,
    owner: owner?.word ?? null,
    model: judgment.facts.model,
    effort,
    promptVersion: JUDGMENT_PROMPT_VERSION,
    costUsd: judgment.facts.estimatedCostUsd,
  };
}

/** The owner's word as the judgment reads it: one more comment on the issue, from the board. */
function ownerComment(owner: OwnerRun): { author: string; createdAt: string; body: string } {
  const { word, previous } = owner;
  const body =
    word.kind === "answer" && previous.call.call === "ask"
      ? `entail asked the owner: ${previous.call.question}\n\nThe owner's answer: ${word.call}.\n\n${word.words}`
      : `entail's call was ${previous.call.call}: ${previous.call.reason}\n\nThe owner overrode it: ${word.call}.\n\n${word.words}`;
  return { author: `${owner.by} (the owner, on entail's board)`, createdAt: owner.at, body };
}

/**
 * Acts on GitHub for one entry: posts its comment unless a comment carrying
 * its marker is already there, closes the issue if it is to be closed, and
 * records that it acted. Returns whether it acted.
 */
async function act(options: PassOptions, repo: string, forge: WatchForge, pending: Pending, record: (entry: NewEntry) => Entry): Promise<boolean> {
  const post = postFor(pending, options.owner);
  if (post === null) return false;
  const body = composeComment(options.owner, post.markerFor, post.text);
  const name = `${repo}#${post.issue}`;
  if (options.dryRun) {
    options.print(`would post on ${name}${post.close ? " and close it" : post.reopen ? " and reopen it if closed" : ""}:\n${indent(body)}`);
    record({ type: "acted", for: post.markerFor, issue: post.issue, comment: { id: 0, url: "(dry run)" }, closed: post.close });
    return true;
  }
  const comments = await forge.comments("issue", post.issue);
  const already = comments.find((comment) => markedTickets(comment.body).includes(post.markerFor));
  const comment = already === undefined ? await forge.postComment("issue", post.issue, body) : { id: already.id, url: already.url };
  if (post.close) await forge.closeIssue(post.issue, "not-planned");
  const reopened = post.reopen && (await forge.issue(post.issue))?.state === "closed";
  if (reopened) await forge.reopenIssue(post.issue);
  record({ type: "acted", for: post.markerFor, issue: post.issue, comment, closed: post.close });
  options.log?.info("acted", { repo, issue: post.issue, for: post.markerFor, comment: comment.url, closed: post.close, alreadyPosted: already !== undefined });
  options.print(`${name}: ${already === undefined ? "posted" : "found already posted"} ${comment.url}${post.close ? ", closed the issue" : reopened ? ", reopened the issue" : ""}`);
  return true;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? "" : `    ${line}`))
    .join("\n");
}

/**
 * Reads repos through their git mirrors in the data directory: the default
 * branch's head, a read-only checkout of it, VISION.md there, and the owner's
 * pins. The previous checkout of a repo is removed when its head moves.
 */
export function mirrorReader(dataDirectory: string): RepoReader {
  const mirrors = new Map<string, Promise<Mirror>>();
  const lastCommit = new Map<string, string>();
  return async (repo, forge) => {
    let opening = mirrors.get(repo);
    if (opening === undefined) {
      opening = forge.project().then((project) =>
        Mirror.open({ dataDirectory, key: { forge: "github", host: HOST, projectId: project.id }, remote: forgeRemote("github", HOST, repo) }),
      );
      mirrors.set(repo, opening);
      opening.catch(() => mirrors.delete(repo));
    }
    const mirror = await opening;
    const head = await mirror.updateDefaultBranch();
    const previous = lastCommit.get(repo);
    if (previous !== undefined && previous !== head.commit) await mirror.removeCheckout(previous);
    const checkout = await mirror.checkout(head.commit);
    lastCommit.set(repo, head.commit);
    const vision = await readVision(mirror.git, head.commit);
    const text = vision.status === "missing" ? null : (await mirror.git.run(["cat-file", "blob", vision.blob])).stdout.toString("utf8");
    return {
      checkout: checkout.directory,
      sha: checkout.commit,
      vision: text === null ? null : { text, commit: head.commit },
      pins: await readPins(dataDirectory, { host: HOST, path: repo }),
    };
  };
}
