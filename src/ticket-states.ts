/**
 * A ticket's states and the transitions between them (MVP-1 spec §17).
 *
 * A ticket is taken in as `deciding`. Flagging and a re-check are not states:
 * a flagged ticket keeps its state until its re-check is recorded. A failed
 * landing check leaves a ticket `landing`, which is no transition at all.
 */
export const TICKET_STATES = [
  "deciding",
  "investigating",
  "declined",
  "on-the-board",
  "cleared",
  "landing",
  "merged",
  "cancelled",
] as const;

export type TicketState = (typeof TICKET_STATES)[number];

/** Final states stay final; an issue comes back only as a new ticket (ADR-0020). */
export const FINAL_STATES = ["declined", "cancelled", "merged"] as const satisfies readonly TicketState[];

export type FinalState = (typeof FINAL_STATES)[number];

/** The state every ticket starts in when it is taken in. */
export const INITIAL_STATE: TicketState = "deciding";

/**
 * Every allowed transition, from → to. Besides the ones listed per state:
 * any non-final state may go to `cancelled` (the issue closed, deleted or
 * moved elsewhere, or the repo unenrolled) and to `merged` (the ticket's PR
 * merged by someone other than entail).
 */
export const TICKET_TRANSITIONS: Readonly<Record<TicketState, readonly TicketState[]>> = {
  // oversized; cause or validity unknown; nothing to do; cleared; needs the owner
  deciding: ["declined", "investigating", "cancelled", "cleared", "on-the-board", "merged"],
  // findings arrive (a ticket is investigated at most once)
  investigating: ["deciding", "cancelled", "merged"],
  // an answer goes ahead, or the item is withdrawn; "don't go ahead"
  "on-the-board": ["deciding", "cancelled", "merged"],
  // a PR linking the issue is being checked; a re-check needs the owner
  cleared: ["landing", "on-the-board", "cancelled", "merged"],
  // merged; a pinned path touched or a re-check needs the owner; PR closed unmerged
  landing: ["merged", "on-the-board", "cleared", "cancelled"],
  declined: [],
  cancelled: [],
  merged: [],
};

export function isTicketState(value: unknown): value is TicketState {
  return typeof value === "string" && (TICKET_STATES as readonly string[]).includes(value);
}

export function isFinalState(state: TicketState): state is FinalState {
  return (FINAL_STATES as readonly TicketState[]).includes(state);
}

export function canTransition(from: TicketState, to: TicketState): boolean {
  return TICKET_TRANSITIONS[from].includes(to);
}

/** A state change a call asked for that spec §17 does not allow. */
export class TransitionError extends Error {
  readonly from: TicketState;
  readonly to: TicketState;
  constructor(from: TicketState, to: TicketState, why?: string) {
    const reason = why ?? (isFinalState(from) ? `${from} is final` : "spec §17 has no such transition");
    super(`a ticket cannot go from ${from} to ${to}: ${reason}`);
    this.name = "TransitionError";
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(from: TicketState, to: TicketState): void {
  if (!canTransition(from, to)) throw new TransitionError(from, to);
}
