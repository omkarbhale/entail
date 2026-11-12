import { readFileSync } from "node:fs";
import type { ActionView, CallView, HeldView, LogFilter, LogPage, LogRow, PullRequestView, RepoView, TrailStep, WaitingResponse } from "./api-types.ts";
import { caseSlug, LANDING_CALLS, landingCaseSlug, OWNER_CALLS, type Case, type LandingCase, type LandingOwnerCall, type OwnerCall } from "./case-book.ts";
import { ciGreen } from "./landing.ts";
import { EFFORTS, type Effort } from "./model-runner.ts";
import { parsePins, pinsFile } from "./pins.ts";
import {
  appendEntry,
  callStatuses,
  criteriaOf,
  heldActions,
  HOST,
  isOwnerAction,
  isRepo,
  landingStatuses,
  latestCalls,
  latestLandings,
  loggedRepos,
  readLog,
  repoState,
  standingActions,
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
  type UndoneEntry,
} from "./records.ts";
import { collapseWhitespace, splitVisionLines } from "./vision.ts";

export type { CallView, PullRequestView } from "./api-types.ts";

/**
 * The owner's side: what waits on them, the log, the repos and their
 * settings, and the owner's three answers to a call (confirm it, override it
 * with a reason, answer its question). Both the board's API and the CLI come
 * through here. Every owner action is appended to the repo's log under the
 * owner's name at once. On the board it is held for a short window in which
 * the owner can undo it; once the window closes, entail writes it to the
 * owner's case book and acts on GitHub for it (see `src/watch.ts`).
 */

/** How long an action taken on the board can be undone before entail acts on it. */
export const HOLD_MS = 10_000;

/** An owner's request entail cannot carry out, with the HTTP status it answers to. */
export class OwnerError extends Error {
  readonly status: 400 | 404 | 409 | 502;
  constructor(status: 400 | 404 | 409 | 502, message: string) {
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

/**
 * Asks entail to judge the issues that were open when the repo was enrolled,
 * which it otherwise judges only once they are edited or mentioned.
 */
export function askBacklog(dataDirectory: string, repoText: string, by: string, issues: readonly number[], now = new Date()): number[] {
  const repo = repoName(repoText);
  const entries = readLog(dataDirectory, repo);
  if (!repoState(repo, entries).enrolled) throw new OwnerError(404, `${repo} is not enrolled`);
  const judged = latestCalls(entries);
  const wanted = [...new Set(issues)].filter((issue) => Number.isSafeInteger(issue) && issue > 0 && !judged.has(issue)).sort((a, b) => a - b);
  appendEntry(dataDirectory, repo, { type: "backlog", by, issues: wanted }, now);
  return wanted;
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

/** How many calls the owner must have checked, and how many of them confirmed, before the board suggests confirm mode off. */
export const CONFIRM_OFF_AFTER = { checked: 5, agreement: 0.8 } as const;

export interface RepoViewOptions {
  /** Every repo with a log, enrolled or not. */
  all?: boolean;
  /** When each repo was last checked in this run. */
  checkedAt?: (repo: string) => string | null;
}

export function repoViews(dataDirectory: string, settings: GlobalSettings, options: RepoViewOptions = {}): RepoView[] {
  return loggedRepos(dataDirectory).flatMap((repo) => {
    const entries = readLog(dataDirectory, repo);
    const state = repoState(repo, entries);
    if (!state.enrolled && options.all !== true) return [];
    const statuses = [...callStatuses(entries).values(), ...landingStatuses(entries).values()];
    // Only confirmations and overrides count toward agreement; answers to questions do not.
    const checked = statuses.filter((status) => status.status === "confirmed" || status.status === "overridden").length;
    const agreed = statuses.filter((status) => status.status === "confirmed").length;
    const lastVision = entries.findLast((entry): entry is CallEntry | LandingEntry => (entry.type === "call" || entry.type === "landing") && entry.vision !== null)?.vision ?? null;
    const file = pinsFile(dataDirectory, { host: HOST, path: repo });
    return [
      {
        ...state,
        uses: runSettings(state, settings),
        calls: entries.filter((entry) => (entry.type === "call" && entry.owner === null && entry.trigger !== "landing") || entry.type === "landing").length,
        waiting: statuses.filter((status) => status.status === "waiting").length,
        checked,
        agreed,
        suggestConfirmOff: state.confirm && checked >= CONFIRM_OFF_AFTER.checked && agreed / checked >= CONFIRM_OFF_AFTER.agreement,
        vision: lastVision === null ? null : { commit: lastVision.commit, url: `https://${HOST}/${repo}/blob/${lastVision.commit}/VISION.md` },
        pins: { file, topics: readPinsNow(file) },
        checkedAt: options.checkedAt?.(repo) ?? null,
        backlogAsked: entries.some((entry) => entry.type === "backlog" && entry.at >= (state.since ?? "")),
      },
    ];
  });
}

// What a call rests on, with links.

function readPinsNow(file: string): string[] {
  try {
    return parsePins(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

// A call as the owner reads it.

/** A call as the owner reads it, with links to the issue, the vision lines and the past cases it rests on. */
export function callView(repo: string, entry: CallEntry, status: CallStatus, entries: readonly Entry[], book: readonly Case[]): CallView {
  const acted = entries.find((other) => other.type === "acted" && other.for === entry.id);
  const chain = waitingChain(entry, entries);
  return {
    id: entry.id,
    kind: "issue",
    repo,
    issue: entry.issue,
    issueText: entry.issueText,
    body: issueBody(entry.issueText),
    visionCommit: entry.vision?.commit ?? null,
    call: entry.call.call,
    reason: entry.call.reason,
    criteria: criteriaOf(entry.call),
    question: entry.call.call === "ask" ? { question: entry.call.question, why: entry.call.why, large: entry.call.large } : null,
    restsOn: {
      visionLines: entry.call.restsOn.visionLines.map((text) => ({ text, ...visionLineLink(repo, entry, text) })),
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
    rejudged: chain.length > 1,
    waitingSince: chain.at(-1)!.at,
  };
}

/** A PR's call as the owner reads it. */
export function landingView(repo: string, entry: LandingEntry, status: CallStatus, entries: readonly Entry[], book: readonly Case[]): CallView {
  const settledBy = "action" in status ? status.action : null;
  // What entail did for this call, or for the owner's action on it.
  const acted = entries.findLast((other): other is PrActedEntry => other.type === "pr-acted" && (other.for === entry.id || other.for === settledBy?.id));
  const firstHead = entries.find((other): other is LandingEntry => other.type === "landing" && other.pr.number === entry.pr.number);
  const chain = landingChain(entry, entries);
  const { call } = entry;
  return {
    id: entry.id,
    kind: "pr",
    repo,
    issue: { ...entry.issue, author: "" },
    issueText: entry.issueText,
    body: issueBody(entry.prText),
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
    rejudged: chain.length > 1,
    waitingSince: chain.at(-1)!.at,
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
    visionLines: restsOn.visionLines.map((text) => ({ text, ...visionLineAt(repo, vision, text) })),
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

/**
 * The call and the calls on the same issue it replaced while they waited on
 * the owner, newest first: an issue edited while its item waits is judged
 * again and its item replaced in place, keeping its place in the order.
 */
function waitingChain(entry: CallEntry, entries: readonly Entry[]): CallEntry[] {
  const chain = [entry];
  if (entry.owner !== null) return chain;
  const { actions, callsByIssue } = indexOf(entries);
  const calls = callsByIssue.get(entry.issue.number) ?? [];
  const earlier = calls.slice(0, calls.indexOf(entry));
  for (let index = earlier.length - 1; index >= 0; index--) {
    const previous = earlier[index]!;
    const waited = previous.owner === null && !actions.has(previous.id) && (previous.call.call === "ask" || previous.confirm);
    if (!waited) break;
    chain.push(previous);
  }
  return chain;
}

/** The same for a PR: its call and the calls on earlier heads it replaced while they waited. */
function landingChain(entry: LandingEntry, entries: readonly Entry[]): LandingEntry[] {
  const chain = [entry];
  const { actions, landingsByPr } = indexOf(entries);
  const landings = landingsByPr.get(entry.pr.number) ?? [];
  const earlier = landings.slice(0, landings.indexOf(entry));
  for (let index = earlier.length - 1; index >= 0; index--) {
    const previous = earlier[index]!;
    if (actions.has(previous.id) || !(previous.call.call === "ask" || previous.confirm)) break;
    chain.push(previous);
  }
  return chain;
}

const indexes = new WeakMap<readonly Entry[], { actions: Map<number, OwnerAction>; callsByIssue: Map<number, CallEntry[]>; landingsByPr: Map<number, LandingEntry[]> }>();

/** What a log's views look up again and again, worked out once per log read. */
function indexOf(entries: readonly Entry[]) {
  let index = indexes.get(entries);
  if (index === undefined) {
    const callsByIssue = new Map<number, CallEntry[]>();
    const landingsByPr = new Map<number, LandingEntry[]>();
    for (const entry of entries) {
      if (entry.type === "call") callsByIssue.set(entry.issue.number, [...(callsByIssue.get(entry.issue.number) ?? []), entry]);
      if (entry.type === "landing") landingsByPr.set(entry.pr.number, [...(landingsByPr.get(entry.pr.number) ?? []), entry]);
    }
    index = { actions: standingActions(entries), callsByIssue, landingsByPr };
    indexes.set(entries, index);
  }
  return index;
}

/** The issue's body as judged: the issue text without its title line and its comments. */
export function issueBody(issueText: string): string {
  const withoutTitle = issueText.replace(/^# .*\n?/u, "");
  const comments = withoutTitle.search(/^## Comments$/mu);
  const body = (comments === -1 ? withoutTitle : withoutTitle.slice(0, comments)).trim();
  return body === "(no description)" ? "" : body;
}

/** A link to a vision line at the commit the call read it at, to the line when it is found. */
function visionLineLink(repo: string, entry: CallEntry, text: string): { url: string | null; line: number | null } {
  return visionLineAt(repo, entry.vision, text);
}

function visionLineAt(repo: string, vision: { commit: string; text: string } | null, text: string): { url: string | null; line: number | null } {
  if (vision === null) return { url: null, line: null };
  const entry = { vision };
  const base = `https://${HOST}/${repo}/blob/${entry.vision.commit}/VISION.md`;
  const wanted = collapseWhitespace(text.replace(/^>\s*/u, ""));
  const line = wanted === "" ? undefined : splitVisionLines(entry.vision.text).find((candidate) => candidate.identity.includes(wanted));
  return line === undefined ? { url: base, line: null } : { url: `${base}#L${line.lineNumber}`, line: line.lineNumber };
}

// What waits on the owner.

/** Everything waiting on the owner across enrolled repos, on issues and PRs: questions first, then calls to confirm, oldest first within each. */
export function waitingItems(dataDirectory: string, book: readonly Case[], repoFilter?: string): CallView[] {
  const items: { view: CallView; position: number }[] = [];
  for (const repo of loggedRepos(dataDirectory)) {
    if (repoFilter !== undefined && repo !== repoFilter) continue;
    const entries = readLog(dataDirectory, repo);
    if (!repoState(repo, entries).enrolled) continue;
    const statuses = callStatuses(entries);
    const landings = landingStatuses(entries);
    for (const entry of entries) {
      if (entry.type === "call") {
        const status = statuses.get(entry.id)!;
        // Calls made in the same moment keep the order they were logged in, counted from the first call of the item.
        if (status.status === "waiting") items.push({ view: callView(repo, entry, status, entries, book), position: entries.indexOf(waitingChain(entry, entries).at(-1)!) });
      } else if (entry.type === "landing") {
        const status = landings.get(entry.id)!;
        if (status.status === "waiting") items.push({ view: landingView(repo, entry, status, entries, book), position: entries.indexOf(landingChain(entry, entries).at(-1)!) });
      }
    }
  }
  const rank = (item: CallView) => (item.call === "ask" ? 0 : 1);
  return items
    .sort((a, b) => rank(a.view) - rank(b.view) || a.view.waitingSince.localeCompare(b.view.waitingSince) || a.position - b.position)
    .map((item) => item.view);
}

/**
 * What the board's Waiting page reads: the items waiting, the owner's actions
 * still in their undo window (so a reload or a second tab shows the receipt),
 * and how many calls entail acted on alone since `since`.
 */
export function waitingResponse(dataDirectory: string, book: readonly Case[], options: { repo?: string; since?: string; now: Date }): WaitingResponse {
  const held: HeldView[] = [];
  let count = 0;
  const repos = new Set<string>();
  for (const repo of loggedRepos(dataDirectory)) {
    if (options.repo !== undefined && repo !== options.repo) continue;
    const entries = readLog(dataDirectory, repo);
    if (!repoState(repo, entries).enrolled) continue;
    const statuses = callStatuses(entries);
    const landings = landingStatuses(entries);
    for (const action of heldActions(entries, options.now)) {
      const call = entries.find((entry): entry is CallEntry | LandingEntry => (entry.type === "call" || entry.type === "landing") && entry.id === action.call);
      if (call?.type === "call") held.push({ item: callView(repo, call, statuses.get(call.id)!, entries, book), action, holdUntil: action.holdUntil! });
      else if (call?.type === "landing") held.push({ item: landingView(repo, call, landings.get(call.id)!, entries, book), action, holdUntil: action.holdUntil! });
    }
    if (options.since !== undefined) {
      for (const entry of entries) {
        if ((entry.type === "call" || entry.type === "landing") && entry.at > options.since && (entry.type === "call" ? statuses : landings).get(entry.id)?.status === "auto") {
          count++;
          repos.add(repo);
        }
      }
    }
  }
  return { items: waitingItems(dataDirectory, book, options.repo), held, actedAlone: { count, repos: [...repos] } };
}

// The log, as the board pages it.

export interface LogPageOptions {
  repo?: string;
  filter?: LogFilter;
  /** Only days before this one, `YYYY-MM-DD`. */
  before?: string;
  /** The owner's time zone, which days are counted in. */
  timeZone?: string;
  /** A page holds whole days, and at least this many calls unless the log runs out. */
  rows?: number;
}

/**
 * One page of the log, newest first, in whole days: every call entail made,
 * with the owner's action on it, the call run again on the owner's word, and
 * the trail of what happened. Nothing is ever trimmed; older days are a
 * `before=` away.
 */
export function logPage(dataDirectory: string, book: readonly Case[], options: LogPageOptions = {}): LogPage {
  const dayOf = dayFormatter(options.timeZone);
  const all: LogRow[] = [];
  for (const repo of loggedRepos(dataDirectory)) {
    if (options.repo !== undefined && repo !== options.repo) continue;
    const entries = readLog(dataDirectory, repo);
    const statuses = callStatuses(entries);
    const landings = landingStatuses(entries);
    for (const entry of entries) {
      if (entry.type === "call" && entry.owner === null) all.push(logRow(repo, entry, statuses, entries, book, dayOf));
      else if (entry.type === "landing") all.push(landingRow(repo, entry, landings, entries, book, dayOf));
    }
  }
  const matches: Record<LogFilter, (row: LogRow) => boolean> = {
    all: () => true,
    waiting: (row) => row.call.status === "waiting",
    overridden: (row) => row.call.status === "overridden",
    questions: (row) => row.call.call === "ask",
    prs: (row) => row.call.kind === "pr",
  };
  const counts = Object.fromEntries((Object.keys(matches) as LogFilter[]).map((key) => [key, all.filter(matches[key]).length])) as Record<LogFilter, number>;
  const wanted = all
    .filter(matches[options.filter ?? "all"])
    .filter((row) => options.before === undefined || row.day < options.before)
    .sort((a, b) => b.call.judgedAt.localeCompare(a.call.judgedAt));
  const size = options.rows ?? 30;
  const rows: LogRow[] = [];
  let index = 0;
  while (index < wanted.length && (rows.length < size || wanted[index]!.day === rows.at(-1)!.day)) rows.push(wanted[index++]!);
  // `before` is exclusive: the next page starts on the day before this page's last.
  return { rows, next: index < wanted.length ? rows.at(-1)!.day : null, counts };
}

function dayFormatter(timeZone: string | undefined): (iso: string) => string {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", { timeZone: timeZone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    format = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
  }
  return (iso) => format.format(new Date(iso));
}

const TRIGGER_WORDS: Record<CallEntry["trigger"], string> = {
  landing: " after a PR was cancelled",
  new: "",
  edit: " after an edit",
  mention: " on an /entail comment",
  owner: " on the owner's word",
  backlog: " from the open backlog",
};

function logRow(repo: string, entry: CallEntry, statuses: Map<number, CallStatus>, entries: readonly Entry[], book: readonly Case[], dayOf: (iso: string) => string): LogRow {
  const call = callView(repo, entry, statuses.get(entry.id)!, entries, book);
  const trail: TrailStep[] = [{ at: entry.at, text: `Judged: ${entry.call.call}${TRIGGER_WORDS[entry.trigger]} · ${entry.model}, ${entry.effort}` }];
  const actedFor = (id: number) => entries.find((other) => other.type === "acted" && other.for === id);
  const posted = actedFor(entry.id);
  if (posted?.type === "acted") {
    trail.push({ at: posted.at, text: entry.call.call === "ask" ? "Posted a note on the issue that a question is waiting on the board" : posted.closed ? "Posted the call on the issue and closed it" : "Posted the call on the issue", url: posted.comment.url });
  }
  const undone = new Map(entries.filter((other): other is UndoneEntry => other.type === "undone").map((other) => [other.action, other]));
  let ownerCall: CallView | null = null;
  for (const action of entries.filter((other): other is OwnerAction => isOwnerAction(other) && other.call === entry.id)) {
    trail.push({ at: action.at, text: actionWords(action) });
    const undo = undone.get(action.id);
    if (undo !== undefined) {
      trail.push({ at: undo.at, text: `${undo.by} undid it; nothing was sent to GitHub` });
      continue;
    }
    const rerun = entries.find((other): other is CallEntry => other.type === "call" && other.owner?.action === action.id);
    if (rerun !== undefined) {
      ownerCall = callView(repo, rerun, statuses.get(rerun.id)!, entries, book);
      trail.push({ at: rerun.at, text: `Added to the case book; judged again on ${action.by}'s word, for the criteria` });
      const rerunPosted = actedFor(rerun.id);
      if (rerunPosted?.type === "acted") trail.push({ at: rerunPosted.at, text: `Posted ${action.by}'s go on the issue`, url: rerunPosted.comment.url });
    }
    const carried = actedFor(action.id);
    if (carried?.type === "acted") {
      trail.push({ at: carried.at, text: `Added to the case book; posted on the issue${carried.closed ? " and closed it" : ""}`, url: carried.comment.url });
    }
  }
  const status = statuses.get(entry.id)!;
  if (status.status === "superseded") {
    const by = entries.find((other) => other.id === status.by);
    if (by !== undefined) trail.push({ at: by.at, text: "Judged again after an edit" });
  }
  // Work started for this call: for entail's go, the owner's action on it, or the go run again on the owner's word.
  const ours = (id: number) => id === entry.id || isActionOn(entries, id, entry.id) || entries.some((other) => other.type === "call" && other.id === id && other.owner !== null && isActionOn(entries, other.owner.action, entry.id));
  for (const started of entries) {
    if (started.type !== "started") continue;
    const acted = entries.find((other) => other.type === "acted" && other.id === started.for);
    if (acted?.type !== "acted" || !ours(acted.for)) continue;
    trail.push({ at: started.at, text: started.exit === 0 ? `Started work: ${started.command}` : `The start command failed (${started.error ?? `exit ${started.exit}`}): ${started.command}` });
  }
  const reopened = entries.filter((other) => other.type === "reopened" && entries.some((act) => act.type === "acted" && act.id === other.after && act.issue === entry.issue.number && (act.for === entry.id || isActionOn(entries, act.for, entry.id))));
  for (const reopen of reopened) trail.push({ at: reopen.at, text: "Reopened on GitHub after entail closed it" });
  trail.sort((a, b) => a.at.localeCompare(b.at));
  return { day: dayOf(entry.at), call, ownerCall, reopened: reopened.length > 0, trail };
}

/** A PR's call in the log, with what followed it. */
function landingRow(repo: string, entry: LandingEntry, statuses: Map<number, CallStatus>, entries: readonly Entry[], book: readonly Case[], dayOf: (iso: string) => string): LogRow {
  const call = landingView(repo, entry, statuses.get(entry.id)!, entries, book);
  const trail: TrailStep[] = [{ at: entry.at, text: `Judged PR #${entry.pr.number}: ${entry.call.call} · ${entry.model}, ${entry.effort}` }];
  const actedFor = (id: number) => entries.find((other): other is PrActedEntry => other.type === "pr-acted" && other.for === id);
  const posted = actedFor(entry.id);
  if (posted !== undefined) trail.push({ at: posted.at, text: prActedWords(posted, entry.call.call), url: posted.comment.url });
  const undone = new Map(entries.filter((other): other is UndoneEntry => other.type === "undone").map((other) => [other.action, other]));
  for (const action of entries.filter((other): other is OwnerAction => isOwnerAction(other) && other.call === entry.id)) {
    trail.push({ at: action.at, text: actionWords(action) });
    const undo = undone.get(action.id);
    if (undo !== undefined) {
      trail.push({ at: undo.at, text: `${undo.by} undid it; nothing was sent to GitHub` });
      continue;
    }
    const carried = actedFor(action.id);
    if (carried !== undefined) trail.push({ at: carried.at, text: `Added to the case book; ${prActedWords(carried, action.type === "confirmed" ? entry.call.call : (action.to as LandingOwnerCall)).toLowerCase()}`, url: carried.comment.url });
  }
  const status = statuses.get(entry.id)!;
  if (status.status === "superseded") {
    const by = entries.find((other) => other.id === status.by);
    if (by !== undefined) trail.push({ at: by.at, text: "Judged again after a push" });
  }
  trail.sort((a, b) => a.at.localeCompare(b.at));
  return { day: dayOf(entry.at), call, ownerCall: null, reopened: false, trail };
}

function prActedWords(acted: PrActedEntry, call: string): string {
  if (acted.merged !== null) return "Merged the PR and commented on it";
  if (acted.closed) return "Closed the PR with the reason";
  if (acted.refused !== null) return `Did not merge: ${acted.refused}`;
  return acted.sentBack || call === "send-back" ? "Sent the PR back with a comment" : "Commented on the PR";
}

function isActionOn(entries: readonly Entry[], actionId: number, callId: number): boolean {
  return entries.some((entry) => isOwnerAction(entry) && entry.id === actionId && entry.call === callId);
}

function actionWords(action: OwnerAction): string {
  if (action.type === "confirmed") return `${action.by} confirmed`;
  if (action.type === "overridden") return `${action.by} overrode: ${action.differently === true ? "go, differently" : action.to}`;
  return `${action.by} answered: ${action.to}`;
}

/** The log of one repo, or of every repo, oldest first, every entry: for `entail calls`. */
export type LogItem =
  | ({ kind: "call" } & Omit<CallView, "kind"> & { callKind: CallView["kind"] })
  | { kind: "owner"; repo: string; at: string; action: OwnerAction; issue: CallEntry["issue"] | null; pr: LandingEntry["pr"] | null }
  | { kind: "acted"; repo: string; at: string; for: number; issue: number; url: string; closed: boolean }
  /** entail ran the start command for a go that acted. */
  | { kind: "started"; repo: string; at: string; issue: number; command: string; exit: number | null; error: string | null }
  /** entail acted on a PR: posted, and merged or closed it if it was to. */
  | { kind: "pr-acted"; repo: string; at: string; for: number; pr: number; url: string; merged: PrActedEntry["merged"]; refused: string | null; sentBack: boolean; closed: boolean }
  /** entail started or stopped following a PR. */
  | { kind: "pr"; repo: string; at: string; entry: Extract<Entry, { type: "followed" | "unfollowed" | "landing-failed" }> }
  | { kind: "repo"; repo: string; at: string; entry: Extract<Entry, { type: "enrolled" | "unenrolled" | "settings" | "undone" | "backlog" | "reopened" }> };

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
        case "started":
          items.push({ kind: "started", repo, at: entry.at, issue: entry.issue, command: entry.command, exit: entry.exit, error: entry.error ?? null });
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

/** How an owner's action is taken: on the board it is held for {@link HOLD_MS} so it can be undone. */
export interface ActOptions {
  /** How long the action can be undone before entail acts on it; 0, the default, acts on the next pass. */
  holdMs?: number;
}

/**
 * Confirms a call waiting in confirm mode, on an issue (go or no) or a PR
 * (merge or send-back): entail then acts on it as it stands.
 */
export async function confirmCall(dataDirectory: string, id: number, by: string, now = new Date(), options: ActOptions = {}): Promise<ConfirmedEntry> {
  const found = findItem(dataDirectory, id);
  if (found.entry.type === "landing") {
    const status = landingStatuses(found.entries).get(id)!;
    if (found.entry.call.call === "ask") throw new OwnerError(409, `call ${id} is a question: answer it`);
    if (status.status !== "waiting") throw new OwnerError(409, `call ${id} is not waiting to be confirmed (${status.status})`);
    return record(dataDirectory, found.repo, { type: "confirmed", by, call: id }, now, options);
  }
  const { repo, entries, entry: call } = found;
  const status = statusOf(entries, call);
  if (call.call.call === "ask") throw new OwnerError(409, `call ${id} is a question: answer it`);
  if (status.status === "superseded") throw new OwnerError(409, `the issue was edited and entail judged it again: read the new call`);
  if (status.status !== "waiting") throw new OwnerError(409, `call ${id} is not waiting to be confirmed (${status.status})`);
  return record(dataDirectory, repo, { type: "confirmed", by, call: id }, now, options);
}

export interface OverrideOptions extends ActOptions {
  /** Keep entail's go, but with the owner's line as its one criterion instead of entail's. */
  differently?: boolean;
}

/**
/**
 * Replaces a call with the owner's own call and reason: go or no on an
 * issue, merge or send-back on a PR. A call that entail already acted on can
 * be overridden too; one judged again since cannot, and neither can a
 * question, which is answered. A go can be overridden with a go made
 * differently: the owner's line becomes, word for word, the criterion the PR
 * must meet. That is for an issue's go only.
 */
export async function overrideCall(dataDirectory: string, id: number, by: string, to: unknown, reason: unknown, now = new Date(), options: OverrideOptions = {}): Promise<OverriddenEntry> {
  const found = findItem(dataDirectory, id);
  if (found.entry.type === "landing") {
    const landing = found.entry;
    if (options.differently === true) throw new OwnerError(409, `only a go on an issue can be made differently`);
    const owner = landingOwnerCall(to);
    const words = ownerWords(reason, "a reason");
    const status = landingStatuses(found.entries).get(id)!;
    if (landing.call.call === "ask") throw new OwnerError(409, `call ${id} is a question: answer it`);
    if (status.status === "superseded") throw new OwnerError(409, `call ${id} was replaced by a newer call on the PR`);
    if (status.status === "closed") throw new OwnerError(409, `the PR of call ${id} is merged or closed`);
    if (status.status === "overridden" || status.status === "answered") throw new OwnerError(409, `call ${id} is already the owner's (${status.status})`);
    if (status.status === "confirmed") throw new OwnerError(409, `call ${id} was confirmed`);
    if (owner === landing.call.call) throw new OwnerError(409, `call ${id} is already ${owner}; confirm it instead`);
    return record(dataDirectory, found.repo, { type: "overridden", by, call: id, to: owner, reason: words }, now, options);
  }
  const { repo, entries, entry: call } = found;
  const owner = ownerCall(to);
  const words = ownerWords(reason, options.differently === true ? "the line that becomes the criterion" : "a reason");
  const status = statusOf(entries, call);
  if (call.call.call === "ask" && call.owner === null) throw new OwnerError(409, `call ${id} is a question: answer it`);
  if (status.status === "superseded") throw new OwnerError(409, `the issue was edited and entail judged it again: read the new call`);
  if (status.status === "overridden" || status.status === "answered") throw new OwnerError(409, `call ${id} is already the owner's (${status.status})`);
  if (status.status === "confirmed") throw new OwnerError(409, `call ${id} was confirmed`);
  const effective = call.owner?.call ?? call.call.call;
  if (options.differently === true) {
    if (owner !== "go" || effective !== "go") throw new OwnerError(409, `only a go can be overridden with a go made differently`);
    return record(dataDirectory, repo, { type: "overridden", by, call: id, to: "go", reason: words, differently: true }, now, options);
  }
  if (owner === effective) throw new OwnerError(409, `call ${id} is already ${owner}; confirm it instead`);
  return record(dataDirectory, repo, { type: "overridden", by, call: id, to: owner, reason: words }, now, options);
}

/**
 * Answers a call's question with the owner's call and words: go or no on an
 * issue, where a go runs the judgment again with the answer; merge or
 * send-back on a PR.
 */
export async function answerCall(dataDirectory: string, id: number, by: string, to: unknown, answer: unknown, now = new Date(), options: ActOptions = {}): Promise<AnsweredEntry> {
  const found = findItem(dataDirectory, id);
  if (found.entry.type === "landing") {
    const owner = landingOwnerCall(to);
    const words = ownerWords(answer, "an answer");
    const status = landingStatuses(found.entries).get(id)!;
    if (found.entry.call.call !== "ask") throw new OwnerError(409, `call ${id} is a ${found.entry.call.call}, not a question: confirm or override it`);
    if (status.status !== "waiting") throw new OwnerError(409, `call ${id} is not waiting for an answer (${status.status})`);
    return record(dataDirectory, found.repo, { type: "answered", by, call: id, to: owner, answer: words }, now, options);
  }
  const { repo, entries, entry: call } = found;
  const owner = ownerCall(to);
  const words = ownerWords(answer, "an answer");
  const status = statusOf(entries, call);
  if (call.call.call !== "ask") throw new OwnerError(409, `call ${id} is a ${call.call.call}, not a question: confirm or override it`);
  if (status.status === "superseded") throw new OwnerError(409, `the issue was edited and entail judged it again: read the new question`);
  if (status.status !== "waiting") throw new OwnerError(409, `call ${id} is not waiting for an answer (${status.status})`);
  return record(dataDirectory, repo, { type: "answered", by, call: id, to: owner, answer: words }, now, options);
}

/**
 * Undoes the owner's action on a call while it is still held. Once the
 * window has closed entail is acting on it, and it can no longer be undone
 * here; it can be overridden instead.
 */
export function undoAction(dataDirectory: string, id: number, by: string, now = new Date()): { undone: ActionView; call: CallView } {
  const { repo, entries, entry } = findItem(dataDirectory, id);
  const action = standingActions(entries).get(entry.id);
  if (action === undefined) throw new OwnerError(409, `nothing on call ${id} to undo`);
  const acted = entries.some(
    (other) => ((other.type === "acted" || other.type === "pr-acted") && other.for === action.id) || (other.type === "call" && other.owner?.action === action.id),
  );
  if (acted || action.holdUntil === undefined || Date.parse(action.holdUntil) <= now.getTime()) {
    throw new OwnerError(409, "too late to undo: entail is already acting on it; override the call instead");
  }
  appendEntry(dataDirectory, repo, { type: "undone", by, action: action.id }, now);
  const after = readLog(dataDirectory, repo);
  const view = entry.type === "call" ? callView(repo, entry, statusOf(after, entry), after, []) : landingView(repo, entry, landingStatuses(after).get(entry.id)!, after, []);
  return { undone: action, call: view };
}

type NewOwnerAction = Omit<ConfirmedEntry, "id" | "at"> | Omit<OverriddenEntry, "id" | "at"> | Omit<AnsweredEntry, "id" | "at">;

function record<E extends NewOwnerAction>(dataDirectory: string, repo: string, entry: E, now: Date, options: ActOptions): E & { id: number; at: string } {
  const holdMs = options.holdMs ?? 0;
  const held = holdMs > 0 ? { ...entry, holdUntil: new Date(now.getTime() + holdMs).toISOString() } : entry;
  return appendEntry(dataDirectory, repo, held, now) as E & { id: number; at: string };
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
  if (action.type === "overridden" && action.differently === true) {
    notes.push(`## entail's go, made differently\n\nentail called go: ${call.call.reason}\n\n${action.by} kept the go and replaced its criteria with their line above, word for word.`);
  } else if (action.type === "overridden") {
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
        ? action.differently === true
          ? `${action.by}'s go made differently on the board, quoted below; their line is the criterion`
          : `${action.by}'s override on the board, quoted below; the one-line reason is its first paragraph`
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
        if (action.type === "overridden") lines.push(`${at}  ${where(issue)}  OVERRIDDEN by ${action.by} to ${action.differently === true ? "go, differently" : action.to} (call ${action.call})`, `      ${oneLine(action.reason)}`);
        if (action.type === "answered") lines.push(`${at}  ${where(issue)}  ANSWERED by ${action.by}: ${action.to} (call ${action.call})`, `      ${oneLine(action.answer)}`);
        break;
      }
      case "acted":
        lines.push(`${at}  ${where(item.issue)}  posted ${item.url}${item.closed ? " and closed the issue" : ""}`);
        break;
      case "started":
        lines.push(`${at}  ${where(item.issue)}  ${item.exit === 0 ? "started work with" : "the start command failed"}: ${item.command}${item.exit === 0 ? "" : ` (${item.error ?? `exit ${item.exit}`})`}`);
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
        if (entry.type === "undone") lines.push(`${at}  ${where(null) || item.repo}  ${entry.by} undid their action ${entry.action}; nothing was sent to GitHub`);
        if (entry.type === "backlog") lines.push(`${at}  ${where(null) || item.repo}  ${entry.by} asked entail to judge the open backlog: ${entry.issues.length === 0 ? "nothing left to judge" : entry.issues.map((issue) => `#${issue}`).join(", ")}`);
        if (entry.type === "reopened") lines.push(`${at}  ${where(entry.issue)}  reopened on GitHub after entail closed it`);
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
