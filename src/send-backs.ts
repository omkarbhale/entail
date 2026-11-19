import type { LandingEntry, LandingPending, PullRequestRef } from "./records.ts";

/**
 * Handing a PR that was sent back, or cancelled, to a command: one the owner
 * sets (`entail settings --send-back '<command>'`), run when entail acts on a
 * landing call that sends a PR back or closes it unmerged, whether that call is
 * entail's own, the owner's confirmation of it, or the owner's override to send
 * back. Never when a PR merges, is raised to the board or is asked about. It
 * runs once per act, as the start command does (`src/starts.ts`, whose runner
 * it shares), after the comment is posted and the act recorded, so what the
 * command does, or fails to do, never changes or delays the call or its
 * comment: the log records that it ran, by which command and with what exit
 * status.
 *
 * entail still never touches the PR itself and depends on no particular
 * executor: `examples/send-back-to-file.sh` appends the handoff to a file.
 */

/** What the send-back command reads on standard input. */
export interface SendBackHandoff {
  repo: string;
  /** `send-back`: the PR stays open for a new push, judged again; `cancel`: it was closed unmerged. */
  outcome: "send-back" | "cancel";
  pr: { number: number; url: string; title: string };
  /** The issue the PR closes; null when no cleared ticket is behind it and it was judged on the vision alone. */
  issue: { number: number; url: string; title: string } | null;
  /** The head commit that was judged. */
  head: string;
  /** The log entry the act answers: entail's landing call, or the owner's action on it. */
  call: number;
  /** Whose call it is: entail's alone, or the owner's (a confirmation or an override). */
  by: "entail" | "owner";
  reason: string;
  /** What needs to change, as the comment on the PR lists it. */
  needsToChange: string[];
  /** The criteria the issue's go set, each marked met or unmet at the head, with the evidence. */
  checklist: { criterion: string; met: boolean; evidence: string }[];
  /** The criteria with where each comes from; empty with no issue. */
  criteria: LandingEntry["criteria"];
  /** The owner's words, when the owner's override is what sent the PR back. */
  ownerWords?: string;
}

/** The handoff for an act that sends a PR back or closes it, given what the act does; the act's own comment is not needed. */
export function sendBackHandoffFor(repo: string, pending: LandingPending, post: { sentBack: boolean; close: boolean }): SendBackHandoff | null {
  const landing: LandingEntry = pending.kind === "landing" ? pending.entry : pending.landing;
  // A send-back that waits for the owner to close the PR is handed over when the owner confirms.
  const waiting = pending.kind === "landing" && landing.cancel && landing.confirm;
  if (waiting || !(post.sentBack || post.close)) return null;
  const pr: PullRequestRef = landing.pr;
  const base = {
    repo,
    outcome: post.close ? ("cancel" as const) : ("send-back" as const),
    pr: { number: pr.number, url: pr.url, title: pr.title },
    issue: landing.issue === null ? null : { number: landing.issue.number, url: landing.issue.url, title: landing.issue.title },
    head: landing.head,
    // An owner's override of a merge sends the PR back on the owner's words; entail's own reason was for merging.
    ...(pending.kind === "landing-owner" && landing.call.call !== "send-back"
      ? { reason: ownerWords(pending), needsToChange: [ownerWords(pending)] }
      : { reason: landing.call.reason, needsToChange: landing.call.needsToChange }),
    checklist: landing.call.criteria.map((check) => ({ criterion: check.criterion, met: check.met, evidence: check.evidence })),
    criteria: landing.criteria,
  };
  switch (pending.kind) {
    case "landing":
      return { ...base, call: pending.entry.id, by: "entail" };
    case "landing-confirmed":
      return { ...base, call: pending.action.id, by: "owner" };
    case "landing-owner":
      return { ...base, call: pending.action.id, by: "owner", ownerWords: ownerWords(pending) };
  }
}

function ownerWords(pending: Extract<LandingPending, { kind: "landing-owner" }>): string {
  return pending.action.type === "overridden" ? pending.action.reason : pending.action.answer;
}
