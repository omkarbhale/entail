/**
 * The shapes the board's API answers with, shared by the server and the
 * board. Plain types only, so the board can read them without anything from
 * Node.
 */

export type Call = "go" | "no" | "ask" | "merge" | "send-back";
/** An owner's call on an issue (go, no) or on a PR (merge, send-back). */
export type OwnerCallName = "go" | "no" | "merge" | "send-back";
export type EffortName = "low" | "medium" | "high" | "xhigh" | "max";
export type TriggerName = "new" | "edit" | "mention" | "owner" | "backlog" | "landing" | "opened" | "push";
export type CallStatusName = "waiting" | "auto" | "confirmed" | "overridden" | "answered" | "owner" | "superseded" | "closed";

export interface CriterionView {
  source: "vision" | "reading" | "edge" | "answer";
  criterion: string;
  basis: string;
}

export interface VisionLineView {
  text: string;
  /** VISION.md at the commit the call read, at the line when it was found. */
  url: string | null;
  /** The line's number in VISION.md, or null when the quote was not found there. */
  line: number | null;
}

export interface CaseRefView {
  slug: string;
  title: string;
  url: string | null;
}

/** An owner's action as recorded: a confirmation, an override or an answer. */
export interface ActionView {
  id: number;
  type: "confirmed" | "overridden" | "answered";
  at: string;
  by: string;
  call: number;
  to?: OwnerCallName;
  reason?: string;
  answer?: string;
  differently?: true;
  holdUntil?: string;
}

/** The owner's word a call was run again on. */
export interface OwnerWordView {
  action: number;
  kind: "override" | "answer";
  call: OwnerCallName;
  words: string;
}

/** One of a PR's criteria, marked met or unmet with the evidence relied on. */
export interface CriterionCheckView {
  criterion: string;
  met: boolean;
  evidence: string;
}

/** What a PR does beyond its criteria, sorted. */
export interface BeyondItemView {
  change: string;
  sort: "needed" | "harmless" | "unwanted";
  why: string;
}

/** A rule applied over the model's call, and why. */
export interface GuardView {
  rule: "ci" | "vision" | "pins";
  from: "merge";
  detail: string;
}

/** What entail read about a PR from the forge, never from its description. */
export interface ForgeFactsView {
  checks: { name: string; status: "pending" | "passed" | "failed"; reported: boolean; url: string | null }[];
  required: { name: string; reported: boolean }[];
  files: { path: string; status: string; previousPath: string | null; additions: number; deletions: number }[];
}

/** A PR's call as the board shows it, beside the shared fields of {@link CallView}. */
export interface PullRequestView {
  number: number;
  title: string;
  url: string;
  author: string;
  /** The head judged; a merge happens at it and nowhere else. */
  head: string;
  /** The default branch's commit the diff was taken against. */
  base: string;
  /** Whether it solves the issue's problem, and the evidence. */
  solves: { solved: boolean; evidence: string };
  /** Each criterion marked met or unmet, with the evidence relied on. */
  checklist: CriterionCheckView[];
  /** What it does beyond its criteria, each sorted needed, harmless or unwanted. */
  beyond: BeyondItemView[];
  /** For a send-back: what needs to change. */
  needsToChange: string[];
  /** For a send-back: whether what blocks it is a product question for the owner. */
  productCall: boolean;
  /** Set when a mechanical rule changed the model's call: CI not green, or VISION.md or a pinned path changed. */
  guard: GuardView | null;
  /** Read from the forge at the head, never from the PR's description. */
  facts: ForgeFactsView & { ciGreen: boolean; touched: { vision: boolean; pins: string[] } };
  /** Send-backs posted on the PR before this call. */
  sendBacks: number;
  /** Whether this call cancels the PR: closes it unmerged with the reason. */
  cancel: boolean;
  /** What entail did on the PR for this call or the owner's action on it, once it acted. */
  outcome: { merged: { sha: string; commit: string | null } | null; refused: string | null; closed: boolean } | null;
}

/**
 * A call as the board reads it: on an issue (go, no or ask) or, with `kind`
 * "pr", on a PR that closes an issue (merge, send-back or ask). A PR's call
 * names the issue it closes in `issue`, carries the criteria entail set for
 * that issue in `criteria`, and everything about the PR in `pr`.
 */
export interface CallView {
  id: number;
  /** "issue" for the call on an issue, "pr" for the landing call on a PR. */
  kind: "issue" | "pr";
  repo: string;
  issue: { number: number; title: string; url: string; author: string; createdAt?: string };
  /** The issue as the judgment read it: title, body and comments, as markdown. */
  issueText: string;
  /** The issue's own words, or for a PR the PR's description: as judged, without title or comments. */
  body: string;
  visionCommit: string | null;
  call: Call;
  reason: string;
  criteria: CriterionView[];
  /** For ask: the question and what makes it one. */
  question: { question: string; why: string; large: boolean } | null;
  restsOn: { visionLines: VisionLineView[]; cases: CaseRefView[] };
  judgedAt: string;
  trigger: TriggerName;
  owner: OwnerWordView | null;
  model: string;
  effort: EffortName;
  costUsd: number | null;
  confirmMode: boolean;
  status: CallStatusName;
  settledBy: ActionView | null;
  posted: { url: string; closed: boolean } | null;
  /** The issue was edited (or the PR pushed to) while an earlier call on it waited, and this call replaced that one. */
  rejudged: boolean;
  /** When the owner was first asked about this issue or PR: the first call of a run of calls replaced while they waited. */
  waitingSince: string;
  /** On a PR's call, everything about the PR; null on an issue's. */
  pr: PullRequestView | null;
}

/** An owner's action in its undo window: entail acts on it when `holdUntil` passes. */
export interface HeldView {
  item: CallView;
  action: ActionView;
  holdUntil: string;
}

export interface WaitingResponse {
  /** Questions first, then calls to confirm; oldest first within each. */
  items: CallView[];
  held: HeldView[];
  /** Calls entail acted on at once (confirm mode off) since the time asked about. */
  actedAlone: { count: number; repos: string[] };
}

export interface TrailStep {
  at: string;
  text: string;
  url?: string;
}

/** One call in the log, with everything that followed it. */
export interface LogRow {
  /** The local day it was judged on, `YYYY-MM-DD`. */
  day: string;
  call: CallView;
  /** The call entail ran again on the owner's go, carrying the criteria posted for it. */
  ownerCall: CallView | null;
  /** Reopened on GitHub after entail closed it. */
  reopened: boolean;
  trail: TrailStep[];
}

export type LogFilter = "all" | "waiting" | "overridden" | "questions" | "prs";

export interface LogPage {
  rows: LogRow[];
  /** The day to ask for next (`before=`), or null when this page reaches the first call. */
  next: string | null;
  /** How many calls each filter holds, over the whole log. */
  counts: Record<LogFilter, number>;
}

export interface RepoView {
  repo: string;
  enrolled: boolean;
  since: string | null;
  confirm: boolean;
  model: string | null;
  effort: EffortName | null;
  /** The model and effort its calls are made with now. */
  uses: { model: string; effort: EffortName };
  calls: number;
  waiting: number;
  /** Calls the owner confirmed or overrode, and how many of them they confirmed. */
  checked: number;
  agreed: number;
  /** Whether entail agrees often enough to suggest turning confirm mode off. */
  suggestConfirmOff: boolean;
  /** VISION.md as the latest call read it. */
  vision: { commit: string; url: string } | null;
  /** The owner's pins for the repo, read from their file. */
  pins: { file: string; topics: string[] };
  /** When the repo was last checked for changes, or null when not yet in this run. */
  checkedAt: string | null;
  /** Whether the owner already asked for the open backlog to be judged. */
  backlogAsked: boolean;
}

export interface SettingsView {
  owner: string | null;
  model: string;
  effort: EffortName;
  notice: string | null;
  /** The command run when a go acts, with the handoff on its standard input; set only from the command line. */
  start: string | null;
}

export interface StatusView {
  /** Whether the loop that watches and acts is running in this process. */
  watching: boolean;
  repos: number;
  checkedAt: string | null;
  checking: boolean;
  /** Where the board is served, for notices. */
  url: string | null;
}

export interface EnrollResponse {
  repo: RepoView;
  /** Issues open on GitHub when it was enrolled, which entail judges only when asked. */
  openIssues: number;
}

export interface CheckResponse {
  repo: string;
  at: string;
  judged: number;
  posted: number;
  failed: boolean;
}

/** What the board hears on `/api/events`. */
export type BoardEvent =
  | { type: "changed" }
  | { type: "checking"; repo: string | null }
  | { type: "checked"; repo: string; at: string; judged: number; posted: number; failed: boolean };
