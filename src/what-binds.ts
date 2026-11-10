/**
 * What binds a call (ADR-0021, issue #170): only the vision of record and the
 * repo's pins decide whether a ticket goes ahead or comes to the owner.
 * Everything else in the repo, such as decision records, the spec, docs,
 * tests and code, is design history. It may inform how a change is built,
 * but it never makes readings consequential, is never something a ticket
 * contradicts, and never locks in or narrows a ticket's criteria. A ticket
 * that overturns a recorded decision gets a criterion to update or supersede
 * the record instead.
 *
 * Every prompt that decides or tests whether a ticket goes ahead, or writes
 * its criteria, carries {@link WHAT_BINDS} word for word, so the decider, the
 * re-check, the challenge and the criteria writer hold the same rule.
 */

/** The repo content that records past decisions or describes how things are, named the same way in every prompt. */
export const REPO_CONTENT = "decision records (such as docs/adr/), a spec, other docs, tests and the code itself";

/** The rule every judging prompt states: nothing binds but the vision of record and the pins. */
export const WHAT_BINDS = `Only the vision of record and the pins decide whether a ticket goes ahead or comes to the owner. Nothing else in the repo binds: ${REPO_CONTENT} are the project's design history. They may inform how a change is built, but a ticket that departs from what they describe or decided is an improvement to be judged like any other. Such content is never a line a ticket contradicts, never makes readings consequential, and never narrows or locks what a ticket asks for. Beyond the vision and the pins, go by a general understanding of what improves the project.`;
