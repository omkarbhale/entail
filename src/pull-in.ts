import { lastIntakeComment } from "./board-item.ts";
import { composeComment } from "./comment-rules.ts";
import { sameActor, type Forge, type IssueComment } from "./forge/forge.ts";
import type { CommentPayload, ForgeWriter } from "./forge-writer.ts";
import { readGlobalSettings } from "./global-settings.ts";
import { recordIntake, repoOwner, type IntakeDetail, type PullIn } from "./intake.ts";
import type { OperationalLog } from "./operational-log.ts";
import type { EnrollmentRecord, RepoRecord, Store, TicketRecord } from "./store.ts";
import { isFinalState } from "./ticket-states.ts";

/** The command that pulls an issue in, as the whole first line of the owner's new comment (ADR-0020). */
export const PULL_IN_COMMAND = "/entail";

/** Whether a comment's whole first line is `/entail`. Text after that line is ignored. */
export function isPullInCommand(body: string): boolean {
  const first = body.split(/\r\n|\r|\n/, 1)[0] ?? "";
  return first.trim() === PULL_IN_COMMAND;
}

/**
 * Why an issue comment is not an `/entail` that counts, judged from the
 * comment and the repo alone (spec §5, ADR-0020):
 *
 * - its whole first line is not `/entail`;
 * - someone other than the owner's account posted it, compared by numeric id;
 * - it was edited, so `/entail` may have been added to an old comment;
 * - it was posted before the repo was enrolled, so it is not newly posted.
 *
 * Whether it was already counted, and what the issue's tickets say, are
 * judged by {@link pullInOutcome}.
 */
export type NotCounted = "not-a-pull-in" | "not-the-owners" | "edited" | "posted-before-enrollment";

export function whyNotCounted(
  comment: Pick<IssueComment, "body" | "author" | "createdAt" | "updatedAt">,
  repo: RepoRecord,
  enrollment: Pick<EnrollmentRecord, "enrolledAt"> | null,
): NotCounted | null {
  if (!isPullInCommand(comment.body)) return "not-a-pull-in";
  if (!sameActor(comment.author, repoOwner(repo))) return "not-the-owners";
  // A comment's update time moves only when it is edited, so a later one
  // means the text may not be what was first posted.
  if (Date.parse(comment.updatedAt) > Date.parse(comment.createdAt)) return "edited";
  const enrolledAt = Date.parse(enrollment?.enrolledAt ?? repo.enrolledAt);
  if (!(Date.parse(comment.createdAt) >= enrolledAt)) return "posted-before-enrollment";
  return null;
}

/**
 * What an `/entail` that counts on its own terms does, from the records and
 * the issue's state (ADR-0020):
 *
 * - `counted`: this comment, by its forge id, already pulled the issue in or
 *   was replied to, so it does nothing again;
 * - `in-flight`: the issue's ticket is in flight, so nothing happens and
 *   nothing is posted;
 * - `before-final-call`: the issue's last ticket is final, and the comment was
 *   posted before the call that made it so, so it does not count;
 * - `closed`: the issue is closed, so entail replies once that it takes in
 *   only open issues;
 * - `pull-in`: the issue is open with no ticket, or its last ticket is final,
 *   so it is taken in as a new ticket linked to that one.
 */
export type PullInOutcome =
  | { outcome: "counted" }
  | { outcome: "in-flight"; ticket: TicketRecord }
  | { outcome: "before-final-call"; ticket: TicketRecord }
  | { outcome: "closed"; latest: TicketRecord | null }
  | { outcome: "pull-in"; predecessor: TicketRecord | null };

export function pullInOutcome(
  comment: Pick<IssueComment, "createdAt">,
  issueState: "open" | "closed",
  latest: TicketRecord | null,
  counted: boolean,
): PullInOutcome {
  if (counted) return { outcome: "counted" };
  if (latest !== null && !isFinalState(latest.state)) return { outcome: "in-flight", ticket: latest };
  // The final call is the one that last changed the latest ticket's state.
  if (latest !== null && !(Date.parse(comment.createdAt) > Date.parse(latest.stateChangedAt))) {
    return { outcome: "before-final-call", ticket: latest };
  }
  if (issueState === "closed") return { outcome: "closed", latest };
  return { outcome: "pull-in", predecessor: latest };
}

/** The purpose recorded with entail's one reply to an `/entail` comment on a closed issue, by that comment's id. */
export function closedIssueReplyPurpose(commentId: number): string {
  return `closed-issue-reply:${commentId}`;
}

/** entail's reply to an `/entail` on a closed issue (spec §9, ADR-0020). No line starts with `/`. */
export const CLOSED_ISSUE_REPLY =
  "This issue is closed, and entail takes in only open issues. To pull it in, reopen it and comment `/entail` again.";

/**
 * Whether this `/entail` comment, by its forge id, was already counted: it
 * pulled one of the issue's tickets in, or entail recorded its reply to it.
 */
function alreadyCounted(store: Store, repo: RepoRecord, issueNumber: number, commentId: number): boolean {
  for (let ticket = store.latestTicketForIssue(repo.id, issueNumber); ticket !== null; ticket = ticket.predecessorId === null ? null : store.getTicket(ticket.predecessorId)) {
    const intake = store.callsForTicket(ticket.id).find((call) => call.kind === "intake");
    if ((intake?.detail as Partial<IntakeDetail> | null)?.pulledInBy?.commentId === commentId) return true;
  }
  return replyWrites(store, repo, issueNumber, commentId).length > 0;
}

function replyWrites(store: Store, repo: RepoRecord, issueNumber: number, commentId: number) {
  const purpose = closedIssueReplyPurpose(commentId);
  return store
    .forgeWritesOn(repo.id, "issue", issueNumber)
    .filter((write) => write.kind === "comment" && (write.payload as Partial<CommentPayload>).purpose === purpose);
}

/** An `/entail` that does nothing: why, from the records and the issue's state. */
type DoesNothing = Exclude<PullInOutcome["outcome"], "pull-in" | "closed">;

/** What became of an issue comment the forge reported as changed. */
export type PullInResult =
  | { takenIn: TicketRecord }
  | { replied: number }
  | { notCounted: NotCounted | "no-issue" | "left-alone-at-fresh-start" | DoesNothing };

export interface PullInContext {
  store: Store;
  forge: Forge;
  repo: RepoRecord;
  settingsVersionId: number | null;
  writer: () => ForgeWriter;
  log: OperationalLog;
}

/**
 * Acts on one issue comment the forge reported as changed (spec §5,
 * ADR-0020). Only the owner's newly posted `/entail` counts, once by its forge
 * id. On an open issue with no ticket, or whose last ticket is final and the
 * comment came after that final call, the issue is taken in as a new ticket
 * linked to its predecessor, decided afresh at the current text and vision.
 * On a closed issue entail replies once. Anything else does nothing and posts
 * nothing, and so does an `/entail` on an issue a fresh start left alone,
 * since a fresh start takes in only new issues (ADR-0009).
 *
 * Safe to run twice for one comment: a pull-in is one transaction that
 * records the comment's id, and a reply is recorded as an intent before it is
 * sent, then resumed rather than posted again.
 */
export async function pullInOnComment(context: PullInContext, comment: IssueComment): Promise<PullInResult> {
  const { store, forge, repo, log } = context;
  const why = whyNotCounted(comment, repo, store.latestEnrollment(repo.id));
  if (why !== null) {
    // Every comment on every issue comes through here, so only an `/entail` is logged.
    if (why !== "not-a-pull-in") log.info("pull-in-not-counted", { repoId: repo.id, issue: comment.issueNumber, commentId: comment.id, why });
    return { notCounted: why };
  }
  const number = comment.issueNumber;
  if (store.leftAloneAtFreshStart(repo.id, number)) return notCounted(log, repo, comment, "left-alone-at-fresh-start");
  const decide = (state: "open" | "closed") =>
    pullInOutcome(comment, state, store.latestTicketForIssue(repo.id, number), alreadyCounted(store, repo, number, comment.id));

  // Settle what the records alone decide before reading the forge.
  const known = decide("open");
  if (known.outcome === "counted" || known.outcome === "in-flight" || known.outcome === "before-final-call") {
    // A reply recorded but not confirmed is resumed, so it is found rather than posted twice.
    if (known.outcome === "counted") await resumeReply(context, number, comment.id);
    return notCounted(log, repo, comment, known.outcome);
  }

  const issue = await forge.issue(number);
  if (issue === null) return notCounted(log, repo, comment, "no-issue");

  if (issue.state === "closed") {
    const outcome = decide("closed");
    if (outcome.outcome !== "closed") return notCounted(log, repo, comment, doesNothing(outcome));
    await reply(context, number, comment.id, outcome.latest);
    log.info("pull-in-replied", { repoId: repo.id, issue: number, commentId: comment.id });
    return { replied: comment.id };
  }

  const comments = await forge.comments("issue", number);
  const taken = store.transaction(() => {
    // Judged again with the records as they are now: another pass may have acted while the forge was read.
    const outcome = decide("open");
    if (outcome.outcome !== "pull-in") return outcome;
    const predecessor = outcome.predecessor;
    const pullIn: PullIn = {
      comment,
      predecessor: predecessor === null ? null : { ticket: predecessor, lastIntakeComment: lastIntakeComment(store.callsForTicket(predecessor.id)) },
    };
    return recordIntake(store, repo, issue, comments, context.settingsVersionId, pullIn);
  });
  if ("outcome" in taken) return notCounted(log, repo, comment, doesNothing(taken));
  log.info("pulled-in", { repoId: repo.id, issue: number, commentId: comment.id, ticketId: taken.id, predecessorId: taken.predecessorId });
  return { takenIn: taken };
}

/** Why an outcome does nothing; called only where the issue's state rules out acting on it. */
function doesNothing(outcome: PullInOutcome): DoesNothing {
  if (outcome.outcome === "pull-in" || outcome.outcome === "closed") throw new Error(`an /entail that would ${outcome.outcome} was judged to do nothing`);
  return outcome.outcome;
}

function notCounted(
  log: OperationalLog,
  repo: RepoRecord,
  comment: IssueComment,
  why: "no-issue" | "left-alone-at-fresh-start" | DoesNothing,
): PullInResult {
  log.info("pull-in-not-counted", { repoId: repo.id, issue: comment.issueNumber, commentId: comment.id, why });
  return { notCounted: why };
}

/**
 * Replies once to an `/entail` on a closed issue. The reply carries the
 * hidden marker of the issue's last ticket when it has one, and otherwise
 * names the `/entail` comment it answers, as there is no ticket to name.
 */
async function reply(context: PullInContext, issueNumber: number, commentId: number, latest: TicketRecord | null): Promise<void> {
  const ownerName = readGlobalSettings(context.store).settings.ownerDisplayName;
  if (ownerName === null) throw new Error("the owner's display name is not set, so entail cannot attribute a comment");
  const body = composeComment(ownerName, latest?.id ?? { reply: commentId }, CLOSED_ISSUE_REPLY);
  const purpose = closedIssueReplyPurpose(commentId);
  const write = latest === null ? { ticketId: null, reply: commentId, purpose } : { ticketId: latest.id, purpose };
  await context.writer().comment(write, "issue", issueNumber, body);
}

/** Resumes a reply recorded for this comment but never confirmed, with the text it was recorded with. */
async function resumeReply(context: PullInContext, issueNumber: number, commentId: number): Promise<void> {
  const writes = replyWrites(context.store, context.repo, issueNumber, commentId);
  if (writes.length === 0 || writes.some((write) => write.confirmed)) return;
  const pending = writes.at(-1)!;
  const purpose = closedIssueReplyPurpose(commentId);
  const write = pending.ticketId === null ? { ticketId: null, reply: commentId, purpose } : { ticketId: pending.ticketId, purpose };
  await context.writer().comment(write, "issue", issueNumber, (pending.payload as CommentPayload).body);
}
