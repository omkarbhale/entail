import { sameActor, type Actor, type Forge, type ForgeComment, type Issue, type IssueComment } from "./forge/forge.ts";
import type { EnrollmentRecord, RepoRecord, Store, TicketRecord } from "./store.ts";

/**
 * Why an issue the forge reported does not enter intake on its own. Only a new
 * issue opened by the owner's account after enrollment does (spec §5,
 * ADR-0018, ADR-0020); any other issue enters only by being pulled in.
 */
export type NotTakenIn =
  /** Someone other than the owner's account opened it, compared by numeric id. */
  | "not-the-owners"
  /** It was open when the repo was enrolled. */
  | "open-at-enrollment"
  /** It was opened before the repo was enrolled. */
  | "opened-before-enrollment"
  /** It is closed, so there is nothing to take in. */
  | "closed"
  /** entail already took it in: a new issue enters once, and a finished ticket comes back only by being pulled in. */
  | "has-a-ticket"
  /** It came from another repo, so it is not a new issue here. */
  | "transferred-in"
  /**
   * It carried entail's hidden marker with no records behind it when the
   * owner confirmed a fresh start, so entail leaves it alone (ADR-0009).
   */
  | "left-alone-at-fresh-start";

/** The owner of an enrolled repo: the account its CLI was logged in as at enrollment (ADR-0018). */
export function repoOwner(repo: RepoRecord): Actor {
  return { forge: repo.forge, host: repo.host, id: repo.ownerAccountId, username: repo.ownerLogin };
}

/**
 * Whether an issue enters intake on its own, judged from the issue and the
 * records alone: null when it may, or why it does not. An issue that may enter
 * still enters only if it was not transferred in, which only the forge can say
 * (see {@link takeInIfNew}).
 *
 * The owner is compared by numeric id, never by username, so a renamed owner
 * still counts and nobody else's issue ever does, whatever its text says.
 */
export function whyNotTakenIn(
  issue: Issue,
  repo: RepoRecord,
  enrollment: Pick<EnrollmentRecord, "enrolledAt" | "openIssueNumbers"> | null,
  hasTicket: boolean,
  leftAloneAtFreshStart = false,
): NotTakenIn | null {
  if (hasTicket) return "has-a-ticket";
  if (leftAloneAtFreshStart) return "left-alone-at-fresh-start";
  if (!sameActor(issue.author, repoOwner(repo))) return "not-the-owners";
  if (issue.state !== "open") return "closed";
  if (enrollment?.openIssueNumbers.includes(issue.number)) return "open-at-enrollment";
  const enrolledAt = Date.parse(enrollment?.enrolledAt ?? repo.enrolledAt);
  if (!(Date.parse(issue.createdAt) >= enrolledAt)) return "opened-before-enrollment";
  return null;
}

/** One piece of an issue's text at intake, tagged with whoever wrote it. */
export type RequestPart =
  | { part: "title"; author: Actor; text: string }
  | { part: "body"; author: Actor; text: string }
  | { part: "comment"; commentId: number; author: Actor; createdAt: string; text: string };

/**
 * What the intake call records: the issue, and its text as a request to be
 * judged. Title, body and comments are untrusted request text, each tagged
 * with its author, and never the owner's word, whoever filed it (ADR-0001).
 */
export interface IntakeDetail {
  issue: { id: number; number: number; url: string; createdAt: string };
  request: RequestPart[];
  /** The owner's `/entail` comment, when the issue was pulled in rather than entering on its own (ADR-0020). */
  pulledInBy?: { commentId: number; url: string; createdAt: string };
  /**
   * The issue's ticket before this one, when it was pulled in again after that
   * one ended, and the last intake comment that ticket posted, which this
   * ticket's first intake comment names (ADR-0020).
   */
  predecessor?: { ticketId: number; state: string; lastIntakeComment: string | null };
}

/** How an issue was pulled in: the owner's `/entail` comment, and the issue's final ticket before, if any. */
export interface PullIn {
  comment: IssueComment;
  predecessor: { ticket: TicketRecord; lastIntakeComment: string | null } | null;
}

export function requestText(issue: Issue, comments: readonly ForgeComment[]): RequestPart[] {
  return [
    { part: "title", author: issue.author, text: issue.title },
    { part: "body", author: issue.author, text: issue.body },
    ...comments.map((comment): RequestPart => ({
      part: "comment",
      commentId: comment.id,
      author: comment.author,
      createdAt: comment.createdAt,
      text: comment.body,
    })),
  ];
}

/**
 * Takes an issue in as a new ticket, deciding, and records the call that took
 * it in with the issue's text exactly as read, in one transaction: a crash
 * leaves either both or neither, and the store refuses a second ticket in
 * flight for the issue. A ticket pulled in again links to its predecessor,
 * which the store requires to be the issue's latest ticket.
 */
export function recordIntake(
  store: Store,
  repo: RepoRecord,
  issue: Issue,
  comments: readonly ForgeComment[],
  settingsVersionId: number | null,
  pullIn: PullIn | null = null,
): TicketRecord {
  return store.transaction(() => {
    const predecessor = pullIn?.predecessor ?? null;
    const ticket = store.takeIn({ repoId: repo.id, issueNumber: issue.number, predecessorId: predecessor?.ticket.id ?? null });
    const detail: IntakeDetail = {
      issue: { id: issue.id, number: issue.number, url: issue.url, createdAt: issue.createdAt },
      request: requestText(issue, comments),
    };
    if (pullIn) detail.pulledInBy = { commentId: pullIn.comment.id, url: pullIn.comment.url, createdAt: pullIn.comment.createdAt };
    if (predecessor) {
      detail.predecessor = { ticketId: predecessor.ticket.id, state: predecessor.ticket.state, lastIntakeComment: predecessor.lastIntakeComment };
    }
    store.recordCall({
      ticketId: ticket.id,
      kind: "intake",
      reason:
        pullIn === null
          ? "The owner's account opened this issue after the repo was enrolled."
          : predecessor === null
            ? "The owner pulled this issue in with /entail."
            : `The owner pulled this issue in again with /entail, after ticket ${predecessor.ticket.id} ended ${predecessor.ticket.state}.`,
      inputs: { issueTitle: issue.title, issueBody: issue.body, settingsVersionId },
      detail,
    });
    return store.getTicket(ticket.id)!;
  });
}

/** What became of an issue the forge reported as changed. */
export type IntakeOutcome = { takenIn: TicketRecord } | { notTakenIn: NotTakenIn };

/**
 * Takes an issue in when it is a new issue the owner opened after enrollment
 * (spec §5): judged from the records, then asked of the forge whether it was
 * transferred in, and only then read for its comments and recorded. Nothing is
 * posted on an issue that is not taken in.
 */
export async function takeInIfNew(
  store: Store,
  forge: Forge,
  repo: RepoRecord,
  issue: Issue,
  settingsVersionId: number | null,
): Promise<IntakeOutcome> {
  const hasTicket = () => store.latestTicketForIssue(repo.id, issue.number) !== null;
  const why = whyNotTakenIn(
    issue,
    repo,
    store.latestEnrollment(repo.id),
    hasTicket(),
    store.leftAloneAtFreshStart(repo.id, issue.number),
  );
  if (why !== null) return { notTakenIn: why };
  if (await forge.transferredIn(issue.number)) return { notTakenIn: "transferred-in" };
  const comments = await forge.comments("issue", issue.number);
  // Another take-in may have recorded it while the forge was being read.
  if (hasTicket()) return { notTakenIn: "has-a-ticket" };
  return { takenIn: recordIntake(store, repo, issue, comments, settingsVersionId) };
}
