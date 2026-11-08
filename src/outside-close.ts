import type { OperationalLog } from "./operational-log.ts";
import type { ChangeHandler, OwedStepPlanner, RepoPass } from "./pass.ts";
import { LABEL_IN_STATE, mergeEndsTicket } from "./pull-requests.ts";
import type { CallRecord, Store, TicketRecord } from "./store.ts";
import { isFinalState } from "./ticket-states.ts";
import { withdrawOpenItem, type WithdrawalBasis } from "./withdraw.ts";

/**
 * Keeping the records in step with issues others close (spec §5, §13, §17,
 * ADR-0008, ADR-0020).
 *
 * When someone other than entail closes, deletes, transfers or converts an
 * issue whose ticket is not final, the ticket is cancelled with a logged
 * call, its `entail:` label is removed where the issue still exists, and its
 * open board item is withdrawn. entail posts nothing on the issue.
 *
 * - entail moves a ticket to a final state before it closes the ticket's
 *   issue itself, so an issue closed while its ticket is in flight was closed
 *   by someone else.
 * - An issue that closes because one of its PRs merged for the ticket is not
 *   cancelled: the merge ends the ticket as merged, recorded by following its
 *   PRs or by entail's own merge.
 * - A close is read from the issue changes each pass reports. A deleted,
 *   transferred or converted issue reports no change, so each in-flight
 *   ticket's issue is also read live: once after each start, and again every
 *   {@link ISSUE_RECHECK_MS} while the ticket has no other step owed.
 * - entail acts on the state it reads. An issue closed and reopened between
 *   two reads cancels nothing, and reopening an issue, by anyone, starts
 *   nothing and posts nothing: a final ticket stays final, and its issue
 *   comes back only when the owner pulls it in (ADR-0020).
 */

/** How long after reading an in-flight ticket's issue live entail reads it again, to find one deleted, transferred or converted. */
export const ISSUE_RECHECK_MS = 5 * 60_000;

/** How the issue went: closed by someone other than entail, or gone from the repo (deleted, transferred or converted). */
export type OutsideClose = "closed" | "gone";

/** What a cancel-on-outside-close call records as its detail. */
export interface OutsideCloseDetail {
  issue: OutsideClose;
}

export interface OutsideCloseOptions {
  store: Store;
  log: OperationalLog;
  /** The clock, in milliseconds, for when an issue is read again. */
  now?: () => number;
}

/** The change handler and the planner that cancel tickets whose issue someone else closed, deleted or moved. */
export interface OutsideCloseFollowing {
  /** Cancels the ticket of an issue the pass read as closed. */
  onChange: ChangeHandler;
  /** Each in-flight ticket's live read of its issue, owed once after each start and then every {@link ISSUE_RECHECK_MS}. */
  planner: OwedStepPlanner;
}

const CALL_REASON: Readonly<Record<OutsideClose, string>> = {
  closed: "Cancelled: someone other than entail closed the issue.",
  gone: "Cancelled: the issue is gone from the repo; it was deleted, transferred to another repo or converted to a discussion.",
};

const BASIS: Readonly<Record<OutsideClose, WithdrawalBasis>> = {
  closed: { kind: "issue-closed" },
  gone: { kind: "issue-gone" },
};

export function outsideCloses(options: OutsideCloseOptions): OutsideCloseFollowing {
  const now = options.now ?? Date.now;
  /** Per ticket, when its issue was last read live. */
  const readAt = new Map<number, number>();

  const onChange: ChangeHandler = async (change, pass) => {
    if (change.kind !== "issue" || change.issue.state !== "closed") return;
    const ticket = options.store.latestTicketForIssue(pass.repo.id, change.issue.number);
    if (ticket === null) return;
    await cancelOnOutsideClose(options, ticket, "closed", pass);
  };

  const planner: OwedStepPlanner = (ticket, pass) => {
    const last = readAt.get(ticket.id);
    if (last !== undefined && now() - last < ISSUE_RECHECK_MS) return null;
    return {
      name: "issue-check",
      run: async () => {
        const issue = await pass.forge.issue(ticket.issueNumber);
        if (issue === null) await cancelOnOutsideClose(options, ticket, "gone", pass);
        else if (issue.state === "closed") await cancelOnOutsideClose(options, ticket, "closed", pass);
        readAt.set(ticket.id, now());
      },
    };
  };

  return { onChange, planner };
}

/**
 * Cancels a ticket whose issue someone other than entail closed, or that is
 * gone from the repo. In one transaction it records the cancel call, the
 * withdrawal of any open board item and, where the issue still exists, the
 * intent to remove the ticket's label; then it sends the label removal. A
 * ticket already final is left alone, except that a label removal its own
 * cancel recorded but never confirmed is sent again, so running this twice
 * for one close is safe.
 */
export async function cancelOnOutsideClose(
  options: Pick<OutsideCloseOptions, "store" | "log">,
  ticket: TicketRecord,
  how: OutsideClose,
  pass: RepoPass,
): Promise<void> {
  const { store, log } = options;
  if (!isFinalState(ticket.state)) {
    // Read before the transaction, since it reads the forge; the transaction then reads the ticket afresh.
    // An issue gone from the repo has no PRs here to read.
    if (how === "closed" && mergeEndsTicket(store, ticket, await pass.forge.linkedPullRequests(ticket.issueNumber))) return;
    const recorded = store.transaction(() => {
      const current = store.getTicket(ticket.id);
      if (current === null || isFinalState(current.state)) return null;
      const detail: OutsideCloseDetail = { issue: how };
      const call = store.recordCall({
        ticketId: current.id,
        kind: "cancel-on-outside-close",
        reason: CALL_REASON[how],
        inputs: { settingsVersionId: pass.settings.id },
        detail,
        stateTo: "cancelled",
      });
      const withdrawn = current.state === "on-the-board" ? withdrawOpenItem(store, { ticketId: current.id, callId: call.id, basis: BASIS[how] }) : null;
      const label = how === "closed" ? (LABEL_IN_STATE[current.state] ?? null) : null;
      if (label !== null) {
        store.recordForgeWriteIntent({
          repoId: pass.repo.id,
          ticketId: current.id,
          callId: call.id,
          kind: "label",
          target: "issue",
          number: current.issueNumber,
          payload: { action: "remove", label },
        });
      }
      return { call, from: current.state, withdrawn };
    });
    if (recorded !== null) {
      log.info("ticket-cancelled-outside-close", {
        ticketId: ticket.id,
        callId: recorded.call.id,
        issue: ticket.issueNumber,
        how,
        from: recorded.from,
        withdrawnItem: recorded.withdrawn?.id ?? null,
      });
    }
  }
  await removeLabelsLeftOver(store, store.getTicket(ticket.id), pass);
}

/** Sends the label removals a ticket's cancel-on-outside-close call recorded and never confirmed. */
async function removeLabelsLeftOver(store: Store, ticket: TicketRecord | null, pass: RepoPass): Promise<void> {
  if (ticket === null || ticket.state !== "cancelled" || ticket.stateCallId === null) return;
  const cancel: CallRecord | null = store.getCall(ticket.stateCallId);
  if (cancel?.kind !== "cancel-on-outside-close") return;
  const pending = store
    .forgeWritesOn(pass.repo.id, "issue", ticket.issueNumber)
    .filter((write) => write.callId === cancel.id && write.kind === "label" && !write.confirmed);
  if (pending.length === 0) return;
  const writer = pass.writer();
  for (const write of pending) {
    // Resumes the intent recorded with the cancel call.
    await writer.removeLabel({ ticketId: ticket.id, callId: cancel.id }, ticket.issueNumber, (write.payload as { label: string }).label);
  }
}
