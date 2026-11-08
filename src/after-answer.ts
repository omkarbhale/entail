import { answerComment, answerWords, goesAhead, type GivenAnswer } from "./answer.ts";
import type { BoardItemSnapshot } from "./board-item.ts";
import type { CriteriaDetail } from "./criteria.ts";
import { readGlobalSettings } from "./global-settings.ts";
import type { OperationalLog } from "./operational-log.ts";
import type { OwedStep, OwedStepPlanner, RepoPass } from "./pass.ts";
import type { AnswerRecord, BoardItemRecord, CallRecord, Store, TicketRecord } from "./store.ts";

/**
 * What an answer does (spec §13 "After an answer", §9, §16; ADR-0008,
 * ADR-0019). The answer itself is not a call: once the owner records it on
 * the board, the next pass makes the call that cites it.
 *
 * - Going ahead (an option, or the owner's own words) returns the ticket to
 *   deciding only to write criteria. The verdict is not run again: the
 *   criteria step writes criteria from the answer, which they cite, and the
 *   usual checks and challenge run (src/criteria.ts).
 * - "Don't go ahead" cancels the ticket, and entail comments and closes the
 *   issue, as not planned on GitHub.
 *
 * Owed work is a function of the records (ADR-0017), so an answer recorded
 * while its host is halted is acted on by the first pass that reaches the
 * host again, and one recorded during a model halt still moves the ticket,
 * with writing its criteria waiting for the halt to clear.
 */

/** The close reason "don't go ahead" closes an issue with: not planned, which GitHub records. */
export const DONT_GO_AHEAD_CLOSE = "not-planned" as const;

/** What a call an answer causes records as its detail. */
export interface AnswerCallDetail {
  /** The board item the answer was given to. */
  boardItemId: number;
  /** The verdict call the ticket was raised from, which going ahead writes criteria for without running it again. */
  verdictCallId: number | null;
  /** The pins the owner has seen for the ticket by answering an item raised for them. */
  pinsSeen: string[];
}

/** The board item that put an on-the-board ticket there, with its answer once the owner gave one. */
function itemOnTheBoard(store: Store, ticket: TicketRecord): { item: BoardItemRecord; answer: AnswerRecord | null } | null {
  if (ticket.state !== "on-the-board" || ticket.stateCallId === null) return null;
  const history = store.boardItemsForTicket(ticket.id).find(({ item }) => item.callId === ticket.stateCallId);
  return history === undefined ? null : { item: history.item, answer: history.answer };
}

/**
 * The answer a ticket owes a call for: the ticket is on the board, the item
 * that put it there is answered, and no call cites that answer yet. Null when
 * it owes none.
 */
export function owedAnswer(store: Store, ticket: TicketRecord, calls: readonly CallRecord[]): { item: BoardItemRecord; answer: AnswerRecord } | null {
  const found = itemOnTheBoard(store, ticket);
  if (found === null || found.answer === null) return null;
  const answerId = found.answer.id;
  if (calls.some((call) => call.answerId === answerId)) return null;
  return { item: found.item, answer: found.answer };
}

/**
 * The verdict call a raise rests on: the verdict itself, or the verdict a
 * criteria call that raised the ticket was written for.
 */
export function verdictCallOfRaise(raise: CallRecord | null, calls: readonly CallRecord[]): CallRecord | null {
  const basedOn = (raise?.detail as { basedOnCallId?: unknown } | null)?.basedOnCallId;
  const call = calls.find((c) => c.id === basedOn);
  if (call === undefined) return null;
  if (call.kind === "verdict") return call;
  if (call.kind === "criteria") {
    const verdictCallId = (call.detail as Partial<CriteriaDetail> | null)?.verdictCallId;
    return calls.find((c) => c.id === verdictCallId && c.kind === "verdict") ?? null;
  }
  return null;
}

/**
 * The answers going ahead that are in force on a ticket, oldest first: each
 * given to an item raised since the ticket's latest verdict. Going ahead never
 * runs the verdict again, so every answer since it still stands; a ticket
 * decided again starts from its new verdict.
 */
export function answersInForce(store: Store, ticketId: number, calls: readonly CallRecord[] = store.callsForTicket(ticketId)): GivenAnswer[] {
  const since = calls.findLast((call) => call.kind === "verdict")?.id ?? 0;
  return store
    .boardItemsForTicket(ticketId)
    .filter(({ item, answer }) => item.callId > since && answer !== null && goesAhead(answer))
    .map(({ item, answer }) => ({ answer: answer!, snapshot: (item.snapshot ?? {}) as Partial<BoardItemSnapshot> }));
}

/**
 * The pins the owner has seen for a ticket (ADR-0008): every pin an answered
 * item named as touched. Once answered, such an item counts as the owner
 * having seen that pin for this ticket, so the same pin does not raise the
 * ticket again.
 */
export function pinsSeen(store: Store, ticketId: number): string[] {
  const seen = new Set<string>();
  for (const { item, answer } of store.boardItemsForTicket(ticketId)) {
    if (answer === null) continue;
    for (const pin of (item.snapshot as Partial<BoardItemSnapshot> | null)?.why?.pins ?? []) seen.add(pin.pin.trim());
  }
  return [...seen];
}

export interface AfterAnswerOptions {
  store: Store;
  log: OperationalLog;
}

/**
 * The owed step an answer causes: a ticket on the board whose item the owner
 * answered gets the call that cites the answer.
 */
export function afterAnswerPlanner(options: AfterAnswerOptions): OwedStepPlanner {
  return (ticket, pass): OwedStep | null => {
    const owed = owedAnswer(options.store, ticket, options.store.callsForTicket(ticket.id));
    if (owed === null) return null;
    return { name: "answer", run: () => actOnAnswer(options, ticket, owed, pass) };
  };
}

/**
 * Makes the call an answer causes. Going ahead, it returns the ticket to
 * deciding, citing the answer, with no forge write: the intake comment comes
 * with the criteria. "Don't go ahead" records, in one transaction, the call
 * that cancels the ticket with the comment's and the close's intents, then
 * comments and closes the issue. A write that fails is settled on the next
 * start.
 */
async function actOnAnswer(
  options: AfterAnswerOptions,
  ticket: TicketRecord,
  owed: { item: BoardItemRecord; answer: AnswerRecord },
  pass: Pick<RepoPass, "repo" | "writer">,
): Promise<void> {
  const { store, log } = options;
  const { item, answer } = owed;
  const snapshot = (item.snapshot ?? {}) as Partial<BoardItemSnapshot>;
  const ownerName = readGlobalSettings(store).settings.ownerDisplayName;
  if (ownerName === null) throw new Error("the owner's display name is not set, so entail cannot attribute a comment");

  const made = store.transaction(() => {
    const now = store.getTicket(ticket.id);
    if (now === null || now.state !== ticket.state || now.stateCallId !== ticket.stateCallId) return null;
    const calls = store.callsForTicket(ticket.id);
    if (owedAnswer(store, now, calls)?.answer.id !== answer.id) return null;
    const detail: AnswerCallDetail = {
      boardItemId: item.id,
      verdictCallId: verdictCallOfRaise(store.getCall(item.callId), calls)?.id ?? null,
      pinsSeen: pinsSeen(store, ticket.id),
    };
    if (goesAhead(answer)) {
      const call = store.recordCall({
        ticketId: ticket.id,
        kind: "go-ahead",
        reason: `The owner's answer goes ahead: “${answerWords(answer, snapshot).trim()}”. entail writes the criteria from it, without running the verdict again.`,
        answerId: answer.id,
        detail,
        stateTo: "deciding",
      });
      return { call, body: null };
    }
    const call = store.recordCall({
      ticketId: ticket.id,
      kind: "cancel-on-answer",
      reason: "The owner decided not to go ahead, so the ticket is cancelled and its issue closed.",
      answerId: answer.id,
      detail,
      stateTo: "cancelled",
    });
    const body = answerComment(ownerName, ticket.id, answer, snapshot, pass.repo.forge);
    const intent = { repoId: pass.repo.id, ticketId: ticket.id, callId: call.id, target: "issue", number: ticket.issueNumber } as const;
    store.recordForgeWriteIntent({ ...intent, kind: "comment", payload: { body } });
    store.recordForgeWriteIntent({ ...intent, kind: "close", payload: { reason: DONT_GO_AHEAD_CLOSE } });
    return { call, body };
  });
  if (made === null) {
    log.info("answer-discarded", { ticketId: ticket.id, answerId: answer.id });
    return;
  }
  log.info("answer-acted-on", { ticketId: ticket.id, answerId: answer.id, callId: made.call.id, kind: made.call.kind });
  if (made.body === null) return;

  // Each resumes the intent recorded above; the comment is found by its hidden marker if it was already posted.
  const writer = pass.writer();
  const write = { ticketId: ticket.id, callId: made.call.id };
  await writer.comment(write, "issue", ticket.issueNumber, made.body);
  await writer.closeIssue(write, ticket.issueNumber, DONT_GO_AHEAD_CLOSE);
}
