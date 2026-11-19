import { randomInt } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ForgeFacts, LandingOwnerCall, OwnerCall } from "./case-book.ts";
import { scopeOf, type Criterion, type GoScope, type IssueCall } from "./judgment.ts";
import type { LandingCall } from "./landing.ts";
import type { GrowthDecision } from "./vision-growth.ts";
import type { AnswerParts } from "./parts.ts";
import { DEFAULT_EFFORT, EFFORTS, type Effort } from "./model-runner.ts";
import { forgeHost, isSelfHostedHost, repoOf, repoSetting } from "./repo-ref.ts";
import type { IssueRef } from "./forge/forge.ts";
import type { SendBackHandoff } from "./send-backs.ts";
import type { Handoff } from "./starts.ts";

/**
 * What entail decided and what the owner said back, one append-only log per
 * repo: `log/<host>/<owner>/<name>.jsonl` in the data directory (a GitLab
 * project's path keeps its subgroups as directories), one JSON
 * entry per line. Nothing is ever rewritten; everything the board and
 * `entail calls` show (whether a repo is enrolled, its settings, what waits
 * on the owner, what is still to post) is derived from the log.
 *
 * Every entry has an id, a random positive integer. An entry that entail
 * acts on the forge for carries its id in the hidden marker of the comment it
 * posts, so a restart finds the comment it already posted and never posts it
 * twice.
 */

export const LOG_DIRECTORY = "log";

interface EntryBase {
  id: number;
  /** ISO time. */
  at: string;
}

/** Who made an owner's entry: the owner's display name. */
interface ByOwner {
  by: string;
}

/** The repo was enrolled: entail judges issues filed or edited from `since` on. */
export interface EnrolledEntry extends EntryBase, ByOwner {
  type: "enrolled";
  /** ISO time: issues filed before it are judged only when edited or mentioned with `/entail`. */
  since: string;
  confirm: boolean;
}

export interface UnenrolledEntry extends EntryBase, ByOwner {
  type: "unenrolled";
}

/**
 * A change to the repo's settings. A model or effort of null means the default; a base branch of null, the forge's default branch.
 * `drift` turns the scheduled drift check on or off; `driftEveryDays` is how often it runs, null meaning the default.
 */
export interface SettingsEntry extends EntryBase, ByOwner {
  type: "settings";
  confirm?: boolean;
  model?: string | null;
  effort?: Effort | null;
  baseBranch?: string | null;
  /** A topic the owner pinned, or took out of the pins file, with this change. */
  pinned?: string;
  unpinned?: string;
  drift?: boolean;
  driftEveryDays?: number | null;
}

/**
 * What made entail judge an issue. `landing` is not a run: it is the
 * question a cancelled PR leaves for the owner when what blocked it was a
 * product call. `backlog` is the owner asking for the open backlog. `vision`
 * is a re-check after VISION.md changed that changed the call. `reopen` is
 * a judgment of an issue entail closed that someone other than the owner
 * reopened: the same intake call, on the issue as it stands. `owner-reopen`
 * is not a run: it is the question the owner's own reopen of an issue entail
 * closed leaves for them on the board.
 */
export type Trigger = "new" | "edit" | "mention" | "owner" | "landing" | "backlog" | "vision" | "reopen" | "owner-reopen";

/** A `/entail` comment, known by its id and the time it was last edited. */
export interface Mention {
  id: number;
  updatedAt: string;
  author: string;
  url: string;
}

/**
 * The owner's word a judgment was run again with: an override to go, or an
 * answer to a question. The call it leads to is the owner's, not entail's.
 */
export interface OwnerWord {
  /** The owner's entry this run answers. */
  action: number;
  kind: "override" | "answer";
  call: OwnerCall;
  /** Set when the owner's go clears the ticket for planning; missing means a go to implement. */
  scope?: "plan";
  words: string;
}

/** One call entail made on an issue, with everything it read to make it. */
export interface CallEntry extends EntryBase {
  type: "call";
  /** The issue; `createdAt` (ISO) is when it was filed, and is missing from calls logged before it was kept. */
  issue: { number: number; title: string; url: string; author: string; createdAt?: string };
  trigger: Trigger;
  /** The `/entail` comments this call answers. */
  mentions: Mention[];
  /** The issue's title and body as judged, hashed, so an edit is told from a comment. */
  content: string;
  /** The issue as the judgment read it. */
  issueText: string;
  vision: { commit: string; text: string } | null;
  /** The base branch's commit the repo was read at. */
  sha: string;
  call: IssueCall;
  /** Whether the repo was in confirm mode, so a go or no waits for the owner. */
  confirm: boolean;
  /** Set when the run was made on the owner's word; the posted call is then the owner's. */
  owner: OwnerWord | null;
  model: string;
  effort: Effort;
  promptVersion: string;
  costUsd: number | null;
  /** Set on a call a vision change moved: what it replaced and the vision passage that moved it. */
  recheck?: VisionRecheck;
}

/** What a call re-checked after VISION.md changed carries: the call it replaced and why. */
export interface VisionRecheck {
  /** The vision-seen entry whose change was re-checked. */
  vision: number;
  /** The call it replaced, and that call's kind as it stood (the owner's, when the owner made it). */
  previous: number;
  previousCall: OwnerCall | "ask";
  /** The vision lines the change removed and added, as they stood. */
  removed: string[];
  added: string[];
  /** The passage of the change that moved the call, quoted: one line, or every changed line when the judgment named none. */
  passage: string;
  /** Whether the passage is a line the change added or removed, when it is one line of it. */
  passageKind?: "added" | "removed";
  /** The open PRs for the issue that relied on the old text: each is told of the change on the forge. */
  pullRequests: PullRequestRef[];
}

/**
 * VISION.md on the base branch as a pass last saw it, recorded when it
 * changed from what entail saw before. `from` is the commit of the vision it
 * replaced. The open issues entail called against the earlier text are
 * re-checked once per change.
 */
export interface VisionSeenEntry extends EntryBase {
  type: "vision-seen";
  commit: string | null;
  text: string | null;
  from: string | null;
}

/**
 * One open issue re-checked after a vision change where nothing was posted:
 * the call held (`held`, with the call the judgment made), the issue was
 * closed (`closed`), or the judgment gave no call (`failed`, tried again up
 * to {@link JUDGMENT_ATTEMPTS} times). A call the change moved is a call
 * entry with `recheck` instead.
 */
export interface RecheckedEntry extends EntryBase {
  type: "rechecked";
  /** The vision-seen entry whose change was re-checked. */
  vision: number;
  issue: number;
  /** The call that was re-checked. */
  call: number;
  outcome: "held" | "closed" | "failed";
  /** For held: the call the judgment made under the new vision, with its reason. */
  judged?: IssueCall;
  /** For failed: why the judgment gave no call. */
  reason?: string;
  model?: string;
  effort?: Effort;
  promptVersion?: string;
  costUsd?: number | null;
}

/**
 * entail held an issue back with no call: an issue it names as a blocker, in
 * its text or by the forge's links, is still open. Nothing is judged and no
 * work starts on it until none is; the issue's latest hold stands until a
 * call on it or an `unblocked` entry. entail posts one comment and the
 * `entail:blocked` label for each hold.
 */
export interface BlockedEntry extends EntryBase {
  type: "blocked";
  issue: { number: number; title: string; url: string; author: string; createdAt: string };
  /** What made entail weigh the issue: the trigger its call carries once no blocker is open. */
  trigger: Trigger;
  /** The `/entail` comments the hold answers, carried to the call made once no blocker is open. */
  mentions: Mention[];
  /** The issue's title and body as read, hashed as a call's are. */
  content: string;
  /** The open blockers, as `owner/name` and number. */
  blockers: IssueRef[];
  /** Whether the forge's own blocking links were read; false when only the issue's text counted. */
  forgeLinks: boolean;
}

/**
 * A held issue was closed before any of its blockers was cleared: it is no
 * longer held. Or (`reopen-closed`) an issue reopened after entail closed it was
 * closed again before any call answered the reopen: nothing is left to answer.
 */
export interface UnblockedEntry extends EntryBase {
  type: "unblocked";
  issue: number;
  why: "closed" | "reopen-closed";
}

/** A PR as the log names it. */
export interface PullRequestRef {
  number: number;
  title: string;
  url: string;
  author: string;
}

/**
 * entail follows a PR: the forge says it closes an issue whose go has acted,
 * or, with `issue` null, no cleared ticket is behind it and it is judged on
 * the vision alone. A PR followed with no ticket is followed again with its
 * issue once a go on an issue it is linked to acts.
 */
export interface FollowedEntry extends EntryBase {
  type: "followed";
  pr: PullRequestRef;
  issue: number | null;
  /**
   * With no issue: the issues the forge linked the PR to when it was followed,
   * none of them with a go that acted. A go acting on one of them has the PR
   * followed again with that issue. Missing on entries logged before it was kept.
   */
  linked?: number[];
}

/** entail stopped following a PR: it was merged or closed, by entail or anyone else. */
/**
 * entail stopped following a PR: it was merged or closed, or, still open, it
 * no longer merges into the repo's base branch (the owner changed the base
 * branch, or the PR was retargeted), and `base` is the branch it merges into.
 */
export interface UnfollowedEntry extends EntryBase {
  type: "unfollowed";
  pr: number;
  state: "merged" | "closed" | "open";
  base?: string;
}

/**
 * A pass started working against a base branch other than the one it worked
 * against before: the owner set, changed or unset the repo's base branch.
 * `picked` are the open PRs into it that the pass read, to pick them up.
 */
export interface BaseBranchSeenEntry extends EntryBase {
  type: "base-branch-seen";
  branch: string;
  picked: number[];
}

/** A landing judgment on a PR's head gave no call: counted, so a head is judged at most {@link JUDGMENT_ATTEMPTS} times. */
export interface LandingFailedEntry extends EntryBase {
  type: "landing-failed";
  pr: number;
  head: string;
  reason: string;
}

/** How many times a PR's head is judged when the judgment gives no call, before landing stalls on it until a new head arrives. */
export const JUDGMENT_ATTEMPTS = 3;

/** One landing call: the call on a PR at one head, with everything it read to make it. */
export interface LandingEntry extends EntryBase {
  type: "landing";
  pr: PullRequestRef;
  /** The issue the PR closes, whose go it was judged against; null when no cleared ticket is behind it and it was judged on the vision alone. */
  issue: { number: number; title: string; url: string } | null;
  /** The call on the issue whose criteria the PR was judged against; null with no issue. */
  issueCall: number | null;
  /** The issue as judged; empty with no issue. */
  issueText: string;
  /** The PR's title and description as judged: its author's words. */
  prText: string;
  /** The PR's head commit judged; a merge happens at it and nowhere else. */
  head: string;
  /** The base branch's commit the diff was taken against. */
  base: string;
  vision: { commit: string; text: string } | null;
  /** With no issue: the issues the forge linked the PR to, and where each stood, as the judgment read them. */
  linked?: { number: number; standing: string }[];
  /** The criteria the issue's go set, which the PR was judged against; none with no issue. */
  criteria: Criterion[];
  /** CI and the changed files, read from the forge at the head. */
  facts: ForgeFacts;
  /** What the changed files touch that only the owner can let merge. */
  touched: { vision: boolean; pins: string[] };
  call: LandingCall;
  /** How many send-backs entail had posted on the PR before this call. */
  sendBacks: number;
  /** A send-back past the limit: the PR is closed with the reason instead. Never set on a PR with no issue, which has no ticket to cancel. */
  cancel: boolean;
  confirm: boolean;
  model: string;
  effort: Effort;
  promptVersion: string;
  costUsd: number | null;
}

/** entail acted on a PR for a landing call or an owner's action on one: commented, and merged or closed if it was to. */
export interface PrActedEntry extends EntryBase {
  type: "pr-acted";
  for: number;
  pr: number;
  comment: { id: number; url: string };
  /** The merge made at the judged head, when one was. */
  merged: { sha: string; commit: string | null } | null;
  /** Why a merge that was called for did not happen. */
  refused: string | null;
  /** Whether this post sent the PR back. */
  sentBack: boolean;
  /** Whether the PR was closed unmerged: cancelled. */
  closed: boolean;
  /** Set when this act sent the PR back or cancelled it and a send-back command was set: the handoff to run once (see `src/send-backs.ts`). */
  handoff?: { command: string; handoff: SendBackHandoff };
}

/**
 * entail is about to run the send-back command for a PR it sent back or
 * cancelled. Written before the command runs, so a restart that finds it with
 * no `handed-back` entry knows the command may already have taken effect and
 * does not run it again.
 */
export interface HandingBackEntry extends EntryBase {
  type: "handing-back";
  /** The `pr-acted` entry whose handoff this is. */
  for: number;
  pr: number;
  command: string;
}

/** entail ran the send-back command for a PR it sent back or cancelled: by which command, and how it exited. */
export interface HandedBackEntry extends EntryBase {
  type: "handed-back";
  /** The `pr-acted` entry whose handoff this ran. */
  for: number;
  pr: number;
  command: string;
  exit: number | null;
  error?: string;
  /** Set when entail stopped while the command ran, so how it ended is unknown; it was not run again. */
  interrupted?: true;
}

/**
 * What every owner's action carries besides its words. An action taken on
 * the board is held for a short window (`holdUntil`, ISO) in which the owner
 * can undo it; entail acts on the forge for it only once the window has closed.
 * An action with no `holdUntil` is acted on at the next pass.
 */
interface Held {
  holdUntil?: string;
}

/** The owner confirmed a call as it stands. */
export interface ConfirmedEntry extends EntryBase, ByOwner, Held {
  type: "confirmed";
  call: number;
}

/**
 * The owner replaced a call with their own, with their reason. With
 * `differently`, the owner kept entail's go but not its criteria: the reason
 * is the owner's line, recorded word for word as the one criterion the PR
 * must meet, and entail does not derive criteria from it.
 */
export interface OverriddenEntry extends EntryBase, ByOwner, Held {
  type: "overridden";
  call: number;
  /** go or no on an issue's call; merge or send-back on a PR's. */
  to: OwnerCall | LandingOwnerCall;
  /** Set when the owner's go clears the ticket for planning; missing means a go to implement. */
  scope?: "plan";
  reason: string;
  differently?: true;
}

/** The owner answered a call's question, and made the call with it. */
export interface AnsweredEntry extends EntryBase, ByOwner, Held {
  type: "answered";
  call: number;
  /** go or no on an issue's call; merge or send-back on a PR's. */
  to: OwnerCall | LandingOwnerCall;
  /** Set when the owner's go clears the ticket for planning; missing means a go to implement. */
  scope?: "plan";
  answer: string;
  /**
   * Set when the owner took only some of the parts of an issue that bundles several: the call is no on the
   * issue itself, which closes once one new issue is filed for each part accepted.
   */
  parts?: AnswerParts;
}

/** The owner undid one of their actions while it was held: entail acts on it neither on the forge nor in the case book. */
export interface UndoneEntry extends EntryBase, ByOwner {
  type: "undone";
  action: number;
}

/** The owner asked entail to judge the issues that were open when the repo was enrolled. */
export interface BacklogEntry extends EntryBase, ByOwner {
  type: "backlog";
  issues: number[];
}

/**
 * Someone reopened on the forge an issue entail had closed. The forge says
 * who: `by` is that account, and `owner` whether it is the account the owner's
 * CLI is logged in as. A reopen is the owner's word only when the forge says
 * the owner did it; when the forge names no one, or an entry was logged before
 * `by` was kept, it is nobody's word.
 */
export interface ReopenedEntry extends EntryBase {
  type: "reopened";
  issue: number;
  /** The acted entry whose close was undone on the forge. */
  after: number;
  by?: { username: string; owner: boolean } | null;
}

/**
 * The reopens of an issue entail closed that no call answers yet, by issue:
 * each issue's latest `reopened` entry with nothing after it on the issue that
 * answers it: a call, an act of entail's, or the owner's own word on a call.
 */
export function pendingReopens(entries: readonly Entry[]): Map<number, ReopenedEntry> {
  const pending = new Map<number, ReopenedEntry>();
  const issueOfCall = new Map<number, number>();
  for (const entry of entries) {
    if (entry.type === "reopened") pending.set(entry.issue, entry);
    else if (entry.type === "call") {
      issueOfCall.set(entry.id, entry.issue.number);
      pending.delete(entry.issue.number);
    } else if (entry.type === "acted") pending.delete(entry.issue);
    else if (entry.type === "unblocked") pending.delete(entry.issue);
    else if (entry.type === "confirmed" || entry.type === "overridden" || entry.type === "answered") {
      const issue = issueOfCall.get(entry.call);
      if (issue !== undefined) pending.delete(issue);
    }
  }
  return pending;
}

/** entail acted on the forge for an entry: its comment posted, and the issue closed if it was to be. */
export interface ActedEntry extends EntryBase {
  type: "acted";
  for: number;
  issue: number;
  comment: { id: number; url: string };
  closed: boolean;
  /** What came of the `entail:` label this act puts on the issue; missing when it puts none, as for a call that waits to be confirmed. */
  label?: LabelChange;
  /** Set when this act is a go acting and a start command was set: the work to start, run once (see `src/starts.ts`). */
  start?: { command: string; handoff: Handoff };
  /** For a call a vision change moved: the comment posted on each open PR that relied on the old text. */
  flagged?: { pr: number; comment: { id: number; url: string } }[];
  /** For a partial answer: the issue filed for each part accepted, by the part's position among the accepted, and whether it was found already filed. */
  filed?: { index: number; number: number; url: string; already: boolean }[];
}

/**
 * The `entail:` label an act put on an issue: the label, and the other
 * `entail:` labels it took off so the issue carries one at a time. When the
 * label could not be put on, `failed` says why; the act went ahead without it.
 */
export interface LabelChange {
  label: string;
  /** Whether the issue carried the label already, so nothing was added. */
  already: boolean;
  removed: string[];
  failed?: string;
}

/**
 * Why entail could not label the repo's issues, from the latest act that
 * labelled one, or null when that label went on (or none was tried yet).
 */
export function labelProblem(entries: readonly Entry[]): string | null {
  const last = entries.findLast((entry): entry is ActedEntry & { label: LabelChange } => entry.type === "acted" && entry.label !== undefined);
  return last?.label.failed ?? null;
}

/**
 * entail is about to run the start command for a go that acted. Written
 * before the command runs, so a restart that finds it with no `started` entry
 * knows the command may already have taken effect and does not run it again.
 */
export interface StartingEntry extends EntryBase {
  type: "starting";
  /** The acted entry whose start this is. */
  for: number;
  issue: number;
  command: string;
}

/** entail ran the start command for a go that acted: by which command, and how it exited. */
export interface StartedEntry extends EntryBase {
  type: "started";
  /** The acted entry whose start this was. */
  for: number;
  issue: number;
  command: string;
  /** The command's exit status; null when it did not exit on its own. */
  exit: number | null;
  error?: string;
  /** Set when entail stopped while the command ran, so how it ended is unknown; it was not run again. */
  interrupted?: true;
}

/** One piece of work a suggestion run found worth filing, as the issue it is filed as. */
export interface Suggestion {
  title: string;
  /** The issue's text, problem first and then what should change. */
  body: string;
  /** Whether it fits one PR, or is larger and goes through intake as an oversized ticket. */
  size: "one PR" | "larger than one PR";
  /** The vision lines it rests on, quoted; empty when it rests on the product alone. */
  visionLines: string[];
}

/** Something a suggestion run considered and did not suggest, with why. */
export interface LeftOut {
  item: string;
  reason: string;
}

/**
 * The owner asked entail to suggest work for the repo, and the run made
 * these suggestions. Each is filed as an issue labelled `entail:suggested`
 * whose body carries this entry's id and the suggestion's index in a hidden
 * marker, so a restart never files one twice.
 */
export interface SuggestedEntry extends EntryBase, ByOwner {
  type: "suggested";
  /** The base branch's commit the repo was read at. */
  sha: string;
  visionCommit: string | null;
  suggestions: Suggestion[];
  leftOut: LeftOut[];
  model: string;
  effort: Effort;
  promptVersion: string;
  costUsd: number | null;
}

/** One suggestion of a run filed as an issue: found already filed, or filed now. */
export interface SuggestionFiledEntry extends EntryBase {
  type: "suggestion-filed";
  /** The suggested entry. */
  for: number;
  /** The suggestion's index in it. */
  index: number;
  issue: { number: number; url: string };
  /** Whether the issue was found already filed, by its marker, rather than filed now. */
  already: boolean;
}

/** A suggestion run the owner asked for gave no suggestions: the model run failed. Nothing was filed. */
export interface SuggestFailedEntry extends EntryBase, ByOwner {
  type: "suggest-failed";
  model: string;
  effort: Effort;
  reason: string;
}

/**
 * What entail decided about one board answer for the vision: whether it
 * makes sense as a general statement, and if so the line and the section it
 * goes under. Recorded before anything is written, so a write that fails is
 * retried from this decision and the model is not run again.
 */
export interface VisionConsideredEntry extends EntryBase {
  type: "vision-considered";
  /** The answered entry this decision is about. */
  answer: number;
  decision: GrowthDecision;
  /** The commit of VISION.md the answer was weighed against; null when the repo had none. */
  visionCommit: string | null;
  model: string;
  effort: Effort;
  promptVersion: string;
  costUsd: number | null;
}

/**
 * entail added a line to VISION.md on the base branch because of a board
 * answer. This entry is where the line's origin is kept: added automatically,
 * from which answer, given by whom. VISION.md itself carries no mark.
 */
export interface VisionGrownEntry extends EntryBase {
  type: "vision-grown";
  /** The vision-considered entry that decided the line. */
  considered: number;
  /** The answered entry, and the call or landing entry it answered. */
  answer: number;
  on: number;
  /** Who gave the answer, as the board recorded them. */
  by: string;
  /** What the answer was given on: an issue, or a PR. */
  about: { kind: "issue" | "pr"; number: number; title: string; url: string };
  /** The line added, exactly as written into VISION.md. */
  line: string;
  /** The heading of the section it went under; null when it went at the end. */
  heading: string | null;
  reason: string;
  /** The commit that wrote it, on the base branch. */
  commit: string;
  branch: string;
}

/** Merged work that drifts from the vision: the finding as a drift check made it, before it is filed. */
export interface DriftFinding {
  title: string;
  body: string;
  /** The vision line the work drifts from, quoted exactly as the vision has it. */
  visionLine: string;
  /** The commits of the merged work the finding is about, as full or abbreviated shas. */
  commits: string[];
}

/**
 * A drift check of merged work against the vision ran, or was skipped with
 * `skipped` saying why (nothing merged since the last check; no VISION.md).
 * Each finding is filed as an issue labelled `entail:drift` whose body carries
 * this entry's id and the finding's index in a hidden marker, so a restart
 * never files one twice.
 */
export interface DriftCheckedEntry extends EntryBase {
  type: "drift-checked";
  /** What started the check: the schedule, or the owner running `entail drift`. */
  trigger: "schedule" | "owner";
  /** The base branch's commit the check read (null when the check was skipped for want of a VISION.md, so it did not check any work), and the one the previous check read (the work merged between them was checked). */
  sha: string | null;
  since: string | null;
  /** How many commits had merged between them. */
  commits: number;
  visionCommit: string | null;
  findings: DriftFinding[];
  leftOut: LeftOut[];
  /** Why no model run was made, or null when one was. */
  skipped: string | null;
  model: string | null;
  effort: Effort | null;
  promptVersion: string | null;
  costUsd: number | null;
}

/** One finding of a drift check filed as an issue: found already filed, by its marker, or filed now. */
export interface DriftFiledEntry extends EntryBase {
  type: "drift-filed";
  /** The drift-checked entry. */
  for: number;
  /** The finding's index in it. */
  index: number;
  issue: { number: number; url: string };
  already: boolean;
}

/** A drift check gave no answer: the model run failed, or the repo could not be read. Nothing was filed; the schedule tries again sooner than usual. */
export interface DriftFailedEntry extends EntryBase {
  type: "drift-failed";
  trigger: "schedule" | "owner";
  reason: string;
}

export type OwnerAction = ConfirmedEntry | OverriddenEntry | AnsweredEntry;

export type Entry =
  | EnrolledEntry
  | UnenrolledEntry
  | SettingsEntry
  | CallEntry
  | OwnerAction
  | ActedEntry
  | UndoneEntry
  | BacklogEntry
  | ReopenedEntry
  | FollowedEntry
  | UnfollowedEntry
  | LandingEntry
  | LandingFailedEntry
  | PrActedEntry
  | StartingEntry
  | StartedEntry
  | HandingBackEntry
  | HandedBackEntry
  | SuggestedEntry
  | SuggestionFiledEntry
  | SuggestFailedEntry
  | DriftCheckedEntry
  | DriftFiledEntry
  | DriftFailedEntry
  | BlockedEntry
  | UnblockedEntry
  | VisionSeenEntry
  | RecheckedEntry
  | VisionConsideredEntry
  | VisionGrownEntry
  | BaseBranchSeenEntry;

/** An entry as written, before it has an id and a time. */
export type NewEntry = Entry extends infer E ? (E extends Entry ? Omit<E, "id" | "at"> : never) : never;

/**
 * Where the logs of the repos on GitHub Enterprise Servers are kept, a
 * directory per host. No host name starts with `_`, so it cannot be one, and
 * a GHES host's logs are never taken for a self-hosted GitLab's.
 */
export const ENTERPRISE_LOG_DIRECTORY = "_github-enterprise";

/**
 * The log file of a repo, `owner/name`, `github://host/owner/name`,
 * `gitlab:group/name` or `gitlab://host/group/name`: under its host, which
 * keeps the forges and hosts apart. A GitHub Enterprise Server's host is
 * under {@link ENTERPRISE_LOG_DIRECTORY}; every other name is where it was.
 */
export function logFile(dataDirectory: string, repo: string): string {
  const { forge, host, path } = repoSetting(repo);
  const parts = path.split("/").map((part) => part.toLowerCase());
  const name = parts.pop()!;
  const under = forge === "github" && host !== forgeHost("github") ? [ENTERPRISE_LOG_DIRECTORY, host] : [host];
  return join(dataDirectory, LOG_DIRECTORY, ...under, ...parts, `${name}.jsonl`);
}

export { isRepo } from "./repo-ref.ts";

/** A fresh entry id: a random positive integer that fits a hidden marker. */
export function newEntryId(): number {
  return randomInt(1, 2 ** 47);
}

/**
 * Appends an entry to a repo's log and returns it as written. A line left
 * half-written by a crash is closed off first, so it never swallows the new
 * entry.
 */
export function appendEntry<E extends NewEntry>(dataDirectory: string, repo: string, entry: E, now: Date = new Date()): E & EntryBase {
  const file = logFile(dataDirectory, repo);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const written = { id: newEntryId(), at: now.toISOString(), ...entry };
  const prefix = endsWithNewline(file) ? "" : "\n";
  appendFileSync(file, `${prefix}${JSON.stringify(written)}\n`, { mode: 0o600 });
  return written;
}

function endsWithNewline(file: string): boolean {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return true;
  }
  if (size === 0) return true;
  const fd = openSync(file, "r");
  try {
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

/** Every entry in a repo's log, in the order written. Unreadable lines are skipped. */
export function readLog(dataDirectory: string, repo: string): Entry[] {
  let text: string;
  try {
    text = readFileSync(logFile(dataDirectory, repo), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: Entry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry = JSON.parse(line) as Entry;
      if (typeof entry === "object" && entry !== null && typeof entry.type === "string" && Number.isSafeInteger(entry.id)) entries.push(entry);
    } catch {
      // A line cut short by a crash: nothing was recorded by it.
    }
  }
  return entries;
}

/** Every repo that has a log, enrolled or not, as `owner/name`, `github://host/owner/name`, `gitlab:group/name` or `gitlab://host/group/name`. */
export function loggedRepos(dataDirectory: string): string[] {
  const log = join(dataDirectory, LOG_DIRECTORY);
  const github = join(log, forgeHost("github"));
  const repos: string[] = [];
  for (const owner of safeReaddir(github)) {
    for (const file of safeReaddir(join(github, owner))) {
      if (file.endsWith(".jsonl")) repos.push(`${owner}/${file.slice(0, -".jsonl".length)}`);
    }
  }
  // A GitLab project sits as deep as its subgroups go, under gitlab.com or a self-hosted GitLab's host.
  const walk = (host: string, directory: string, path: string[]): void => {
    for (const entry of safeReaddir(directory)) {
      if (entry.endsWith(".jsonl")) {
        if (path.length > 0) repos.push(repoOf({ forge: "gitlab", host, path: [...path, entry.slice(0, -".jsonl".length)].join("/") }));
      } else walk(host, join(directory, entry), [...path, entry]);
    }
  };
  walk(forgeHost("gitlab"), join(log, forgeHost("gitlab")), []);
  for (const host of safeReaddir(log)) {
    if (isSelfHostedHost(host)) walk(host, join(log, host), []);
  }
  // A GitHub Enterprise Server's repos sit two deep under their host, as github.com's do.
  const enterprise = join(log, ENTERPRISE_LOG_DIRECTORY);
  for (const host of safeReaddir(enterprise)) {
    if (!isSelfHostedHost(host)) continue;
    for (const owner of safeReaddir(join(enterprise, host))) {
      for (const file of safeReaddir(join(enterprise, host, owner))) {
        if (file.endsWith(".jsonl")) repos.push(repoOf({ forge: "github", host, path: `${owner}/${file.slice(0, -".jsonl".length)}` }));
      }
    }
  }
  return repos.sort();
}

function safeReaddir(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

// Settings for every repo.

export const SETTINGS_FILE = "settings.json";

/** Settings for every repo: the owner's name on comments, the model and effort a repo uses unless it names its own, where notices go, and where the records are backed up. */
export interface GlobalSettings {
  /** The owner's display name, as comments name them; the username the forge CLI is logged in as when unset. */
  owner: string | null;
  model: string;
  effort: Effort;
  /**
   * The command entail runs when something starts waiting on the owner, with
   * one line and a link and never the question; null sends no notice. See
   * `src/notices.ts`.
   */
  notice?: string | null;
  /**
   * The command entail runs when a go acts, with the handoff as JSON on its
   * standard input; null starts nothing. See `src/starts.ts`.
   */
  start?: string | null;
  /**
   * The command entail runs when it sends a PR back or cancels it, with the
   * handoff as JSON on its standard input; null runs nothing. See
   * `src/send-backs.ts`.
   */
  sendBack?: string | null;
  /**
   * The git remote entail backs its records up to after each pass; null backs
   * nothing up. See `src/backup.ts`.
   */
  backup?: string | null;
}

export function readSettings(dataDirectory: string, defaults: { model: string }): GlobalSettings {
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(readFileSync(join(dataDirectory, SETTINGS_FILE), "utf8"));
    if (typeof value === "object" && value !== null && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    // No settings yet: the defaults.
  }
  return {
    owner: typeof parsed.owner === "string" && parsed.owner.trim() !== "" ? parsed.owner : null,
    model: typeof parsed.model === "string" && parsed.model !== "" ? parsed.model : defaults.model,
    effort: (EFFORTS as readonly unknown[]).includes(parsed.effort) ? (parsed.effort as Effort) : DEFAULT_EFFORT,
    notice: typeof parsed.notice === "string" && parsed.notice.trim() !== "" ? parsed.notice : null,
    start: typeof parsed.start === "string" && parsed.start.trim() !== "" ? parsed.start : null,
    sendBack: typeof parsed.sendBack === "string" && parsed.sendBack.trim() !== "" ? parsed.sendBack : null,
    backup: typeof parsed.backup === "string" && parsed.backup.trim() !== "" ? parsed.backup : null,
  };
}

export function writeSettings(dataDirectory: string, settings: GlobalSettings): void {
  const path = join(dataDirectory, SETTINGS_FILE);
  const staging = `${path}.new-${process.pid}`;
  writeFileSync(staging, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(staging, path);
}

// What the log says now.

/** A repo as its log leaves it. */
export interface RepoState {
  repo: string;
  enrolled: boolean;
  /** ISO time issues are judged from; null when never enrolled. */
  since: string | null;
  confirm: boolean;
  /** The repo's own model and effort, or null for the default. */
  model: string | null;
  effort: Effort | null;
  /**
   * The branch entail works against in place of the forge's default branch,
   * or null for the forge's default: what it reads, which PRs it follows, what
   * it diffs against and where it merges.
   */
  baseBranch: string | null;
  /** Whether merged work is checked against the vision on a schedule. Off until the owner turns it on. */
  drift: boolean;
  /** How often that check runs, in days, or null for the default. */
  driftEveryDays: number | null;
  /** The VISION.md a pass last recorded seeing change, or null when none was recorded. */
  vision: { entry: number; commit: string | null; text: string | null } | null;
}

export function repoState(repo: string, entries: readonly Entry[]): RepoState {
  const state: RepoState = { repo, enrolled: false, since: null, confirm: true, model: null, effort: null, baseBranch: null, drift: false, driftEveryDays: null, vision: null };
  for (const entry of entries) {
    if (entry.type === "enrolled") {
      state.enrolled = true;
      state.since = entry.since;
      state.confirm = entry.confirm;
    } else if (entry.type === "unenrolled") {
      state.enrolled = false;
    } else if (entry.type === "settings") {
      if (entry.confirm !== undefined) state.confirm = entry.confirm;
      if (entry.model !== undefined) state.model = entry.model;
      if (entry.effort !== undefined) state.effort = entry.effort;
      if (entry.baseBranch !== undefined) state.baseBranch = entry.baseBranch;
      if (entry.drift !== undefined) state.drift = entry.drift;
      if (entry.driftEveryDays !== undefined) state.driftEveryDays = entry.driftEveryDays;
    } else if (entry.type === "vision-seen") {
      state.vision = { entry: entry.id, commit: entry.commit, text: entry.text };
    }
  }
  return state;
}

/** Where a call stands with the owner. */
export type CallStatus =
  /** A question, or a go or no in confirm mode, waiting on the owner. */
  | { status: "waiting" }
  /** A go or no made with confirm mode off: entail acted on it at once. */
  | { status: "auto" }
  /** The owner confirmed it, overrode it or answered its question. */
  | { status: "confirmed" | "overridden" | "answered"; action: OwnerAction }
  /** A call run on the owner's word: the owner's call. */
  | { status: "owner" }
  /** The issue, or the PR, was judged again before the owner settled this call. */
  | { status: "superseded"; by: number }
  /** A PR's call: the PR was merged or closed before the owner settled it. */
  | { status: "closed" };

export function isOwnerAction(entry: Entry): entry is OwnerAction {
  return entry.type === "confirmed" || entry.type === "overridden" || entry.type === "answered";
}

/** The owner's actions that were undone. */
export function undoneActions(entries: readonly Entry[]): Set<number> {
  const undone = new Set<number>();
  for (const entry of entries) if (entry.type === "undone") undone.add(entry.action);
  return undone;
}

/** Whether an action is still in its window, where the owner can undo it and entail does not act on it. */
export function isHeld(action: OwnerAction, now: Date): boolean {
  return action.holdUntil !== undefined && Date.parse(action.holdUntil) > now.getTime();
}

/** The owner's action that stands on each call: the first one not undone. */
export function standingActions(entries: readonly Entry[]): Map<number, OwnerAction> {
  const undone = undoneActions(entries);
  const actions = new Map<number, OwnerAction>();
  for (const entry of entries) {
    if (isOwnerAction(entry) && !undone.has(entry.id) && !actions.has(entry.call)) actions.set(entry.call, entry);
  }
  return actions;
}

/** Each call in a log with where it stands, oldest first. */
export function callStatuses(entries: readonly Entry[]): Map<number, CallStatus> {
  const actions = standingActions(entries);
  const latestByIssue = new Map<number, number>();
  for (const entry of entries) {
    if (entry.type === "call") latestByIssue.set(entry.issue.number, entry.id);
  }
  const statuses = new Map<number, CallStatus>();
  for (const entry of entries) {
    if (entry.type !== "call") continue;
    const action = actions.get(entry.id);
    const latest = latestByIssue.get(entry.issue.number)!;
    if (action) statuses.set(entry.id, { status: action.type, action });
    else if (entry.owner !== null) statuses.set(entry.id, { status: "owner" });
    else if (latest !== entry.id) statuses.set(entry.id, { status: "superseded", by: latest });
    else if (entry.call.call === "ask" || entry.confirm) statuses.set(entry.id, { status: "waiting" });
    else statuses.set(entry.id, { status: "auto" });
  }
  return statuses;
}

/** The latest call on each issue. */
export function latestCalls(entries: readonly Entry[]): Map<number, CallEntry> {
  const latest = new Map<number, CallEntry>();
  for (const entry of entries) if (entry.type === "call") latest.set(entry.issue.number, entry);
  return latest;
}

/** The `/entail` comments already judged, by comment id and edit time. */
export function judgedMentions(entries: readonly Entry[]): Set<string> {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.type === "call" || entry.type === "blocked") for (const mention of entry.mentions) seen.add(mentionKey(mention));
  }
  return seen;
}

export function mentionKey(mention: Pick<Mention, "id" | "updatedAt">): string {
  return `${mention.id}@${Date.parse(mention.updatedAt)}`;
}

/**
 * The issues entail holds back now, each with its latest hold: a hold with no
 * call on the issue after it and not ended by an `unblocked` entry.
 */
export function heldIssues(entries: readonly Entry[]): Map<number, BlockedEntry> {
  const held = new Map<number, BlockedEntry>();
  for (const entry of entries) {
    if (entry.type === "blocked") held.set(entry.issue.number, entry);
    else if (entry.type === "call") held.delete(entry.issue.number);
    else if (entry.type === "unblocked") held.delete(entry.issue);
  }
  return held;
}

/** An entry entail still has to act on the forge for, in log order. */
export type Pending =
  | { kind: "call"; entry: CallEntry }
  /** A hold: posted as a note that the issue waits on its blockers, with the `entail:blocked` label. */
  | { kind: "blocked"; entry: BlockedEntry }
  | { kind: "confirmed"; action: ConfirmedEntry; call: CallEntry }
  /** An override to no or a no answer: closed with the owner's words. */
  | { kind: "owner-no"; action: OverriddenEntry | AnsweredEntry; call: CallEntry }
  /** A go, but differently: posted with the owner's line as its criterion, with no judgment run again. */
  | { kind: "owner-go"; action: OverriddenEntry; call: CallEntry }
  /** An override to go or a go answer, waiting for the judgment to run again on the owner's word. */
  | { kind: "rerun"; action: OverriddenEntry | AnsweredEntry; call: CallEntry };

/**
 * What entail has yet to do on the forge, in log order: calls to post (only an
 * issue's latest call; one judged again before it was posted is not posted),
 * the standing hold on each blocked issue to post,
 * confirmations to post, owner's calls of no to post and close, owner's goes
 * made differently to post, and owner's calls of go whose judgment has to run
 * again on the owner's word. An owner's action still in its undo window, or
 * undone, is not work yet.
 */
export function pendingWork(entries: readonly Entry[], now: Date = new Date()): Pending[] {
  const undone = undoneActions(entries);
  const acted = new Set<number>();
  const rerunFor = new Set<number>();
  const calls = new Map<number, CallEntry>();
  for (const entry of entries) {
    if (entry.type === "acted") acted.add(entry.for);
    if (entry.type === "call") {
      calls.set(entry.id, entry);
      if (entry.owner !== null) rerunFor.add(entry.owner.action);
    }
  }
  const latest = latestCalls(entries);
  const held = heldIssues(entries);
  const pending: Pending[] = [];
  for (const entry of entries) {
    if (acted.has(entry.id)) continue;
    if (entry.type === "blocked") {
      // Only the standing hold is posted: one a call or a newer hold replaced has nothing left to say.
      if (held.get(entry.issue.number)?.id === entry.id) pending.push({ kind: "blocked", entry });
      continue;
    }
    if (entry.type === "call") {
      if (latest.get(entry.issue.number)?.id === entry.id) pending.push({ kind: "call", entry });
      continue;
    }
    if (!isOwnerAction(entry) || undone.has(entry.id) || isHeld(entry, now)) continue;
    const call = calls.get(entry.call);
    if (call === undefined) continue;
    if (entry.type === "confirmed") pending.push({ kind: "confirmed", action: entry, call });
    else if (entry.to === "no") pending.push({ kind: "owner-no", action: entry, call });
    else if (entry.type === "overridden" && entry.differently === true) pending.push({ kind: "owner-go", action: entry, call });
    else if (!rerunFor.has(entry.id)) pending.push({ kind: "rerun", action: entry, call });
  }
  return pending;
}

/** One board answer the vision has yet to weigh, or a line decided and not yet written. */
export type GrowthWork =
  | { kind: "consider"; answer: AnsweredEntry; target: CallEntry | LandingEntry }
  | { kind: "write"; considered: VisionConsideredEntry & { decision: { add: true } }; answer: AnsweredEntry; target: CallEntry | LandingEntry };

/**
 * Answers given on the board from this time on are weighed for the vision;
 * those given before it settled their tickets when the vision did not grow
 * from answers, and are never weighed.
 */
export const GROWTH_STARTS_AT = "2026-11-19T00:00:00.000Z";

/**
 * What the vision has yet to do with the board answers, in log order: each
 * answer past its undo window and not undone that was not weighed yet, and
 * each decided line not written yet.
 */
export function pendingGrowth(entries: readonly Entry[], now: Date = new Date()): GrowthWork[] {
  const undone = undoneActions(entries);
  const targets = new Map<number, CallEntry | LandingEntry>();
  const considered = new Map<number, VisionConsideredEntry>();
  const grown = new Set<number>();
  for (const entry of entries) {
    if (entry.type === "call" || entry.type === "landing") targets.set(entry.id, entry);
    else if (entry.type === "vision-considered") considered.set(entry.answer, entry);
    else if (entry.type === "vision-grown") grown.add(entry.considered);
  }
  const work: GrowthWork[] = [];
  for (const entry of entries) {
    if (entry.type !== "answered" || undone.has(entry.id) || isHeld(entry, now) || Date.parse(entry.at) < Date.parse(GROWTH_STARTS_AT)) continue;
    const target = targets.get(entry.call);
    if (target === undefined) continue;
    const decided = considered.get(entry.id);
    if (decided === undefined) work.push({ kind: "consider", answer: entry, target });
    else if (decided.decision.add && !grown.has(decided.id)) work.push({ kind: "write", considered: decided as VisionConsideredEntry & { decision: { add: true } }, answer: entry, target });
  }
  return work;
}

/** The lines entail added to the vision from board answers, oldest first. */
export function visionGrowth(entries: readonly Entry[]): VisionGrownEntry[] {
  return entries.filter((entry): entry is VisionGrownEntry => entry.type === "vision-grown");
}

/** The acted entries whose work is still to start, in log order: each with a start, no `starting` marker and no `started` entry. */
export function pendingStarts(entries: readonly Entry[]): (ActedEntry & { start: NonNullable<ActedEntry["start"]> })[] {
  const begun = new Set(entries.flatMap((entry) => (entry.type === "starting" || entry.type === "started" ? [entry.for] : [])));
  return entries.filter((entry): entry is ActedEntry & { start: NonNullable<ActedEntry["start"]> } => entry.type === "acted" && entry.start !== undefined && !begun.has(entry.id));
}

/** The starts that began and have no recorded outcome: entail stopped while the command ran. They are not run again. */
export function interruptedStarts(entries: readonly Entry[]): StartingEntry[] {
  const ended = new Set(entries.flatMap((entry) => (entry.type === "started" ? [entry.for] : [])));
  return entries.filter((entry): entry is StartingEntry => entry.type === "starting" && !ended.has(entry.for));
}

/** The `pr-acted` entries whose handoff is still to run, in log order: each with a handoff, no `handing-back` marker and no `handed-back` entry. */
export function pendingHandoffs(entries: readonly Entry[]): (PrActedEntry & { handoff: NonNullable<PrActedEntry["handoff"]> })[] {
  const begun = new Set(entries.flatMap((entry) => (entry.type === "handing-back" || entry.type === "handed-back" ? [entry.for] : [])));
  return entries.filter((entry): entry is PrActedEntry & { handoff: NonNullable<PrActedEntry["handoff"]> } => entry.type === "pr-acted" && entry.handoff !== undefined && !begun.has(entry.id));
}

/** The send-backs that began and have no recorded outcome: entail stopped while the command ran. They are not run again. */
export function interruptedHandoffs(entries: readonly Entry[]): HandingBackEntry[] {
  const ended = new Set(entries.flatMap((entry) => (entry.type === "handed-back" ? [entry.for] : [])));
  return entries.filter((entry): entry is HandingBackEntry => entry.type === "handing-back" && !ended.has(entry.for));
}

/** Whether work on an issue was started already: its start command exited 0 or was interrupted, or a start is still to run. */
export function workStarted(entries: readonly Entry[], issue: number): boolean {
  const started = new Map(entries.flatMap((entry) => (entry.type === "started" ? [[entry.for, entry] as const] : [])));
  return entries.some((entry) => entry.type === "acted" && entry.issue === issue && entry.start !== undefined && (started.has(entry.id) ? started.get(entry.id)!.exit === 0 || started.get(entry.id)!.interrupted === true : true));
}

/** The owner's actions still held, not undone and not yet acted on, with when their windows close. */
export function heldActions(entries: readonly Entry[], now: Date): OwnerAction[] {
  const undone = undoneActions(entries);
  return entries.filter((entry): entry is OwnerAction => isOwnerAction(entry) && !undone.has(entry.id) && isHeld(entry, now));
}

/**
 * What the go a call entry posts clears the ticket for: the owner's word
 * when the run was made on it (an override or answer to go stays implement
 * unless the owner picked plan), else entail's own go. Null when the entry
 * is not a go.
 */
export function goScope(entry: Pick<CallEntry, "call" | "owner">): GoScope | null {
  if (entry.owner !== null) return entry.owner.call === "go" ? (entry.owner.scope ?? "implement") : null;
  return entry.call.call === "go" ? scopeOf(entry.call) : null;
}

/** The criteria a call carries, none for a no. */
export function criteriaOf(call: IssueCall): Criterion[] {
  return call.call === "no" ? [] : call.criteria;
}

/**
 * The criterion every go carries as posted and handed off, after the model's:
 * link the PR so the forge records it as closing the issue. entail follows a
 * PR only through the forge's own link data, never the PR's claim. It is a
 * rendering rule, not stored in the log, and never given to the landing call.
 */
export function linkCriterion(issue: number, baseBranch: string | null = null): { criterion: string; source: "entail"; basis: string } {
  if (baseBranch !== null) {
    // The forge may not link a PR into a branch other than its default, so the head branch's name carries the issue.
    return {
      criterion: `Open the PR into \`${baseBranch}\` from a branch whose name carries this issue's number, such as \`${issue}-short-name\`, and link it to this issue, for example with \`Closes #${issue}\` in the PR description; a PR into \`${baseBranch}\` that is neither linked nor named for this issue is judged on the vision alone, without this issue's criteria.`,
      source: "entail",
      basis: `entail judges a PR against an issue's criteria only when the forge's own link data says it closes that issue or, as the forge may not link a PR into ${baseBranch}, its head branch's name names it.`,
    };
  }
  return {
    criterion: `Link the PR to this issue so GitHub lists it under the PR's Development section, for example with \`Closes #${issue}\` in the PR description; a PR that is not linked is judged on the vision alone, without this issue's criteria.`,
    source: "entail",
    basis: "entail judges a PR against an issue's criteria only when GitHub's own link data says it closes that issue.",
  };
}

// PRs.

/** After this many send-backs of one PR, the next call that would send it back cancels it. */
export const SEND_BACK_LIMIT = 3;

/** The PRs entail follows and has not stopped following, by number, with the issue each closes. */
export function followedPullRequests(entries: readonly Entry[]): Map<number, FollowedEntry> {
  const followed = new Map<number, FollowedEntry>();
  for (const entry of entries) {
    if (entry.type === "followed") followed.set(entry.pr.number, entry);
    if (entry.type === "unfollowed") followed.delete(entry.pr);
  }
  return followed;
}

/** A followed PR whose landing judgment gave no call {@link JUDGMENT_ATTEMPTS} times at its latest failed head, and has no call there. */
export interface StalledLanding {
  pr: number;
  head: string;
  attempts: number;
  /** Why the last attempt gave no call. */
  reason: string;
}

/** The PRs whose landing is stalled, derived from the log: a new push, judged, ends it. */
export function stalledLandings(entries: readonly Entry[]): StalledLanding[] {
  const followed = followedPullRequests(entries);
  const last = new Map<number, LandingFailedEntry>();
  for (const entry of entries) {
    if (entry.type === "landing-failed" && followed.has(entry.pr)) last.set(entry.pr, entry);
    if (entry.type === "landing") last.delete(entry.pr.number);
  }
  return [...last.values()]
    .map((failed) => ({ pr: failed.pr, head: failed.head, reason: failed.reason, attempts: entries.filter((entry) => entry.type === "landing-failed" && entry.pr === failed.pr && entry.head === failed.head).length }))
    .filter((stalled) => stalled.attempts >= JUDGMENT_ATTEMPTS)
    .sort((a, b) => a.pr - b.pr);
}

/** The latest landing call on each PR. */
export function latestLandings(entries: readonly Entry[]): Map<number, LandingEntry> {
  const latest = new Map<number, LandingEntry>();
  for (const entry of entries) if (entry.type === "landing") latest.set(entry.pr.number, entry);
  return latest;
}

/** How many send-backs entail has posted on a PR. */
export function sendBacksPosted(entries: readonly Entry[], pr: number): number {
  return entries.filter((entry) => entry.type === "pr-acted" && entry.pr === pr && entry.sentBack).length;
}

/**
 * The call on an issue a PR is judged against: its latest call, when that
 * call (or the owner's word it was run on) is go. Null when the issue has no
 * go, so a PR closing it is not entail's to land.
 */
export function goCallOn(entries: readonly Entry[], issue: number): CallEntry | null {
  const call = latestCalls(entries).get(issue);
  if (call === undefined) return null;
  const effective = call.owner?.call ?? call.call.call;
  return effective === "go" ? call : null;
}

/**
 * The go on an issue that has acted: {@link goCallOn}'s go, unless it still
 * waits for the owner to confirm it, or the owner's confirmation is still in
 * its undo window. Only a cleared go puts a PR's criteria behind it; a PR
 * linked to an issue whose go still waits is judged on the vision alone
 * until the go acts.
 */
export function clearedGoOn(entries: readonly Entry[], issue: number, now: Date = new Date()): CallEntry | null {
  const go = goCallOn(entries, issue);
  if (go === null) return null;
  const status = callStatuses(entries).get(go.id);
  if (status === undefined || status.status === "waiting") return null;
  return "action" in status && isHeld(status.action, now) ? null : go;
}

/** Each landing call in a log with where it stands with the owner, oldest first. */
export function landingStatuses(entries: readonly Entry[]): Map<number, CallStatus> {
  const actions = standingActions(entries);
  const latest = latestLandings(entries);
  const stopped = new Set<number>();
  for (const entry of entries) {
    if (entry.type === "unfollowed") stopped.add(entry.pr);
    if (entry.type === "followed") stopped.delete(entry.pr.number);
  }
  const statuses = new Map<number, CallStatus>();
  for (const entry of entries) {
    if (entry.type !== "landing") continue;
    const action = actions.get(entry.id);
    const newest = latest.get(entry.pr.number)!;
    if (action) statuses.set(entry.id, { status: action.type, action });
    else if (newest.id !== entry.id) statuses.set(entry.id, { status: "superseded", by: newest.id });
    else if (stopped.has(entry.pr.number)) statuses.set(entry.id, { status: "closed" });
    else if (entry.call.call === "ask" || entry.confirm) statuses.set(entry.id, { status: "waiting" });
    else statuses.set(entry.id, { status: "auto" });
  }
  return statuses;
}

/** A landing call or an owner's action on one that entail still has to act on the forge for. */
export type LandingPending =
  | { kind: "landing"; entry: LandingEntry }
  | { kind: "landing-confirmed"; action: ConfirmedEntry; landing: LandingEntry }
  | { kind: "landing-owner"; action: OverriddenEntry | AnsweredEntry; to: LandingOwnerCall; landing: LandingEntry };

/**
 * What entail has yet to do on PRs, in log order: each PR's latest landing
 * call to post (and act on, unless it waits for the owner), and each owner's
 * action on a PR's latest call. Nothing is done for a PR entail stopped
 * following, or for a call a newer one on the same PR replaced. An owner's
 * action still in its undo window, or undone, is not work yet.
 */
export function pendingLanding(entries: readonly Entry[], now: Date = new Date()): LandingPending[] {
  const undone = undoneActions(entries);
  const acted = new Set<number>();
  const landings = new Map<number, LandingEntry>();
  for (const entry of entries) {
    if (entry.type === "pr-acted") acted.add(entry.for);
    if (entry.type === "landing") landings.set(entry.id, entry);
  }
  const latest = latestLandings(entries);
  const followed = followedPullRequests(entries);
  const current = (landing: LandingEntry) => latest.get(landing.pr.number)?.id === landing.id && followed.has(landing.pr.number);
  const pending: LandingPending[] = [];
  for (const entry of entries) {
    if (acted.has(entry.id)) continue;
    if (entry.type === "landing") {
      if (current(entry)) pending.push({ kind: "landing", entry });
      continue;
    }
    if (!isOwnerAction(entry) || undone.has(entry.id) || isHeld(entry, now)) continue;
    const landing = landings.get(entry.call);
    if (landing === undefined || !current(landing)) continue;
    if (entry.type === "confirmed") pending.push({ kind: "landing-confirmed", action: entry, landing });
    else if (entry.to === "merge" || entry.to === "send-back") pending.push({ kind: "landing-owner", action: entry, to: entry.to, landing });
  }
  return pending;
}
