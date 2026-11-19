import { createHash } from "node:crypto";
import { join } from "node:path";
import { openBlockers, readBlockers, refsText, sameBlockers } from "./blockers.ts";
import { landingPrecedentsFor, OWNER_CASE_BOOK, precedentsFor, renderIssue, renderPullRequest, writeCase, writeLandingCase, type Case, type LandingCase, type OwnerCall } from "./case-book.ts";
import { ChangeDeduplicator } from "./changes.ts";
import { composeComment, markedTickets } from "./comment-rules.ts";
import type { CursorStore } from "./cursors.ts";
import {
  allChecksFinished,
  assertEntailLabel,
  ENTAIL_LABEL_PREFIX,
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
import { oneLine, type RepoFailure } from "./health.ts";
import { formatCall, judge, JUDGMENT_PROMPT_VERSION, RECHECK_PROMPT_VERSION, scopeOf, type IssueCall } from "./judgment.ts";
import { ciGreen, ciProblems, formatLandingCall, judgeLanding, landingPromptVersion, touched, type LinkedIssue } from "./landing.ts";
import { forgeRemote, Mirror, type MirrorRemote } from "./mirror.ts";
import type { ModelRunner } from "./model-runner.ts";
import type { OperationalLog } from "./operational-log.ts";
import { caseFor, landingCaseFor, runSettings } from "./owner.ts";
import { readPins } from "./pins.ts";
import { knownKinds, settleByRuling, type Settlement } from "./rulings.ts";
import type { AnswerParts } from "./parts.ts";
import { BLOCKED_LABEL, markedParts, partBody, postFor, pullRequestPostFor, type FiledPart, type MergeResult } from "./posts.ts";
import {
  appendEntry,
  clearedGoOn,
  followedPullRequests,
  goCallOn,
  heldIssues,
  heldActions,
  judgedMentions,
  latestCalls,
  latestLandings,
  loggedRepos,
  mentionKey,
  newEntryId,
  pendingLanding,
  interruptedHandoffs,
  interruptedStarts,
  pendingGrowth,
  pendingHandoffs,
  pendingStarts,
  pendingWork,
  readLog,
  type ActedEntry,
  type AnsweredEntry,
  type BlockedEntry,
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
  type PullRequestRef,
  type LabelChange,
  type RepoState,
  type Trigger,
  type VisionRecheck,
  type VisionSeenEntry,
  type BaseBranchSeenEntry,
  workStarted,
} from "./records.ts";
import { sendBackHandoffFor, type SendBackHandoff } from "./send-backs.ts";
import { handoffFor, runStart, type Handoff, type StartResult } from "./starts.ts";
import { SUGGESTED_LABEL, TITLE_LIMIT, type SuggestReader } from "./suggest.ts";
import { collapseWhitespace, readVision, VISION_PATH, visionTextChange, type VisionChange } from "./vision.ts";
import { addVisionLine, decideGrowth, VISION_GROWTH_PROMPT_VERSION, type GrowthDecision } from "./vision-growth.ts";

/**
 * One pass over the enrolled repos: read what changed on each since the last
 * pass, make the call once on each new or edited issue and on each `/entail`
 * mention, run the judgment again where the owner answered go, and act on
 * the forge for everything not yet acted on: post each call, close on a no
 * (unless the repo is in confirm mode), and post what the owner decided on
 * the board.
 *
 * An owner's action taken on the board is acted on only once its undo window
 * has closed: entail then writes it to the owner's case book and posts it.
 *
 * The pass also follows each open PR that the forge says closes an issue
 * whose go has acted, and each open, non-draft PR with no such issue behind
 * it, which is judged on the vision alone: once CI has finished at a head it
 * has not judged, the landing judgment makes the call on that head, and entail posts it on the
 * PR, merges at that head (unless the repo is in confirm mode), or closes a
 * PR it sent back too often. A new push is judged again; nothing is reused.
 * The owner's action on a PR's call is acted on the same way, once its
 * window has closed.
 *
 * Each act on an issue puts the `entail:` label for the call that acted on
 * it (`entail:go`, `entail:plan` for a go for planning, `entail:no`, or
 * `entail:ask` while a question waits),
 * taking off any other `entail:` label. Only an account that cannot label
 * lets the act go ahead without it; any other label failure holds the act for
 * a retry next pass.
 *
 * An issue that names an open blocker, in its text ("blocked by #12",
 * "depends on #12") or by the forge's own blocking links, is held instead of
 * judged: no call, no criteria and no work, one comment saying what it waits
 * on, and the `entail:blocked` label (`src/blockers.ts`). A held issue is
 * weighed again when it changes (an edit, or an `/entail` comment), when the
 * change feed reports a change to one of its blockers in the same repo (a
 * blocker closing is one), and, for a blocker in another repo, which this
 * repo's feed never reports, by reading that blocker's state each pass. Once
 * none of its blockers is open it is judged as it would have been; while the
 * same blockers stay open nothing new is posted.
 *
 * When a go acts and the owner set a start command, entail runs it with the
 * handoff, once per issue, and records that work was started (`src/starts.ts`).
 *
 * When VISION.md on the base branch states different lines from what
 * entail last saw, the pass records the change and re-checks once each open
 * issue whose posted call was made under the earlier text: the same
 * judgment, with the earlier call and the lines removed and added. A call the
 * change moves is posted as a changed call, quoting the line that moved it
 * and flagging each open PR for the issue; a call that holds is logged and
 * nothing is posted.
 *
 * Every call and every act is appended to the repo's log. With `dryRun` the
 * pass changes nothing: no log entry, no cursor, no comment, no close, no
 * merge and no case; it prints what it would do instead.
 */

/** What a pass needs of a forge. */
export type WatchForge = Pick<
  Forge,
  | "setting"
  | "wording"
  | "baseBranch"
  | "project"
  | "changesSince"
  | "issue"
  | "blockedBy"
  | "issueState"
  | "comments"
  | "postComment"
  | "addLabel"
  | "removeLabel"
  | "access"
  | "closeIssue"
  | "createIssue"
  | "openIssues"
  | "reopenIssue"
  | "pullRequest"
  | "openPullRequests"
  | "linkedIssues"
  | "checks"
  | "pullRequestFiles"
  | "mergeMethods"
  | "merge"
  | "pullRequestState"
  | "closePullRequest"
  | "updateFile"
  | "commitsTouching"
>;

/** A repo read at its base branch's head, for the judgment: the default branch, or the base branch the owner set. */
export interface RepoReading {
  checkout: string;
  sha: string;
  vision: { text: string; commit: string } | null;
  pins: string[];
}

/** Reads a repo for the judgment: once per pass and repo, and only when something there is judged. */
export type RepoReader = (repo: string, forge: WatchForge) => Promise<RepoReading>;

/** A PR read at one head for the landing judgment: its diff from git, and the base branch it would merge into. */
export interface PullRequestReading {
  /** A read-only checkout of the PR's head. */
  checkout: string;
  head: string;
  /** The base branch's head the diff is taken against. */
  base: string;
  diff: string;
  /** ISO time the head commit was made. */
  committedAt: string;
  /** Whether the head defines CI for its forge: workflows under `.github/workflows` on GitHub, `.gitlab-ci.yml` on GitLab. */
  definesCI: boolean;
  /** VISION.md on the base branch. */
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
  onChecked?: (repo: string, outcome: CheckOutcome) => void;
  /** Runs the start command; {@link runStart} unless replaced in tests. */
  startWork?: (command: string, handoff: Handoff) => Promise<StartResult>;
  /** Runs the send-back command; {@link runStart} unless replaced in tests. */
  handBack?: (command: string, handoff: SendBackHandoff) => Promise<StartResult>;
}

/** What a check on one repo did; `failure` is the last step that failed, if any did. */
export interface CheckOutcome {
  ok: boolean;
  judged: number;
  posted: number;
  failure?: RepoFailure;
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
      const message = error instanceof Error ? error.message : String(error);
      const failure = failureAt(options, "the pass", message, error instanceof RateLimitedError ? error.resetAt : undefined);
      if (options.actOnly !== true) options.onChecked?.(repo, { ok: false, judged: 0, posted: 0, failure });
      report.failed.push(repo);
      // Forget what was seen, so the changes are read and weighed again next pass.
      options.seen.delete(repo);
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

/** A failed step, as the owner is told of it. */
function failureAt(options: PassOptions, step: string, message: string, resetAt?: Date): RepoFailure {
  return { at: (options.now?.() ?? new Date()).toISOString(), step, message: oneLine(message), ...(resetAt === undefined ? {} : { resetAt: resetAt.toISOString() }) };
}

async function passRepo(options: PassOptions, state: RepoState, entries: Entry[]): Promise<CheckOutcome> {
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
    failure: null,
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
  const current = () => [...readLog(options.dataDirectory, repo), ...planned];
  const works = issueWork(fresh, entries, state);
  if (options.actOnly !== true) {
    for (const number of await heldToWeigh(forge, heldIssues(entries), fresh, works)) works.push({ number, issue: null, mentions: [] });
    works.sort((a, b) => a.number - b.number);
  }
  for (const work of works) {
    options.signal?.throwIfAborted();
    const issue = work.issue ?? (await forge.issue(work.number));
    if (issue === null) continue;
    noteReopened(issue, entries, record);
    const held = heldIssues(current()).get(issue.number);
    if (held !== undefined && issue.state !== "open" && work.mentions.length === 0) {
      // Closed while held: nothing is left to wait for.
      record({ type: "unblocked", issue: issue.number, why: "closed" });
      continue;
    }
    const trigger = work.mentions.length > 0 ? "mention" : held !== undefined ? held.trigger : triggerFor(issue, work, entries, state);
    if (trigger === null) continue;
    const outcome = await holdOrJudge(context, issue, trigger, work.mentions, held, record);
    if (outcome === "failed") {
      ok = false;
      continue;
    }
    judgedNow.add(issue.number);
    if (outcome === "judged") judged++;
  }

  // The owner asked for the open backlog: each issue on it with no call yet, while it is still open.
  if (options.actOnly !== true) {
    const called = latestCalls(entries);
    const held = heldIssues(current());
    for (const number of backlogIssues(entries)) {
      // A held issue is weighed again only when it or one of its blockers changes.
      if (called.has(number) || judgedNow.has(number) || held.has(number)) continue;
      options.signal?.throwIfAborted();
      const issue = await forge.issue(number);
      if (issue === null || issue.state !== "open") continue;
      const outcome = await holdOrJudge(context, issue, "backlog", [], undefined, record);
      if (outcome === "failed") {
        ok = false;
        continue;
      }
      if (outcome === "judged") judged++;
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
      ...(action.scope === "plan" ? { scope: "plan" as const } : {}),
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
    const rechecked = await recheckVision(context, entries, record, planned);
    judged += rechecked;
  }

  if (options.actOnly !== true) {
    const landed = await passPullRequests(context, await forge.project(), fresh, record, planned);
    judged += landed.judged;
    if (!landed.ok) ok = false;
  }

  // One post that fails, such as on an issue deleted since, does not hold up the others; it is tried again next pass.
  let posted = 0;
  let acted = true;
  let access: Promise<string | null> | null = null;
  // What the account may do is read once per pass, and only when a label is to go on.
  const cannotLabel = () =>
    (access ??= forge.access().then((read) => read.cannotLabelAndComment));
  for (const pending of pendingWork([...readLog(options.dataDirectory, repo), ...planned], now())) {
    options.signal?.throwIfAborted();
    try {
      if (await act(options, repo, forge, pending, record, () => [...readLog(options.dataDirectory, repo), ...planned], cannotLabel)) posted++;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      acted = false;
      const message = error instanceof Error ? error.message : String(error);
      const issue = pending.kind === "call" || pending.kind === "blocked" ? pending.entry.issue.number : pending.call.issue.number;
      options.log?.warn("act-failed", { repo, issue, error: message });
      context.failure = failureAt(options, `acting on #${issue}`, message, error instanceof RateLimitedError ? error.resetAt : undefined);
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
      context.failure = failureAt(options, `acting on PR #${pr}`, message, error instanceof RateLimitedError ? error.resetAt : undefined);
      options.print(`${repo}#${pr}: entail could not act on the pull request: ${message}; it tries again next pass`);
    }
  }

  // A board answer that makes sense as a general statement grows the vision, and the owner is told; most answers add nothing.
  if (!(await growVision(context, record, () => [...readLog(options.dataDirectory, repo), ...planned]))) acted = false;

  // Work starts after the go that starts it was posted; a crash before the start begins runs it at the next pass.
  // A start that began and has no outcome was cut off with the command possibly already at work: it is logged as interrupted, never run again.
  for (const begun of interruptedStarts([...readLog(options.dataDirectory, repo), ...planned])) {
    if (options.dryRun) continue;
    const error = "entail stopped while the start command was running; it may have taken effect, so it was not run again";
    record({ type: "started", for: begun.for, issue: begun.issue, command: begun.command, exit: null, error, interrupted: true });
    options.log?.warn("start-interrupted", { repo, issue: begun.issue, command: begun.command, error });
    options.print(`${repo}#${begun.issue}: ${error}`);
  }
  for (const acted of pendingStarts([...readLog(options.dataDirectory, repo), ...planned])) {
    options.signal?.throwIfAborted();
    await startWork(options, repo, acted, record);
  }

  // The send-back command runs after the comment that sent the PR back was posted and recorded; a crash before it begins runs it at the next pass.
  // One that began and has no outcome was cut off with the command possibly already at work: it is logged as interrupted, never run again.
  for (const begun of interruptedHandoffs([...readLog(options.dataDirectory, repo), ...planned])) {
    if (options.dryRun) continue;
    const error = "entail stopped while the send-back command was running; it may have taken effect, so it was not run again";
    record({ type: "handed-back", for: begun.for, pr: begun.pr, command: begun.command, exit: null, error, interrupted: true });
    options.log?.warn("hand-back-interrupted", { repo, pr: begun.pr, command: begun.command, error });
    options.print(`${repo}#${begun.pr}: ${error}`);
  }
  for (const acted of pendingHandoffs([...readLog(options.dataDirectory, repo), ...planned])) {
    options.signal?.throwIfAborted();
    await handBack(options, repo, acted, record);
  }

  if (ok && !options.dryRun && key !== null) options.cursors.set(key, batch.cursor);
  // A judgment that did not run is tried again: the changes are read again from the old cursor.
  if (!ok) options.seen.delete(repo);
  return { ok: ok && acted, judged, posted, ...(context.failure === null ? {} : { failure: context.failure }) };
}

/** The sentence a pass prints, and the commit says, for a line added from an answer. */
function growthSubject(target: CallEntry | LandingEntry): { kind: "issue" | "pr"; number: number; title: string; url: string } {
  if (target.type === "call") return { kind: "issue", ...target.issue };
  return { kind: "pr", number: target.pr.number, title: target.pr.title, url: target.pr.url };
}

/**
 * Weighs each board answer given since the vision started to grow from them,
 * once, and writes the line of each that makes sense as a general statement
 * into VISION.md on the base branch, then records where it came from. The
 * decision is recorded before the write, so a write the forge refused (a
 * protected branch, a file that moved) is tried again next pass without
 * another model run. Returns false when something could not be done.
 */
async function growVision(context: JudgeContext, record: (entry: NewEntry) => Entry, entries: () => Entry[]): Promise<boolean> {
  const { options, state, forge } = context;
  const { repo } = state;
  const now = () => options.now?.() ?? new Date();
  let ok = true;
  for (const work of pendingGrowth(entries(), now())) {
    options.signal?.throwIfAborted();
    const subject = growthSubject(work.target);
    const name = `${repo}#${subject.number}`;
    let considered = work.kind === "write" ? work.considered : null;
    try {
      if (work.kind === "consider") {
        const reading = await context.reading();
        const { model, effort } = runSettings(state, options.settings);
        const question =
          work.target.type === "call" ? (work.target.call.call === "ask" ? work.target.call.question : "") : (work.target.call.question?.question ?? "");
        const decided = await decideGrowth(
          options.runner,
          {
            repo,
            about: name,
            context: work.target.type === "call" ? work.target.issueText : `${work.target.issue === null ? "" : `${work.target.issueText.trim()}\n\n`}The pull request: ${work.target.prText}`,
            question,
            by: work.answer.by,
            chose: work.answer.to === "go" && work.answer.scope === "plan" ? "go, for planning" : work.answer.to,
            answer: work.answer.answer,
            vision: reading.vision,
            checkout: reading.checkout,
            sha: reading.sha,
          },
          { model, effort, ...(options.signal === undefined ? {} : { signal: options.signal }) },
        );
        if (!decided.ok) {
          options.log?.warn("vision-growth-failed", { repo, answer: work.answer.id, failure: decided.failure.kind, message: decided.failure.message });
          context.failure = failureAt(options, `weighing the answer on #${subject.number} for the vision`, `${decided.failure.kind}: ${decided.failure.message}`, decided.failure.resetAt);
          options.print(`${name}: weighing the answer for the vision gave no decision (${decided.failure.kind}): ${decided.failure.message}; it is tried again next pass`);
          ok = false;
          continue;
        }
        const entry = record({
          type: "vision-considered",
          answer: work.answer.id,
          decision: decided.decision,
          visionCommit: reading.vision?.commit ?? null,
          model: decided.facts.model,
          effort,
          promptVersion: VISION_GROWTH_PROMPT_VERSION,
          costUsd: decided.facts.estimatedCostUsd,
        }) as Extract<Entry, { type: "vision-considered" }>;
        options.log?.info("vision-considered", { repo, answer: work.answer.id, add: decided.decision.add, model: decided.facts.model, costUsd: decided.facts.estimatedCostUsd });
        if (!decided.decision.add) {
          options.print(`${name}: ${work.answer.by}'s answer settles this ${subject.kind === "pr" ? "PR" : "ticket"} only; nothing added to the vision: ${oneLine(decided.decision.reason)}`);
          continue;
        }
        considered = entry as typeof considered;
      }
      if (considered === null || !considered.decision.add) continue;
      const { line, heading } = considered.decision;
      if (options.dryRun) {
        options.print(`would add to ${repo}'s ${VISION_PATH} from ${work.answer.by}'s answer on ${name}: ${line}`);
        continue;
      }
      const message = `Add a line to ${VISION_PATH} from a board answer on ${subject.kind === "pr" ? "PR " : ""}#${subject.number}\n\n${line}\n\nBoard answer ${work.answer.id}`;
      let written = await forge.updateFile(VISION_PATH, (current) => (current === null ? null : addVisionLine(current, line, heading)), message);
      if (!written.changed) {
        // An earlier pass may have committed this line and stopped before recording it: the commit is on the file's history.
        const earlier = (await forge.commitsTouching(VISION_PATH)).find((entry) => entry.message.trim() === message.trim());
        if (earlier !== undefined) written = { changed: true, commit: earlier.commit, branch: (await forge.project()).baseBranch };
      }
      if (!written.changed) {
        // The vision has no file to grow, or already says it: nothing was added, and the answer is not weighed again.
        record({ type: "vision-considered", answer: work.answer.id, decision: { add: false, reason: `${considered.decision.reason} Nothing was added: the vision has no ${VISION_PATH} to add to, or already says it.` }, visionCommit: considered.visionCommit, model: considered.model, effort: considered.effort, promptVersion: considered.promptVersion, costUsd: null });
        options.print(`${name}: nothing was added to the vision: it has no ${VISION_PATH}, or already says it`);
        continue;
      }
      record({
        type: "vision-grown",
        considered: considered.id,
        answer: work.answer.id,
        on: work.target.id,
        by: work.answer.by,
        about: subject,
        line,
        heading,
        reason: considered.decision.reason,
        commit: written.commit,
        branch: written.branch,
      });
      options.log?.info("vision-grown", { repo, answer: work.answer.id, commit: written.commit });
      options.print(`${repo}: added to ${VISION_PATH} automatically, from ${work.answer.by}'s answer on ${name}, at ${written.commit.slice(0, 7)}:\n${indent(line)}\n    ${oneLine(considered.decision.reason)}\n    open calls made under the earlier text are re-checked next pass, and an open PR whose ticket's call moves is told it relied on the old text`);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      ok = false;
      const message = error instanceof Error ? error.message : String(error);
      options.log?.warn("vision-growth-failed", { repo, answer: work.answer.id, error: message });
      context.failure = failureAt(options, `adding to the vision from the answer on #${subject.number}`, message, error instanceof RateLimitedError ? error.resetAt : undefined);
      options.print(`${name}: entail could not write the line into ${VISION_PATH}: ${message}; it tries again next pass`);
    }
  }
  return ok;
}

/**
 * The held issues to weigh again though they did not change themselves: each
 * whose blocker in this repo changed in this batch, and each with a blocker in
 * another repo that is no longer open, read from the forge since this repo's
 * feed does not report it. Issues already weighed in this pass are left out.
 */
async function heldToWeigh(forge: WatchForge, held: ReadonlyMap<number, BlockedEntry>, changes: readonly Change[], works: readonly IssueWork[]): Promise<number[]> {
  const path = forge.setting.path.toLowerCase();
  const changed = new Set(changes.flatMap((change) => (change.kind === "issue" ? [change.issue.number] : [])));
  const weighed = new Set(works.map((work) => work.number));
  const again: number[] = [];
  for (const [number, hold] of held) {
    if (weighed.has(number)) continue;
    const here = hold.blockers.filter((blocker) => blocker.path.toLowerCase() === path);
    let weigh = here.some((blocker) => changed.has(blocker.number));
    for (const blocker of hold.blockers) {
      if (weigh) break;
      if (blocker.path.toLowerCase() !== path) weigh = (await forge.issueState(blocker.path, blocker.number)) !== "open";
    }
    if (weigh) again.push(number);
  }
  return again;
}

/**
 * Weighs one issue: holds it when one of its blockers is open, or judges it.
 * A hold with the same open blockers as the standing one, and no new
 * `/entail` comment to answer, records nothing, so nothing new is posted.
 */
async function holdOrJudge(
  context: JudgeContext,
  issue: Issue,
  trigger: Trigger,
  mentions: Mention[],
  held: BlockedEntry | undefined,
  record: (entry: NewEntry) => Entry,
): Promise<"held" | "judged" | "failed"> {
  const { options, forge, state } = context;
  const reading = await readBlockers(forge, issue);
  const open = openBlockers(reading.blockers);
  const carried = [...(held?.mentions ?? []), ...mentions];
  if (open.length > 0) {
    if (held !== undefined && mentions.length === 0 && sameBlockers(held.blockers, open)) return "held";
    record({
      type: "blocked",
      issue: { number: issue.number, title: issue.title, url: issue.url, author: issue.author.username, createdAt: issue.createdAt },
      trigger,
      mentions: carried,
      content: contentHash(issue),
      blockers: open,
      forgeLinks: reading.forgeLinks,
    });
    options.log?.info("held", { repo: state.repo, issue: issue.number, blockers: open.map((ref) => `${ref.path}#${ref.number}`), forgeLinks: reading.forgeLinks });
    options.print(`${state.repo}#${issue.number}: held, blocked by ${refsText(open, state.repo)}${reading.forgeLinks ? "" : " (the forge's blocked-by links could not be read; only the text was checked)"}`);
    return "held";
  }
  const entry = await judgeIssue(context, issue, trigger, carried, null);
  if (entry === null) return "failed";
  record(entry);
  return "judged";
}

/** The issues the owner asked entail to judge from the open backlog, in the order asked. */
function backlogIssues(entries: readonly Entry[]): number[] {
  const issues: number[] = [];
  for (const entry of entries) if (entry.type === "backlog") for (const issue of entry.issues) if (!issues.includes(issue)) issues.push(issue);
  return issues;
}

/**
 * Records an issue someone reopened on the forge after entail closed it. It
 * is kept in the log as what happened, not as the owner's word: the forge
 * does not say here who reopened it.
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
  /** The last step of this check that failed, if one did. */
  failure: RepoFailure | null;
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
  const logged = readLog(options.dataDirectory, repo);
  const asOf = options.now?.() ?? new Date();
  const judgment = await judge(
    options.runner,
    {
      repo,
      issueNumber: issue.number,
      issueText,
      vision: reading.vision,
      pins: reading.pins,
      precedents: precedentsFor(book, repo, issueText),
      kinds: knownKinds(logged, asOf),
      checkout: reading.checkout,
      sha: reading.sha,
    },
    { model, effort, ...(options.signal === undefined ? {} : { signal: options.signal }) },
  );
  const name = `${repo}#${issue.number}`;
  if (!judgment.ok) {
    options.log?.warn("judgment-failed", { repo, issue: issue.number, failure: judgment.failure.kind, message: judgment.failure.message });
    context.failure = failureAt(options, `judging #${issue.number}`, `${judgment.failure.kind}: ${judgment.failure.message}`, judgment.failure.resetAt);
    options.print(`${name}: the judgment gave no call (${judgment.failure.kind}): ${judgment.failure.message}; it is tried again next pass`);
    return null;
  }
  // The owner's own word is never replaced by a ruling; a question that would go to the owner may be settled by one.
  const settled = owner === null ? settleByRuling(judgment.call, { entries: logged, issueText, pins: reading.pins, now: asOf }) : { call: judgment.call, ruling: null, notSettled: null };
  const call = settled.call;
  options.log?.info("judged", { repo, issue: issue.number, trigger, call: call.call, model: judgment.facts.model, costUsd: judgment.facts.estimatedCostUsd });
  logSettlement(options, repo, issue.number, judgment.call, settled);
  const why = owner === null ? trigger : `the owner's ${owner.word.kind}, ${ownerCallWords(owner.word)}`;
  options.print(`${name} (${why}): ${issue.title}\n${indent(formatCall(call))}`);
  return {
    type: "call",
    issue: { number: issue.number, title: issue.title, url: issue.url, author: issue.author.username, createdAt: issue.createdAt },
    trigger,
    mentions,
    content: contentHash(issue),
    issueText,
    vision: reading.vision,
    sha: reading.sha,
    call,
    confirm: state.confirm,
    owner: owner?.word ?? null,
    model: judgment.facts.model,
    effort,
    promptVersion: JUDGMENT_PROMPT_VERSION,
    costUsd: judgment.facts.estimatedCostUsd,
  };
}

/** Tells the operational log what a ruling did with a call that would have gone to the owner: settled it, or why not. */
function logSettlement(options: PassOptions, repo: string, issue: number, judged: IssueCall, settled: Settlement): void {
  if (settled.ruling !== null) {
    options.log?.info("ruled", { repo, issue, kind: settled.ruling.kind, outcome: settled.ruling.outcome, answers: settled.ruling.answers.map((answer) => ({ call: answer.call, by: answer.by })) });
  } else if (settled.notSettled !== null && judged.call === "ask") {
    options.log?.info("ruling-not-used", { repo, issue, kind: judged.kind ?? "", why: settled.notSettled });
  }
}

/** The owner's word as the judgment reads it: one more comment on the issue, from the board. */
function ownerComment(owner: OwnerRun): { author: string; createdAt: string; body: string } {
  const { word, previous } = owner;
  const body =
    word.kind === "answer" && previous.call.call === "ask"
      ? `entail asked the owner: ${previous.call.question}\n\nThe owner's answer: ${ownerCallWords(word)}.\n\n${word.words}`
      : `entail's call was ${previous.call.call === "go" && scopeOf(previous.call) === "plan" ? "go, for planning" : previous.call.call}: ${previous.call.reason}\n\nThe owner overrode it: ${ownerCallWords(word)}.\n\n${word.words}`;
  return { author: `${owner.by} (the owner, on entail's board)`, createdAt: owner.at, body };
}

/** The owner's call as words: go, go for planning, or no. */
function ownerCallWords(word: OwnerWord): string {
  return word.call === "go" && word.scope === "plan" ? "go, for planning" : word.call;
}

/**
 * Acts on the forge for one entry: posts its comment unless a comment carrying
 * its marker is already there, closes the issue if it is to be closed, puts
 * on its `entail:` label, and records that it acted, with what came of the
 * label. Returns whether it acted.
 */
async function act(
  options: PassOptions,
  repo: string,
  forge: WatchForge,
  pending: Pending,
  record: (entry: NewEntry) => Entry,
  entries: () => Entry[],
  cannotLabel: () => Promise<string | null>,
): Promise<boolean> {
  // An answer that took only some of an issue's parts files each as an issue before the original is closed.
  const taking = pending.kind === "owner-no" && pending.action.type === "answered" ? pending.action : null;
  const filing = taking?.parts === undefined ? null : { action: taking, parts: taking.parts };
  const filed = filing === null ? [] : await filePartIssues(options, repo, forge, pending.kind === "owner-no" ? pending.call : null, filing.action, filing.parts);
  const post = postFor(pending, options.owner, repo, forge.baseBranch, filed);
  if (post === null) return false;
  const command = options.settings.start ?? null;
  const handoff = command === null ? null : handoffFor(repo, pending, forge.baseBranch);
  const start = command !== null && handoff !== null && !workStarted(entries(), handoff.issue.number) ? { start: { command, handoff } } : {};
  const body = composeComment(options.owner, post.markerFor, post.text);
  const name = `${repo}#${post.issue}`;
  // The owner's action reaches the case book as its window closes, before anything is posted for it.
  if (!options.dryRun && pending.kind !== "call" && pending.kind !== "blocked") await writeCase(join(options.dataDirectory, OWNER_CASE_BOOK), caseFor(repo, pending.call, pending.action));
  if (options.dryRun) {
    options.print(`would post on ${name}${post.close ? " and close it" : post.reopen ? " and reopen it if closed" : ""}${post.label === null ? "" : `, labelled ${post.label}`}:\n${indent(body)}`);
    if (pending.kind === "call") for (const pr of pending.entry.recheck?.pullRequests ?? []) options.print(`would tell ${repo}#${pr.number} that it relied on the old vision`);
    record({ type: "acted", for: post.markerFor, issue: post.issue, comment: { id: 0, url: "(dry run)" }, closed: post.close, ...start, ...(filing === null ? {} : { filed: [] }) });
    return true;
  }
  // A call that waits to be confirmed puts on no label, but the hold it ends takes its label off.
  const unhold = post.label === null && pending.kind === "call";
  const live = post.reopen || post.label !== null || unhold ? await forge.issue(post.issue) : null;
  const label = post.label === null ? null : await putLabel(forge, post.issue, post.label, live?.labels ?? [], cannotLabel);
  if (unhold && live?.labels.includes(BLOCKED_LABEL) === true && (await cannotLabel()) === null) await forge.removeLabel(post.issue, BLOCKED_LABEL);
  const comments = await forge.comments("issue", post.issue);
  const already = comments.find((comment) => markedTickets(comment.body).includes(post.markerFor));
  const comment = already === undefined ? await forge.postComment("issue", post.issue, body) : { id: already.id, url: already.url };
  const flagged = pending.kind === "call" && pending.entry.recheck !== undefined ? await flagPullRequests(options, forge, pending.entry, pending.entry.recheck, comment.url) : [];
  if (post.close) await forge.closeIssue(post.issue, "not-planned");
  const reopened = post.reopen && live?.state === "closed";
  if (reopened) await forge.reopenIssue(post.issue);
  record({ type: "acted", for: post.markerFor, issue: post.issue, comment, closed: post.close, ...(label === null ? {} : { label }), ...start, ...(flagged.length === 0 ? {} : { flagged }), ...(filing === null ? {} : { filed: filed.flatMap((one) => (one.number === null ? [] : [{ index: one.index, number: one.number, url: one.url, already: one.already }])) }) });
  options.log?.info("acted", { repo, issue: post.issue, for: post.markerFor, comment: comment.url, closed: post.close, alreadyPosted: already !== undefined, ...(label === null ? {} : { label: label.label, labelRemoved: label.removed }) });
  if (label?.failed !== undefined) options.log?.warn("label-failed", { repo, issue: post.issue, label: label.label, error: label.failed });
  const labelled = label === null || label.already ? "" : label.failed === undefined ? `, labelled it ${label.label}` : `, could not label it ${label.label} (${label.failed})`;
  options.print(`${name}: ${already === undefined ? "posted" : "found already posted"} ${comment.url}${post.close ? ", closed the issue" : reopened ? ", reopened the issue" : ""}${labelled}`);
  return true;
}

/**
 * Files one issue for each part the owner accepted, labelled with nothing so it
 * goes through ordinary intake: it is judged when the next pass reads it, like
 * any issue filed since the repo was enrolled. A part whose marker an open
 * issue already carries (filed before a crash could record it) is found, not
 * filed again. A dry run files nothing.
 */
async function filePartIssues(options: PassOptions, repo: string, forge: WatchForge, call: CallEntry | null, action: AnsweredEntry, parts: AnswerParts): Promise<(FiledPart & { url: string; already: boolean })[]> {
  const issue = call?.issue.number ?? 0;
  if (options.dryRun) {
    options.print(`would file ${parts.accepted.length} issue${parts.accepted.length === 1 ? "" : "s"} from ${repo}#${issue}:\n${indent(parts.accepted.map((part) => `- ${part.title}`).join("\n"))}`);
    return parts.accepted.map((_, index) => ({ index, number: null, url: "(dry run)", already: false }));
  }
  const marked = new Map<number, Issue>();
  for (const open of await forge.openIssues()) for (const index of markedParts(open.body, action.id)) if (!marked.has(index)) marked.set(index, open);
  const filed: (FiledPart & { url: string; already: boolean })[] = [];
  for (const [index, part] of parts.accepted.entries()) {
    const found = marked.get(index);
    const long = part.title.length > TITLE_LIMIT;
    const filing = long ? { title: part.title.slice(0, TITLE_LIMIT), body: `${part.title}${part.body === "" ? "" : `\n\n${part.body}`}` } : part;
    const made = found ?? (await forge.createIssue(filing.title, partBody(options.owner, issue, action.id, index, filing), []));
    filed.push({ index, number: made.number, url: made.url, already: found !== undefined });
    options.log?.info("part-filed", { repo, issue, for: action.id, index, filed: made.url, alreadyFiled: found !== undefined });
  }
  return filed;
}

/**
 * Tells each open PR for an issue whose call a vision change moved that it
 * relied on the old text, once: a comment carrying the call's marker is not
 * posted again. A PR closed since is left alone.
 */
async function flagPullRequests(options: PassOptions, forge: WatchForge, entry: CallEntry, recheck: VisionRecheck, issueComment: string): Promise<NonNullable<ActedEntry["flagged"]>> {
  const flagged: NonNullable<ActedEntry["flagged"]> = [];
  const pullRequest = forge.wording.pullRequest;
  for (const pr of recheck.pullRequests) {
    const live = await forge.pullRequest(pr.number);
    if (live.state !== "open") continue;
    const comments = await forge.comments("pr", pr.number);
    const already = comments.find((comment) => markedTickets(comment.body).includes(entry.id));
    const text = `VISION.md changed, and entail's call on #${entry.issue.number}, which this ${pullRequest} is for, changed with it: **${recheck.previousCall}** → **${entry.call.call}**. This ${pullRequest} relied on the old text. What changed and why: ${issueComment}`;
    const comment = already === undefined ? await forge.postComment("pr", pr.number, composeComment(options.owner, entry.id, text)) : { id: already.id, url: already.url };
    flagged.push({ pr: pr.number, comment });
    options.print(`${forge.setting.path}#${pr.number}: ${already === undefined ? "told the" : "found already told the"} ${pullRequest} it relied on the old vision: ${comment.url}`);
  }
  return flagged;
}

/**
 * Puts `label` on an issue that carries `carried`, taking off any other
 * `entail:` label first, so the issue carries one at a time. A label the
 * issue carries already is not added again. An account that may not label
 * here is returned for the act to record, and the act goes ahead without the
 * label; any other failure throws, so the act is tried again next pass.
 */
async function putLabel(forge: WatchForge, issue: number, label: string, carried: readonly string[], cannotLabel: () => Promise<string | null>): Promise<LabelChange> {
  const removed: string[] = [];
  const already = carried.includes(label);
  // `entail:suggested` says where the issue came from, not what was called on it, so it stays.
  const others = carried.filter((other) => other !== label && other !== SUGGESTED_LABEL && other.startsWith(ENTAIL_LABEL_PREFIX) && isEntailLabel(other));
  if (already && others.length === 0) return { label, already, removed };
  const cannot = await cannotLabel();
  if (cannot !== null) return { label, already: false, removed, failed: cannot };
  for (const other of others) {
    await forge.removeLabel(issue, other);
    removed.push(other);
  }
  if (!already) await forge.addLabel(issue, label);
  return { label, already, removed };
}

function isEntailLabel(label: string): boolean {
  try {
    assertEntailLabel(label);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs the start command for a go that acted and records that work was
 * started, by which command and with what exit status. A command that fails
 * is recorded and logged, and is not run again: the call stands either way.
 */
async function startWork(options: PassOptions, repo: string, acted: ReturnType<typeof pendingStarts>[number], record: (entry: NewEntry) => Entry): Promise<void> {
  const { command } = acted.start;
  // A handoff recorded before scope was kept is a go to implement.
  const handoff = { ...acted.start.handoff, scope: acted.start.handoff.scope ?? "implement" };
  const name = `${repo}#${acted.issue}`;
  if (options.dryRun) {
    options.print(`would start work on ${name} with: ${command}\n${indent(JSON.stringify(handoff, null, 2))}`);
    return;
  }
  // Recorded before the command runs: a restart that finds it with no outcome does not run the command again.
  record({ type: "starting", for: acted.id, issue: acted.issue, command });
  const result = await (options.startWork ?? runStart)(command, handoff);
  record({ type: "started", for: acted.id, issue: acted.issue, command, exit: result.exit, ...(result.error === undefined ? {} : { error: result.error }) });
  if (result.exit === 0) {
    options.log?.info("started", { repo, issue: acted.issue, command });
    options.print(`${name}: started work with ${command}`);
  } else {
    options.log?.warn("start-failed", { repo, issue: acted.issue, command, exit: result.exit, error: result.error });
    options.print(`${name}: the start command failed (${result.error ?? `exit ${result.exit}`}); the call stands`);
  }
}

/**
 * Runs the send-back command for a PR that was sent back or cancelled and
 * records by which command and with what exit status. A command that fails or
 * times out is recorded and logged and is not run again: the call and its
 * comment stand either way, and nothing here changes them.
 */
async function handBack(options: PassOptions, repo: string, acted: ReturnType<typeof pendingHandoffs>[number], record: (entry: NewEntry) => Entry): Promise<void> {
  const { command, handoff } = acted.handoff;
  const name = `${repo}#${acted.pr}`;
  if (options.dryRun) {
    options.print(`would hand ${name} to the send-back command: ${command}\n${indent(JSON.stringify(handoff, null, 2))}`);
    return;
  }
  record({ type: "handing-back", for: acted.id, pr: acted.pr, command });
  const result = await (options.handBack ?? runStart)(command, handoff);
  record({ type: "handed-back", for: acted.id, pr: acted.pr, command, exit: result.exit, ...(result.error === undefined ? {} : { error: result.error }) });
  if (result.exit === 0) {
    options.log?.info("handed-back", { repo, pr: acted.pr, command });
    options.print(`${name}: handed it to ${command}`);
  } else {
    options.log?.warn("hand-back-failed", { repo, pr: acted.pr, command, exit: result.exit, error: result.error });
    options.print(`${name}: the send-back command failed (${result.error ?? `exit ${result.exit}`}); the call stands`);
  }
}

// Vision changes.

/**
 * VISION.md as entail last saw it: the change a pass last recorded, or before
 * any was recorded, the vision the latest call read. Undefined when nothing
 * was ever judged, so there is nothing to compare.
 */
function lastSeenVision(state: RepoState, entries: readonly Entry[]): { commit: string | null; text: string | null } | undefined {
  if (state.vision !== null) return state.vision;
  const last = entries.findLast((entry): entry is CallEntry | LandingEntry => entry.type === "call" || entry.type === "landing");
  if (last === undefined) return undefined;
  return { commit: last.vision?.commit ?? null, text: last.vision?.text ?? null };
}

function moved(change: VisionChange): boolean {
  return change.removed.length > 0 || change.added.length > 0;
}

/** The call on an issue as it stands: the owner's, when the call was run on the owner's word. */
function standingCall(call: CallEntry): "go" | "no" | "ask" {
  return call.owner?.call ?? call.call.call;
}

/**
 * The calls a vision change leaves to re-check, in log order: the latest call
 * on each issue that was posted (for it or for the owner's action on it) and
 * read a vision whose lines differ from the change's, not yet re-checked for
 * this change. A call from a cancelled PR is left alone, and so is an issue
 * held back by an open blocker or with something still to do on it, such as
 * the owner's action in its window: it is re-checked once that is done.
 */
function recheckWork(entries: readonly Entry[], seen: VisionSeenEntry, now: Date): CallEntry[] {
  const posted = new Set<number>();
  const actionOn = new Map<number, number>();
  for (const entry of entries) {
    if (entry.type === "acted") posted.add(entry.for);
    if (entry.type === "confirmed" || entry.type === "overridden" || entry.type === "answered") actionOn.set(entry.id, entry.call);
  }
  const postedCalls = new Set<number>();
  for (const id of posted) postedCalls.add(actionOn.get(id) ?? id);
  const done = new Set<number>();
  const failures = new Map<number, number>();
  for (const entry of entries) {
    if (entry.type !== "rechecked" || entry.vision !== seen.id) continue;
    if (entry.outcome === "failed") failures.set(entry.call, (failures.get(entry.call) ?? 0) + 1);
    else done.add(entry.call);
  }
  const busy = new Set<number>();
  for (const pending of pendingWork(entries, now)) busy.add("entry" in pending ? pending.entry.issue.number : pending.call.issue.number);
  // An issue held back by an open blocker gets no call until it is cleared.
  for (const number of heldIssues(entries).keys()) busy.add(number);
  const held = new Set(heldActions(entries, now).map((action) => action.call));
  const latest = latestCalls(entries);
  const work: CallEntry[] = [];
  for (const entry of entries) {
    if (entry.type !== "call" || latest.get(entry.issue.number)?.id !== entry.id) continue;
    if (entry.trigger === "landing" || !postedCalls.has(entry.id) || done.has(entry.id)) continue;
    if ((failures.get(entry.id) ?? 0) >= JUDGMENT_ATTEMPTS) continue;
    if (busy.has(entry.issue.number) || held.has(entry.id)) continue;
    if (!moved(visionTextChange(entry.vision?.text ?? null, seen.text))) continue;
    work.push(entry);
  }
  return work;
}

/** The line of a vision change that moved a call: the model's quote matched to a removed or added line, else its words as given, else every changed line. */
function movingPassage(quote: string, change: VisionChange): Pick<VisionRecheck, "passage"> & { passageKind?: "added" | "removed" } {
  const wanted = collapseWhitespace(quote.replace(/^\s*[-+>]\s*/u, ""));
  if (wanted !== "") {
    for (const kind of ["added", "removed"] as const) {
      const line = change[kind].find((one) => one.identity === wanted) ?? change[kind].find((one) => one.identity.includes(wanted) || wanted.includes(one.identity));
      if (line !== undefined) return { passage: line.text.trim(), passageKind: kind };
    }
    return { passage: quote.trim() };
  }
  return { passage: [...change.removed.map((line) => `- ${line.text.trim()}`), ...change.added.map((line) => `+ ${line.text.trim()}`)].join("\n") };
}

/**
 * Notices a change to VISION.md on the base branch and re-checks the open
 * issues called under the earlier text, once per change. Returns how many
 * judgments ran.
 */
async function recheckVision(context: JudgeContext, startEntries: readonly Entry[], record: (entry: NewEntry) => Entry, planned: readonly Entry[]): Promise<number> {
  const { options, state, forge } = context;
  const { repo } = state;
  const now = () => options.now?.() ?? new Date();
  const current = () => [...readLog(options.dataDirectory, repo), ...planned];
  const seen = lastSeenVision(state, startEntries);
  // Nothing was ever called here, so nothing can be re-checked, and the vision is not read for it.
  if (seen === undefined) return 0;
  let reading: RepoReading;
  try {
    reading = await context.reading();
  } catch (error) {
    if (options.signal?.aborted) throw error;
    // The vision could not be read: the rest of the pass goes on, and the change is noticed next pass.
    const message = error instanceof Error ? error.message : String(error);
    options.log?.warn("vision-read-failed", { repo, error: message });
    context.failure = failureAt(options, "reading VISION.md", message);
    options.print(`${repo}: entail could not read VISION.md to look for a change: ${message}; it looks again next pass`);
    return 0;
  }
  const vision = reading.vision;
  if (moved(visionTextChange(seen.text, vision?.text ?? null))) {
    record({ type: "vision-seen", commit: vision?.commit ?? null, text: vision?.text ?? null, from: seen.commit });
    options.log?.info("vision-changed", { repo, from: seen.commit, to: vision?.commit ?? null });
    options.print(`${repo}: VISION.md changed${seen.commit === null ? "" : ` since ${seen.commit.slice(0, 7)}`}${vision === null ? "; it was removed" : ` at ${vision.commit.slice(0, 7)}`}`);
  }
  const entries = current();
  const change = entries.findLast((entry): entry is VisionSeenEntry => entry.type === "vision-seen");
  if (change === undefined) return 0;
  const work = recheckWork(entries, change, now());
  if (work.length === 0) return 0;
  options.print(`${repo}: re-checking ${work.length} open call${work.length === 1 ? "" : "s"} made under the earlier vision`);
  const book = await options.book();
  const { model, effort } = runSettings(state, options.settings);
  const followed = followedPullRequests(entries);
  let judged = 0;
  for (const [index, call] of work.entries()) {
    options.signal?.throwIfAborted();
    const number = call.issue.number;
    const name = `${repo}#${number}`;
    const progress = `(${index + 1} of ${work.length})`;
    const base = { type: "rechecked" as const, vision: change.id, issue: number, call: call.id };
    const issue = await forge.issue(number);
    if (issue === null || issue.state !== "open") {
      record({ ...base, outcome: "closed" });
      options.print(`${name} ${progress}: the issue is closed; not re-checked`);
      continue;
    }
    const lines = visionTextChange(call.vision?.text ?? null, change.text);
    const previous = standingCall(call);
    const judgment = await judge(
      options.runner,
      {
        repo,
        issueNumber: number,
        issueText: call.issueText,
        vision: reading.vision,
        pins: reading.pins,
        precedents: precedentsFor(book, repo, call.issueText),
        kinds: knownKinds(readLog(options.dataDirectory, repo), now()),
        checkout: reading.checkout,
        sha: reading.sha,
        recheck: {
          previous: { call: previous, reason: call.owner === null ? call.call.reason : call.owner.words, owner: call.owner !== null },
          from: call.vision?.commit ?? null,
          removed: lines.removed.map((line) => line.text),
          added: lines.added.map((line) => line.text),
        },
      },
      { model, effort, ...(options.signal === undefined ? {} : { signal: options.signal }) },
    );
    judged++;
    if (!judgment.ok) {
      const reason = `${judgment.failure.kind}: ${judgment.failure.message}`;
      record({ ...base, outcome: "failed", reason, model, effort, promptVersion: RECHECK_PROMPT_VERSION, costUsd: judgment.facts?.estimatedCostUsd ?? null });
      options.log?.warn("recheck-failed", { repo, issue: number, failure: judgment.failure.kind, message: judgment.failure.message });
      context.failure = failureAt(options, `re-checking #${number}`, reason, judgment.failure.resetAt);
      options.print(`${name} ${progress}: the re-check gave no call (${reason}); it is tried again next pass, up to ${JUDGMENT_ATTEMPTS} times`);
      continue;
    }
    const facts = { model: judgment.facts.model, effort, promptVersion: RECHECK_PROMPT_VERSION, costUsd: judgment.facts.estimatedCostUsd };
    // The owner's own word is never replaced by a ruling; any other question the re-check would send to the owner may be.
    const settled = call.owner !== null ? { call: judgment.call, ruling: null, notSettled: null } : settleByRuling(judgment.call, { entries: readLog(options.dataDirectory, repo), issueText: call.issueText, pins: reading.pins, now: now() });
    logSettlement(options, repo, number, judgment.call, settled);
    options.log?.info("rechecked", { repo, issue: number, from: previous, call: settled.call.call, model: judgment.facts.model, costUsd: judgment.facts.estimatedCostUsd });
    if (settled.call.call === previous) {
      record({ ...base, outcome: "held", judged: settled.call, ...facts });
      options.print(`${name} ${progress}: the call holds under the new vision: ${previous}`);
      continue;
    }
    const pullRequests: PullRequestRef[] = [];
    for (const followedPr of followed.values()) {
      if (followedPr.issue !== number) continue;
      const pr = await forge.pullRequest(followedPr.pr.number);
      if (pr.state === "open") pullRequests.push(pullRequestRef(pr));
    }
    const recheck: VisionRecheck = {
      vision: change.id,
      previous: call.id,
      previousCall: previous,
      removed: lines.removed.map((line) => line.text),
      added: lines.added.map((line) => line.text),
      ...movingPassage(judgment.visionChange ?? "", lines),
      pullRequests,
    };
    record({
      type: "call",
      issue: { ...call.issue, title: issue.title, url: issue.url },
      trigger: "vision",
      mentions: [],
      content: call.content,
      issueText: call.issueText,
      vision: reading.vision,
      sha: reading.sha,
      call: settled.call,
      // The owner made the earlier call: a change to it waits for them whatever the mode.
      confirm: state.confirm || call.owner !== null,
      owner: null,
      ...facts,
      recheck,
    });
    options.print(`${name} ${progress}: the vision change moves the call: ${previous} → ${settled.call.call}: ${issue.title}\n${indent(formatCall(settled.call))}\n    moved by: ${recheck.passage}${pullRequests.length === 0 ? "" : `\n    in-flight work that relied on the old text: ${pullRequests.map((pr) => pr.url).join(", ")}`}`);
  }
  return judged;
}

// PRs.

/** How long after a head was committed, a head with no checks at all is taken as checks not yet reported. */
const CHECKS_WINDOW_MS = 10 * 60 * 1000;

/**
 * Follows and judges the repo's PRs: each open PR that changed this pass and
 * each PR already followed. A PR to the base branch is followed with its
 * issue once the forge says it closes an issue whose go has acted (by its own
 * link data, or, in a repo with a base branch set, by the PR's head branch
 * name when the forge links none: {@link Forge.linkedIssues}); an open, non-draft one with no cleared ticket behind it (linked to
 * no such issue, or to one whose go still waits for the owner) is followed
 * with none, and judged on the vision alone until a go on an issue it is
 * linked to acts. A followed PR's every new head is judged once its checks
 * have finished, and a PR merged or closed is no longer followed. Returns
 * whether every PR could be read.
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
  let ok = true;
  let judged = 0;
  // When the owner set, changed or unset the base branch, the PRs already open into the new one are picked up, once.
  const worked = entries.findLast((entry): entry is BaseBranchSeenEntry => entry.type === "base-branch-seen")?.branch ?? project.defaultBranch;
  if (worked !== project.baseBranch && entries.some((entry) => entry.type === "settings" && entry.baseBranch !== undefined)) {
    try {
      const open = await forge.openPullRequests();
      for (const pr of open) changed.add(pr.number);
      record({ type: "base-branch-seen", branch: project.baseBranch, picked: open.map((pr) => pr.number) });
      options.print(`${repo}: now working against ${project.baseBranch}; ${open.length === 0 ? "no open pull request into it" : `reading the open pull requests into it: ${open.map((pr) => `#${pr.number}`).join(", ")}`}`);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      ok = false;
      const message = error instanceof Error ? error.message : String(error);
      options.log?.warn("pr-read-failed", { repo, baseBranch: project.baseBranch, error: message });
      context.failure = failureAt(options, `reading the pull requests into ${project.baseBranch}`, message, error instanceof RateLimitedError ? error.resetAt : undefined);
      options.print(`${repo}: entail could not read the pull requests into ${project.baseBranch}: ${message}; it tries again next pass`);
    }
  }
  const numbers = [...new Set([...followed.keys(), ...changed])].sort((a, b) => a - b);
  const latest = latestLandings(entries);
  for (const number of numbers) {
    options.signal?.throwIfAborted();
    const name = `${repo}#${number}`;
    try {
      const pr = await forge.pullRequest(number);
      const following = followed.get(number);
      // A PR followed into a branch that is no longer the base branch, as after the owner changed it, is followed no more.
      if (following !== undefined && pr.state === "open" && pr.baseBranch !== project.baseBranch) {
        record({ type: "unfollowed", pr: number, state: "open", base: pr.baseBranch });
        options.print(`${name}: the pull request merges into ${pr.baseBranch}, not the base branch ${project.baseBranch}; no longer following it`);
        continue;
      }
      let issue = following?.issue ?? null;
      let linkedNow = following?.linked ?? [];
      // A PR followed with no ticket is linked again when it changed, or when a go on an issue it was linked to has acted since.
      const cleared = (one: number) => clearedGoOn(entries, one, options.now?.() ?? new Date()) !== null;
      const relink = following !== undefined && following.issue === null && pr.state === "open" && (changed.has(number) || (following.linked ?? []).some(cleared));
      if (following === undefined || relink) {
        if (following === undefined && (pr.state !== "open" || pr.baseBranch !== project.baseBranch)) continue;
        const linked = await forge.linkedIssues(number);
        const closes = linked.find(cleared) ?? null;
        if (following === undefined) {
          if (closes === null && pr.draft) continue;
          record({ type: "followed", pr: pullRequestRef(pr), issue: closes, ...(closes === null ? { linked } : {}) });
          options.print(
            closes === null
              ? `${name}: following the pull request "${pr.title}", which has no cleared ticket behind it: it is judged on the vision alone`
              : `${name}: following the pull request "${pr.title}", which closes #${closes}`,
          );
        } else if (closes !== null) {
          record({ type: "followed", pr: pullRequestRef(pr), issue: closes });
          options.print(`${name}: the pull request now closes #${closes}, whose go has acted: it is judged against that go's criteria from now on`);
        } else if (!sameIssues(linked, following.linked ?? [])) {
          record({ type: "followed", pr: pullRequestRef(pr), issue: null, linked });
        }
        issue = closes;
        linkedNow = linked;
      }
      if (pr.state !== "open") {
        record({ type: "unfollowed", pr: number, state: pr.state });
        options.print(`${name}: the pull request is ${pr.state}; no longer following it`);
        continue;
      }
      if (pr.draft || pr.baseBranch !== project.baseBranch) continue;
      // A head is judged once on what is behind it: a PR whose go acted since it was judged with no ticket is judged again against the criteria.
      const last = latest.get(number);
      if (last?.head === pr.headSha && (last.issue?.number ?? null) === issue) continue;
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
      const go = issue === null ? null : goCallOn(entries, issue);
      if (issue !== null && go === null) {
        if (changed.has(number)) options.print(`${name}: #${issue} no longer has a go, so the pull request is not judged`);
        continue;
      }
      const entry = await judgePullRequest(context, pr, go, { checks: report.checks, required: report.required }, entries, go === null ? linkedNow.map((one) => ({ number: one, standing: linkedStanding(entries, one) })) : []);
      if ("skipped" in entry) {
        // Nothing is recorded, so the PR is read again next pass; the reason is said once, when the PR changed.
        if (changed.has(number)) {
          options.log?.info("landing-skipped", { repo, pr: number, head: pr.headSha, why: "no-vision" });
          options.print(`${name}: ${entry.skipped}`);
        }
        continue;
      }
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
      context.failure = failureAt(options, `reading PR #${number}`, message, error instanceof RateLimitedError ? error.resetAt : undefined);
      options.print(`${name}: entail could not read the pull request: ${message}; it tries again next pass`);
    }
  }
  return { ok, judged };
}

/** Where an issue a PR with no cleared ticket is linked to stands with entail, in a sentence for the landing judgment. */
function linkedStanding(entries: readonly Entry[], issue: number): string {
  const call = latestCalls(entries).get(issue);
  if (call === undefined) return "entail has made no call on it.";
  const effective = call.owner?.call ?? call.call.call;
  if (effective === "no") return `${call.owner === null ? "entail" : "the owner"} said no to it: ${call.call.reason}`;
  if (effective === "ask") return `entail's question on it waits for the owner's answer: ${call.call.call === "ask" ? call.call.question : call.call.reason}`;
  return "entail's go on it waits for the owner to confirm it.";
}

function sameIssues(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((one) => b.includes(one));
}

function pullRequestRef(pr: PullRequest): LandingEntry["pr"] {
  return { number: pr.number, title: pr.title, url: pr.url, author: pr.author.username };
}

/**
 * Makes the landing call on a PR's head, against the criteria of the go it
 * closes, or on the vision alone when `go` is null: no cleared ticket is
 * behind it. `failed` with the reason when the run gave none, or `waiting`
 * when CI has not reported at the head, or `skipped` with the reason when the
 * PR has no ticket and the repo no VISION.md: there is nothing to judge it
 * against, so it gets no model run and is left to the owner.
 */
async function judgePullRequest(
  context: JudgeContext,
  pr: PullRequest,
  go: CallEntry | null,
  checks: Pick<LandingEntry["facts"], "checks" | "required">,
  entries: readonly Entry[],
  linked: LinkedIssue[],
): Promise<NewEntry | { failed: string } | { waiting: string } | { skipped: string }> {
  const { options, state, forge } = context;
  const { repo } = state;
  const name = `${repo}#${pr.number}`;
  const files = await forge.pullRequestFiles(pr.number);
  const facts = { ...checks, files };
  const reading = await options.prReader(repo, forge, pr.number, pr.headSha);
  try {
    if (go === null && reading.vision === null) {
      return { skipped: `no cleared ticket is behind this pull request and ${repo} has no VISION.md on ${forge.baseBranch}, so there is nothing to judge it against; entail leaves it to the owner to merge` };
    }
    if (checks.checks.length === 0 && checks.required.length === 0) {
      const age = (options.now?.() ?? new Date()).getTime() - Date.parse(reading.committedAt);
      if (age < CHECKS_WINDOW_MS) return { waiting: `no checks have reported at ${pr.headSha.slice(0, 7)} yet, which was committed ${Math.max(0, Math.round(age / 60_000))} minutes ago` };
      if (reading.definesCI) return { waiting: `the repository defines CI but no check has reported at ${pr.headSha.slice(0, 7)}` };
    }
    const criteria = go === null || go.call.call === "no" ? [] : go.call.criteria;
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
        issue: go === null ? null : { number: go.issue.number, text: go.issueText },
        criteria,
        ...(go === null ? { linked } : {}),
        vision: reading.vision,
        pins: reading.pins,
        facts,
        diff: reading.diff,
        precedents: landingPrecedentsFor(await options.landingBook(), repo, go === null ? prText : go.issueText),
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
    // A PR with no ticket behind it has no ticket to cancel: it is sent back each time, never closed.
    const cancel = go !== null && call.call === "send-back" && sendBacks >= SEND_BACK_LIMIT;
    options.log?.info("landed-call", { repo, pr: pr.number, head: pr.headSha, call: call.call, cancel, model: judgment.facts.model, costUsd: judgment.facts.estimatedCostUsd });
    const behind = go === null ? "with no cleared ticket behind it, judged on the vision alone" : `closing #${go.issue.number}`;
    options.print(`${name} at ${pr.headSha.slice(0, 7)}, ${behind}: ${pr.title}\n${indent(formatLandingCall(call, go === null))}${cancel ? `\n    (sent back ${sendBacks} times before: this cancels it)` : ""}`);
    return {
      type: "landing",
      pr: pullRequestRef(pr),
      issue: go === null ? null : { number: go.issue.number, title: go.issue.title, url: go.issue.url },
      issueCall: go?.id ?? null,
      issueText: go?.issueText ?? "",
      prText,
      head: pr.headSha,
      base: reading.base,
      vision: reading.vision,
      ...(go === null && linked.length > 0 ? { linked } : {}),
      criteria,
      facts,
      touched: touched(files, reading.pins),
      call,
      sendBacks,
      cancel,
      confirm: state.confirm,
      model: judgment.facts.model,
      effort,
      promptVersion: landingPromptVersion(go === null ? null : go.issue),
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
  const post = pullRequestPostFor(pending, options.owner, forge.wording.pullRequest);
  const name = `${repo}#${post.pr}`;
  const sendBackCommand = options.settings.sendBack ?? null;
  const sendBackHandoff = sendBackCommand === null ? null : sendBackHandoffFor(repo, pending, post);
  const handoff = sendBackCommand !== null && sendBackHandoff !== null ? { handoff: { command: sendBackCommand, handoff: sendBackHandoff } } : {};
  const productQuestion = post.close && landing.call.productCall && landing.call.question !== null;
  if (options.dryRun) {
    const merge: MergeResult | null = post.merge ? { merged: true, sha: landing.head, commit: null } : null;
    const body = composeComment(options.owner, post.markerFor, post.text(merge));
    const what = [post.merge ? `merge at ${landing.head}` : "", post.close ? "close it unmerged" : "", productQuestion && landing.issue !== null ? `raise #${landing.issue.number}'s question to ${options.owner}` : ""].filter((part) => part !== "");
    options.print(`would post on ${name}${what.length > 0 ? `, then ${what.join(" and ")}` : ""}:\n${indent(body)}`);
    record({ type: "pr-acted", for: post.markerFor, pr: post.pr, comment: { id: 0, url: "(dry run)" }, merged: null, refused: null, sentBack: post.sentBack, closed: post.close, ...handoff });
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
    ...handoff,
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
 * merged counts as merged; a closed one, one whose head moved since, one that
 * no longer merges into the base branch (the owner changed it since, or the PR
 * was retargeted), or one whose CI is not green at that head is refused
 * without asking the forge. The
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
  if (live.state === "closed") return { merged: false, refusal: `the ${forge.wording.pullRequest} is closed` };
  if (live.headSha !== landing.head) return { merged: false, refusal: `its head moved to \`${live.headSha}\` since it was judged` };
  const { baseBranch } = await forge.project();
  if (live.baseBranch !== baseBranch) return { merged: false, refusal: `it merges into \`${live.baseBranch}\`, not the base branch \`${baseBranch}\`` };
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
 * The forges of a run, one per repo, each working against the base branch the
 * repo's log sets now: a repo's forge is made again when the owner changes its
 * base branch, so the next pass works against the new one.
 */
export function forgesByBaseBranch<F extends { readonly baseBranch: string | null }>(dataDirectory: string, make: (repo: string, baseBranch: string | null) => F): (repo: string) => F {
  const forges = new Map<string, F>();
  return (repo) => {
    const { baseBranch } = repoState(repo, readLog(dataDirectory, repo));
    let forge = forges.get(repo);
    if (forge === undefined || forge.baseBranch !== baseBranch) forges.set(repo, (forge = make(repo, baseBranch)));
    return forge;
  };
}

/**
 * Reads repos through their git mirrors in the data directory: the base
 * branch's head (the forge's default branch, or the base branch the owner set
 * for the repo), a read-only checkout of it, VISION.md there, and the owner's
 * pins. The previous checkout of a repo is removed when its head moves.
 */
export function mirrorReader(dataDirectory: string): RepoReader {
  return mirrorReaders(dataDirectory).reader;
}

/**
 * The readers of a run, sharing one mirror per repo: {@link mirrorReader}'s
 * for the call on an issue, and one for a PR's head, which fetches it, diffs it
 * against the base branch's head and checks it out until the judgment is
 * done, and one for a suggestion run. `remote` replaces where a repo's mirror
 * fetches from, as tests do with a local repository.
 */
export function mirrorReaders(
  dataDirectory: string,
  options: { remote?: (setting: WatchForge["setting"]) => MirrorRemote } = {},
): { reader: RepoReader; prReader: PullRequestReader; suggestReader: SuggestReader } {
  const mirrors = new Map<string, Promise<Mirror>>();
  const lastCommit = new Map<string, string>();
  /** The base branch commits a suggestion run is reading, with how many runs read each: their checkouts stay until released. */
  const held = new Map<string, number>();
  /** One base branch update at a time per repo, since a suggestion run reads beside the pass. */
  const updates = new Map<string, Promise<unknown>>();
  const updateBaseBranch = (repo: string, mirror: Mirror, forge: Pick<WatchForge, "baseBranch">) => {
    const update = (updates.get(repo) ?? Promise.resolve()).catch(() => {}).then(() => mirror.updateBranch(forge.baseBranch));
    updates.set(repo, update);
    return update;
  };
  const mirrorOf = (repo: string, forge: Pick<WatchForge, "project" | "setting">): Promise<Mirror> => {
    let opening = mirrors.get(repo);
    if (opening === undefined) {
      opening = forge.project().then((project) =>
        Mirror.open({
          dataDirectory,
          key: { forge: forge.setting.forge, host: forge.setting.host, projectId: project.id },
          remote: options.remote?.(forge.setting) ?? forgeRemote(forge.setting.forge, forge.setting.host, forge.setting.path),
        }),
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
    const head = await updateBaseBranch(repo, mirror, forge);
    const previous = lastCommit.get(repo);
    if (previous !== undefined && previous !== head.commit && !held.has(previous)) await mirror.removeCheckout(previous);
    const checkout = await mirror.checkout(head.commit);
    lastCommit.set(repo, head.commit);
    return {
      checkout: checkout.directory,
      sha: checkout.commit,
      vision: await visionAt(mirror, head.commit),
      pins: await readPins(dataDirectory, forge.setting),
    };
  };
  const prReader: PullRequestReader = async (repo, forge, pr, head) => {
    const mirror = await mirrorOf(repo, forge);
    const base = await updateBaseBranch(repo, mirror, forge);
    const fetched = await mirror.fetchPullRequestHead(pr, head);
    if (fetched.commit !== head) throw new Error(`the pull request's head moved to ${fetched.commit} while it was read`);
    const diff = await mirror.pullRequestDiff(base.commit, head);
    const checkout = await mirror.checkout(head);
    const committedAt = (await mirror.git.run(["show", "-s", "--format=%cI", head, "--"])).stdout.toString("utf8").trim();
    const ciPath = forge.setting.forge === "gitlab" ? ".gitlab-ci.yml" : ".github/workflows";
    const definesCI = (await mirror.git.run(["cat-file", "-e", `${head}:${ciPath}`], { okExitCodes: [1, 128] })).exitCode === 0;
    return {
      checkout: checkout.directory,
      head,
      base: base.commit,
      diff,
      committedAt,
      definesCI,
      vision: await visionAt(mirror, base.commit),
      pins: await readPins(dataDirectory, forge.setting),
      // The base branch's own checkout is the issue reader's to remove.
      release: async () => {
        if ([...lastCommit.values()].includes(head)) return;
        await mirror.removeCheckout(head);
      },
    };
  };
  const suggestReader: SuggestReader = async (repo, forge) => {
    const mirror = await mirrorOf(repo, forge);
    const head = await updateBaseBranch(repo, mirror, forge);
    held.set(head.commit, (held.get(head.commit) ?? 0) + 1);
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      const left = (held.get(head.commit) ?? 1) - 1;
      if (left > 0) held.set(head.commit, left);
      else held.delete(head.commit);
      // The issue reader's own checkout is its to remove.
      if (left <= 0 && ![...lastCommit.values()].includes(head.commit)) await mirror.removeCheckout(head.commit);
    };
    try {
      const checkout = await mirror.checkout(head.commit);
      const tree = (await mirror.git.run(["ls-tree", "-r", "--name-only", "-z", head.commit, "--"])).stdout.toString("utf8").split("\0").filter((path) => path !== "");
      const readmePath = tree.filter((path) => /^readme(\.[\w-]+)?$/iu.test(path)).sort((a, b) => Number(/\.md$/iu.test(b)) - Number(/\.md$/iu.test(a)))[0];
      const readme = readmePath === undefined ? null : { path: readmePath, text: (await mirror.git.run(["show", `${head.commit}:${readmePath}`, "--"])).stdout.toString("utf8") };
      return { checkout: checkout.directory, sha: checkout.commit, vision: await visionAt(mirror, head.commit), readme, tree, release };
    } catch (error) {
      await release();
      throw error;
    }
  };
  return { reader, prReader, suggestReader };
}
