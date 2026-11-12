import { join } from "node:path";
import {
  caseSlug,
  LANDING_CALLS,
  landingCaseSlug,
  OWNER_CASE_BOOK,
  OWNER_CALLS,
  writeCase,
  writeLandingCase,
  type Case,
  type ForgeFacts,
  type LandingCase,
  type LandingOwnerCall,
  type OwnerCall,
} from "./case-book.ts";
import type { Criterion } from "./judgment.ts";
import { ciGreen, type BeyondItem, type CriterionCheck, type Guard } from "./landing.ts";
import { EFFORTS, type Effort } from "./model-runner.ts";
import {
  appendEntry,
  callStatuses,
  criteriaOf,
  HOST,
  isRepo,
  landingStatuses,
  latestCalls,
  latestLandings,
  loggedRepos,
  readLog,
  repoState,
  type AnsweredEntry,
  type CallEntry,
  type LandingEntry,
  type PrActedEntry,
  type CallStatus,
  type ConfirmedEntry,
  type Entry,
  type GlobalSettings,
  type OverriddenEntry,
  type OwnerAction,
  type RepoState,
} from "./records.ts";
import { collapseWhitespace, splitVisionLines } from "./vision.ts";

/**
 * The owner's side: what waits on them, the log, the repos and their
 * settings, and the owner's three answers to a call (confirm it, override it
 * with a reason, answer its question). Both the board's API and the CLI come
 * through here. Every owner action is appended to the repo's log under the
 * owner's name and, when it settles an issue, written to the owner's case
 * book; entail acts on GitHub for it on its next pass.
 */

/** An owner's request entail cannot carry out, with the HTTP status it answers to. */
export class OwnerError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = "OwnerError";
    this.status = status;
  }
}

/** The repo as the owner named it, checked and lower-cased the way its log is kept. */
export function repoName(text: string): string {
  const repo = text.trim().replace(/^https:\/\/github\.com\//u, "").replace(/\.git$/u, "").replace(/\/$/u, "").toLowerCase();
  if (!isRepo(repo)) throw new OwnerError(400, `not a repo: ${text} (expected owner/name)`);
  return repo;
}

// Repos and settings.

export interface EnrollOptions {
  /** Whether the repo starts in confirm mode; it does unless the owner says otherwise. */
  confirm?: boolean;
  /** Judge issues filed from this time on; now by default. */
  since?: Date;
}

export function enroll(dataDirectory: string, repoText: string, by: string, options: EnrollOptions = {}, now = new Date()): RepoState {
  const repo = repoName(repoText);
  if (repoState(repo, readLog(dataDirectory, repo)).enrolled) throw new OwnerError(409, `${repo} is already enrolled`);
  appendEntry(dataDirectory, repo, { type: "enrolled", by, since: (options.since ?? now).toISOString(), confirm: options.confirm ?? true }, now);
  return repoState(repo, readLog(dataDirectory, repo));
}

export function unenroll(dataDirectory: string, repoText: string, by: string, now = new Date()): RepoState {
  const repo = repoName(repoText);
  if (!repoState(repo, readLog(dataDirectory, repo)).enrolled) throw new OwnerError(404, `${repo} is not enrolled`);
  appendEntry(dataDirectory, repo, { type: "unenrolled", by }, now);
  return repoState(repo, readLog(dataDirectory, repo));
}

export interface RepoSettingsChange {
  confirm?: boolean;
  /** A model name, or null for the default. */
  model?: string | null;
  /** An effort level, or null for the default. */
  effort?: Effort | null;
}

/** Checks a settings change as it arrives from the board or the command line. */
export function checkSettingsChange(change: Record<string, unknown>): RepoSettingsChange {
  const checked: RepoSettingsChange = {};
  for (const key of Object.keys(change)) {
    if (!["confirm", "model", "effort"].includes(key)) throw new OwnerError(400, `no setting named ${key}`);
  }
  if (change.confirm !== undefined) {
    if (typeof change.confirm !== "boolean") throw new OwnerError(400, "confirm is true or false");
    checked.confirm = change.confirm;
  }
  if (change.model !== undefined) {
    if (change.model !== null && (typeof change.model !== "string" || !/^[\w.:-]+$/u.test(change.model))) throw new OwnerError(400, "model is a model name, or null for the default");
    checked.model = change.model as string | null;
  }
  if (change.effort !== undefined) {
    if (change.effort !== null && !(EFFORTS as readonly unknown[]).includes(change.effort)) throw new OwnerError(400, `effort is one of ${EFFORTS.join(", ")}, or null for the default`);
    checked.effort = change.effort as Effort | null;
  }
  return checked;
}

export function changeRepoSettings(dataDirectory: string, repoText: string, by: string, change: RepoSettingsChange, now = new Date()): RepoState {
  const repo = repoName(repoText);
  const state = repoState(repo, readLog(dataDirectory, repo));
  if (!state.enrolled) throw new OwnerError(404, `${repo} is not enrolled`);
  const changed: RepoSettingsChange = {};
  if (change.confirm !== undefined && change.confirm !== state.confirm) changed.confirm = change.confirm;
  if (change.model !== undefined && change.model !== state.model) changed.model = change.model;
  if (change.effort !== undefined && change.effort !== state.effort) changed.effort = change.effort;
  if (Object.keys(changed).length > 0) appendEntry(dataDirectory, repo, { type: "settings", by, ...changed }, now);
  return repoState(repo, readLog(dataDirectory, repo));
}

/** The model and effort a repo's calls are made with. */
export function runSettings(state: RepoState, settings: GlobalSettings): { model: string; effort: Effort } {
  return { model: state.model ?? settings.model, effort: state.effort ?? settings.effort };
}

export interface RepoView extends RepoState {
  /** The model and effort its calls are made with now. */
  uses: { model: string; effort: Effort };
  calls: number;
  waiting: number;
  /** Calls the owner checked in confirm mode, and how many of them they confirmed as they stood. */
  checked: number;
  agreed: number;
}

export function repoViews(dataDirectory: string, settings: GlobalSettings, options: { all?: boolean } = {}): RepoView[] {
  return loggedRepos(dataDirectory).flatMap((repo) => {
    const entries = readLog(dataDirectory, repo);
    const state = repoState(repo, entries);
    if (!state.enrolled && options.all !== true) return [];
    const statuses = [...callStatuses(entries).values(), ...landingStatuses(entries).values()];
    return [
      {
        ...state,
        uses: runSettings(state, settings),
        calls: entries.filter((entry) => (entry.type === "call" && entry.owner === null && entry.trigger !== "landing") || entry.type === "landing").length,
        waiting: statuses.filter((status) => status.status === "waiting").length,
        checked: statuses.filter((status) => status.status === "confirmed" || status.status === "overridden").length,
        agreed: statuses.filter((status) => status.status === "confirmed").length,
      },
    ];
  });
}

// What a call rests on, with links.

/**
 * A call as the owner reads it: on an issue (go, no or ask) or, with `kind`
 * "pr", on a PR that closes an issue (merge, send-back or ask). A PR's call
 * names the issue it closes in `issue`, carries the criteria entail set for
 * that issue in `criteria`, and everything about the PR in `pr`.
 */
export interface CallView {
  id: number;
  /** "issue" for the call on an issue, "pr" for the landing call on a PR. */
  kind: "issue" | "pr";
  repo: string;
  issue: { number: number; title: string; url: string; author: string };
  /** The issue as the judgment read it: title, body and comments, as markdown. */
  issueText: string;
  /** The commit VISION.md was read at, or null when the repo had none. */
  visionCommit: string | null;
  call: "go" | "no" | "ask" | "merge" | "send-back";
  reason: string;
  /** The criteria the call set (on an issue) or the PR was judged against (on a PR). */
  criteria: Criterion[];
  /** For ask: the question and what makes it one. */
  question: { question: string; why: string; large: boolean } | null;
  restsOn: { visionLines: { text: string; url: string | null }[]; cases: { slug: string; title: string; url: string | null }[] };
  judgedAt: string;
  /** What made entail judge: on an issue, as recorded; on a PR, "opened" for its first judged head and "push" for a later one. */
  trigger: CallEntry["trigger"] | "opened" | "push";
  /** The owner's word this call was run on, when it was. */
  owner: CallEntry["owner"];
  model: string;
  effort: Effort;
  costUsd: number | null;
  confirmMode: boolean;
  status: CallStatus["status"];
  /** The owner's action on it, when there is one. */
  settledBy: OwnerAction | null;
  /** The comment entail posted for it, once posted; on a PR, `closed` means the PR was cancelled. */
  posted: { url: string; closed: boolean } | null;
  /** On a PR's call, everything about the PR; null on an issue's. */
  pr: PullRequestView | null;
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
  checklist: CriterionCheck[];
  /** What it does beyond its criteria, each sorted needed, harmless or unwanted. */
  beyond: BeyondItem[];
  /** For a send-back: what needs to change. */
  needsToChange: string[];
  /** For a send-back: whether what blocks it is a product question for the owner. */
  productCall: boolean;
  /** Set when a mechanical rule changed the model's call: CI not green, or VISION.md or a pinned path changed. */
  guard: Guard | null;
  /** Read from the forge at the head, never from the PR's description. */
  facts: ForgeFacts & { ciGreen: boolean; touched: { vision: boolean; pins: string[] } };
  /** Send-backs posted on the PR before this call. */
  sendBacks: number;
  /** Whether this call cancels the PR: closes it unmerged with the reason. */
  cancel: boolean;
  /** What entail did on the PR for this call or the owner's action on it, once it acted. */
  outcome: { merged: { sha: string; commit: string | null } | null; refused: string | null; closed: boolean } | null;
}

/** A call as the owner reads it, with links to the issue, the vision lines and the past cases it rests on. */
export function callView(repo: string, entry: CallEntry, status: CallStatus, entries: readonly Entry[], book: readonly Case[]): CallView {
  const acted = entries.find((other) => other.type === "acted" && other.for === entry.id);
  return {
    id: entry.id,
    kind: "issue",
    repo,
    issue: entry.issue,
    issueText: entry.issueText,
    visionCommit: entry.vision?.commit ?? null,
    call: entry.call.call,
    reason: entry.call.reason,
    criteria: criteriaOf(entry.call),
    question: entry.call.call === "ask" ? { question: entry.call.question, why: entry.call.why, large: entry.call.large } : null,
    restsOn: {
      visionLines: entry.call.restsOn.visionLines.map((text) => ({ text, url: visionLineUrl(repo, entry, text) })),
      cases: entry.call.restsOn.cases.map((slug) => {
        const past = book.find((candidate) => candidate.slug === slug);
        return {
          slug,
          title: past === undefined ? slug : `${past.repo}#${past.issue}`,
          url: past === undefined ? null : `https://${HOST}/${past.repo}/issues/${past.issue}`,
        };
      }),
    },
    judgedAt: entry.at,
    trigger: entry.trigger,
    owner: entry.owner,
    model: entry.model,
    effort: entry.effort,
    costUsd: entry.costUsd,
    confirmMode: entry.confirm,
    status: status.status,
    settledBy: "action" in status ? status.action : null,
    posted: acted?.type === "acted" ? { url: acted.comment.url, closed: acted.closed } : null,
    pr: null,
  };
}

/** A PR's call as the owner reads it. */
export function landingView(repo: string, entry: LandingEntry, status: CallStatus, entries: readonly Entry[], book: readonly Case[]): CallView {
  const settledBy = "action" in status ? status.action : null;
  // What entail did for this call, or for the owner's action on it.
  const acted = entries.findLast((other): other is PrActedEntry => other.type === "pr-acted" && (other.for === entry.id || other.for === settledBy?.id));
  const firstHead = entries.find((other): other is LandingEntry => other.type === "landing" && other.pr.number === entry.pr.number);
  const { call } = entry;
  return {
    id: entry.id,
    kind: "pr",
    repo,
    issue: { ...entry.issue, author: "" },
    issueText: entry.issueText,
    visionCommit: entry.vision?.commit ?? null,
    call: call.call,
    reason: call.reason,
    criteria: entry.criteria,
    question: call.question === null ? null : { ...call.question, large: false },
    restsOn: restsOnView(repo, entry.vision, call.restsOn, book),
    judgedAt: entry.at,
    trigger: firstHead?.id === entry.id ? "opened" : "push",
    owner: null,
    model: entry.model,
    effort: entry.effort,
    costUsd: entry.costUsd,
    confirmMode: entry.confirm,
    status: status.status,
    settledBy,
    posted: acted === undefined ? null : { url: acted.comment.url, closed: acted.closed },
    pr: {
      ...entry.pr,
      head: entry.head,
      base: entry.base,
      solves: call.solves,
      checklist: call.criteria,
      beyond: call.beyond,
      needsToChange: call.needsToChange,
      productCall: call.productCall,
      guard: call.guard,
      facts: { ...entry.facts, ciGreen: ciGreen(entry.facts), touched: entry.touched },
      sendBacks: entry.sendBacks,
      cancel: entry.cancel,
      outcome: acted === undefined ? null : { merged: acted.merged, refused: acted.refused, closed: acted.closed },
    },
  };
}

function restsOnView(repo: string, vision: LandingEntry["vision"], restsOn: { visionLines: string[]; cases: string[] }, book: readonly Case[]): CallView["restsOn"] {
  return {
    visionLines: restsOn.visionLines.map((text) => ({ text, url: vision === null ? null : visionLineAt(repo, vision, text) })),
    cases: restsOn.cases.map((slug) => {
      const past = book.find((candidate) => candidate.slug === slug);
      return { slug, title: past === undefined ? slug : `${past.repo}#${past.issue}`, url: past === undefined ? null : `https://${HOST}/${past.repo}/issues/${past.issue}` };
    }),
  };
}

/** One call of either kind by its id, as the owner reads it. */
export function itemView(dataDirectory: string, id: number, book: readonly Case[]): CallView {
  const found = findItem(dataDirectory, id);
  if (found.entry.type === "call") return callView(found.repo, found.entry, callStatuses(found.entries).get(id)!, found.entries, book);
  return landingView(found.repo, found.entry, landingStatuses(found.entries).get(id)!, found.entries, book);
}

/** A link to a vision line at the commit the call read it at, to the line when it is found. */
function visionLineUrl(repo: string, entry: CallEntry, text: string): string | null {
  if (entry.vision === null) return null;
  return visionLineAt(repo, entry.vision, text);
}

function visionLineAt(repo: string, vision: { commit: string; text: string }, text: string): string {
  const entry = { vision };
  const base = `https://${HOST}/${repo}/blob/${entry.vision.commit}/VISION.md`;
  const wanted = collapseWhitespace(text.replace(/^>\s*/u, ""));
  const line = wanted === "" ? undefined : splitVisionLines(entry.vision.text).find((candidate) => candidate.identity.includes(wanted));
  return line === undefined ? base : `${base}#L${line.lineNumber}`;
}

// What waits on the owner, and the log.

/** Everything waiting on the owner across enrolled repos, on issues and PRs: questions first, then calls to confirm, oldest first within each. */
export function waitingItems(dataDirectory: string, book: readonly Case[], repoFilter?: string): CallView[] {
  const items: CallView[] = [];
  for (const repo of loggedRepos(dataDirectory)) {
    if (repoFilter !== undefined && repo !== repoFilter) continue;
    const entries = readLog(dataDirectory, repo);
    if (!repoState(repo, entries).enrolled) continue;
    const statuses = callStatuses(entries);
    const landings = landingStatuses(entries);
    for (const entry of entries) {
      if (entry.type === "call") {
        const status = statuses.get(entry.id)!;
        if (status.status === "waiting") items.push(callView(repo, entry, status, entries, book));
      } else if (entry.type === "landing") {
        const status = landings.get(entry.id)!;
        if (status.status === "waiting") items.push(landingView(repo, entry, status, entries, book));
      }
    }
  }
  const rank = (item: CallView) => (item.call === "ask" ? 0 : 1);
  return items.sort((a, b) => rank(a) - rank(b) || a.judgedAt.localeCompare(b.judgedAt));
}

/** One line of the log as the owner reads it. */
export type LogItem =
  | ({ kind: "call" } & Omit<CallView, "kind"> & { callKind: CallView["kind"] })
  | { kind: "owner"; repo: string; at: string; action: OwnerAction; issue: CallEntry["issue"] | null; pr: LandingEntry["pr"] | null }
  | { kind: "acted"; repo: string; at: string; for: number; issue: number; url: string; closed: boolean }
  /** entail acted on a PR: posted, and merged or closed it if it was to. */
  | { kind: "pr-acted"; repo: string; at: string; for: number; pr: number; url: string; merged: PrActedEntry["merged"]; refused: string | null; sentBack: boolean; closed: boolean }
  /** entail started or stopped following a PR. */
  | { kind: "pr"; repo: string; at: string; entry: Extract<Entry, { type: "followed" | "unfollowed" | "landing-failed" }> }
  | { kind: "repo"; repo: string; at: string; entry: Extract<Entry, { type: "enrolled" | "unenrolled" | "settings" }> };

/**
 * The log of one repo, or of every repo, oldest first: each repo's in the
 * order it was written, and the repos merged by time.
 */
export function logItems(dataDirectory: string, book: readonly Case[], repoFilter?: string): LogItem[] {
  const perRepo: LogItem[][] = [];
  for (const repo of loggedRepos(dataDirectory)) {
    if (repoFilter !== undefined && repo !== repoFilter) continue;
    const items: LogItem[] = [];
    perRepo.push(items);
    const entries = readLog(dataDirectory, repo);
    const statuses = callStatuses(entries);
    const landings = landingStatuses(entries);
    const calls = new Map(entries.flatMap((entry) => (entry.type === "call" ? [[entry.id, entry] as const] : [])));
    const prCalls = new Map(entries.flatMap((entry) => (entry.type === "landing" ? [[entry.id, entry] as const] : [])));
    const asItem = (view: CallView): LogItem => {
      const { kind, ...rest } = view;
      return { kind: "call", callKind: kind, ...rest };
    };
    for (const entry of entries) {
      switch (entry.type) {
        case "call":
          items.push(asItem(callView(repo, entry, statuses.get(entry.id)!, entries, book)));
          break;
        case "landing":
          items.push(asItem(landingView(repo, entry, landings.get(entry.id)!, entries, book)));
          break;
        case "confirmed":
        case "overridden":
        case "answered": {
          const landing = prCalls.get(entry.call);
          items.push({ kind: "owner", repo, at: entry.at, action: entry, issue: calls.get(entry.call)?.issue ?? (landing ? { ...landing.issue, author: "" } : null), pr: landing?.pr ?? null });
          break;
        }
        case "acted":
          items.push({ kind: "acted", repo, at: entry.at, for: entry.for, issue: entry.issue, url: entry.comment.url, closed: entry.closed });
          break;
        case "pr-acted":
          items.push({ kind: "pr-acted", repo, at: entry.at, for: entry.for, pr: entry.pr, url: entry.comment.url, merged: entry.merged, refused: entry.refused, sentBack: entry.sentBack, closed: entry.closed });
          break;
        case "followed":
        case "unfollowed":
        case "landing-failed":
          items.push({ kind: "pr", repo, at: entry.at, entry });
          break;
        default:
          items.push({ kind: "repo", repo, at: entry.at, entry });
      }
    }
  }
  const timeOf = (item: LogItem) => ("judgedAt" in item ? item.judgedAt : item.at);
  const merged: LogItem[] = [];
  const heads = perRepo.map(() => 0);
  for (;;) {
    let next = -1;
    perRepo.forEach((items, index) => {
      const item = items[heads[index]!];
      if (item !== undefined && (next === -1 || timeOf(item) < timeOf(perRepo[next]![heads[next]!]!))) next = index;
    });
    if (next === -1) return merged;
    merged.push(perRepo[next]![heads[next]!++]!);
  }
}

// The owner's answers to a call.

/** Finds a call by its id in any repo's log. */
export function findCall(dataDirectory: string, id: number): { repo: string; entries: Entry[]; call: CallEntry } {
  const found = findItem(dataDirectory, id);
  if (found.entry.type !== "call") throw new OwnerError(404, `no call ${id} on an issue`);
  return { repo: found.repo, entries: found.entries, call: found.entry };
}

/** Finds a call on an issue or a PR by its id in any repo's log. */
export function findItem(dataDirectory: string, id: number): { repo: string; entries: Entry[]; entry: CallEntry | LandingEntry } {
  for (const repo of loggedRepos(dataDirectory)) {
    const entries = readLog(dataDirectory, repo);
    const entry = entries.find((candidate): candidate is CallEntry | LandingEntry => (candidate.type === "call" || candidate.type === "landing") && candidate.id === id);
    if (entry) return { repo, entries, entry };
  }
  throw new OwnerError(404, `no call ${id}`);
}

/** The latest call on an issue, as `entail confirm owner/repo#n` names it. */
export function latestCallOn(dataDirectory: string, repoText: string, issue: number): number {
  const repo = repoName(repoText);
  const call = latestCalls(readLog(dataDirectory, repo)).get(issue);
  if (call === undefined) throw new OwnerError(404, `entail has made no call on ${repo}#${issue}`);
  return call.id;
}

/** The latest call on a PR, as `entail confirm owner/repo#n` names it when n is a PR entail judged. */
export function latestLandingOn(dataDirectory: string, repoText: string, pr: number): number | null {
  return latestLandings(readLog(dataDirectory, repoName(repoText))).get(pr)?.id ?? null;
}

/** The latest call on an issue or a PR by its number: a PR's when entail judged a PR by that number. */
export function latestItemOn(dataDirectory: string, repoText: string, number: number): number {
  return latestLandingOn(dataDirectory, repoText, number) ?? latestCallOn(dataDirectory, repoText, number);
}

function statusOf(entries: readonly Entry[], call: CallEntry): CallStatus {
  return callStatuses(entries).get(call.id)!;
}

function ownerCall(text: unknown): OwnerCall {
  if (!(OWNER_CALLS as readonly unknown[]).includes(text)) throw new OwnerError(400, "the call is go or no");
  return text as OwnerCall;
}

function landingOwnerCall(text: unknown): LandingOwnerCall {
  if (!(LANDING_CALLS as readonly unknown[]).includes(text)) throw new OwnerError(400, "the call on a PR is merge or send-back");
  return text as LandingOwnerCall;
}

function ownerWords(text: unknown, what: string): string {
  if (typeof text !== "string" || text.trim() === "") throw new OwnerError(400, `${what} is required`);
  return text.trim();
}

/**
 * Confirms a call waiting in confirm mode, on an issue (go or no) or a PR
 * (merge or send-back): entail then acts on it as it stands.
 */
export async function confirmCall(dataDirectory: string, id: number, by: string, now = new Date()): Promise<ConfirmedEntry> {
  const found = findItem(dataDirectory, id);
  if (found.entry.type === "landing") {
    const status = landingStatuses(found.entries).get(id)!;
    if (found.entry.call.call === "ask") throw new OwnerError(409, `call ${id} is a question: answer it`);
    if (status.status !== "waiting") throw new OwnerError(409, `call ${id} is not waiting to be confirmed (${status.status})`);
    return actOnLanding(dataDirectory, found.repo, found.entry, { type: "confirmed", by, call: id }, now);
  }
  const { repo, entries, entry: call } = found;
  const status = statusOf(entries, call);
  if (call.call.call === "ask") throw new OwnerError(409, `call ${id} is a question: answer it`);
  if (status.status !== "waiting") throw new OwnerError(409, `call ${id} is not waiting to be confirmed (${status.status})`);
  const action = await act(dataDirectory, repo, call, { type: "confirmed", by, call: id }, now);
  return action;
}

/**
 * Replaces a call with the owner's own call and reason: go or no on an
 * issue, merge or send-back on a PR. A call that entail already acted on can
 * be overridden too; one judged again since cannot, and neither can a
 * question, which is answered.
 */
export async function overrideCall(dataDirectory: string, id: number, by: string, to: unknown, reason: unknown, now = new Date()): Promise<OverriddenEntry> {
  const found = findItem(dataDirectory, id);
  if (found.entry.type === "landing") {
    const landing = found.entry;
    const owner = landingOwnerCall(to);
    const words = ownerWords(reason, "a reason");
    const status = landingStatuses(found.entries).get(id)!;
    if (landing.call.call === "ask") throw new OwnerError(409, `call ${id} is a question: answer it`);
    if (status.status === "superseded") throw new OwnerError(409, `call ${id} was replaced by a newer call on the PR`);
    if (status.status === "closed") throw new OwnerError(409, `the PR of call ${id} is merged or closed`);
    if (status.status === "overridden" || status.status === "answered") throw new OwnerError(409, `call ${id} is already the owner's (${status.status})`);
    if (owner === landing.call.call) throw new OwnerError(409, `call ${id} is already ${owner}; confirm it instead`);
    return actOnLanding(dataDirectory, found.repo, landing, { type: "overridden", by, call: id, to: owner, reason: words }, now);
  }
  const { repo, entries, entry: call } = found;
  const owner = ownerCall(to);
  const words = ownerWords(reason, "a reason");
  const status = statusOf(entries, call);
  if (call.call.call === "ask" && call.owner === null) throw new OwnerError(409, `call ${id} is a question: answer it`);
  if (status.status === "superseded") throw new OwnerError(409, `call ${id} was replaced by a newer call on the issue`);
  if (status.status === "overridden" || status.status === "answered") throw new OwnerError(409, `call ${id} is already the owner's (${status.status})`);
  const effective = call.owner?.call ?? call.call.call;
  if (owner === effective) throw new OwnerError(409, `call ${id} is already ${owner}; confirm it instead`);
  const action = await act(dataDirectory, repo, call, { type: "overridden", by, call: id, to: owner, reason: words }, now);
  return action;
}

/**
 * Answers a call's question with the owner's call and words: go or no on an
 * issue, where a go runs the judgment again with the answer; merge or
 * send-back on a PR.
 */
export async function answerCall(dataDirectory: string, id: number, by: string, to: unknown, answer: unknown, now = new Date()): Promise<AnsweredEntry> {
  const found = findItem(dataDirectory, id);
  if (found.entry.type === "landing") {
    const owner = landingOwnerCall(to);
    const words = ownerWords(answer, "an answer");
    const status = landingStatuses(found.entries).get(id)!;
    if (found.entry.call.call !== "ask") throw new OwnerError(409, `call ${id} is a ${found.entry.call.call}, not a question: confirm or override it`);
    if (status.status !== "waiting") throw new OwnerError(409, `call ${id} is not waiting for an answer (${status.status})`);
    return actOnLanding(dataDirectory, found.repo, found.entry, { type: "answered", by, call: id, to: owner, answer: words }, now);
  }
  const { repo, entries, entry: call } = found;
  const owner = ownerCall(to);
  const words = ownerWords(answer, "an answer");
  const status = statusOf(entries, call);
  if (call.call.call !== "ask") throw new OwnerError(409, `call ${id} is a ${call.call.call}, not a question: confirm or override it`);
  if (status.status !== "waiting") throw new OwnerError(409, `call ${id} is not waiting for an answer (${status.status})`);
  const action = await act(dataDirectory, repo, call, { type: "answered", by, call: id, to: owner, answer: words }, now);
  return action;
}

/** The case an owner's action makes: the issue as judged, the vision it was judged under, and the owner's call with its reason. */
export function caseFor(repo: string, call: CallEntry, action: OwnerAction): Case {
  const asCalled = call.owner?.call ?? call.call.call;
  const base = {
    slug: caseSlug(repo, call.issue.number),
    repo,
    issue: call.issue.number,
    issueText: call.issueText,
    vision: call.vision?.text ?? "",
    visionCommit: call.vision?.commit ?? call.sha,
    date: action.at.slice(0, 10),
  };
  if (action.type === "confirmed") {
    const criteria = criteriaOf(call.call);
    return {
      ...base,
      call: asCalled as OwnerCall,
      reason: oneLine(call.owner?.words ?? call.call.reason),
      reasonFrom: `entail's reason, confirmed by ${action.by} on the board`,
      notes: criteria.length === 0 ? "" : `## The criteria ${action.by} confirmed\n\n${criteria.map((criterion) => `- ${criterion.criterion}`).join("\n")}`,
    };
  }
  const words = action.type === "overridden" ? action.reason : action.answer;
  const notes = [`## ${action.by}'s words\n\n${quote(words)}`];
  if (action.type === "overridden") {
    notes.push(`## entail's call, overridden\n\nentail called ${asCalled}: ${call.call.reason}`);
  } else if (call.call.call === "ask") {
    notes.push(`## entail's question\n\n${quote(call.call.question)}\n\nWhy it was a question: ${call.call.why}`);
  }
  return {
    ...base,
    call: action.to as OwnerCall,
    reason: oneLine(words),
    reasonFrom:
      action.type === "overridden"
        ? `${action.by}'s override on the board, quoted below; the one-line reason is its first paragraph`
        : `${action.by}'s answer on the board to entail's question, quoted below; the one-line reason is its first paragraph`,
    notes: notes.join("\n\n"),
  };
}

/** The landing case an owner's action on a PR's call makes: the PR as judged, and the owner's call with its reason. */
export function landingCaseFor(repo: string, landing: LandingEntry, action: OwnerAction): LandingCase {
  const { call } = landing;
  const base = {
    kind: "landing" as const,
    slug: landingCaseSlug(repo, landing.pr.number),
    repo,
    issue: landing.issue.number,
    pr: landing.pr.number,
    head: landing.head,
    base: landing.base,
    issueText: landing.issueText,
    vision: landing.vision?.text ?? "",
    visionCommit: landing.vision?.commit ?? landing.base,
    criteria: landing.criteria.map((criterion) => ({ criterion: criterion.criterion, basis: criterion.basis })),
    prText: landing.prText,
    facts: landing.facts,
    date: action.at.slice(0, 10),
  };
  if (action.type === "confirmed") {
    return {
      ...base,
      call: call.call as LandingOwnerCall,
      reason: oneLine(call.reason),
      reasonFrom: `entail's reason, confirmed by ${action.by} on the board`,
      notes: call.needsToChange.length === 0 ? "" : `## What needs to change, as ${action.by} confirmed\n\n${call.needsToChange.map((item) => `- ${item}`).join("\n")}`,
    };
  }
  const words = action.type === "overridden" ? action.reason : action.answer;
  const notes = [`## ${action.by}'s words\n\n${quote(words)}`];
  if (action.type === "overridden") notes.push(`## entail's call, overridden\n\nentail called ${call.call}: ${call.reason}`);
  else if (call.question !== null) notes.push(`## entail's question\n\n${quote(call.question.question)}\n\nWhy it was a question: ${call.question.why}`);
  return {
    ...base,
    call: action.to as LandingOwnerCall,
    reason: oneLine(words),
    reasonFrom:
      action.type === "overridden"
        ? `${action.by}'s override on the board, quoted below; the one-line reason is its first paragraph`
        : `${action.by}'s answer on the board to entail's question, quoted below; the one-line reason is its first paragraph`,
    notes: notes.join("\n\n"),
  };
}

/** Writes the owner's case first, then logs the action, so a case that cannot be written leaves the call still waiting. */
type NewOwnerAction = Omit<ConfirmedEntry, "id" | "at"> | Omit<OverriddenEntry, "id" | "at"> | Omit<AnsweredEntry, "id" | "at">;

async function act<E extends NewOwnerAction>(dataDirectory: string, repo: string, call: CallEntry, entry: E, now: Date): Promise<E & { id: number; at: string }> {
  const draft = { id: 0, at: now.toISOString(), ...entry } as unknown as OwnerAction;
  await writeCase(join(dataDirectory, OWNER_CASE_BOOK), caseFor(repo, call, draft));
  return appendEntry(dataDirectory, repo, entry, now);
}

async function actOnLanding<E extends NewOwnerAction>(dataDirectory: string, repo: string, landing: LandingEntry, entry: E, now: Date): Promise<E & { id: number; at: string }> {
  const draft = { id: 0, at: now.toISOString(), ...entry } as unknown as OwnerAction;
  await writeLandingCase(join(dataDirectory, OWNER_CASE_BOOK), landingCaseFor(repo, landing, draft));
  return appendEntry(dataDirectory, repo, entry, now);
}

function oneLine(text: string): string {
  return text.trim().split(/\n\s*\n/u)[0]!.replace(/\s+/gu, " ").trim();
}

function quote(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => (line.trim() === "" ? ">" : `> ${line}`))
    .join("\n");
}

// The log as text, for `entail calls`.

export function formatLog(items: readonly LogItem[], options: { repoColumn: boolean }): string {
  if (items.length === 0) return "No calls yet.";
  const lines: string[] = [];
  for (const item of items) {
    const at = ("judgedAt" in item ? item.judgedAt : item.at).slice(0, 16).replace("T", " ");
    const where = (issue: number | null) => `${options.repoColumn ? item.repo : ""}${issue === null ? "" : `#${issue}`}`;
    switch (item.kind) {
      case "call": {
        if (item.pr !== null) {
          lines.push(`${at}  ${where(item.pr.number)}  ${item.call.toUpperCase()} by entail at ${item.pr.head.slice(0, 7)}: ${item.pr.title} (closes #${item.issue.number})`, `      ${item.reason}`);
          lines.push(...prLines(item.pr, "      "));
          if (item.question !== null) lines.push(`      question: ${item.question.question}`);
          lines.push(`      ${statusLine(item)} · ${item.model} at ${item.effort} effort · call ${item.id}`);
          break;
        }
        const whose = item.owner === null ? "entail" : `entail, on ${item.owner.kind === "answer" ? "the owner's answer" : "the owner's override"} (the owner's call: ${item.owner.call})`;
        lines.push(`${at}  ${where(item.issue.number)}  ${item.call.toUpperCase()} by ${whose}: ${item.issue.title}`, `      ${item.reason}`);
        for (const line of item.restsOn.visionLines) lines.push(`      rests on the vision: > ${line.text}`);
        for (const past of item.restsOn.cases) lines.push(`      rests on case ${past.slug}`);
        if (item.question !== null) lines.push(`      question: ${item.question.question}`);
        for (const criterion of item.criteria) lines.push(`      criterion [${criterion.source}]: ${criterion.criterion}`);
        lines.push(`      ${statusLine(item)} · ${item.model} at ${item.effort} effort · call ${item.id}`);
        break;
      }
      case "owner": {
        const { action } = item;
        const issue = item.pr?.number ?? item.issue?.number ?? null;
        if (action.type === "confirmed") lines.push(`${at}  ${where(issue)}  CONFIRMED by ${action.by} (call ${action.call})`);
        if (action.type === "overridden") lines.push(`${at}  ${where(issue)}  OVERRIDDEN by ${action.by} to ${action.to} (call ${action.call})`, `      ${oneLine(action.reason)}`);
        if (action.type === "answered") lines.push(`${at}  ${where(issue)}  ANSWERED by ${action.by}: ${action.to} (call ${action.call})`, `      ${oneLine(action.answer)}`);
        break;
      }
      case "acted":
        lines.push(`${at}  ${where(item.issue)}  posted ${item.url}${item.closed ? " and closed the issue" : ""}`);
        break;
      case "pr-acted": {
        const did = item.merged !== null ? ` and merged at ${item.merged.sha.slice(0, 7)}` : item.closed ? " and closed the PR unmerged" : item.refused !== null ? `; the merge did not happen: ${item.refused}` : "";
        lines.push(`${at}  ${where(item.pr)}  posted ${item.url}${did}`);
        break;
      }
      case "pr":
        if (item.entry.type === "followed") lines.push(`${at}  ${where(item.entry.pr.number)}  following PR "${item.entry.pr.title}", which closes #${item.entry.issue}`);
        else if (item.entry.type === "landing-failed") lines.push(`${at}  ${where(item.entry.pr)}  the landing judgment at ${item.entry.head.slice(0, 7)} gave no call: ${item.entry.reason}`);
        else lines.push(`${at}  ${where(item.entry.pr)}  stopped following the PR: it is ${item.entry.state}`);
        break;
      case "repo": {
        const { entry } = item;
        if (entry.type === "enrolled") lines.push(`${at}  ${where(null) || item.repo}  enrolled by ${entry.by}, judging issues filed from ${entry.since.slice(0, 16).replace("T", " ")}, confirm mode ${entry.confirm ? "on" : "off"}`);
        if (entry.type === "unenrolled") lines.push(`${at}  ${where(null) || item.repo}  unenrolled by ${entry.by}`);
        if (entry.type === "settings") {
          const changes = [
            entry.confirm === undefined ? null : `confirm mode ${entry.confirm ? "on" : "off"}`,
            entry.model === undefined ? null : `model ${entry.model ?? "the default"}`,
            entry.effort === undefined ? null : `effort ${entry.effort ?? "the default"}`,
          ].filter((change) => change !== null);
          lines.push(`${at}  ${where(null) || item.repo}  ${entry.by} set ${changes.join(", ")}`);
        }
        break;
      }
    }
  }
  return lines.join("\n");
}

function prLines(pr: PullRequestView, indent: string): string[] {
  const lines = [`${indent}solves the problem: ${pr.solves.solved ? "yes" : "NO"}; CI ${pr.facts.ciGreen ? "green" : "NOT green"}; ${pr.facts.files.length} files changed`];
  for (const check of pr.checklist) lines.push(`${indent}criterion ${check.met ? "met" : "UNMET"}: ${check.criterion}`);
  for (const item of pr.beyond) lines.push(`${indent}beyond the criteria, ${item.sort}: ${item.change}`);
  for (const item of pr.needsToChange) lines.push(`${indent}needs to change: ${item}`);
  if (pr.guard !== null) lines.push(`${indent}the model said ${pr.guard.from}; ${pr.guard.detail}`);
  if (pr.cancel) lines.push(`${indent}cancels the PR after ${pr.sendBacks} send-backs`);
  return lines;
}

function statusLine(item: Pick<CallView, "status" | "call" | "settledBy">): string {
  switch (item.status) {
    case "waiting":
      return item.call === "ask" ? "waiting for the owner's answer" : "waiting for the owner to confirm";
    case "auto":
      return "acted on at once (confirm mode off)";
    case "owner":
      return "the owner's call";
    case "superseded":
      return "judged again before the owner settled it";
    case "closed":
      return "the PR was merged or closed before the owner settled it";
    default:
      return `${item.status} by ${item.settledBy?.by ?? "the owner"}`;
  }
}

/** What waits on the owner, as text. */
export function formatWaiting(items: readonly CallView[]): string {
  if (items.length === 0) return "Nothing is waiting on you.";
  const blocks = items.map((item) => {
    const lines =
      item.pr === null
        ? [`${item.repo}#${item.issue.number}: ${item.issue.title}`, `  ${item.issue.url}`]
        : [`${item.repo}#${item.pr.number} (PR, closes #${item.issue.number}): ${item.pr.title}`, `  ${item.pr.url}`];
    if (item.call === "ask") {
      lines.push(`  QUESTION (call ${item.id}): ${item.question!.question}`, `  Why it is a question: ${item.question!.why}`, `  entail's reasoning: ${item.reason}`);
    } else {
      lines.push(`  ${item.call.toUpperCase()}, to confirm (call ${item.id}): ${item.reason}`);
    }
    for (const line of item.restsOn.visionLines) lines.push(`  rests on the vision: > ${line.text}`);
    for (const past of item.restsOn.cases) lines.push(`  rests on case ${past.slug}${past.url === null ? "" : ` (${past.url})`}`);
    if (item.pr !== null) lines.push(...prLines(item.pr, "  "));
    else for (const criterion of item.criteria) lines.push(`  criterion [${criterion.source}]: ${criterion.criterion}`);
    return lines.join("\n");
  });
  return blocks.join("\n\n");
}
