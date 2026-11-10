import {
  AGAINST_VISION_WARNING,
  ANSWER_FIELDS,
  answerComment,
  answerOf,
  answerOutcome,
  answerPostsComment,
  answerWords,
  draftFrom,
  goesAgainstVisionLine,
  itemVersion,
  recordBoardAnswer,
  refusalFor,
  refusalText,
  stepFrom,
  versionFrom,
  type ChosenAnswer,
  type GivenAnswer,
} from "./answer.ts";
import { answersInForce } from "./after-answer.ts";
import {
  BOARD_ANSWER_PATH,
  BOARD_DATA_PATH,
  BOARD_PATH,
  BOARD_POLL_MS,
  ITEM_PARAM,
  type AnswerReply,
  type BoardData,
  type BoardDetail,
  type BoardItemStatus,
  type HappenedEvent,
  type ItemState,
  type ItemView,
  type ListEntry,
  type NoteView,
  type OutcomeView,
  type ReceiptView,
  type ReviewView,
} from "./app-view.ts";
import type { BoardItemSnapshot } from "./board-item.ts";
import { CALL_KIND_LABELS, CALLS_PATH, issueUrl, recordId, repoLabel, ticketPath } from "./calls-page.ts";
import { readGlobalSettings } from "./global-settings.ts";
import { MARK_WORDS, shortSha } from "./intake-comment.ts";
import { readRepoSettings } from "./repo-settings.ts";
import { SETTINGS_PATH } from "./settings-page.ts";
import type { FormRequest, Page, PageRequest, Reply } from "./server.ts";
import type { AnswerRecord, BoardItemHistory, CallRecord, RepoRecord, Store } from "./store.ts";
import type { TicketState } from "./ticket-states.ts";
import { VISION_PATH } from "./vision.ts";

export { BOARD_ANSWER_PATH, BOARD_DATA_PATH, BOARD_POLL_MS, ITEM_PARAM, type BoardItemStatus };

/**
 * The board, server side (spec §13, ADR-0012, ADR-0008, ADR-0021): an inbox
 * of the open board items, oldest raised first across all repos, beside the
 * selected item with its parts in order. The board app in the browser
 * (src/ui) renders it from the data here, and asks for that data again every
 * few seconds, so the list refreshes and the form of an item that was
 * withdrawn, answered or locked locks without a reload, keeping whatever the
 * owner typed. The answer form is the one path an answer enters entail (spec
 * §13 "Answering", src/answer.ts): "Review answer" records nothing, "Record
 * answer as <owner> (final)" records it, and a receipt then stays in place.
 */

export interface BoardPageOptions {
  store: Store;
  /**
   * Whether entail cannot reach a host: its host halt (spec §16), which locks
   * that host's items. No host is halted unless this says so.
   */
  hostHalted?: (host: string) => boolean;
  /**
   * Whether entail is still catching up with a repo resumed after a pause,
   * which keeps its items locked (ADR-0018). No repo is catching up unless
   * this says so.
   */
  catchingUp?: (repoId: number) => boolean;
  /** The clock: how long ago items were raised, and when today began. */
  now?: () => Date;
  /** Called once an answer is recorded, so the records repo commits after every answer (spec §3). */
  afterAnswer?: () => void;
}

/**
 * Why an open item's form is locked: its repo is paused, or was resumed and
 * entail has not caught up with it yet, or entail cannot reach its host (spec
 * §13 "Locked items", ADR-0018).
 */
export type ItemLock = { kind: "paused" } | { kind: "catching-up" } | { kind: "halted"; host: string };

/** One item as the board shows it. */
export interface BoardEntry {
  history: BoardItemHistory;
  snapshot: Partial<BoardItemSnapshot>;
  repo: RepoRecord | null;
  status: BoardItemStatus;
  lock: ItemLock | null;
  /** For a withdrawn item, what happens to its ticket next. */
  next: string | null;
  /** Earlier answers going ahead on the ticket, which the comment quotes before this item's. */
  earlier: GivenAnswer[];
  /** For an answered item: the comment entail posted for the answer, once posted. */
  posted: string | null;
  /** The item's host while entail cannot reach it (its host halt), whatever the item's status. */
  unreachable: string | null;
}

/** The board as the page shows it: the open items, then those answered or withdrawn today. */
export interface Board {
  open: BoardEntry[];
  endedToday: BoardEntry[];
}

/** The board page, the data the app asks for every few seconds, and the answer form's endpoint. */
export function boardPages(options: BoardPageOptions): Page[] {
  return [
    { path: BOARD_PATH, nav: "Board", get: (request) => boardPage(options, request) },
    { path: BOARD_DATA_PATH, get: (request) => boardDataReply(options, request) },
    { path: BOARD_ANSWER_PATH, post: (request) => answerPost(options, request) },
  ];
}

/** The start of the local day `now` falls in: items answered or withdrawn before it have left the board. */
export function startOfDay(now: Date): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start;
}

/**
 * The board: every open item, oldest raised first across all repos, and every
 * item answered or withdrawn since the local day began. The order is display
 * order only; nothing reorders or postpones an item.
 */
export function readBoard(options: BoardPageOptions): Board {
  const { store } = options;
  const now = (options.now ?? (() => new Date()))();
  const repos = new Map<number, RepoRecord | null>();
  const repoOf = (ticketId: number): RepoRecord | null => {
    const ticket = store.getTicket(ticketId);
    if (ticket === null) return null;
    if (!repos.has(ticket.repoId)) repos.set(ticket.repoId, store.getRepo(ticket.repoId));
    return repos.get(ticket.repoId)!;
  };
  const board: Board = { open: [], endedToday: [] };
  for (const history of store.boardItemsOnBoard(startOfDay(now).toISOString())) {
    const entry = entryOf(options, history, repoOf(history.item.ticketId));
    (entry.status === "open" ? board.open : board.endedToday).push(entry);
  }
  return board;
}

/** One board item as the board shows it, with its repo. */
function entryOf(options: BoardPageOptions, history: BoardItemHistory, repo: RepoRecord | null): BoardEntry {
  const status: BoardItemStatus = history.answer ? "answered" : history.withdrawal ? "withdrawn" : "open";
  const ticketId = history.item.ticketId;
  const calls = status === "withdrawn" ? [] : options.store.callsForTicket(ticketId);
  return {
    history,
    snapshot: (history.item.snapshot ?? {}) as Partial<BoardItemSnapshot>,
    repo,
    status,
    lock: status === "open" ? lockOf(options, repo) : null,
    next: history.withdrawal ? whatNext(options.store.getCall(history.withdrawal.callId)?.stateChange?.to ?? null) : null,
    earlier: status === "withdrawn" ? [] : answersInForce(options.store, ticketId, calls).filter((given) => given.answer.boardItemId < history.item.id),
    posted: history.answer === null ? null : postedFor(calls, history.answer.id),
    unreachable: repo !== null && options.hostHalted?.(repo.host) === true ? repo.host : null,
  };
}

/** The comment entail posted for an answer: the one posted by a call citing it, once confirmed. */
function postedFor(calls: readonly CallRecord[], answerId: number): string | null {
  for (const call of calls) {
    if (call.answerId !== answerId) continue;
    const posted = call.postedComments.at(-1);
    if (posted) return posted.commentUrl;
  }
  return null;
}

/** Why an item's form is locked, in the words a refused answer gives. */
function lockText(lock: ItemLock | null): string | null {
  if (lock === null) return null;
  if (lock.kind === "paused") return "this repo is paused.";
  if (lock.kind === "catching-up") return "entail is catching up with this repo after its pause.";
  return `entail cannot reach ${lock.host}.`;
}

/** Whether an open item's form is locked, and why. */
function lockOf(options: BoardPageOptions, repo: RepoRecord | null): ItemLock | null {
  if (repo === null) return null;
  if (readRepoSettings(options.store, repo.id)?.settings.paused === true) return { kind: "paused" };
  if (options.catchingUp?.(repo.id) === true) return { kind: "catching-up" };
  if (options.hostHalted?.(repo.host) === true) return { kind: "halted", host: repo.host };
  return null;
}

/** How long ago an item was raised, in a few words. */
export function raisedAgo(raisedAt: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(raisedAt)) / 60_000));
  if (minutes < 1) return "raised just now";
  if (minutes < 60) return `raised ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `raised ${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `raised ${days} day${days === 1 ? "" : "s"} ago`;
}

function forgeName(forge: string): string {
  return forge === "github" ? "GitHub" : forge === "gitlab" ? "GitLab" : forge;
}

/** The item's repo and forge, from its records or, failing those, its snapshot. */
function whereOf(entry: BoardEntry): { label: string; forge: string } {
  if (entry.repo) return { label: repoLabel(entry.repo), forge: forgeName(entry.repo.forge) };
  const repo = entry.snapshot.ticket?.repo;
  return repo ? { label: repoLabel(repo), forge: forgeName(repo.forge) } : { label: "an unknown repo", forge: "" };
}

/** The selected item: the one asked for, or else the oldest open item. */
function selectedId(url: URL, board: Board): { id: number | null; asked: boolean } {
  const asked = url.searchParams.get(ITEM_PARAM);
  if (asked !== null) return { id: recordId(asked), asked: true };
  return { id: board.open[0]?.history.item.id ?? null, asked: false };
}

function findEntry(board: Board, id: number | null): BoardEntry | null {
  if (id === null) return null;
  return [...board.open, ...board.endedToday].find((e) => e.history.item.id === id) ?? null;
}

function ownerName(store: Store): string | null {
  return readGlobalSettings(store).settings.ownerDisplayName;
}

function titleOf(board: Board): string {
  return board.open.length === 0 ? "Board" : `Board (${board.open.length})`;
}

/** The board page: the app renders it from the board's data, with the selected item's status. */
function boardPage(options: BoardPageOptions, request: PageRequest): Reply {
  const data = boardData(options, request.url, request.server.token);
  return { status: data.detail.kind === "unknown" ? 404 : 200, board: { title: data.title, data } };
}

/** What the app asks every few seconds: the board's data for the item it shows. */
function boardDataReply(options: BoardPageOptions, request: PageRequest): Reply {
  return { status: 200, json: boardData(options, request.url, request.server.token) };
}

/**
 * The board's data: the count, the list, and the selected item with its
 * parts in the order spec §13 lists them, or why there is none to show.
 */
export function boardData(options: BoardPageOptions, url: URL, token: string): BoardData {
  const now = (options.now ?? (() => new Date()))();
  const board = readBoard(options);
  const selected = selectedId(url, board);
  const nextId = board.open[0]?.history.item.id ?? null;
  const entry = findEntry(board, selected.id);
  let detail: BoardDetail;
  if (entry !== null) {
    detail = itemView(entry, now);
  } else if (selected.asked) {
    const history = selected.id === null ? null : options.store.boardItem(selected.id);
    detail =
      history === null
        ? { kind: "unknown" }
        : { kind: "left", id: history.item.id, decision: history.item.decision, answered: history.answer !== null, historyPath: ticketPath(history.item.ticketId) };
  } else {
    detail = { kind: "empty" };
  }
  return {
    title: titleOf(board),
    token,
    pollMs: BOARD_POLL_MS,
    owner: ownerName(options.store),
    links: { calls: CALLS_PATH, settings: SETTINGS_PATH },
    open: board.open.map((e) => listEntry(e, now)),
    endedToday: board.endedToday.map((e) => listEntry(e, now)),
    selected: selected.id,
    asked: selected.asked,
    nextId,
    detail,
  };
}

function listEntry(e: BoardEntry, now: Date): ListEntry {
  const where = whereOf(e);
  return {
    id: e.history.item.id,
    decision: e.history.item.decision,
    repo: where.label,
    forge: where.forge,
    ago: raisedAgo(e.history.item.raisedAt, now),
    why: whyTag(e),
    status: e.status,
    locked: e.lock !== null,
  };
}

/** The list's tag for why an item was raised: contradicts a line, consequential readings, a pin by name, or a failed check. */
function whyTag(e: BoardEntry): { kind: string; tag: string } {
  const kind = e.snapshot.why?.kind ?? e.history.item.whyRaised;
  return { kind: kind.replaceAll("_", "-"), tag: e.snapshot.why?.tag ?? kind.replaceAll("_", " ") };
}

function forgeOf(e: BoardEntry): string | undefined {
  return e.repo?.forge ?? e.snapshot.ticket?.repo.forge;
}

/** The selected item: its parts in the order spec §13 lists them. */
function itemView(e: BoardEntry, now: Date): ItemView {
  const { item } = e.history;
  const s = e.snapshot;
  const where = whereOf(e);
  const issueNumber = s.ticket?.issue.number;
  const issueHref = s.ticket?.issue.url || (e.repo && issueNumber !== undefined ? issueUrl(e.repo, issueNumber) : "");
  const check = s.visionCheck;
  const ticket = s.ticket;
  return {
    kind: "item",
    id: item.id,
    version: itemVersion(s),
    ticketId: item.ticketId,
    status: e.status,
    meta: { repo: where.label, forge: where.forge, issueNumber: issueNumber ?? null, raisedAt: item.raisedAt, ago: raisedAgo(item.raisedAt, now).replace(/^raised /, "") },
    decision: item.decision,
    state: itemState(e),
    why: s.why?.text ?? item.whyRaised,
    visionCheck:
      check === undefined
        ? null
        : {
            commit: shortSha(check.commit),
            visionPath: VISION_PATH,
            lines: check.lines.map((line) => ({
              mark: line.mark,
              markWords: MARK_WORDS[line.mark] ?? line.mark,
              text: line.text,
              heading: line.heading || null,
              permalink: line.permalink,
              lineNumber: line.lineNumber,
            })),
          },
    ticket:
      ticket === undefined
        ? null
        : {
            title: ticket.issue.title || `Issue #${ticket.issue.number}`,
            number: ticket.issue.number,
            href: issueHref,
            filedBy: ticket.filedBy?.username ?? null,
            request: ticket.request,
          },
    happened: s.happened === undefined ? null : happenedEvents(s.happened, item.ticketId),
    historyPath: ticketPath(item.ticketId),
    form: {
      options: (s.form?.options ?? []).map((o) => ({ id: o.id, title: o.title, outcome: o.outcome, warning: o.againstVisionLine ? AGAINST_VISION_WARNING : null })),
      dontGoAheadOutcome: `The ticket is cancelled and entail closes the issue${forgeOf(e) === "github" ? " as not planned" : ""}.`,
    },
  };
}

/** What happened on the ticket: its calls and answers, newest first. */
function happenedEvents(happened: BoardItemSnapshot["happened"], ticketId: number): HappenedEvent[] {
  const events: HappenedEvent[] = [
    ...happened.calls.map((call) => ({
      at: call.madeAt,
      label: CALL_KIND_LABELS[call.kind] ?? call.kind,
      otherTicket: call.ticketId === ticketId ? null : `ticket ${call.ticketId}, before it was pulled in again`,
      text: call.reason,
      stateChange: call.stateChange ? `${call.stateChange.from} → ${call.stateChange.to}` : null,
    })),
    ...happened.answers.map((answer) => ({
      at: answer.answeredAt,
      label: `answered by ${answer.answeredBy}`,
      otherTicket: answer.ticketId === ticketId ? null : `ticket ${answer.ticketId}`,
      text: `${answer.decision} ${answer.shape === "option" ? `→ option ${answer.optionId ?? ""}` : answer.shape === "own-words" ? `→ “${answer.text ?? ""}”` : "→ don't go ahead"}`,
      stateChange: null,
    })),
  ];
  // Newest first; the snapshot's calls already are, and an answer sits where it was given.
  return events.sort((a, b) => b.at.localeCompare(a.at));
}

/** The selected item's state, which the app re-reads every few seconds: open, locked, answered or withdrawn. */
function itemState(e: BoardEntry): ItemState {
  if (e.status === "withdrawn") return { kind: "withdrawn", reason: e.history.withdrawal!.reason, next: e.next };
  if (e.status === "answered") return { kind: "answered", receipt: receipt(e.history.answer!, e) };
  if (e.lock !== null) return e.lock;
  return { kind: "open" };
}

/** What happens to a withdrawn item's ticket, from the state the call that withdrew it moved it to. */
export function whatNext(state: TicketState | null): string | null {
  switch (state) {
    case "cancelled":
      return "The ticket is cancelled, so nothing more is asked.";
    case "deciding":
      return "The ticket is decided again. If it still needs you, a new item comes to the board.";
    case "cleared":
    case "landing":
      return "The ticket is checked again. If it still needs you, a new item comes to the board.";
    case "merged":
      return "The ticket's change was merged elsewhere, so nothing more is asked.";
    default:
      return null;
  }
}

function noteView(answer: Pick<ChosenAnswer, "note" | "showNoteOnIssue">): NoteView {
  return { text: answer.note, shown: answer.note !== null && answer.showNoteOnIssue };
}

function outcomeView(answer: ChosenAnswer, e: BoardEntry): OutcomeView {
  const outcome = answerOutcome(answer, forgeOf(e), e.snapshot);
  return { stateWords: outcome.stateWords, next: outcome.next };
}

/**
 * The receipt, in place on the answered item: who answered, when, the item
 * version answered, the ticket's new state, what happens next and the comment
 * entail posts. The app offers "Next decision" beside it and never moves on by itself.
 */
function receipt(answer: AnswerRecord, e: BoardEntry): ReceiptView {
  let comment: string | null;
  try {
    comment = answerPostsComment(answer, e.snapshot) ? answerComment(answer.answeredBy, e.history.item.ticketId, answer, e.snapshot, forgeOf(e), { earlier: e.earlier }) : null;
  } catch {
    comment = null;
  }
  return {
    answeredBy: answer.answeredBy,
    answeredAt: answer.answeredAt,
    itemVersion: answer.itemVersion,
    words: answerWords(answer, e.snapshot),
    note: noteView(answer),
    outcome: outcomeView(answer, e),
    comment,
    posted: e.posted,
    unreachable: e.unreachable,
  };
}

/**
 * The answer form's post, answered as JSON. Every step reads the item again:
 * an answer to a withdrawn item, an already answered item or an older version
 * than the form showed is refused, and the reply says so and gives back what
 * the owner typed. "Review answer" records nothing and replies with the
 * review; only "Record answer" records, and the server has already checked
 * the per-start token.
 */
function answerPost(options: BoardPageOptions, request: FormRequest): Reply {
  const { store } = options;
  const form = request.form;
  const itemId = recordId(form.get(ANSWER_FIELDS.item) ?? "");
  const history = itemId === null ? null : store.boardItem(itemId);
  const reply = (json: AnswerReply, status: number): Reply => ({ status, json });
  if (itemId === null || history === null) return reply({ kind: "unknown", message: refusalText({ kind: "unknown" }) }, 404);
  const draft = draftFrom(form);
  const step = stepFrom(form);
  const back = (status: number, error: string | null, refusal: string | null) => reply({ kind: "form", itemId, draft, error, refusal }, status);
  if (step === null) return back(400, "The form did not say which step to take. Review your answer again.", null);
  if (step === "back") return back(200, null, null);

  const ticket = store.getTicket(history.item.ticketId);
  const repo = ticket === null ? null : store.getRepo(ticket.repoId);
  const entry = entryOf(options, history, repo);
  const shown = versionFrom(form);
  const refusal = refusalFor(history, shown, lockText(entry.lock));
  if (refusal !== null) return back(409, null, refusalText(refusal));
  const owner = ownerName(store);
  if (owner === null) return back(409, null, refusalText({ kind: "no-owner" }));
  const chosen = answerOf(draft, entry.snapshot.form?.options ?? []);
  if ("error" in chosen) return back(400, chosen.error, null);
  if (step === "review") return reply({ kind: "review", itemId, draft, review: reviewOf(entry, owner, chosen.answer) }, 200);

  const result = recordBoardAnswer(store, { itemId, shownVersion: shown, answeredBy: owner, answer: chosen.answer, locked: lockText(entry.lock) });
  if ("refused" in result) return back(409, null, refusalText(result.refused));
  options.afterAnswer?.();
  // The receipt stays in place on the item; the board does not move on by itself.
  return reply({ kind: "recorded", itemId }, 200);
}

/**
 * "Review answer": records nothing, and shows the answer, whether the note is
 * private or shown, what happens next and the exact comment entail will post.
 */
function reviewOf(e: BoardEntry, owner: string, answer: ChosenAnswer): ReviewView {
  return {
    owner,
    words: answerWords(answer, e.snapshot),
    warning: goesAgainstVisionLine(answer, e.snapshot) ? AGAINST_VISION_WARNING : null,
    note: noteView(answer),
    outcome: outcomeView(answer, e),
    comment: answerPostsComment(answer, e.snapshot) ? answerComment(owner, e.history.item.ticketId, answer, e.snapshot, forgeOf(e), { earlier: e.earlier }) : null,
  };
}
