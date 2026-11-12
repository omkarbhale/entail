import { randomInt } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ForgeFacts, LandingOwnerCall, OwnerCall } from "./case-book.ts";
import type { Criterion, IssueCall } from "./judgment.ts";
import type { LandingCall } from "./landing.ts";
import { DEFAULT_EFFORT, EFFORTS, type Effort } from "./model-runner.ts";
import type { Handoff } from "./starts.ts";

/**
 * What entail decided and what the owner said back, one append-only log per
 * repo: `log/<host>/<owner>/<name>.jsonl` in the data directory, one JSON
 * entry per line. Nothing is ever rewritten; everything the board and
 * `entail calls` show (whether a repo is enrolled, its settings, what waits
 * on the owner, what is still to post) is derived from the log.
 *
 * Every entry has an id, a random positive integer. An entry that entail
 * acts on GitHub for carries its id in the hidden marker of the comment it
 * posts, so a restart finds the comment it already posted and never posts it
 * twice.
 */

export const LOG_DIRECTORY = "log";

/** The repos entail serves, all on github.com for now. */
export const HOST = "github.com";

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

/** A change to the repo's settings. A model or effort of null means the default. */
export interface SettingsEntry extends EntryBase, ByOwner {
  type: "settings";
  confirm?: boolean;
  model?: string | null;
  effort?: Effort | null;
}

/**
 * What made entail judge an issue. `landing` is not a run: it is the
 * question a cancelled PR leaves for the owner when what blocked it was a
 * product call. `backlog` is the owner asking for the open backlog.
 */
export type Trigger = "new" | "edit" | "mention" | "owner" | "landing" | "backlog";

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
  /** The default branch's commit the repo was read at. */
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
}

/** A PR as the log names it. */
export interface PullRequestRef {
  number: number;
  title: string;
  url: string;
  author: string;
}

/** entail follows a PR: the forge says it closes an issue entail called go on. */
export interface FollowedEntry extends EntryBase {
  type: "followed";
  pr: PullRequestRef;
  issue: number;
}

/** entail stopped following a PR: it was merged or closed, by entail or anyone else. */
export interface UnfollowedEntry extends EntryBase {
  type: "unfollowed";
  pr: number;
  state: "merged" | "closed";
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
  issue: { number: number; title: string; url: string };
  /** The call on the issue whose criteria the PR was judged against. */
  issueCall: number;
  issueText: string;
  /** The PR's title and description as judged: its author's words. */
  prText: string;
  /** The PR's head commit judged; a merge happens at it and nowhere else. */
  head: string;
  /** The default branch's commit the diff was taken against. */
  base: string;
  vision: { commit: string; text: string } | null;
  /** The criteria the issue's go set, which the PR was judged against. */
  criteria: Criterion[];
  /** CI and the changed files, read from the forge at the head. */
  facts: ForgeFacts;
  /** What the changed files touch that only the owner can let merge. */
  touched: { vision: boolean; pins: string[] };
  call: LandingCall;
  /** How many send-backs entail had posted on the PR before this call. */
  sendBacks: number;
  /** A send-back past the limit: the PR is closed with the reason instead. */
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
}

/**
 * What every owner's action carries besides its words. An action taken on
 * the board is held for a short window (`holdUntil`, ISO) in which the owner
 * can undo it; entail acts on GitHub for it only once the window has closed.
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
  reason: string;
  differently?: true;
}

/** The owner answered a call's question, and made the call with it. */
export interface AnsweredEntry extends EntryBase, ByOwner, Held {
  type: "answered";
  call: number;
  /** go or no on an issue's call; merge or send-back on a PR's. */
  to: OwnerCall | LandingOwnerCall;
  answer: string;
}

/** The owner undid one of their actions while it was held: entail acts on it neither on GitHub nor in the case book. */
export interface UndoneEntry extends EntryBase, ByOwner {
  type: "undone";
  action: number;
}

/** The owner asked entail to judge the issues that were open when the repo was enrolled. */
export interface BacklogEntry extends EntryBase, ByOwner {
  type: "backlog";
  issues: number[];
}

/** Someone reopened on GitHub an issue entail had closed: recorded, not taken as the owner's word. */
export interface ReopenedEntry extends EntryBase {
  type: "reopened";
  issue: number;
  /** The acted entry whose close was undone on GitHub. */
  after: number;
}

/** entail acted on GitHub for an entry: its comment posted, and the issue closed if it was to be. */
export interface ActedEntry extends EntryBase {
  type: "acted";
  for: number;
  issue: number;
  comment: { id: number; url: string };
  closed: boolean;
  /** Set when this act is a go acting and a start command was set: the work to start, run once (see `src/starts.ts`). */
  start?: { command: string; handoff: Handoff };
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
  | StartedEntry;

/** An entry as written, before it has an id and a time. */
export type NewEntry = Entry extends infer E ? (E extends Entry ? Omit<E, "id" | "at"> : never) : never;

/** The log file of a repo, `owner/name`. */
export function logFile(dataDirectory: string, repo: string): string {
  const [owner, name, ...rest] = repo.split("/");
  if (owner === undefined || name === undefined || rest.length > 0 || !REPO_PART.test(owner) || !REPO_PART.test(name)) {
    throw new RangeError(`not a repo: ${repo} (expected owner/name)`);
  }
  return join(dataDirectory, LOG_DIRECTORY, HOST, owner.toLowerCase(), `${name.toLowerCase()}.jsonl`);
}

const REPO_PART = /^(?!\.{1,2}$)[\w.-]+$/u;

/** Whether `text` names a repo as `owner/name`. */
export function isRepo(text: string): boolean {
  try {
    logFile("/", text);
    return true;
  } catch {
    return false;
  }
}

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

/** Every repo that has a log, enrolled or not, as `owner/name`. */
export function loggedRepos(dataDirectory: string): string[] {
  const root = join(dataDirectory, LOG_DIRECTORY, HOST);
  const repos: string[] = [];
  for (const owner of safeReaddir(root)) {
    for (const file of safeReaddir(join(root, owner))) {
      if (file.endsWith(".jsonl")) repos.push(`${owner}/${file.slice(0, -".jsonl".length)}`);
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

/** Settings for every repo: the owner's name on comments, the model and effort a repo uses unless it names its own, and where notices go. */
export interface GlobalSettings {
  /** The owner's display name, as comments name them; the logged-in GitHub username when unset. */
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
}

export function repoState(repo: string, entries: readonly Entry[]): RepoState {
  const state: RepoState = { repo, enrolled: false, since: null, confirm: true, model: null, effort: null };
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
    if (entry.type === "call") for (const mention of entry.mentions) seen.add(mentionKey(mention));
  }
  return seen;
}

export function mentionKey(mention: Pick<Mention, "id" | "updatedAt">): string {
  return `${mention.id}@${Date.parse(mention.updatedAt)}`;
}

/** An entry entail still has to act on GitHub for, in log order. */
export type Pending =
  | { kind: "call"; entry: CallEntry }
  | { kind: "confirmed"; action: ConfirmedEntry; call: CallEntry }
  /** An override to no or a no answer: closed with the owner's words. */
  | { kind: "owner-no"; action: OverriddenEntry | AnsweredEntry; call: CallEntry }
  /** A go, but differently: posted with the owner's line as its criterion, with no judgment run again. */
  | { kind: "owner-go"; action: OverriddenEntry; call: CallEntry }
  /** An override to go or a go answer, waiting for the judgment to run again on the owner's word. */
  | { kind: "rerun"; action: OverriddenEntry | AnsweredEntry; call: CallEntry };

/**
 * What entail has yet to do on GitHub, in log order: calls to post (only an
 * issue's latest call; one judged again before it was posted is not posted),
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
  const pending: Pending[] = [];
  for (const entry of entries) {
    if (acted.has(entry.id)) continue;
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

/** The acted entries whose work is still to start, in log order: each with a start and no `started` entry for it. */
export function pendingStarts(entries: readonly Entry[]): (ActedEntry & { start: NonNullable<ActedEntry["start"]> })[] {
  const started = new Set(entries.flatMap((entry) => (entry.type === "started" ? [entry.for] : [])));
  return entries.filter((entry): entry is ActedEntry & { start: NonNullable<ActedEntry["start"]> } => entry.type === "acted" && entry.start !== undefined && !started.has(entry.id));
}

/** Whether work on an issue was started already: its start command exited 0, or a start is still to run. */
export function workStarted(entries: readonly Entry[], issue: number): boolean {
  const started = new Map(entries.flatMap((entry) => (entry.type === "started" ? [[entry.for, entry] as const] : [])));
  return entries.some((entry) => entry.type === "acted" && entry.issue === issue && entry.start !== undefined && (started.get(entry.id)?.exit ?? 0) === 0);
}

/** The owner's actions still held, not undone and not yet acted on, with when their windows close. */
export function heldActions(entries: readonly Entry[], now: Date): OwnerAction[] {
  const undone = undoneActions(entries);
  return entries.filter((entry): entry is OwnerAction => isOwnerAction(entry) && !undone.has(entry.id) && isHeld(entry, now));
}

/** The criteria a call carries, none for a no. */
export function criteriaOf(call: IssueCall): Criterion[] {
  return call.call === "no" ? [] : call.criteria;
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

/** A landing call or an owner's action on one that entail still has to act on GitHub for. */
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
