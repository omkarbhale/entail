import { createHash } from "node:crypto";
import { join } from "node:path";
import { landingPrecedentsFor, OWNER_CASE_BOOK, precedentsFor, renderIssue, renderPullRequest, writeCase, writeLandingCase, type Case, type LandingCase, type OwnerCall } from "./case-book.ts";
import { ChangeDeduplicator } from "./changes.ts";
import { composeComment, markedTickets } from "./comment-rules.ts";
import type { CursorStore } from "./cursors.ts";
import {
  allChecksFinished,
  projectKey,
  RateLimitedError,
  requiredChecksReported,
  type Change,
  type Forge,
  type Issue,
  type MergeMethod,
  type Project,
  type PullRequest,
} from "./forge/forge.ts";
import { formatCall, judge, JUDGMENT_PROMPT_VERSION } from "./judgment.ts";
import { ciGreen, ciProblems, formatLandingCall, judgeLanding, LANDING_PROMPT_VERSION, touched } from "./landing.ts";
import { forgeRemote, Mirror } from "./mirror.ts";
import type { ModelRunner } from "./model-runner.ts";
import type { OperationalLog } from "./operational-log.ts";
import { caseFor, landingCaseFor, runSettings } from "./owner.ts";
import { readPins } from "./pins.ts";
import { postFor, pullRequestPostFor, type MergeResult } from "./posts.ts";
import {
  appendEntry,
  followedPullRequests,
  goCallOn,
  HOST,
  judgedMentions,
  latestCalls,
  latestLandings,
  loggedRepos,
  mentionKey,
  newEntryId,
  pendingLanding,
  pendingWork,
  readLog,
  type ActedEntry,
  repoState,
  SEND_BACK_LIMIT,
  JUDGMENT_ATTEMPTS,
  sendBacksPosted,
  type CallEntry,
  type Entry,
  type LandingEntry,
  type LandingPending,
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
 * An owner's action taken on the board is acted on only once its undo window
 * has closed: entail then writes it to the owner's case book and posts it.
 *
 * The pass also follows each open PR that the forge says closes an issue
 * entail called go on: once CI has finished at a head it has not judged, the
 * landing judgment makes the call on that head, and entail posts it on the
 * PR, merges at that head (unless the repo is in confirm mode), or closes a
 * PR it sent back too often. A new push is judged again; nothing is reused.
 * The owner's action on a PR's call is acted on the same way, once its
 * window has closed.
 *
 * Every call and every act is appended to the repo's log. With `dryRun` the
 * pass changes nothing: no log entry, no cursor, no comment, no close, no
 * merge and no case; it prints what it would do instead.
 */

/** What a pass needs of a forge. */
export type WatchForge = Pick<
  Forge,
  | "setting"
  | "project"
  | "changesSince"
  | "issue"
  | "comments"
  | "postComment"
  | "closeIssue"
  | "reopenIssue"
  | "pullRequest"
  | "linkedIssues"
  | "checks"
  | "pullRequestFiles"
  | "mergeMethods"
  | "merge"
  | "pullRequestState"
  | "closePullRequest"
>;

/** A repo read at its default branch's head, for the judgment. */
export interface RepoReading {
  checkout: string;
  sha: string;
  vision: { text: string; commit: string } | null;
  pins: string[];
}

/** Reads a repo for the judgment: once per pass and repo, and only when something there is judged. */
export type RepoReader = (repo: string, forge: WatchForge) => Promise<RepoReading>;

/** A PR read at one head for the landing judgment: its diff from git, and the default branch it would merge into. */
export interface PullRequestReading {
  /** A read-only checkout of the PR's head. */
  checkout: string;
  head: string;
  /** The default branch's head the diff is taken against. */
  base: string;
  diff: string;
  /** ISO time the head commit was made. */
  committedAt: string;
  /** Whether the head holds workflow files under `.github/workflows`. */
  definesCI: boolean;
  /** VISION.md on the default branch. */
  vision: { text: string; commit: string } | null;
  pins: string[];
  /** Removes what the reading left behind, such as the checkout. */
  release: () => Promise<void>;
}

/** Reads a PR at a head. */
export type PullRequestReader = (repo: string, forge: WatchForge, pr: number, head: string) => Promise<PullRequestReading>;

export interface PassOptions {
  dataDirectory: string;
  /** The owner's display name, for the attribution line and the owner's word. */
  owner: string;
  settings: GlobalSettings;
  forgeFor: (repo: string) => WatchForge;
  reader: RepoReader;
  prReader: PullRequestReader;
  runner: ModelRunner;
  cursors: CursorStore;
  /** Changes already seen, per repo, kept across the passes of one run. */
  seen: Map<string, ChangeDeduplicator>;
  /** The case book: the shipped one and the owner's. */
  book: () => Promise<Case[]>;
  /** The landing cases of the same books. */
  landingBook: () => Promise<LandingCase[]>;
  log: OperationalLog | null;
  dryRun: boolean;
  /** Where the pass reports, line by line, for the owner to read. */
  print: (text: string) => void;
  now?: () => Date;
  signal?: AbortSignal;
  /** Only these repos; every enrolled repo when left out. */
  only?: readonly string[];
  /** Read nothing new from the forge: only act on what the log says is still to do, such as an owner's action whose window closed. */
  actOnly?: boolean;
  /** Told when a repo has been checked for changes, with what the check did. */
  onChecked?: (repo: string, outcome: { ok: boolean; judged: number; posted: number }) => void;
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
    if (options.only !== undefined && !options.only.includes(repo)) continue;
    const entries = readLog(options.dataDirectory, repo);
    const state = repoState(repo, entries);
    if (!state.enrolled) continue;
    report.repos++;
    try {
      const outcome = await passRepo(options, state, entries);
      report.judged += outcome.judged;
      report.posted += outcome.posted;
      if (!outcome.ok) report.failed.push(repo);
      if (options.actOnly !== true) options.onChecked?.(repo, outcome);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (options.actOnly !== true) options.onChecked?.(repo, { ok: false, judged: 0, posted: 0 });
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
  const now = () => options.now?.() ?? new Date();
  let key: string | null = null;
  let batch: { changes: Change[]; cursor: string } = { changes: [], cursor: "" };
  if (options.actOnly !== true) {
    key = projectKey(await forge.project());
    batch = await forge.changesSince(options.cursors.get(key));
  }
  let seen = options.seen.get(repo);
  if (seen === undefined) options.seen.set(repo, (seen = new ChangeDeduplicator()));
  const fresh = options.actOnly === true ? [] : seen.fresh(batch.changes);

  let reading: Promise<RepoReading> | null = null;
  const context: JudgeContext = {
    options,
    state,
    forge,
    reading: () => (reading ??= options.reader(repo, forge)),
  };
  const planned: Entry[] = [];
  const record = (entry: NewEntry): Entry => {
    if (options.dryRun) {
      const written = { id: newEntryId(), at: now().toISOString(), ...entry } as Entry;
      planned.push(written);
      return written;
    }
    return appendEntry(options.dataDirectory, repo, entry, now()) as Entry;
  };

  let ok = true;
  let judged = 0;
  const judgedNow = new Set<number>();
  for (const work of issueWork(fresh, entries, state)) {
    options.signal?.throwIfAborted();
    const issue = work.issue ?? (await forge.issue(work.number));
    if (issue === null) continue;
    noteReopened(issue, entries, record);
    const trigger = triggerFor(issue, work, entries, state);
    if (trigger === null) continue;
    const entry = await judgeIssue(context, issue, trigger, work.mentions, null);
    if (entry === null) {
      ok = false;
      continue;
    }
    record(entry);
    judgedNow.add(issue.number);
    judged++;
  }

  // The owner asked for the open backlog: each issue on it with no call yet, while it is still open.
  if (options.actOnly !== true) {
    const called = latestCalls(entries);
    for (const number of backlogIssues(entries)) {
      if (called.has(number) || judgedNow.has(number)) continue;
      options.signal?.throwIfAborted();
      const issue = await forge.issue(number);
      if (issue === null || issue.state !== "open") continue;
      const entry = await judgeIssue(context, issue, "backlog", [], null);
      if (entry === null) {
        ok = false;
        continue;
      }
      record(entry);
      judged++;
    }
  }

  // The owner said go on the board: the judgment runs again with their word, for the criteria.
  for (const pending of pendingWork([...readLog(options.dataDirectory, repo), ...planned], now())) {
    if (pending.kind !== "rerun") continue;
    options.signal?.throwIfAborted();
    const issue = await forge.issue(pending.call.issue.number);
    if (issue === null) continue;
    const { action } = pending;
    if (!options.dryRun) await writeCase(join(options.dataDirectory, OWNER_CASE_BOOK), caseFor(repo, pending.call, action));
    const word: OwnerWord = {
      action: action.id,
      kind: action.type === "overridden" ? "override" : "answer",
      call: action.to as OwnerCall,
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

  if (options.actOnly !== true) {
    const landed = await passPullRequests(context, await forge.project(), fresh, record, planned);
    judged += landed.judged;
    if (!landed.ok) ok = false;
  }

  // One post that fails, such as on an issue deleted since, does not hold up the others; it is tried again next pass.
  let posted = 0;
  let acted = true;
  for (const pending of pendingWork([...readLog(options.dataDirectory, repo), ...planned], now())) {
    options.signal?.throwIfAborted();
    try {
      if (await act(options, repo, forge, pending, record)) posted++;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      acted = false;
      const message = error instanceof Error ? error.message : String(error);
      const issue = pending.kind === "call" ? pending.entry.issue.number : pending.call.issue.number;
      options.log?.warn("act-failed", { repo, issue, error: message });
      options.print(`${repo}#${issue}: entail could not act on the issue: ${message}; it tries again next pass`);
    }
  }
  for (const pending of pendingLanding([...readLog(options.dataDirectory, repo), ...planned], now())) {
    options.signal?.throwIfAborted();
    const pr = pending.kind === "landing" ? pending.entry.pr.number : pending.landing.pr.number;
    try {
      if (await actOnPullRequest(options, context.state, forge, pending, record)) posted++;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      acted = false;
      const message = error instanceof Error ? error.message : String(error);
      options.log?.warn("pr-act-failed", { repo, pr, error: message });
      options.print(`${repo}#${pr}: entail could not act on the pull request: ${message}; it tries again next pass`);
    }
  }

  if (ok && !options.dryRun && key !== null) options.cursors.set(key, batch.cursor);
  // A judgment that did not run is tried again: the changes are read again from the old cursor.
  if (!ok) options.seen.delete(repo);
  return { ok: ok && acted, judged, posted };
}

/** The issues the owner asked entail to judge from the open backlog, in the order asked. */
function backlogIssues(entries: readonly Entry[]): number[] {
  const issues: number[] = [];
  for (const entry of entries) if (entry.type === "backlog") for (const issue of entry.issues) if (!issues.includes(issue)) issues.push(issue);
  return issues;
}

/**
 * Records an issue someone reopened on GitHub after entail closed it. It is
 * kept in the log as what happened, not as the owner's word: GitHub does not
 * say here who reopened it.
 */
function noteReopened(issue: Issue, entries: readonly Entry[], record: (entry: NewEntry) => Entry): void {
  if (issue.state !== "open") return;
  const last = entries.findLast((entry): entry is ActedEntry => entry.type === "acted" && entry.issue === issue.number);
  if (last === undefined || !last.closed) return;
  if (entries.some((entry) => entry.type === "reopened" && entry.after === last.id)) return;
  record({ type: "reopened", issue: issue.number, after: last.id });
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
    issue: { number: issue.number, title: issue.title, url: issue.url, author: issue.author.username, createdAt: issue.createdAt },
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
  // The owner's action reaches the case book as its window closes, before anything is posted for it.
  if (!options.dryRun && pending.kind !== "call") await writeCase(join(options.dataDirectory, OWNER_CASE_BOOK), caseFor(repo, pending.call, pending.action));
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

// PRs.

/** How long after a head was committed, a head with no checks at all is taken as checks not yet reported. */
const CHECKS_WINDOW_MS = 10 * 60 * 1000;

/**
 * Follows and judges the repo's PRs: each open PR that changed this pass and
 * each PR already followed. A PR is followed once the forge's own link data
 * says it closes an issue entail called go on; a followed PR's every new head
 * is judged once its checks have finished, and a PR merged or closed is no
 * longer followed. Returns whether every PR could be read.
 */
async function passPullRequests(
  context: JudgeContext,
  project: Project,
  fresh: readonly Change[],
  record: (entry: NewEntry) => Entry,
  planned: readonly Entry[],
): Promise<{ ok: boolean; judged: number }> {
  const { options, state, forge } = context;
  const { repo } = state;
  const entries = [...readLog(options.dataDirectory, repo), ...planned];
  const followed = followedPullRequests(entries);
  const changed = new Set<number>();
  for (const change of fresh) if (change.kind === "pull-request" && change.pullRequest.state === "open") changed.add(change.pullRequest.number);
  const numbers = [...new Set([...followed.keys(), ...changed])].sort((a, b) => a - b);
  const latest = latestLandings(entries);
  let ok = true;
  let judged = 0;
  for (const number of numbers) {
    options.signal?.throwIfAborted();
    const name = `${repo}#${number}`;
    try {
      const pr = await forge.pullRequest(number);
      let issue = followed.get(number)?.issue;
      if (issue === undefined) {
        if (pr.state !== "open" || pr.baseBranch !== project.defaultBranch) continue;
        issue = (await forge.linkedIssues(number)).find((linked) => goCallOn(entries, linked) !== null);
        if (issue === undefined) continue;
        record({ type: "followed", pr: pullRequestRef(pr), issue });
        options.print(`${name}: following the pull request "${pr.title}", which closes #${issue}`);
      }
      if (pr.state !== "open") {
        record({ type: "unfollowed", pr: number, state: pr.state });
        options.print(`${name}: the pull request is ${pr.state}; no longer following it`);
        continue;
      }
      if (pr.draft || pr.baseBranch !== project.defaultBranch) continue;
      if (latest.get(number)?.head === pr.headSha) continue;
      const failures = entries.filter((entry) => entry.type === "landing-failed" && entry.pr === number && entry.head === pr.headSha).length;
      if (failures >= JUDGMENT_ATTEMPTS) {
        if (changed.has(number)) options.print(`${name}: landing is stalled at ${pr.headSha.slice(0, 7)}: the judgment gave no call ${failures} times; it resumes with a new push`);
        continue;
      }
      const report = await forge.checks(number, pr.headSha, []);
      if (!allChecksFinished(report) || !requiredChecksReported(report)) {
        if (changed.has(number)) options.print(`${name}: waiting for CI to finish at ${pr.headSha.slice(0, 7)} before judging`);
        continue;
      }
      const go = goCallOn(entries, issue);
      if (go === null) {
        if (changed.has(number)) options.print(`${name}: #${issue} no longer has a go, so the pull request is not judged`);
        continue;
      }
      const entry = await judgePullRequest(context, pr, go, { checks: report.checks, required: report.required }, entries);
      if ("waiting" in entry) {
        options.log?.info("checks-awaited", { repo, pr: number, head: pr.headSha, why: entry.waiting });
        if (changed.has(number)) options.print(`${name}: ${entry.waiting}; not judged yet`);
        continue;
      }
      if ("failed" in entry) {
        record({ type: "landing-failed", pr: number, head: pr.headSha, reason: entry.failed });
        continue;
      }
      record(entry);
      judged++;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      ok = false;
      const message = error instanceof Error ? error.message : String(error);
      options.log?.warn("pr-read-failed", { repo, pr: number, error: message });
      options.print(`${name}: entail could not read the pull request: ${message}; it tries again next pass`);
    }
  }
  return { ok, judged };
}

function pullRequestRef(pr: PullRequest): LandingEntry["pr"] {
  return { number: pr.number, title: pr.title, url: pr.url, author: pr.author.username };
}

/** Makes the landing call on a PR's head; `failed` with the reason when the run gave none, or `waiting` when CI has not reported at the head. */
async function judgePullRequest(
  context: JudgeContext,
  pr: PullRequest,
  go: CallEntry,
  checks: Pick<LandingEntry["facts"], "checks" | "required">,
  entries: readonly Entry[],
): Promise<NewEntry | { failed: string } | { waiting: string }> {
  const { options, state, forge } = context;
  const { repo } = state;
  const name = `${repo}#${pr.number}`;
  const files = await forge.pullRequestFiles(pr.number);
  const facts = { ...checks, files };
  const reading = await options.prReader(repo, forge, pr.number, pr.headSha);
  try {
    if (checks.checks.length === 0 && checks.required.length === 0) {
      const age = (options.now?.() ?? new Date()).getTime() - Date.parse(reading.committedAt);
      if (age < CHECKS_WINDOW_MS) return { waiting: `no checks have reported at ${pr.headSha.slice(0, 7)} yet, which was committed ${Math.max(0, Math.round(age / 60_000))} minutes ago` };
      if (reading.definesCI) return { waiting: `the repository defines CI but no check has reported at ${pr.headSha.slice(0, 7)}` };
    }
    const criteria = go.call.call === "no" ? [] : go.call.criteria;
    const sendBacks = sendBacksPosted(entries, pr.number);
    const sentBack = new Set(entries.flatMap((entry) => (entry.type === "pr-acted" && entry.pr === pr.number && entry.sentBack ? [entry.for] : [])));
    const earlier = entries.flatMap((entry) =>
      entry.type === "landing" && entry.pr.number === pr.number && sentBack.has(entry.id) ? [{ head: entry.head, needsToChange: entry.call.needsToChange }] : [],
    );
    const prText = renderPullRequest(pr);
    const { model, effort } = runSettings(state, options.settings);
    const judgment = await judgeLanding(
      options.runner,
      {
        repo,
        pr: { number: pr.number, text: prText },
        head: pr.headSha,
        base: reading.base,
        issue: { number: go.issue.number, text: go.issueText },
        criteria,
        vision: reading.vision,
        pins: reading.pins,
        facts,
        diff: reading.diff,
        precedents: landingPrecedentsFor(await options.landingBook(), repo, go.issueText),
        sendBacks: earlier,
        checkout: reading.checkout,
      },
      { model, effort, ...(options.signal === undefined ? {} : { signal: options.signal }) },
    );
    if (!judgment.ok) {
      options.log?.warn("landing-failed", { repo, pr: pr.number, failure: judgment.failure.kind, message: judgment.failure.message });
      options.print(`${name}: the landing judgment gave no call (${judgment.failure.kind}): ${judgment.failure.message}; it is tried again next pass, up to ${JUDGMENT_ATTEMPTS} times at this head`);
      return { failed: `${judgment.failure.kind}: ${judgment.failure.message}` };
    }
    const { call } = judgment;
    const cancel = call.call === "send-back" && sendBacks >= SEND_BACK_LIMIT;
    options.log?.info("landed-call", { repo, pr: pr.number, head: pr.headSha, call: call.call, cancel, model: judgment.facts.model, costUsd: judgment.facts.estimatedCostUsd });
    options.print(`${name} at ${pr.headSha.slice(0, 7)}, closing #${go.issue.number}: ${pr.title}\n${indent(formatLandingCall(call))}${cancel ? `\n    (sent back ${sendBacks} times before: this cancels it)` : ""}`);
    return {
      type: "landing",
      pr: pullRequestRef(pr),
      issue: { number: go.issue.number, title: go.issue.title, url: go.issue.url },
      issueCall: go.id,
      issueText: go.issueText,
      prText,
      head: pr.headSha,
      base: reading.base,
      vision: reading.vision,
      criteria,
      facts,
      touched: touched(files, reading.pins),
      call,
      sendBacks,
      cancel,
      confirm: state.confirm,
      model: judgment.facts.model,
      effort,
      promptVersion: LANDING_PROMPT_VERSION,
      costUsd: judgment.facts.estimatedCostUsd,
    };
  } finally {
    await reading.release();
  }
}

/**
 * Acts on a PR for one landing call or owner's action: merges at the judged
 * head when it is to be merged, posts the comment unless one carrying its
 * marker is already there, closes the PR when it is cancelled, and records
 * what it did. Returns whether it acted.
 */
async function actOnPullRequest(
  options: PassOptions,
  state: RepoState,
  forge: WatchForge,
  pending: LandingPending,
  record: (entry: NewEntry) => Entry,
): Promise<boolean> {
  const { repo } = state;
  const landing = pending.kind === "landing" ? pending.entry : pending.landing;
  const post = pullRequestPostFor(pending, options.owner);
  const name = `${repo}#${post.pr}`;
  const productQuestion = post.close && landing.call.productCall && landing.call.question !== null;
  if (options.dryRun) {
    const merge: MergeResult | null = post.merge ? { merged: true, sha: landing.head, commit: null } : null;
    const body = composeComment(options.owner, post.markerFor, post.text(merge));
    const what = [post.merge ? `merge at ${landing.head}` : "", post.close ? "close it unmerged" : "", productQuestion ? `raise #${landing.issue.number}'s question to ${options.owner}` : ""].filter((part) => part !== "");
    options.print(`would post on ${name}${what.length > 0 ? `, then ${what.join(" and ")}` : ""}:\n${indent(body)}`);
    record({ type: "pr-acted", for: post.markerFor, pr: post.pr, comment: { id: 0, url: "(dry run)" }, merged: null, refused: null, sentBack: post.sentBack, closed: post.close });
    return true;
  }
  // The owner's action reaches the case book as its window closes, before anything is posted or merged for it.
  if (pending.kind !== "landing") await writeLandingCase(join(options.dataDirectory, OWNER_CASE_BOOK), landingCaseFor(repo, landing, pending.action));
  const merge = post.merge ? await mergeAtHead(options, forge, landing) : null;
  const body = composeComment(options.owner, post.markerFor, post.text(merge));
  const comments = await forge.comments("pr", post.pr);
  const already = comments.find((comment) => markedTickets(comment.body).includes(post.markerFor));
  const comment = already === undefined ? await forge.postComment("pr", post.pr, body) : { id: already.id, url: already.url };
  if (post.close) await forge.closePullRequest(post.pr);
  record({
    type: "pr-acted",
    for: post.markerFor,
    pr: post.pr,
    comment,
    merged: merge?.merged ? { sha: merge.sha, commit: merge.commit } : null,
    refused: merge !== null && !merge.merged ? merge.refusal : null,
    sentBack: post.sentBack,
    closed: post.close,
  });
  if (merge?.merged) record({ type: "unfollowed", pr: post.pr, state: "merged" });
  if (post.close) {
    record({ type: "unfollowed", pr: post.pr, state: "closed" });
    const question = productQuestion ? cancelQuestion(state, landing, readLog(options.dataDirectory, repo)) : null;
    if (question !== null) record(question);
  }
  options.log?.info("pr-acted", { repo, pr: post.pr, for: post.markerFor, comment: comment.url, merged: merge?.merged ?? null, closed: post.close, alreadyPosted: already !== undefined });
  const did = merge === null ? "" : merge.merged ? `, merged at ${merge.sha.slice(0, 7)}` : `; not merged: ${merge.refusal}`;
  options.print(`${name}: ${already === undefined ? "posted" : "found already posted"} ${comment.url}${did}${post.close ? ", closed the pull request unmerged" : ""}`);
  return true;
}

/**
 * The question a cancelled PR leaves for the owner when what blocked it was a
 * product call: an ask on the issue, carrying the go's criteria, so the
 * owner's answer settles how work on the issue goes on.
 */
function cancelQuestion(state: RepoState, landing: LandingEntry, entries: readonly Entry[]): NewEntry | null {
  const go = entries.find((entry): entry is CallEntry => entry.type === "call" && entry.id === landing.issueCall);
  if (go === undefined || landing.call.question === null) return null;
  return {
    type: "call",
    issue: go.issue,
    trigger: "landing",
    mentions: [],
    content: go.content,
    issueText: go.issueText,
    vision: go.vision,
    sha: go.sha,
    call: {
      call: "ask",
      reason: `entail sent ${landing.pr.url} back ${landing.sendBacks} times and closed it: ${landing.call.reason}`,
      restsOn: landing.call.restsOn,
      question: landing.call.question.question,
      why: landing.call.question.why,
      large: false,
      criteria: go.call.call === "no" ? [] : go.call.criteria,
    },
    confirm: state.confirm,
    owner: null,
    model: landing.model,
    effort: landing.effort,
    promptVersion: landing.promptVersion,
    costUsd: null,
  };
}

/**
 * Merges a PR at the head that was judged, and only there: a PR already
 * merged counts as merged; a closed one, one whose head moved since, or one
 * whose CI is not green at that head is refused without asking the forge. The
 * repo's own merge method is followed: squash where it is allowed, else the
 * first the repo allows.
 */
async function mergeAtHead(options: PassOptions, forge: WatchForge, landing: LandingEntry): Promise<MergeResult> {
  const number = landing.pr.number;
  const live = await forge.pullRequest(number);
  if (live.state === "merged") {
    const merged = await forge.pullRequestState(number);
    return { merged: true, sha: merged.headSha, commit: merged.mergeCommitSha };
  }
  if (live.state === "closed") return { merged: false, refusal: "the pull request is closed" };
  if (live.headSha !== landing.head) return { merged: false, refusal: `its head moved to \`${live.headSha}\` since it was judged` };
  const report = await forge.checks(number, landing.head, []);
  if (!ciGreen(report)) return { merged: false, refusal: `CI is not green at the judged head: ${ciProblems(report).join("; ")}` };
  const outcome = await forge.merge(number, landing.head, mergeMethod(await forge.mergeMethods()));
  options.log?.info("merge", { repo: forge.setting.path, pr: number, head: landing.head, merged: outcome.merged });
  return outcome.merged ? { merged: true, sha: landing.head, commit: outcome.mergeCommitSha } : { merged: false, refusal: outcome.refusal };
}

/** Squash unless the repo does not allow it, then the first method it allows; squash when the forge does not say. */
export function mergeMethod(allowed: readonly MergeMethod[] | null): MergeMethod {
  if (allowed === null || allowed.length === 0 || allowed.includes("squash")) return "squash";
  return allowed.includes("merge") ? "merge" : allowed[0]!;
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
  return mirrorReaders(dataDirectory).reader;
}

/**
 * The readers of a run, sharing one mirror per repo: {@link mirrorReader}'s
 * for the call on an issue, and one for a PR's head, which fetches it, diffs it
 * against the default branch's head and checks it out until the judgment is
 * done.
 */
export function mirrorReaders(dataDirectory: string): { reader: RepoReader; prReader: PullRequestReader } {
  const mirrors = new Map<string, Promise<Mirror>>();
  const lastCommit = new Map<string, string>();
  const mirrorOf = (repo: string, forge: WatchForge): Promise<Mirror> => {
    let opening = mirrors.get(repo);
    if (opening === undefined) {
      opening = forge.project().then((project) =>
        Mirror.open({ dataDirectory, key: { forge: "github", host: HOST, projectId: project.id }, remote: forgeRemote("github", HOST, repo) }),
      );
      mirrors.set(repo, opening);
      opening.catch(() => mirrors.delete(repo));
    }
    return opening;
  };
  const visionAt = async (mirror: Mirror, commit: string) => {
    const vision = await readVision(mirror.git, commit);
    const text = vision.status === "missing" ? null : (await mirror.git.run(["cat-file", "blob", vision.blob])).stdout.toString("utf8");
    return text === null ? null : { text, commit };
  };
  const reader: RepoReader = async (repo, forge) => {
    const mirror = await mirrorOf(repo, forge);
    const head = await mirror.updateDefaultBranch();
    const previous = lastCommit.get(repo);
    if (previous !== undefined && previous !== head.commit) await mirror.removeCheckout(previous);
    const checkout = await mirror.checkout(head.commit);
    lastCommit.set(repo, head.commit);
    return {
      checkout: checkout.directory,
      sha: checkout.commit,
      vision: await visionAt(mirror, head.commit),
      pins: await readPins(dataDirectory, { host: HOST, path: repo }),
    };
  };
  const prReader: PullRequestReader = async (repo, forge, pr, head) => {
    const mirror = await mirrorOf(repo, forge);
    const base = await mirror.updateDefaultBranch();
    const fetched = await mirror.fetchPullRequestHead(pr, head);
    if (fetched.commit !== head) throw new Error(`the pull request's head moved to ${fetched.commit} while it was read`);
    const diff = await mirror.pullRequestDiff(base.commit, head);
    const checkout = await mirror.checkout(head);
    const committedAt = (await mirror.git.run(["show", "-s", "--format=%cI", head, "--"])).stdout.toString("utf8").trim();
    const definesCI = (await mirror.git.run(["cat-file", "-e", `${head}:.github/workflows`], { okExitCodes: [1, 128] })).exitCode === 0;
    return {
      checkout: checkout.directory,
      head,
      base: base.commit,
      diff,
      committedAt,
      definesCI,
      vision: await visionAt(mirror, base.commit),
      pins: await readPins(dataDirectory, { host: HOST, path: repo }),
      // The default branch's own checkout is the issue reader's to remove.
      release: async () => {
        if ([...lastCommit.values()].includes(head)) return;
        await mirror.removeCheckout(head);
      },
    };
  };
  return { reader, prReader };
}
