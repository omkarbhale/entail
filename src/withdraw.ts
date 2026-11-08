import type { BoardItemRecord, Store } from "./store.ts";

/**
 * Withdrawing a board item (spec §13 "Withdrawn items", ADR-0008, ADR-0012).
 *
 * An open item is withdrawn when its basis changes before it is answered. The
 * withdrawal is recorded with the call that takes the ticket off the board,
 * in the same transaction: cancelling it, deciding it again or checking it
 * again. A withdrawn item takes no answer, and the board locks its form,
 * saying why (the reason recorded here) and what happens next (worked out
 * from the state that call moved the ticket to). The owner's typed text stays
 * on the page to copy and is never recorded.
 */

/** Why an open board item was withdrawn: what changed its basis. */
export type WithdrawalBasis =
  /** Someone other than entail closed the issue, so the ticket is cancelled. */
  | { kind: "issue-closed" }
  /** The issue was deleted, transferred to another repo or converted to a discussion, so the ticket is cancelled. */
  | { kind: "issue-gone" }
  /** The issue's title or body was edited, so the ticket is decided again (ADR-0020). */
  | { kind: "issue-edited" }
  /** A vision change removed or reworded a line in the item's vision check, or added a line (ADR-0016). */
  | { kind: "vision-change" }
  /** A pin change touched the item: a pin was added, or a pin it names was removed or edited (ADR-0018). */
  | { kind: "pin-change"; pins: readonly string[] }
  /** A new push arrived on the PR a landing pin item was about (ADR-0014). */
  | { kind: "new-push" }
  /** The repo was unenrolled, so the ticket is cancelled (ADR-0018). */
  | { kind: "repo-unenrolled" };

/** The reason a withdrawn item gives, in the words the board form shows when it locks. */
export function withdrawalReason(basis: WithdrawalBasis): string {
  switch (basis.kind) {
    case "issue-closed":
      return "Someone other than entail closed the issue.";
    case "issue-gone":
      return "The issue is gone from the repo: it was deleted, transferred to another repo or converted to a discussion.";
    case "issue-edited":
      return "The issue was edited, and this item's options were written for the old text.";
    case "vision-change":
      return "VISION.md changed in a way that touches this item's vision check.";
    case "pin-change": {
      const names = basis.pins.map((pin) => `“${pin.trim()}”`);
      const listed = names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
      return names.length === 0 ? "The repo's pins changed." : `The ${names.length === 1 ? "pin" : "pins"} ${listed} changed.`;
    }
    case "new-push":
      return "A new push arrived on the pull request this item was about.";
    case "repo-unenrolled":
      return "The repo was unenrolled.";
  }
}

/**
 * Withdraws the ticket's open board item, if it has one, for the call that
 * takes the ticket off the board. Run it in the transaction that records that
 * call: the store refuses a withdrawal by any call that did not move the
 * ticket from on the board. Returns the item withdrawn, or null when the
 * ticket had no open item.
 */
export function withdrawOpenItem(
  store: Store,
  input: { ticketId: number; callId: number; basis: WithdrawalBasis },
): BoardItemRecord | null {
  const item = store.openBoardItem(input.ticketId);
  if (item === null) return null;
  store.withdrawBoardItem({ boardItemId: item.id, callId: input.callId, reason: withdrawalReason(input.basis) });
  return item;
}
