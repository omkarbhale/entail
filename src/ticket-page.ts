import {
  answerSummary,
  CALL_FILTERS,
  CALLS_PATH,
  CallContext,
  issueUrl,
  missing,
  recordId,
  renderCall,
  repoLabel,
  TICKET_PATH,
  ticketPath,
} from "./calls-page.ts";
import type { RetryState } from "./model-runs.ts";
import { escapeHtml, renderPage, timeHtml } from "./page.ts";
import type { Page, PageRequest, Reply } from "./server.ts";
import type { AnswerRecord, BoardItemHistory, CallRecord, Store, TicketRecord } from "./store.ts";

export interface TicketPageOptions {
  store: Store;
  /**
   * The ticket's retry state while its model step is failing, or null. It is
   * operational, not a record, so a restart forgets it (ADR-0019).
   */
  retryState?: (ticketId: number) => RetryState | null;
}

/**
 * Each ticket's page (spec §14, ADR-0009, ADR-0019): its whole history, in
 * order, with every call in full, each board item raised and how it ended,
 * and each answer under the name of whoever gave it; links to the ticket it
 * was pulled in after and the one that pulled it in again, with the history
 * of every ticket before it, so its predecessors' calls and answers show
 * (ADR-0020); and its own retry state. Like the Calls page it asks nothing and offers no action.
 */
export function ticketPage(options: TicketPageOptions): Page {
  return {
    path: TICKET_PATH,
    get: (request) => ticketView(options, request),
  };
}

function ticketView(options: TicketPageOptions, request: PageRequest): Reply {
  const { store } = options;
  const id = recordId(request.url.searchParams.get("id"));
  const ticket = id === null ? null : store.getTicket(id);
  if (ticket === null) return missing(request, "Ticket", "entail has no ticket with this id.");

  const context = new CallContext(store);
  const repo = context.repo(ticket.repoId);
  const successor = store.successorOf(ticket.id);
  const facts: [string, string][] = [];
  if (repo) facts.push(["Repo", escapeHtml(repoLabel(repo))]);
  facts.push([
    "Issue",
    repo ? `<a href="${escapeHtml(issueUrl(repo, ticket.issueNumber))}">#${ticket.issueNumber}</a>` : `#${ticket.issueNumber}`,
  ]);
  facts.push(["State", `${escapeHtml(ticket.state)} <span class="muted">since ${timeHtml(ticket.stateChangedAt)}</span>`]);
  facts.push(["Taken in", timeHtml(ticket.takenInAt)]);
  if (ticket.predecessorId !== null) {
    facts.push(["Pulled in again after", `<a href="${escapeHtml(ticketPath(ticket.predecessorId))}">ticket ${ticket.predecessorId}</a>`]);
  }
  if (successor !== null) {
    facts.push(["Pulled in again as", `<a href="${escapeHtml(ticketPath(successor.id))}">ticket ${successor.id}</a>`]);
  }
  facts.push(["Calls", `<a href="${escapeHtml(`${CALLS_PATH}?${CALL_FILTERS.ticket}=${ticket.id}`)}">on the Calls page</a>`]);

  const title = `Ticket ${ticket.id}`;
  const body = `<h1>${escapeHtml(title)}${repo ? `: ${escapeHtml(repoLabel(repo))}#${ticket.issueNumber}` : ""}</h1>
<p class="muted">This page is read-only.</p>
<dl>
${facts.map(([name, value]) => `<dt>${escapeHtml(name)}</dt><dd>${value}</dd>`).join("\n")}
</dl>
<h2>Retry state</h2>
${renderRetryState(options.retryState?.(ticket.id) ?? null)}
<h2>History</h2>
${renderHistory(ticket, store.callsForTicket(ticket.id), store.boardItemsForTicket(ticket.id), context)}${renderPredecessors(store, ticket, context)}`;
  return { status: 200, html: renderPage(request, { title, body }) };
}

/** Whether the ticket's model step is failing, and when it is tried again; never which runs wait. */
export function renderRetryState(retry: RetryState | null): string {
  if (retry === null) return `<p>No model step for this ticket is failing.</p>`;
  const failures = `${retry.failures} machine ${retry.failures === 1 ? "failure" : "failures"} in a row`;
  return `<p class="notice">This ticket's model step is failing: ${escapeHtml(failures)} since ${timeHtml(retry.failingSince)}. It is tried again at ${timeHtml(retry.retryAt)}.</p>
<p>Last failure (${escapeHtml(retry.lastFailure.kind)}): ${escapeHtml(retry.lastFailure.message)}</p>`;
}

/**
 * The history of each ticket the issue had before this one, newest first:
 * their calls, board items and answers. An answer settles only its own
 * ticket (ADR-0008), so these are shown for what the owner said before.
 */
function renderPredecessors(store: Store, ticket: TicketRecord, context: CallContext): string {
  const sections: string[] = [];
  for (let id = ticket.predecessorId; id !== null; ) {
    const before = store.getTicket(id);
    if (before === null) break;
    sections.push(`<section class="predecessor" id="predecessor-${before.id}">
<h3>Before this: <a href="${escapeHtml(ticketPath(before.id))}">ticket ${before.id}</a>, ${escapeHtml(before.state)}</h3>
${renderHistory(before, store.callsForTicket(before.id), store.boardItemsForTicket(before.id), context)}
</section>`);
    id = before.predecessorId;
  }
  if (sections.length === 0) return "";
  return `\n<h2>Tickets before this one</h2>\n<p class="muted">This issue was pulled in again. Their answers settled only their own tickets.</p>\n${sections.join("\n")}`;
}

type HistoryEntry = { at: string; order: number; seq: number; html: string };

/**
 * The ticket's history, oldest first: taking it in, each call, each board
 * item raised, and the answer or withdrawal that ended it. Entries at the
 * same time keep the order they happen in: a call, then the item it raised.
 */
function renderHistory(ticket: TicketRecord, calls: readonly CallRecord[], items: readonly BoardItemHistory[], context: CallContext): string {
  const entries: HistoryEntry[] = [
    { at: ticket.takenInAt, order: 0, seq: 0, html: `<p>${timeHtml(ticket.takenInAt)} · Taken in, deciding.</p>` },
  ];
  for (const call of calls) {
    entries.push({ at: call.madeAt, order: 1, seq: call.id, html: renderCall(call, context, { heading: "h3", ticketLinks: false }) });
  }
  for (const { item, answer, withdrawal } of items) {
    entries.push({
      at: item.raisedAt,
      order: 2,
      seq: item.id,
      html: `<section class="event" id="board-item-${item.id}">
<h3>Raised to the board: ${escapeHtml(item.decision)}</h3>
<p class="muted">${timeHtml(item.raisedAt)} · by call ${item.callId}</p>
<p>Why: ${escapeHtml(item.whyRaised)}</p>
</section>`,
    });
    if (answer) entries.push({ at: answer.answeredAt, order: 3, seq: answer.id, html: renderAnswer(answer, item.decision) });
    if (withdrawal) {
      entries.push({
        at: withdrawal.withdrawnAt,
        order: 3,
        seq: item.id,
        html: `<section class="event">
<h3>Board item withdrawn: ${escapeHtml(item.decision)}</h3>
<p class="muted">${timeHtml(withdrawal.withdrawnAt)} · by call ${withdrawal.callId}</p>
<p>Why: ${escapeHtml(withdrawal.reason)}</p>
</section>`,
      });
    }
  }
  entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.order - b.order || a.seq - b.seq));
  return `<ol class="history">\n${entries.map((entry) => `<li>\n${entry.html}\n</li>`).join("\n")}\n</ol>`;
}

/** An answer under the name of whoever gave it (ADR-0008). */
function renderAnswer(answer: AnswerRecord, decision: string): string {
  const note =
    answer.note === null
      ? ""
      : `<p>Note (${answer.showNoteOnIssue ? "shown on the issue" : "private"}): ${escapeHtml(answer.note)}</p>`;
  return `<section class="event" id="answer-${answer.id}">
<h3>Answered by ${escapeHtml(answer.answeredBy)}: ${escapeHtml(answerSummary(answer))}</h3>
<p class="muted">${timeHtml(answer.answeredAt)} · on “${escapeHtml(decision)}”</p>
${note}
</section>`;
}
