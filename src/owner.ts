import { join } from "node:path";
import { caseSlug, OWNER_CASE_BOOK, OWNER_CALLS, writeCase, type Case, type OwnerCall } from "./case-book.ts";
import type { Criterion } from "./judgment.ts";
import { EFFORTS, type Effort } from "./model-runner.ts";
import {
  appendEntry,
  callStatuses,
  criteriaOf,
  HOST,
  isRepo,
  latestCalls,
  loggedRepos,
  readLog,
  repoState,
  type AnsweredEntry,
  type CallEntry,
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
    const statuses = [...callStatuses(entries).values()];
    return [
      {
        ...state,
        uses: runSettings(state, settings),
        calls: entries.filter((entry) => entry.type === "call" && entry.owner === null).length,
        waiting: statuses.filter((status) => status.status === "waiting").length,
        checked: statuses.filter((status) => status.status === "confirmed" || status.status === "overridden").length,
        agreed: statuses.filter((status) => status.status === "confirmed").length,
      },
    ];
  });
}

// What a call rests on, with links.

export interface CallView {
  id: number;
  repo: string;
  issue: { number: number; title: string; url: string; author: string };
  /** The issue as the judgment read it: title, body and comments, as markdown. */
  issueText: string;
  /** The commit VISION.md was read at, or null when the repo had none. */
  visionCommit: string | null;
  call: "go" | "no" | "ask";
  reason: string;
  criteria: Criterion[];
  /** For ask: the question and what makes it one. */
  question: { question: string; why: string; large: boolean } | null;
  restsOn: { visionLines: { text: string; url: string | null }[]; cases: { slug: string; title: string; url: string | null }[] };
  judgedAt: string;
  trigger: CallEntry["trigger"];
  /** The owner's word this call was run on, when it was. */
  owner: CallEntry["owner"];
  model: string;
  effort: Effort;
  costUsd: number | null;
  confirmMode: boolean;
  status: CallStatus["status"];
  /** The owner's action on it, when there is one. */
  settledBy: OwnerAction | null;
  /** The comment entail posted for it, once posted. */
  posted: { url: string; closed: boolean } | null;
}

/** A call as the owner reads it, with links to the issue, the vision lines and the past cases it rests on. */
export function callView(repo: string, entry: CallEntry, status: CallStatus, entries: readonly Entry[], book: readonly Case[]): CallView {
  const acted = entries.find((other) => other.type === "acted" && other.for === entry.id);
  return {
    id: entry.id,
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
  };
}

/** A link to a vision line at the commit the call read it at, to the line when it is found. */
function visionLineUrl(repo: string, entry: CallEntry, text: string): string | null {
  if (entry.vision === null) return null;
  const base = `https://${HOST}/${repo}/blob/${entry.vision.commit}/VISION.md`;
  const wanted = collapseWhitespace(text.replace(/^>\s*/u, ""));
  const line = wanted === "" ? undefined : splitVisionLines(entry.vision.text).find((candidate) => candidate.identity.includes(wanted));
  return line === undefined ? base : `${base}#L${line.lineNumber}`;
}

// What waits on the owner, and the log.

/** Everything waiting on the owner across enrolled repos: questions first, then calls to confirm, oldest first within each. */
export function waitingItems(dataDirectory: string, book: readonly Case[], repoFilter?: string): CallView[] {
  const items: CallView[] = [];
  for (const repo of loggedRepos(dataDirectory)) {
    if (repoFilter !== undefined && repo !== repoFilter) continue;
    const entries = readLog(dataDirectory, repo);
    if (!repoState(repo, entries).enrolled) continue;
    const statuses = callStatuses(entries);
    for (const entry of entries) {
      if (entry.type !== "call") continue;
      const status = statuses.get(entry.id)!;
      if (status.status === "waiting") items.push(callView(repo, entry, status, entries, book));
    }
  }
  const rank = (item: CallView) => (item.call === "ask" ? 0 : 1);
  return items.sort((a, b) => rank(a) - rank(b) || a.judgedAt.localeCompare(b.judgedAt));
}

/** One line of the log as the owner reads it. */
export type LogItem =
  | ({ kind: "call" } & CallView)
  | { kind: "owner"; repo: string; at: string; action: OwnerAction; issue: CallEntry["issue"] | null }
  | { kind: "acted"; repo: string; at: string; for: number; issue: number; url: string; closed: boolean }
  | { kind: "repo"; repo: string; at: string; entry: Exclude<Entry, CallEntry | OwnerAction | { type: "acted" }> };

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
    const calls = new Map(entries.flatMap((entry) => (entry.type === "call" ? [[entry.id, entry] as const] : [])));
    for (const entry of entries) {
      switch (entry.type) {
        case "call":
          items.push({ kind: "call", ...callView(repo, entry, statuses.get(entry.id)!, entries, book) });
          break;
        case "confirmed":
        case "overridden":
        case "answered":
          items.push({ kind: "owner", repo, at: entry.at, action: entry, issue: calls.get(entry.call)?.issue ?? null });
          break;
        case "acted":
          items.push({ kind: "acted", repo, at: entry.at, for: entry.for, issue: entry.issue, url: entry.comment.url, closed: entry.closed });
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
  for (const repo of loggedRepos(dataDirectory)) {
    const entries = readLog(dataDirectory, repo);
    const call = entries.find((entry): entry is CallEntry => entry.type === "call" && entry.id === id);
    if (call) return { repo, entries, call };
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

function statusOf(entries: readonly Entry[], call: CallEntry): CallStatus {
  return callStatuses(entries).get(call.id)!;
}

function ownerCall(text: unknown): OwnerCall {
  if (!(OWNER_CALLS as readonly unknown[]).includes(text)) throw new OwnerError(400, "the call is go or no");
  return text as OwnerCall;
}

function ownerWords(text: unknown, what: string): string {
  if (typeof text !== "string" || text.trim() === "") throw new OwnerError(400, `${what} is required`);
  return text.trim();
}

/** Confirms a go or no waiting in confirm mode: entail then acts on it as it stands. */
export async function confirmCall(dataDirectory: string, id: number, by: string, now = new Date()): Promise<ConfirmedEntry> {
  const { repo, entries, call } = findCall(dataDirectory, id);
  const status = statusOf(entries, call);
  if (call.call.call === "ask") throw new OwnerError(409, `call ${id} is a question: answer it`);
  if (status.status !== "waiting") throw new OwnerError(409, `call ${id} is not waiting to be confirmed (${status.status})`);
  const action = await act(dataDirectory, repo, call, { type: "confirmed", by, call: id }, now);
  return action;
}

/**
 * Replaces a go or no with the owner's own call and reason. A call that
 * entail already acted on can be overridden too; one judged again since
 * cannot, and neither can a question, which is answered.
 */
export async function overrideCall(dataDirectory: string, id: number, by: string, to: unknown, reason: unknown, now = new Date()): Promise<OverriddenEntry> {
  const { repo, entries, call } = findCall(dataDirectory, id);
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

/** Answers a call's question with the owner's call and words; on go the judgment runs again with the answer. */
export async function answerCall(dataDirectory: string, id: number, by: string, to: unknown, answer: unknown, now = new Date()): Promise<AnsweredEntry> {
  const { repo, entries, call } = findCall(dataDirectory, id);
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
    call: action.to,
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
        const issue = item.issue?.number ?? null;
        if (action.type === "confirmed") lines.push(`${at}  ${where(issue)}  CONFIRMED by ${action.by} (call ${action.call})`);
        if (action.type === "overridden") lines.push(`${at}  ${where(issue)}  OVERRIDDEN by ${action.by} to ${action.to} (call ${action.call})`, `      ${oneLine(action.reason)}`);
        if (action.type === "answered") lines.push(`${at}  ${where(issue)}  ANSWERED by ${action.by}: ${action.to} (call ${action.call})`, `      ${oneLine(action.answer)}`);
        break;
      }
      case "acted":
        lines.push(`${at}  ${where(item.issue)}  posted ${item.url}${item.closed ? " and closed the issue" : ""}`);
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

function statusLine(item: CallView): string {
  switch (item.status) {
    case "waiting":
      return item.call === "ask" ? "waiting for the owner's answer" : "waiting for the owner to confirm";
    case "auto":
      return "acted on at once (confirm mode off)";
    case "owner":
      return "the owner's call";
    case "superseded":
      return "judged again before the owner settled it";
    default:
      return `${item.status} by ${item.settledBy?.by ?? "the owner"}`;
  }
}

/** What waits on the owner, as text. */
export function formatWaiting(items: readonly CallView[]): string {
  if (items.length === 0) return "Nothing is waiting on you.";
  const blocks = items.map((item) => {
    const lines = [`${item.repo}#${item.issue.number}: ${item.issue.title}`, `  ${item.issue.url}`];
    if (item.call === "ask") {
      lines.push(`  QUESTION (call ${item.id}): ${item.question!.question}`, `  Why it is a question: ${item.question!.why}`, `  entail's reasoning: ${item.reason}`);
    } else {
      lines.push(`  ${item.call.toUpperCase()}, to confirm (call ${item.id}): ${item.reason}`);
    }
    for (const line of item.restsOn.visionLines) lines.push(`  rests on the vision: > ${line.text}`);
    for (const past of item.restsOn.cases) lines.push(`  rests on case ${past.slug}${past.url === null ? "" : ` (${past.url})`}`);
    for (const criterion of item.criteria) lines.push(`  criterion [${criterion.source}]: ${criterion.criterion}`);
    return lines.join("\n");
  });
  return blocks.join("\n\n");
}
