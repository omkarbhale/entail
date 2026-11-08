import {
  AGAINST_VISION_WARNING,
  ANSWER_FIELDS,
  answerComment,
  answerOf,
  answerOutcome,
  answerWords,
  draftFrom,
  goesAgainstVisionLine,
  itemVersion,
  recordBoardAnswer,
  refusalFor,
  refusalText,
  stepFrom,
  versionFrom,
  type AnswerDraft,
  type AnswerRefusal,
  type ChosenAnswer,
  type GivenAnswer,
} from "./answer.ts";
import { answersInForce } from "./after-answer.ts";
import { BOARD_PATH, type BoardItemSnapshot, type BoardOption, type HappenedAnswer, type HappenedCall } from "./board-item.ts";
import { CALL_KIND_LABELS, CALLS_PATH, issueUrl, recordId, repoLabel, ticketPath } from "./calls-page.ts";
import { readGlobalSettings } from "./global-settings.ts";
import { MARK_WORDS, shortSha } from "./intake-comment.ts";
import { escapeHtml, renderPage, timeHtml } from "./page.ts";
import { readRepoSettings } from "./repo-settings.ts";
import { SETTINGS_PATH } from "./settings-page.ts";
import { TOKEN_FIELD, type FormRequest, type Page, type PageRequest, type Reply } from "./server.ts";
import type { AnswerRecord, BoardItemHistory, CallRecord, RepoRecord, Store, WithdrawalRecord } from "./store.ts";
import type { TicketState } from "./ticket-states.ts";
import { VISION_PATH } from "./vision.ts";

/**
 * The board page, read side (spec §13, ADR-0012, ADR-0008): an inbox of the
 * open board items, oldest raised first across all repos, beside the selected
 * item with its parts in order. The page asks entail's local process for the
 * board every few seconds and, without a reload, refreshes the list and locks
 * the form of an item that was withdrawn, answered or locked, keeping
 * whatever the owner typed. The answer form is the one path an answer enters
 * entail (spec §13 "Answering", src/answer.ts): "Review answer" records
 * nothing, "Record answer as <owner> (final)" records it, and a receipt then
 * stays in place.
 */

/** Where the page asks for the board while it is open: local traffic, no forge requests (ADR-0012). */
export const BOARD_LIVE_PATH = "/board/live";
/** How often the page asks: every few seconds. */
export const BOARD_POLL_MS = 3000;
/** The query parameter naming the selected item, as {@link boardItemLink} writes it. */
export const ITEM_PARAM = "item";
/** Where the answer form posts: to review an answer, record it as final, or go back. */
export const BOARD_ANSWER_PATH = "/board/answer";

export interface BoardPageOptions {
  store: Store;
  /**
   * Whether entail cannot reach a host: its host halt (spec §16), which locks
   * that host's items. No host is halted unless this says so.
   */
  hostHalted?: (host: string) => boolean;
  /** The clock: how long ago items were raised, and when today began. */
  now?: () => Date;
  /** Called once an answer is recorded, so the records repo commits after every answer (spec §3). */
  afterAnswer?: () => void;
}

/** How an item on the board stands. */
export type BoardItemStatus = "open" | "answered" | "withdrawn";

/** Why an open item's form is locked: its repo is paused, or entail cannot reach its host (spec §13 "Locked items"). */
export type ItemLock = { kind: "paused" } | { kind: "halted"; host: string };

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

/** The board page and the endpoint it asks every few seconds. */
export function boardPages(options: BoardPageOptions): Page[] {
  return [
    { path: BOARD_PATH, nav: "Board", get: (request) => boardView(options, request) },
    { path: BOARD_LIVE_PATH, get: (request) => liveView(options, request) },
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
  return lock.kind === "paused" ? "this repo is paused." : `entail cannot reach ${lock.host}.`;
}

/** Whether an open item's form is locked, and why. */
function lockOf(options: BoardPageOptions, repo: RepoRecord | null): ItemLock | null {
  if (repo === null) return null;
  if (readRepoSettings(options.store, repo.id)?.settings.paused === true) return { kind: "paused" };
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
function selectedId(request: PageRequest, board: Board): { id: number | null; asked: boolean } {
  const asked = request.url.searchParams.get(ITEM_PARAM);
  if (asked !== null) return { id: recordId(asked), asked: true };
  return { id: board.open[0]?.history.item.id ?? null, asked: false };
}

function findEntry(board: Board, id: number | null): BoardEntry | null {
  if (id === null) return null;
  return [...board.open, ...board.endedToday].find((e) => e.history.item.id === id) ?? null;
}

/** The oldest open item, which "Next decision" opens: the owner moves on by choosing to, never by itself. */
function nextOpenId(board: Board): number | null {
  return board.open[0]?.history.item.id ?? null;
}

function nextDecision(nextId: number | null): string {
  return nextId === null ? "" : `\n<p><a class="next-decision" href="${escapeHtml(itemPath(nextId))}">Next decision</a></p>`;
}

function itemPath(id: number): string {
  return `${BOARD_PATH}?${ITEM_PARAM}=${id}`;
}

function ownerName(store: Store): string | null {
  return readGlobalSettings(store).settings.ownerDisplayName;
}

/**
 * What the selected item's form part shows in place of a fresh form: the
 * form again with what the owner had filled in, perhaps with what is missing
 * or why nothing was recorded, or the review of their answer.
 */
type FormPanel =
  | { kind: "form"; draft: AnswerDraft; error?: string; refusal?: AnswerRefusal }
  | { kind: "review"; draft: AnswerDraft; answer: ChosenAnswer };

/** A reply to the answer form: the board, with the item it answered selected and its panel shown. */
interface AnswerView {
  itemId: number;
  panel: FormPanel;
  status: number;
}

function boardView(options: BoardPageOptions, request: PageRequest, view?: AnswerView): Reply {
  const now = (options.now ?? (() => new Date()))();
  const board = readBoard(options);
  const selected = view ? { id: view.itemId, asked: true } : selectedId(request, board);
  const owner = ownerName(options.store);
  let entry = findEntry(board, selected.id);
  if (entry === null && view !== undefined) {
    // An item that left the board before today still shows the answer it refused, to copy.
    const history = options.store.boardItem(view.itemId);
    const ticket = history === null ? null : options.store.getTicket(history.item.ticketId);
    if (history !== null) entry = entryOf(options, history, ticket === null ? null : options.store.getRepo(ticket.repoId));
  }
  const live = `${BOARD_LIVE_PATH}${selected.id === null ? "" : `?${ITEM_PARAM}=${selected.id}`}`;

  let detail: string;
  let status = view?.status ?? 200;
  if (entry !== null) {
    detail = renderItem(entry, now, nextOpenId(board), { token: request.server.token, owner, panel: view?.panel ?? null });
  } else if (selected.asked) {
    const item = selected.id === null ? null : options.store.boardItem(selected.id);
    if (item === null) {
      status = 404;
      detail = `<p>entail has no board item with this id.</p>`;
    } else {
      detail = `<h2 class="decision">${escapeHtml(item.item.decision)}</h2>
<p>This item has left the board: it was ${item.answer ? "answered" : "withdrawn"} before today. <a href="${escapeHtml(ticketPath(item.item.ticketId))}">Its ticket's history</a> keeps it, and the <a href="${CALLS_PATH}">Calls page</a> has every call.</p>`;
    }
  } else {
    detail = `<p class="empty">Nothing needs you.</p>`;
  }

  const body = `<div id="board" class="board" data-live="${escapeHtml(live)}" data-poll-ms="${BOARD_POLL_MS}">
<div class="board-head">
<h1>Board ${renderCount(board)}</h1>
<a href="${CALLS_PATH}">Calls</a>
<span class="muted answering">answering as ${owner === null ? `<a href="${SETTINGS_PATH}">no one yet: set your display name</a>` : `<strong>${escapeHtml(owner)}</strong>`}</span>
</div>
<div class="inbox">
${renderList(board, selected.id, now)}
<article id="item" class="item" aria-live="polite">
${detail}
</article>
</div>
</div>
<style>${STYLE}</style>
<script>${BOARD_SCRIPT}</script>`;
  return { status, html: renderPage(request, { title: titleOf(board), body, wide: true }) };
}

/**
 * What the page asks every few seconds: the count, the list and the selected
 * item's state. The page swaps in the count and the list, and locks the form
 * when the item's state says so, never touching what the owner typed.
 */
function liveView(options: BoardPageOptions, request: PageRequest): Reply {
  const now = (options.now ?? (() => new Date()))();
  const board = readBoard(options);
  const selected = selectedId(request, board);
  const entry = findEntry(board, selected.id);
  const nextId = nextOpenId(board);
  const state =
    entry !== null
      ? renderItemState(entry, nextId)
      : selected.id !== null
        ? renderLeftState(nextId)
        : `<div id="item-state" data-key="none" data-locked="false" hidden></div>`;
  // Only the empty page asks without an item id, and it has no typed text to lose.
  const select = !selected.asked && entry !== null ? `<a id="select" href="${escapeHtml(itemPath(selected.id!))}"></a>\n` : "";
  const html = `<!doctype html>
<title>${escapeHtml(titleOf(board))} · entail</title>
${renderCount(board)}
${renderList(board, selected.id, now)}
${select}${state}
`;
  return { status: 200, html };
}

function titleOf(board: Board): string {
  return board.open.length === 0 ? "Board" : `Board (${board.open.length})`;
}

function renderCount(board: Board): string {
  return `<span id="board-count" class="count">· ${board.open.length} open</span>`;
}

function renderList(board: Board, selected: number | null, now: Date): string {
  const entry = (e: BoardEntry) => {
    const id = e.history.item.id;
    const where = whereOf(e);
    const current = id === selected ? ' aria-current="true"' : "";
    const status = e.status === "open" ? (e.lock ? ` <span class="tag status">locked</span>` : "") : ` <span class="tag status">${e.status}</span>`;
    return `<li><a href="${escapeHtml(itemPath(id))}"${current}>
<span class="d">${escapeHtml(e.history.item.decision)}</span>
<span class="m">${escapeHtml(where.label)} · ${escapeHtml(where.forge)} · ${escapeHtml(raisedAgo(e.history.item.raisedAt, now))} ${whyTag(e)}${status}</span>
</a></li>`;
  };
  const open =
    board.open.length === 0 ? `<p class="muted">Nothing needs you.</p>` : `<ol class="entries">\n${board.open.map(entry).join("\n")}\n</ol>`;
  const ended =
    board.endedToday.length === 0
      ? ""
      : `\n<h2>Answered or withdrawn today</h2>\n<ol class="entries ended">\n${board.endedToday.map(entry).join("\n")}\n</ol>`;
  return `<nav id="board-list" class="list" aria-label="Board items">
<h2>Needs you · ${board.open.length}</h2>
${open}${ended}
</nav>`;
}

/** The list's tag for why an item was raised: contradicts a line, consequential readings, a pin by name, or a failed check. */
function whyTag(e: BoardEntry): string {
  const kind = e.snapshot.why?.kind ?? e.history.item.whyRaised;
  const tag = e.snapshot.why?.tag ?? kind.replaceAll("_", " ");
  return `<span class="tag why-${escapeHtml(kind.replaceAll("_", "-"))}">${escapeHtml(tag)}</span>`;
}

/** What rendering the selected item's form needs beyond the item. */
interface FormContext {
  /** The per-start token every form carries back. */
  token: string;
  /** The owner's display name, whom the answer is recorded as. */
  owner: string | null;
  panel: FormPanel | null;
}

/** The selected item: its parts in the order spec §13 lists them. */
function renderItem(e: BoardEntry, now: Date, nextId: number | null, context: FormContext): string {
  const { item } = e.history;
  const s = e.snapshot;
  const where = whereOf(e);
  const issueNumber = s.ticket?.issue.number;
  const issueHref = s.ticket?.issue.url || (e.repo && issueNumber !== undefined ? issueUrl(e.repo, issueNumber) : "");
  const meta = `<p class="muted item-meta">${escapeHtml(where.label)} · ${escapeHtml(where.forge)}${
    issueNumber === undefined ? "" : ` · issue #${issueNumber}`
  } · raised ${timeHtml(item.raisedAt)} (${escapeHtml(raisedAgo(item.raisedAt, now).replace(/^raised /, ""))})</p>`;
  return `${meta}
<section data-part="decision"><h2 class="decision">${escapeHtml(item.decision)}</h2></section>
${renderItemState(e, nextId)}
<section data-part="why" class="why"><h3>Why it was raised</h3>
<p>${escapeHtml(s.why?.text ?? item.whyRaised)}</p></section>
${renderVisionCheck(s)}
${renderTicket(s, issueHref)}
${renderHappened(e)}
${renderFormPart(e, context)}`;
}

function renderVisionCheck(s: Partial<BoardItemSnapshot>): string {
  const check = s.visionCheck;
  if (check === undefined) return `<section data-part="vision-check"><h3>Vision check</h3><p class="muted">Not recorded.</p></section>`;
  const lines =
    check.lines.length === 0
      ? `<p class="muted">No vision line bears on this issue.</p>`
      : `<ul class="vision">\n${check.lines
          .map(
            (line) => `<li class="vline mark-${escapeHtml(line.mark)}"><span class="mark">${escapeHtml(MARK_WORDS[line.mark] ?? line.mark)}</span>
<q>${escapeHtml(line.text)}</q>${line.heading ? ` <span class="muted">under “${escapeHtml(line.heading)}”</span>` : ""} <a href="${escapeHtml(line.permalink)}">line ${line.lineNumber}</a></li>`,
          )
          .join("\n")}\n</ul>`;
  return `<section data-part="vision-check"><h3>Vision check</h3>
<p class="hint">Only the lines that bear on this issue, quoted from ${VISION_PATH} at <code>${escapeHtml(shortSha(check.commit))}</code>.</p>
${lines}</section>`;
}

function renderTicket(s: Partial<BoardItemSnapshot>, issueHref: string): string {
  const ticket = s.ticket;
  if (ticket === undefined) return `<section data-part="ticket"><h3>What the ticket was</h3><p class="muted">Not recorded.</p></section>`;
  const title = escapeHtml(ticket.issue.title || `Issue #${ticket.issue.number}`);
  const link = issueHref ? `<a href="${escapeHtml(issueHref)}">${title}</a>` : title;
  const filedBy = ticket.filedBy ? ` · filed by ${escapeHtml(ticket.filedBy.username)}` : "";
  return `<section data-part="ticket"><h3>What the ticket was</h3>
<p><strong>${link}</strong> · #${ticket.issue.number}${filedBy}</p>
<p class="hint">The reporter's request, not your word:</p>
<blockquote class="request">${escapeHtml(ticket.request)}</blockquote></section>`;
}

function renderHappened(e: BoardEntry): string {
  const happened = e.snapshot.happened;
  const history = `<p><a href="${escapeHtml(ticketPath(e.history.item.ticketId))}">The ticket's history</a></p>`;
  if (happened === undefined) return `<section data-part="happened"><h3>What happened</h3>${history}</section>`;
  type Event = { at: string; html: string };
  const events: Event[] = [
    ...happened.calls.map((call: HappenedCall) => ({
      at: call.madeAt,
      html: `<strong>${escapeHtml(CALL_KIND_LABELS[call.kind] ?? call.kind)}</strong>${
        call.ticketId === e.history.item.ticketId ? "" : ` <span class="muted">(ticket ${call.ticketId}, before it was pulled in again)</span>`
      }: ${escapeHtml(call.reason)}${call.stateChange ? ` <span class="muted">${escapeHtml(call.stateChange.from)} → ${escapeHtml(call.stateChange.to)}</span>` : ""}`,
    })),
    ...happened.answers.map((answer: HappenedAnswer) => ({
      at: answer.answeredAt,
      html: `<strong>answered by ${escapeHtml(answer.answeredBy)}</strong>${
        answer.ticketId === e.history.item.ticketId ? "" : ` <span class="muted">(ticket ${answer.ticketId})</span>`
      }: ${escapeHtml(answer.decision)} ${escapeHtml(happenedAnswerWords(answer))}`,
    })),
  ];
  // Newest first; the snapshot's calls already are, and an answer sits where it was given.
  events.sort((a, b) => b.at.localeCompare(a.at));
  return `<section data-part="happened"><h3>What happened</h3>
<ol class="happened">
${events.map((ev) => `<li>${timeHtml(ev.at)} ${ev.html}</li>`).join("\n")}
</ol>
${history}</section>`;
}

function happenedAnswerWords(answer: HappenedAnswer): string {
  switch (answer.shape) {
    case "option":
      return `→ option ${answer.optionId ?? ""}`;
    case "own-words":
      return `→ “${answer.text ?? ""}”`;
    default:
      return "→ don't go ahead";
  }
}

/** The item's form part: the answer form, or the review of an answer (spec §13 "Answer shapes", "Answering"). */
function renderFormPart(e: BoardEntry, context: FormContext): string {
  const panel = context.panel;
  const refusal =
    panel?.kind === "form" && panel.refusal !== undefined
      ? `<p class="refusal" role="alert"><strong>Not recorded.</strong> ${escapeHtml(refusalText(panel.refusal))}</p>\n`
      : "";
  const error = panel?.kind === "form" && panel.error !== undefined ? `<p class="error" role="alert">${escapeHtml(panel.error)}</p>\n` : "";
  // An answered item's receipt stands in its place; a fresh page shows no form under it.
  if (panel === null && e.status === "answered") return "";
  const body = panel?.kind === "review" ? renderReview(e, context, panel.draft, panel.answer) : renderForm(e, context, panel?.draft ?? null);
  return `<section data-part="form"><h3>Your answer</h3>
${refusal}${error}${body}</section>`;
}

function forgeOf(e: BoardEntry): string | undefined {
  return e.repo?.forge ?? e.snapshot.ticket?.repo.forge;
}

/** The hidden fields every answer form carries: the per-start token, the item and the item version it showed. */
function hiddenFields(e: BoardEntry, token: string): string {
  return `<input type="hidden" name="${TOKEN_FIELD}" value="${escapeHtml(token)}">
<input type="hidden" name="${ANSWER_FIELDS.item}" value="${e.history.item.id}">
<input type="hidden" name="${ANSWER_FIELDS.version}" value="${itemVersion(e.snapshot)}">`;
}

function renderForm(e: BoardEntry, context: FormContext, draft: AnswerDraft | null): string {
  const options: BoardOption[] = e.snapshot.form?.options ?? [];
  const locked = e.status !== "open" || e.lock !== null;
  const off = locked ? " disabled" : "";
  const ro = locked ? " readonly" : "";
  const github = forgeOf(e) === "github";
  const checked = (value: string) => (draft?.answer === value ? " checked" : "");
  const choice = (value: string, title: string, outcome: string | null, extra = "", cls = "") =>
    `<label class="choice${cls}"><input type="radio" name="${ANSWER_FIELDS.answer}" value="${escapeHtml(value)}"${checked(value)}${off}> <span class="t">${escapeHtml(title)}</span>${
      outcome ? `\n<span class="o">${escapeHtml(outcome)}</span>` : ""
    }${extra}</label>`;
  // When going ahead goes against a vision line, that option carries the one warning, with no link to edit the vision.
  const warning = (o: BoardOption) => (o.againstVisionLine ? `\n<span class="warn">${escapeHtml(AGAINST_VISION_WARNING)}</span>` : "");
  const note = draft?.note ?? "";
  return `<form id="answer-form" class="answer" method="post" action="${BOARD_ANSWER_PATH}" data-locked="${locked}">
${hiddenFields(e, context.token)}
<fieldset>
<legend>How to answer</legend>
${options.map((o) => choice(`option:${o.id}`, o.title, o.outcome, warning(o))).join("\n")}
${choice("own-words", "Answer in my own words", null)}
<textarea name="${ANSWER_FIELDS.text}" aria-label="Your own words" placeholder="What should happen? An executor will build from this."${ro}>${escapeHtml(draft?.text ?? "")}</textarea>
${choice("dont-go-ahead", "Don't go ahead", `The ticket is cancelled and entail closes the issue${github ? " as not planned" : ""}.`, "", " stop")}
</fieldset>
<details${note.trim() === "" ? "" : " open"}><summary>Add a note</summary>
<textarea name="${ANSWER_FIELDS.note}" aria-label="Your note" placeholder="Optional. Kept in entail's records."${ro}>${escapeHtml(note)}</textarea>
<label class="choice"><input type="checkbox" name="${ANSWER_FIELDS.showNote}" value="1"${draft?.showNote ? " checked" : ""}${off}> Show my note on the issue</label>
</details>
<p class="actions"><button type="submit" name="${ANSWER_FIELDS.step}" value="review"${off}>Review answer</button>
<span class="hint">Nothing is recorded until you confirm.</span></p>
</form>`;
}

/** Whether the note is private or shown on the issue, as the review and receipt say it. */
function noteLine(answer: Pick<ChosenAnswer, "note" | "showNoteOnIssue">): string {
  if (answer.note === null) return `<p class="muted">No note.</p>`;
  return `<p><span class="muted">Your note, ${answer.showNoteOnIssue ? "shown on the issue" : "private: kept in entail's records only"}:</span></p>
<blockquote class="note">${escapeHtml(answer.note)}</blockquote>`;
}

/** What happens next, with the ticket's new state. */
function outcomeHtml(answer: ChosenAnswer, e: BoardEntry): string {
  const outcome = answerOutcome(answer, forgeOf(e));
  return `<p>The ticket's new state: <strong>${escapeHtml(outcome.stateWords)}</strong>.</p>
<ul class="steps">
${outcome.next.map((step) => `<li>${escapeHtml(step)}</li>`).join("\n")}
</ul>`;
}

/**
 * "Review answer": records nothing, and shows the answer, whether the note is
 * private or shown, what happens next and the exact comment entail will post.
 * "Record answer as <owner> (final)" records it; "Back" returns to the form
 * with everything as the owner left it.
 */
function renderReview(e: BoardEntry, context: FormContext, draft: AnswerDraft, answer: ChosenAnswer): string {
  const owner = context.owner ?? "";
  const comment = answerComment(owner, e.history.item.ticketId, answer, e.snapshot, forgeOf(e), { earlier: e.earlier });
  const keep = (name: string, value: string) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  return `<div id="review" class="review">
<p><strong>Check your answer before it is recorded. Answers are final.</strong></p>
<p><span class="muted">You answer:</span> <strong>${escapeHtml(answerWords(answer, e.snapshot))}</strong></p>
${goesAgainstVisionLine(answer, e.snapshot) ? `<p class="warn">${escapeHtml(AGAINST_VISION_WARNING)}</p>\n` : ""}${noteLine(answer)}
<h4>What happens next</h4>
${outcomeHtml(answer, e)}
<h4>On the issue, entail will post</h4>
<pre class="comment">${escapeHtml(comment)}</pre>
<form id="answer-form" class="answer" method="post" action="${BOARD_ANSWER_PATH}" data-locked="false">
${hiddenFields(e, context.token)}
${keep(ANSWER_FIELDS.answer, draft.answer)}
${keep(ANSWER_FIELDS.text, draft.text)}
${keep(ANSWER_FIELDS.note, draft.note)}
${draft.showNote ? keep(ANSWER_FIELDS.showNote, "1") : ""}
<p class="actions"><button type="submit" name="${ANSWER_FIELDS.step}" value="record">Record answer as ${escapeHtml(owner)} (final)</button>
<button type="submit" name="${ANSWER_FIELDS.step}" value="back">Back</button></p>
</form>
</div>`;
}

/**
 * The answer form's post. Every step reads the item again: an answer to a
 * withdrawn item, an already answered item or an older version than the
 * form showed is refused, and the page says so, keeping what the owner typed.
 * Only the final step records, and the server has already checked the
 * per-start token.
 */
function answerPost(options: BoardPageOptions, request: FormRequest): Reply {
  const { store } = options;
  const form = request.form;
  const itemId = recordId(form.get(ANSWER_FIELDS.item) ?? "");
  const history = itemId === null ? null : store.boardItem(itemId);
  if (itemId === null || history === null) {
    return {
      status: 404,
      html: renderPage(request, { title: "Board", body: `<h1>Board</h1>\n<p class="refusal">${escapeHtml(refusalText({ kind: "unknown" }))}</p>` }),
    };
  }
  const draft = draftFrom(form);
  const step = stepFrom(form);
  const view = (panel: FormPanel, status: number) => boardView(options, request, { itemId, panel, status });
  if (step === null) return view({ kind: "form", draft, error: "The form did not say which step to take. Review your answer again." }, 400);
  if (step === "back") return view({ kind: "form", draft }, 200);

  const ticket = store.getTicket(history.item.ticketId);
  const repo = ticket === null ? null : store.getRepo(ticket.repoId);
  const entry = entryOf(options, history, repo);
  const shown = versionFrom(form);
  const refusal = refusalFor(history, shown, lockText(entry.lock));
  if (refusal !== null) return view({ kind: "form", draft, refusal }, 409);
  const owner = ownerName(store);
  if (owner === null) return view({ kind: "form", draft, refusal: { kind: "no-owner" } }, 409);
  const chosen = answerOf(draft, entry.snapshot.form?.options ?? []);
  if ("error" in chosen) return view({ kind: "form", draft, error: chosen.error }, 400);
  if (step === "review") return view({ kind: "review", draft, answer: chosen.answer }, 200);

  const result = recordBoardAnswer(store, { itemId, shownVersion: shown, answeredBy: owner, answer: chosen.answer, locked: lockText(entry.lock) });
  if ("refused" in result) return view({ kind: "form", draft, refusal: result.refused }, 409);
  options.afterAnswer?.();
  // The receipt stays in place on the item; the page does not move on by itself.
  return { redirect: itemPath(itemId) };
}

/**
 * The selected item's state, which the page re-reads every few seconds: open,
 * locked, answered or withdrawn. Its key changes when the state does, and the
 * page then swaps it in and locks or unlocks the form.
 */
function renderItemState(e: BoardEntry, nextId: number | null): string {
  if (e.status === "withdrawn") return withdrawnState(e.history.withdrawal!, e, nextId);
  if (e.status === "answered") return answeredState(e.history.answer!, e, nextId);
  if (e.lock?.kind === "paused") {
    return stateBox(
      "paused",
      true,
      `<strong>This item is locked: this repo is paused.</strong>
<p>Its form unlocks once the repo is resumed and entail has caught up with it.</p>`,
    );
  }
  if (e.lock?.kind === "halted") {
    return stateBox(
      `halted:${e.lock.host}`,
      true,
      `<strong>This item is locked: entail cannot reach ${escapeHtml(e.lock.host)}.</strong>
<p>Its form unlocks once entail reaches ${escapeHtml(e.lock.host)} again and has caught up.</p>`,
    );
  }
  return `<div id="item-state" data-key="open" data-locked="false" hidden></div>`;
}

function withdrawnState(withdrawal: WithdrawalRecord, e: BoardEntry, nextId: number | null): string {
  return stateBox(
    `withdrawn:${nextId ?? ""}`,
    true,
    `<strong>Withdrawn: this item takes no answer.</strong>
<p>${escapeHtml(withdrawal.reason)}</p>
${e.next ? `<p>${escapeHtml(e.next)}</p>` : ""}
<p class="hint">Anything you typed stays below to copy. It is not recorded.</p>${nextDecision(nextId)}`,
  );
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

/**
 * The receipt, in place on the answered item: who answered, when, the item
 * version answered, the ticket's new state, what happens next and the comment
 * entail posts, with "Next decision" to the oldest open item. The page does
 * not move on by itself.
 */
function answeredState(answer: AnswerRecord, e: BoardEntry, nextId: number | null): string {
  let comment: string;
  try {
    comment = answerComment(answer.answeredBy, e.history.item.ticketId, answer, e.snapshot, forgeOf(e), { earlier: e.earlier });
  } catch {
    comment = "";
  }
  return stateBox(
    // The comment's posting, or its host halting, changes the key, so the receipt is swapped in again.
    `answered:${nextId ?? ""}:${e.posted !== null ? "posted" : e.unreachable !== null ? "waiting" : ""}`,
    true,
    `<p><strong>Answered by ${escapeHtml(answer.answeredBy)}</strong> at ${timeHtml(answer.answeredAt)} · item version ${answer.itemVersion}</p>
<p><span class="muted">The answer:</span> <strong>${escapeHtml(answerWords(answer, e.snapshot))}</strong></p>
${noteLine(answer)}
${outcomeHtml(answer, e)}
${comment === "" ? "" : `<details><summary>The comment entail posts on the issue</summary>\n<pre class="comment">${escapeHtml(comment)}</pre></details>`}${postedLine(e)}${nextDecision(nextId)}`,
  );
}

/**
 * Whether the answer's comment is on the issue yet: a link once it is posted,
 * or, while entail cannot reach the item's host, that the comment is kept and
 * posted when the host answers again (spec §16 "Answering during a halt").
 */
function postedLine(e: BoardEntry): string {
  if (e.posted !== null) return `\n<p class="posted">Posted on the issue: <a href="${escapeHtml(e.posted)}">entail's comment</a>.</p>`;
  if (e.unreachable === null) return "";
  const host = escapeHtml(e.unreachable);
  return `\n<p class="warn">entail cannot reach ${host} now. Your answer is recorded, and the comment is kept and posted when ${host} answers again.</p>`;
}

function renderLeftState(nextId: number | null): string {
  return stateBox(`left:${nextId ?? ""}`, true, `<strong>This item has left the board.</strong>${nextDecision(nextId)}`);
}

function stateBox(key: string, locked: boolean, html: string): string {
  return `<div id="item-state" class="state state-${escapeHtml(key.split(":")[0]!)}" data-key="${escapeHtml(key)}" data-locked="${locked}" role="status">
${html}
</div>`;
}

const STYLE = `
.board-head { display: flex; flex-wrap: wrap; gap: 1rem; align-items: baseline; }
.board-head h1 { margin: 0; }
.board-head .answering { margin-left: auto; }
.inbox { display: grid; grid-template-columns: minmax(0, 22rem) minmax(0, 1fr); gap: 1.5rem; margin-top: 1rem; }
.list h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 1rem 0 .25rem; }
.list ol.entries { list-style: none; padding: 0; margin: 0; }
.list li a { display: block; padding: .5rem .6rem; border-radius: 6px; color: inherit; text-decoration: none; }
.list li a[aria-current] { background: var(--soft); outline: 1px solid var(--line); }
.list .d { display: block; font-weight: 600; line-height: 1.35; }
.list .m { display: block; font-size: .8rem; color: var(--muted); margin-top: .2rem; }
.tag { display: inline-block; font-size: .75rem; padding: 0 .5rem; border-radius: 99px; background: var(--soft); border: 1px solid var(--line); white-space: nowrap; }
.tag.why-contradiction { color: var(--bad); }
.item { min-width: 0; }
.item h2.decision { font-size: 1.3rem; margin: .25rem 0 1rem; }
.item h3 { font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 1.5rem 0 .5rem; }
.item-meta { margin: 0; font-size: .875rem; }
.why { padding: .25rem .75rem .5rem; background: var(--soft); border-radius: 6px; }
ul.vision { list-style: none; padding: 0; }
.vline { border-left: 3px solid var(--line); padding: .25rem .6rem; margin: .4rem 0; }
.vline.mark-contradicts { border-color: var(--bad); }
.vline .mark { font-size: .75rem; font-weight: 600; margin-right: .4rem; }
blockquote.request { margin: .25rem 0; padding: .5rem .75rem; background: var(--soft); border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; }
ol.happened { list-style: none; padding: 0; }
ol.happened li { padding: .3rem 0; border-bottom: 1px dashed var(--line); }
form.answer .choice { display: block; border: 1px solid var(--line); border-radius: 6px; padding: .5rem .75rem; margin: .5rem 0; }
form.answer .choice .t { font-weight: 600; }
form.answer .choice .o { display: block; color: var(--muted); font-size: .875rem; }
form.answer .choice.stop .t { color: var(--bad); }
form.answer textarea { max-width: none; min-height: 4rem; }
form.answer[data-locked=true] { opacity: .75; }
.state { margin: .75rem 0; padding: .6rem .8rem; border-radius: 6px; border: 1px solid var(--line); background: var(--soft); }
.state p { margin: .25rem 0 0; }
.empty { color: var(--muted); text-align: center; padding: 3rem 1rem; }
form.answer .warn, .review .warn { display: block; margin-top: .35rem; font-size: .875rem; color: var(--bad); }
form.answer .actions { display: flex; gap: .75rem; align-items: baseline; flex-wrap: wrap; }
.review, .state-answered { border: 1px solid var(--accent); border-radius: 6px; padding: .6rem .8rem; }
.review h4 { margin: 1rem 0 .25rem; font-size: .9rem; }
pre.comment { white-space: pre-wrap; overflow-wrap: anywhere; }
blockquote.note { margin: .25rem 0; padding: .35rem .75rem; border-left: 3px solid var(--line); white-space: pre-wrap; overflow-wrap: anywhere; }
.refusal { padding: .5rem .75rem; border-left: 3px solid var(--bad); background: var(--soft); }
a.next-decision { display: inline-block; padding: .4rem 1rem; border: 1px solid var(--accent); border-radius: 4px; text-decoration: none; }
@media (max-width: 52rem) { .inbox { grid-template-columns: minmax(0, 1fr); } }
`;

/**
 * The page's live updates: every few seconds it asks for the board and swaps
 * in the count, the list and the selected item's state. When the state says
 * locked it locks the form in place: choices are disabled and text fields
 * made read-only, so typed text stays visible to copy, and the form refuses
 * to submit. The form itself is never replaced.
 */
export const BOARD_SCRIPT = `
(() => {
  const board = document.getElementById("board");
  if (!board) return;
  const parser = new DOMParser();
  const form = () => document.getElementById("answer-form");
  const lock = (locked) => {
    const f = form();
    if (!f) return;
    f.dataset.locked = String(locked);
    for (const el of f.elements) {
      if (el.type === "hidden" || el.tagName === "FIELDSET") continue;
      if (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && el.type === "text")) el.readOnly = locked;
      else el.disabled = locked;
    }
  };
  document.addEventListener("submit", (event) => {
    if (event.target === form() && form().dataset.locked === "true") event.preventDefault();
  }, true);
  const swap = (doc, id) => {
    const next = doc.getElementById(id);
    const current = document.getElementById(id);
    if (next && current) current.replaceWith(document.importNode(next, true));
    return next;
  };
  let busy = false;
  const poll = async () => {
    if (busy) return;
    busy = true;
    try {
      const response = await fetch(board.dataset.live, { cache: "no-store" });
      if (!response.ok) return;
      const doc = parser.parseFromString(await response.text(), "text/html");
      const select = doc.getElementById("select");
      if (select) {
        location.assign(select.getAttribute("href"));
        return;
      }
      swap(doc, "board-count");
      swap(doc, "board-list");
      if (doc.title) document.title = doc.title;
      const next = doc.getElementById("item-state");
      const current = document.getElementById("item-state");
      if (next && current && next.dataset.key !== current.dataset.key) {
        current.replaceWith(document.importNode(next, true));
        lock(next.dataset.locked === "true");
      }
    } catch {
      // entail may be restarting; the next poll tries again.
    } finally {
      busy = false;
    }
  };
  setInterval(poll, Number(board.dataset.pollMs) || 3000);
})();
`;
