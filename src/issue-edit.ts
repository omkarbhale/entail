import type { JudgedRequest } from "./decider.ts";
import type { RequestPart } from "./intake.ts";
import type { OperationalLog } from "./operational-log.ts";
import { RAISED_LABEL } from "./intake-comment.ts";
import type { ChangeHandler, RepoPass } from "./pass.ts";
import type { CallRecord, Store, TicketRecord } from "./store.ts";
import { isFinalState } from "./ticket-states.ts";
import { withdrawOpenItem } from "./withdraw.ts";

/**
 * What an issue edit is, and what it does to a ticket in each state (spec
 * §12, ADR-0020, ADR-0016).
 *
 * - **An edit** is a change to the issue's title or body compared with the
 *   text the ticket's latest call recorded. A change to whitespace only is no
 *   edit, and neither is ticking or unticking a task-list checkbox. Comments,
 *   labels, assignees and milestones are not compared at all, and who edited
 *   does not matter: issue text is never the owner's word (ADR-0001).
 * - **Recorded.** An edit to an issue whose ticket is not final is recorded
 *   as an `issue-edit` call holding the new text, which every later step
 *   judges, so owed work stays a function of the records (ADR-0017).
 * - **Deciding.** A verdict or criteria run in flight is discarded, and the
 *   ticket is decided at the latest text (`decider.ts`, `criteria.ts`).
 * - **Investigating.** Nothing more: when findings arrive, the ticket is
 *   decided at the text recorded by then.
 * - **On the board.** The open item is withdrawn, its form locks saying the
 *   issue was edited, and the ticket is decided again, in one transaction.
 * - **Cleared or landing.** The ticket is flagged until a re-check at the
 *   latest text is recorded, including one cleared by the owner's answer
 *   (`flags.ts`, `recheck.ts`); it keeps its state and `entail:cleared`, and
 *   nothing for it merges meanwhile.
 * - **Final.** Nothing happens.
 */

/** An issue's title and body as a call recorded them. */
export interface IssueText {
  title: string;
  body: string;
}

/** What an `issue-edit` call records as its detail: the request at the new text, and the text before and after. */
export interface IssueEditDetail {
  /** The request as the decider now judges it: the new title and body, with the comments the ticket was taken in with. */
  request: RequestPart[];
  edit: { from: IssueText; to: IssueText };
}

/** An edit since a judgment: the text the judgment read, the text now, and the edit calls between them. */
export interface IssueEditSince {
  from: IssueText;
  to: IssueText;
  editCallIds: number[];
}

/** A task-list item's checkbox at the start of a line: a bullet or number, then `[ ]`, `[x]` or `[X]`. */
const TASK_BOX = /^(\s*(?:[-*+]|\d+[.)])\s+)\[[ xX]\]/gmu;

/**
 * An issue's title or body as an edit is judged on: every task-list checkbox
 * unticked, and every run of whitespace one space, with none at either end.
 */
export function comparableIssueText(text: string): string {
  return text.replace(/\r\n?/gu, "\n").replace(TASK_BOX, "$1[ ]").replace(/\s+/gu, " ").trim();
}

/**
 * Whether the issue's current title or body is an edit of the text recorded
 * (ADR-0020): it differs other than by whitespace or task-list ticks.
 */
export function isIssueEdit(recorded: IssueText, current: IssueText): boolean {
  return comparableIssueText(recorded.title) !== comparableIssueText(current.title) || comparableIssueText(recorded.body) !== comparableIssueText(current.body);
}

/**
 * The issue text the ticket's latest call to record one judged, or null when
 * none did. A raise is passed over: it repeats the inputs of the call it rests
 * on, which may be older than an edit since.
 */
export function recordedIssueText(calls: readonly CallRecord[]): IssueText | null {
  for (const call of [...calls].reverse()) {
    if (call.kind === "raise") continue;
    const text = issueTextOf(call);
    if (text !== null) return text;
  }
  return null;
}

/** The issue text a call recorded with its inputs, or null when it recorded none. */
export function issueTextOf(call: CallRecord): IssueText | null {
  const title = call.inputs?.issueTitle;
  const body = call.inputs?.issueBody;
  return typeof title === "string" && typeof body === "string" ? { title, body } : null;
}

/** The id of the ticket's latest `issue-edit` call, or 0 when the issue was never edited. */
export function latestIssueEditId(calls: readonly CallRecord[]): number {
  return calls.findLast((call) => call.kind === "issue-edit")?.id ?? 0;
}

/**
 * The edit a judgment has not seen: the text the judgment read against the
 * text recorded since, when they differ as an edit. An issue edited back to
 * the text judged has no edit since. Null when there is none, or the
 * judgment recorded no text.
 */
export function issueEditSince(judgment: CallRecord, calls: readonly CallRecord[]): IssueEditSince | null {
  const from = issueTextOf(judgment);
  const to = recordedIssueText(calls);
  if (from === null || to === null || !isIssueEdit(from, to)) return null;
  const editCallIds = calls.filter((call) => call.id > judgment.id && call.kind === "issue-edit").map((call) => call.id);
  return editCallIds.length === 0 ? null : { from, to, editCallIds };
}

/** The request at the new text: the title and body replaced, every other part as it was. */
export function editedRequest(request: JudgedRequest, current: IssueText): RequestPart[] {
  return request.parts.map((part) => (part.part === "title" ? { ...part, text: current.title } : part.part === "body" ? { ...part, text: current.body } : part));
}

const REASONS: Readonly<Record<"deciding" | "investigating" | "on-the-board" | "withdrawn" | "cleared" | "landing", string>> = {
  deciding: "The issue was edited, so any run in flight is discarded and the ticket is decided at the latest text.",
  investigating: "The issue was edited; the ticket is decided at the text current when its findings arrive.",
  "on-the-board": "The issue was edited; the owner's answer to its board item stands, and the ticket goes on from it at the latest text.",
  withdrawn: "The issue was edited, so the open board item is withdrawn and the ticket decided again at the latest text.",
  cleared: "The issue was edited, so the ticket is flagged for a re-check at the latest text; nothing for it merges until the re-check is recorded.",
  landing: "The issue was edited, so the ticket is flagged for a re-check at the latest text; nothing for it merges until the re-check is recorded.",
};

/**
 * Records an edit to the ticket's issue (ADR-0020), when the current text is
 * an edit of the text its latest call recorded: the `issue-edit` call with the
 * new text, and, for a ticket on the board with an open item, the withdrawal
 * of that item and the intent to remove `entail:raised` with the call that
 * takes the ticket back to deciding, in one transaction. A final ticket, or
 * text that is no edit, records nothing. Safe to run twice for one edit.
 * Returns the call, or null.
 */
export function recordIssueEdit(store: Store, ticketId: number, current: IssueText, settingsVersionId: number | null): CallRecord | null {
  return store.transaction(() => {
    const ticket = store.getTicket(ticketId);
    if (ticket === null || isFinalState(ticket.state)) return null;
    const calls = store.callsForTicket(ticket.id);
    const recorded = recordedIssueText(calls);
    const request = judgedRequestOf(calls);
    if (recorded === null || request === null || !isIssueEdit(recorded, current)) return null;
    const withdraw = ticket.state === "on-the-board" && store.openBoardItem(ticket.id) !== null;
    const detail: IssueEditDetail = { request: editedRequest(request, current), edit: { from: recorded, to: { title: current.title, body: current.body } } };
    const call = store.recordCall({
      ticketId: ticket.id,
      kind: "issue-edit",
      reason: REASONS[withdraw ? "withdrawn" : (ticket.state as keyof typeof REASONS)],
      inputs: { issueTitle: current.title, issueBody: current.body, settingsVersionId },
      detail,
      ...(withdraw ? { stateTo: "deciding" as const } : {}),
    });
    if (withdraw) {
      withdrawOpenItem(store, { ticketId: ticket.id, callId: call.id, basis: { kind: "issue-edited" } });
      store.recordForgeWriteIntent({
        repoId: ticket.repoId,
        ticketId: ticket.id,
        callId: call.id,
        kind: "label",
        target: "issue",
        number: ticket.issueNumber,
        payload: { action: "remove", label: RAISED_LABEL },
      });
    }
    return call;
  });
}

/** The request the ticket's latest call recorded, read here to keep this module free of the decider's imports. */
function judgedRequestOf(calls: readonly CallRecord[]): JudgedRequest | null {
  for (const call of [...calls].reverse()) {
    const text = issueTextOf(call);
    const parts = (call.detail as { request?: unknown } | null)?.request;
    if (text !== null && Array.isArray(parts)) return { ...text, parts: parts as RequestPart[] };
  }
  return null;
}

export interface IssueEditOptions {
  store: Store;
  log: OperationalLog;
}

/** Records the edit an issue change the pass read carries, on the issue's latest ticket. */
export function issueEdits(options: IssueEditOptions): { onChange: ChangeHandler } {
  const { store, log } = options;
  const onChange: ChangeHandler = async (change, pass) => {
    if (change.kind !== "issue" || change.issue.state !== "open") return;
    const ticket: TicketRecord | null = store.latestTicketForIssue(pass.repo.id, change.issue.number);
    if (ticket === null) return;
    const call = recordIssueEdit(store, ticket.id, change.issue, pass.settings.id);
    if (call !== null) {
      logEdit(log, ticket, call);
      await removeRaisedOnEdit(ticket, call, pass);
    }
  };
  return { onChange };
}

/** Sends the removal of `entail:raised` an edit recorded when it took the ticket off the board, resuming its intent. */
export async function removeRaisedOnEdit(ticket: TicketRecord, call: CallRecord, pass: Pick<RepoPass, "writer">): Promise<void> {
  if (call.stateChange === null) return;
  await pass.writer().removeLabel({ ticketId: ticket.id, callId: call.id }, ticket.issueNumber, RAISED_LABEL);
}

/** Logs an edit recorded. */
export function logEdit(log: OperationalLog, ticket: TicketRecord, call: CallRecord): void {
  log.info("issue-edit-recorded", { ticketId: ticket.id, issueNumber: ticket.issueNumber, callId: call.id, state: ticket.state, withdrawn: call.stateChange !== null });
}
