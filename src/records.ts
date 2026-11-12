import { randomInt } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OwnerCall } from "./case-book.ts";
import type { Criterion, IssueCall } from "./judgment.ts";
import { DEFAULT_EFFORT, EFFORTS, type Effort } from "./model-runner.ts";

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

/** What made entail judge an issue. */
export type Trigger = "new" | "edit" | "mention" | "owner";

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
  issue: { number: number; title: string; url: string; author: string };
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

/** The owner confirmed a call as it stands. */
export interface ConfirmedEntry extends EntryBase, ByOwner {
  type: "confirmed";
  call: number;
}

/** The owner replaced a call with their own, with their reason. */
export interface OverriddenEntry extends EntryBase, ByOwner {
  type: "overridden";
  call: number;
  to: OwnerCall;
  reason: string;
}

/** The owner answered a call's question, and made the call with it. */
export interface AnsweredEntry extends EntryBase, ByOwner {
  type: "answered";
  call: number;
  to: OwnerCall;
  answer: string;
}

/** entail acted on GitHub for an entry: its comment posted, and the issue closed if it was to be. */
export interface ActedEntry extends EntryBase {
  type: "acted";
  for: number;
  issue: number;
  comment: { id: number; url: string };
  closed: boolean;
}

export type OwnerAction = ConfirmedEntry | OverriddenEntry | AnsweredEntry;

export type Entry = EnrolledEntry | UnenrolledEntry | SettingsEntry | CallEntry | OwnerAction | ActedEntry;

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

/** Settings for every repo: the owner's name on comments, and the model and effort a repo uses unless it names its own. */
export interface GlobalSettings {
  /** The owner's display name, as comments name them; the logged-in GitHub username when unset. */
  owner: string | null;
  model: string;
  effort: Effort;
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
  /** The issue was judged again before the owner settled this call. */
  | { status: "superseded"; by: number };

/** Each call in a log with where it stands, oldest first. */
export function callStatuses(entries: readonly Entry[]): Map<number, CallStatus> {
  const actions = new Map<number, OwnerAction>();
  const latestByIssue = new Map<number, number>();
  for (const entry of entries) {
    if ((entry.type === "confirmed" || entry.type === "overridden" || entry.type === "answered") && !actions.has(entry.call)) actions.set(entry.call, entry);
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
  /** An override to go or a go answer, waiting for the judgment to run again on the owner's word. */
  | { kind: "rerun"; action: OverriddenEntry | AnsweredEntry; call: CallEntry };

/**
 * What entail has yet to do on GitHub, in log order: calls to post (only an
 * issue's latest call; one judged again before it was posted is not posted),
 * confirmations to post, owner's calls of no to post and close, and owner's
 * calls of go whose judgment has to run again on the owner's word.
 */
export function pendingWork(entries: readonly Entry[]): Pending[] {
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
    if (entry.type !== "confirmed" && entry.type !== "overridden" && entry.type !== "answered") continue;
    const call = calls.get(entry.call);
    if (call === undefined) continue;
    if (entry.type === "confirmed") pending.push({ kind: "confirmed", action: entry, call });
    else if (entry.to === "no") pending.push({ kind: "owner-no", action: entry, call });
    else if (!rerunFor.has(entry.id)) pending.push({ kind: "rerun", action: entry, call });
  }
  return pending;
}

/** The criteria a call carries, none for a no. */
export function criteriaOf(call: IssueCall): Criterion[] {
  return call.call === "no" ? [] : call.criteria;
}
