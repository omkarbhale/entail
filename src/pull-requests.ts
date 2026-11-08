import { composeComment } from "./comment-rules.ts";
import type { Change, PullRequest } from "./forge/forge.ts";
import type { CommentPayload } from "./forge-writer.ts";
import { readGlobalSettings } from "./global-settings.ts";
import { CLEARED_LABEL } from "./intake-comment.ts";
import { openLandingItem, withdrawOnNewPush } from "./landing-pin.ts";
import type { OperationalLog } from "./operational-log.ts";
import type { ChangeHandler, OwedStep, OwedStepPlanner, RepoPass } from "./pass.ts";
import { repoSettingsOf } from "./repo-settings.ts";
import type { CallRecord, Store, TicketRecord } from "./store.ts";
import type { TicketState } from "./ticket-states.ts";
import { countsAsExecutor } from "./who-counts.ts";

/**
 * How entail follows the PRs for its tickets, before any grading (spec §10,
 * §11, ADR-0013, ADR-0014, ADR-0018).
 *
 * - A PR is a ticket's PR only when the forge's own linked-issue data says it
 *   closes the ticket's issue and its base is the default branch; PR text is
 *   never parsed for links.
 * - A cleared ticket moves to landing once a linking PR from an account that
 *   counts is open, and a landing ticket goes back to cleared once none is.
 * - A new push to the PR of an open landing pin item withdraws the item, and
 *   the ticket goes back to landing to be checked again (`landing-pin.ts`).
 * - A linking PR merged by anyone other than entail, the owner included and
 *   whether or not it would have passed, records the ticket as merged; entail
 *   then closes the issue and removes its label, which changes nothing where
 *   the forge already did.
 * - A PR linking an issue with no criteria in force (its ticket deciding,
 *   investigating or on the board, or its latest ticket declined or
 *   cancelled) is not checked and gets one comment saying so. One linking an
 *   issue whose latest ticket is merged gets one "already merged" comment. Under "owner
 *   plus listed executors", a PR from any other account is not checked and
 *   gets one comment that the repo lands work only from its executors
 *   instead. Each is posted once per PR and ticket, whatever restarts.
 * - entail never reads labels anyone else sets, assignment or any pickup
 *   signal: everything here is worked out from its records and the forge's
 *   PRs alone.
 */

/** What a one-time comment on a PR is for, recorded with its intent so it is posted once per PR and ticket. */
export const ONE_TIME_COMMENTS = {
  /** The PR links an issue with no criteria in force. */
  noCriteria: "pr-no-criteria",
  /** The PR's author does not count as an executor in the repo. */
  notCounted: "pr-not-counted",
  /** The PR links a ticket that is already merged, through another PR. */
  alreadyMerged: "pr-already-merged",
  /** A re-check after a vision change raised the PR's ticket to the owner (ADR-0016). */
  raisedAfterRecheck: "pr-raised-after-recheck",
  /** The owner answered "don't go ahead" on a ticket a re-check raised, so it was cancelled (ADR-0016). */
  cancelledAfterRecheck: "pr-cancelled-after-recheck",
} as const;

export type OneTimeComment = (typeof ONE_TIME_COMMENTS)[keyof typeof ONE_TIME_COMMENTS];

/** The label an investigated issue carries (ADR-0013). */
const INVESTIGATE_LABEL = "entail:investigate";

/** The `entail:` label an issue carries while its ticket is in each state, if any (ADR-0013). */
export const LABEL_IN_STATE: Partial<Record<TicketState, string>> = {
  cleared: CLEARED_LABEL,
  landing: CLEARED_LABEL,
  investigating: INVESTIGATE_LABEL,
};

/** The states in which a ticket has no criteria in force yet. */
const NO_CRITERIA_YET: ReadonlySet<TicketState> = new Set<TicketState>(["deciding", "investigating", "on-the-board"]);

/** The final states whose issue has no criteria in force: a merged ticket's PRs get the "already merged" comment instead. */
const ENDED: ReadonlySet<TicketState> = new Set<TicketState>(["declined", "cancelled"]);

/** What a call that moves a ticket because of its PRs records as its detail. */
export interface PullRequestDetail {
  /** The PRs the call is about, by number. */
  pullRequests: number[];
}

/** What a merged-by-others call records as its detail. */
export interface MergedByOthersDetail extends PullRequestDetail {
  url: string;
  /** The PR's head when entail saw it merged. */
  headSha: string;
}

export interface PullRequestOptions {
  store: Store;
  log: OperationalLog;
}

/** The planner and the change handler that follow a repo's PRs, sharing what they know of PR changes. */
export interface PullRequestFollowing {
  /** Each in-flight ticket's step that follows its PRs, owed when its PRs, its state or the repo's settings may have changed. */
  planner: OwedStepPlanner;
  /** Notes each PR change, and comments once on a PR linking an issue whose latest ticket ended. */
  onChange: ChangeHandler;
}

/**
 * Follows the PRs of every enrolled repo's tickets. A ticket's PRs are read
 * again when a PR in its repo changed, its state changed or the repo's
 * settings were saved since they were last read, and once after each start.
 * What it does is worked out from the records and the forge alone, so reading
 * them again repeats nothing.
 */
export function pullRequestFollowing(options: PullRequestOptions): PullRequestFollowing {
  /** Per repo, how many passes have seen a PR change. */
  const generation = new Map<number, number>();
  /** Per ticket, what it was last followed at. */
  const followed = new Map<number, string>();

  const planner: OwedStepPlanner = (ticket, pass): OwedStep | null => {
    const key = `${ticket.state}:${ticket.stateCallId ?? 0}:${pass.settings.id}:${generation.get(pass.repo.id) ?? 0}`;
    if (followed.get(ticket.id) === key) return null;
    return {
      name: "pull-requests",
      run: async () => {
        await followTicket(options, ticket, pass);
        followed.set(ticket.id, key);
      },
    };
  };

  const onChange: ChangeHandler = async (change, pass) => {
    if (change.kind !== "pull-request") return;
    generation.set(pass.repo.id, (generation.get(pass.repo.id) ?? 0) + 1);
    await commentOnEndedTickets(options, change, pass);
  };

  return { planner, onChange };
}

/** Whether the ticket is where it was when the step began. */
function unmoved(store: Store, ticket: TicketRecord): boolean {
  const now = store.getTicket(ticket.id);
  return now !== null && now.state === ticket.state && now.stateCallId === ticket.stateCallId;
}

/** Follows one in-flight ticket's PRs: merged, moved to landing or back, or commented on once. */
async function followTicket(options: PullRequestOptions, ticket: TicketRecord, pass: RepoPass): Promise<void> {
  const { store } = options;
  const pullRequests = await pass.forge.linkedPullRequests(ticket.issueNumber);
  if (!unmoved(store, ticket)) return;

  const merged = pullRequests.find((pr) => pr.state === "merged" && mergedForTicket(store, ticket, pr));
  if (merged) {
    await recordMergedByOthers(options, ticket, merged, pass);
    return;
  }

  // A new push to the PR an open landing pin item is about withdraws it, and the landing check runs again (spec §11).
  const landingItem = openLandingItem(store, ticket);
  const pushed = landingItem === null ? undefined : pullRequests.find((pr) => pr.number === landingItem.landing.pullRequest);
  if (landingItem !== null && pushed !== undefined && pushed.state === "open" && pushed.headSha !== landingItem.landing.headSha) {
    await withdrawOnNewPush(options, ticket, landingItem, pushed, pass);
    return;
  }

  const settings = repoSettingsOf(pass.settings);
  const open = pullRequests.filter((pr) => pr.state === "open");
  const counted = open.filter((pr) => countsAsExecutor(pass.repo, settings, pr.author));
  const excluded = open.filter((pr) => !counted.includes(pr));

  if (ticket.state === "cleared" && counted.length > 0) {
    moveForPullRequests(options, ticket, pass, "landing", counted);
  } else if (ticket.state === "landing" && counted.length === 0) {
    const closed = pullRequests.filter((pr) => pr.state === "closed");
    moveForPullRequests(options, ticket, pass, "cleared", closed.length > 0 ? closed : excluded);
  }

  for (const pr of excluded) {
    await commentOnce(options, pass, ticket, pr, ONE_TIME_COMMENTS.notCounted, notCountedText(pass, ticket.issueNumber));
  }
  // A PR whose pinned paths are on the board already said so in its landing comment (spec §11).
  if (NO_CRITERIA_YET.has(ticket.state) && landingItem === null) {
    for (const pr of counted) {
      // A PR told its issue was raised to the owner after a vision change already knows why it is not checked.
      if (ticket.state === "on-the-board" && commented(store, pass, ticket, pr, ONE_TIME_COMMENTS.raisedAfterRecheck)) continue;
      await commentOnce(options, pass, ticket, pr, ONE_TIME_COMMENTS.noCriteria, noCriteriaYetText(pass, ticket));
    }
  }
}

/**
 * Whether a merged PR is this ticket's own: not one entail is merging for it
 * right now, which records its own call, and not one that merged for an
 * earlier ticket of the issue, or before this ticket was taken in.
 */
function mergedForTicket(store: Store, ticket: TicketRecord, pr: PullRequest): boolean {
  if (Date.parse(pr.updatedAt) < Date.parse(ticket.takenInAt)) return false;
  const earlier = new Set<number>();
  for (let id = ticket.predecessorId; id !== null; id = store.getTicket(id)?.predecessorId ?? null) earlier.add(id);
  const merges = store.forgeWritesOn(ticket.repoId, "pr", pr.number).filter((write) => write.kind === "merge");
  if (merges.some((write) => write.ticketId === ticket.id && !write.confirmed)) return false;
  if (merges.some((write) => write.ticketId !== null && earlier.has(write.ticketId))) return false;
  for (const id of earlier) {
    if (store.callsForTicket(id).some((call) => call.stateChange?.to === "merged" && recordsPullRequest(call, pr.number))) return false;
  }
  return true;
}

/**
 * Whether one of the issue's PRs merged for this ticket, by anyone, entail
 * included: the merge then ends the ticket as merged, so the issue closing
 * with it is no outside close (spec §17).
 */
export function mergeEndsTicket(store: Store, ticket: TicketRecord, pullRequests: readonly PullRequest[]): boolean {
  return pullRequests.some((pr) => {
    if (pr.state !== "merged") return false;
    const entailMerging = store
      .forgeWritesOn(ticket.repoId, "pr", pr.number)
      .some((write) => write.kind === "merge" && write.ticketId === ticket.id);
    return entailMerging || mergedForTicket(store, ticket, pr);
  });
}

function recordsPullRequest(call: CallRecord, number: number): boolean {
  const detail = call.detail as Partial<PullRequestDetail> | null;
  return Array.isArray(detail?.pullRequests) && detail.pullRequests.includes(number);
}

/** Moves a cleared ticket to landing, or a landing ticket back to cleared, with the call that says why. */
function moveForPullRequests(options: PullRequestOptions, ticket: TicketRecord, pass: RepoPass, to: "landing" | "cleared", prs: readonly PullRequest[]): void {
  const { store, log } = options;
  const numbers = prs.map((pr) => pr.number);
  const named = numbers.map((n) => `#${n}`).join(", ");
  const reason =
    to === "landing"
      ? `Landing: PR ${named}, which links the issue, is open.`
      : prs.some((pr) => pr.state === "closed")
        ? `Back to cleared: PR ${named} was closed without merging, and no other PR for the issue is open.`
        : `Back to cleared: no PR for the issue from an account that counts is open${named === "" ? "" : `; PR ${named} is from an account that does not count`}.`;
  const recorded = store.transaction(() => {
    if (!unmoved(store, ticket)) return null;
    const detail: PullRequestDetail = { pullRequests: numbers };
    return store.recordCall({
      ticketId: ticket.id,
      kind: to === "landing" ? "pr-opened" : "pr-closed",
      reason,
      inputs: { settingsVersionId: pass.settings.id },
      detail,
      stateTo: to,
    });
  });
  if (recorded) log.info(to === "landing" ? "ticket-landing" : "ticket-back-to-cleared", { ticketId: ticket.id, callId: recorded.id, pullRequests: numbers });
}

/**
 * Records the ticket as merged by someone other than entail (spec §11,
 * ADR-0014). In one transaction it records the merged call with the intents
 * to close the issue and to remove the ticket's label; then it sends both,
 * which change nothing where the forge already closed the issue on merge.
 */
async function recordMergedByOthers(options: PullRequestOptions, ticket: TicketRecord, pr: PullRequest, pass: RepoPass): Promise<void> {
  const { store, log } = options;
  const label = LABEL_IN_STATE[ticket.state] ?? null;
  const recorded = store.transaction(() => {
    if (!unmoved(store, ticket)) return null;
    const detail: MergedByOthersDetail = { pullRequests: [pr.number], url: pr.url, headSha: pr.headSha };
    const call = store.recordCall({
      ticketId: ticket.id,
      kind: "merged-by-others",
      reason: `Merged: PR #${pr.number}, which links the issue, was merged on the forge by someone other than entail.`,
      inputs: { prHeadSha: pr.headSha, settingsVersionId: pass.settings.id },
      detail,
      stateTo: "merged",
    });
    const write = { repoId: pass.repo.id, ticketId: ticket.id, callId: call.id, target: "issue" as const, number: ticket.issueNumber };
    store.recordForgeWriteIntent({ ...write, kind: "close", payload: { reason: "completed" } });
    if (label !== null) store.recordForgeWriteIntent({ ...write, kind: "label", payload: { action: "remove", label } });
    return call;
  });
  if (recorded === null) return;
  log.info("ticket-merged-by-others", { ticketId: ticket.id, callId: recorded.id, pullRequest: pr.number });

  // Each resumes the intent recorded above.
  const writer = pass.writer();
  const write = { ticketId: ticket.id, callId: recorded.id };
  await writer.closeIssue(write, ticket.issueNumber, "completed");
  if (label !== null) await writer.removeLabel(write, ticket.issueNumber, label);
}

/**
 * Comments on a PR that links an issue whose latest ticket ended, once per PR
 * and ticket: declined or cancelled, that the issue has no criteria in force;
 * merged, that the ticket is already merged (ADR-0014). A PR whose author does
 * not count gets only the comment that the repo lands work only from its
 * executors.
 */
// Tightening who counts is not re-applied to PRs linking an ended (declined or cancelled) ticket: such a PR can never land and already got the one-time no-criteria comment naming the end state; the newly-excluded comment applies to PRs on tickets that could still land, which followTicket covers.
async function commentOnEndedTickets(options: PullRequestOptions, change: Extract<Change, { kind: "pull-request" }>, pass: RepoPass): Promise<void> {
  const { store } = options;
  const pr = change.pullRequest;
  if (pr.state !== "open") return;
  const ended: TicketRecord[] = [];
  for (const issueNumber of await pass.forge.linkedIssues(pr.number)) {
    const ticket = store.latestTicketForIssue(pass.repo.id, issueNumber);
    if (ticket && (ENDED.has(ticket.state) || ticket.state === "merged")) ended.push(ticket);
  }
  if (ended.length === 0) return;
  const counts = countsAsExecutor(pass.repo, repoSettingsOf(pass.settings), pr.author);
  for (const ticket of ended) {
    if (!counts) await commentOnce(options, pass, ticket, pr, ONE_TIME_COMMENTS.notCounted, notCountedText(pass, ticket.issueNumber));
    else if (ticket.state === "merged") await commentOnce(options, pass, ticket, pr, ONE_TIME_COMMENTS.alreadyMerged, alreadyMergedText(store, pass, ticket));
    else if (!commented(store, pass, ticket, pr, ONE_TIME_COMMENTS.cancelledAfterRecheck)) {
      // A PR told its ticket was cancelled after a re-check already has the comment that answers why it is not checked.
      await commentOnce(options, pass, ticket, pr, ONE_TIME_COMMENTS.noCriteria, endedText(store, pass, ticket));
    }
  }
}

/** Whether a one-time comment for this purpose was recorded on the PR for the ticket, posted or not yet. */
function commented(store: Store, pass: RepoPass, ticket: TicketRecord, pr: Pick<PullRequest, "number">, purpose: OneTimeComment): boolean {
  return store
    .forgeWritesOn(pass.repo.id, "pr", pr.number)
    .some((write) => write.kind === "comment" && write.ticketId === ticket.id && (write.payload as Partial<CommentPayload>).purpose === purpose);
}

/**
 * Posts a one-time comment on a PR for a ticket, unless one was already
 * posted for the same PR, ticket and purpose. One recorded but not yet
 * confirmed is resumed with the text it was recorded with, so it is found by
 * its hidden marker rather than posted twice.
 */
export async function commentOnce(
  options: PullRequestOptions,
  pass: RepoPass,
  ticket: TicketRecord,
  pr: Pick<PullRequest, "number">,
  purpose: OneTimeComment,
  text: string,
): Promise<void> {
  const { store, log } = options;
  const writes = store
    .forgeWritesOn(pass.repo.id, "pr", pr.number)
    .filter((write) => write.kind === "comment" && write.ticketId === ticket.id && (write.payload as Partial<CommentPayload>).purpose === purpose);
  if (writes.some((write) => write.confirmed)) return;
  const pending = writes.at(-1);
  let body: string;
  if (pending) {
    body = (pending.payload as CommentPayload).body;
  } else {
    const ownerName = readGlobalSettings(store).settings.ownerDisplayName;
    if (ownerName === null) throw new Error("the owner's display name is not set, so entail cannot attribute a comment");
    body = composeComment(ownerName, ticket.id, text);
  }
  await pass.writer().comment({ ticketId: ticket.id, purpose }, "pr", pr.number, body);
  log.info("pr-commented", { ticketId: ticket.id, pullRequest: pr.number, purpose });
}

/** Where a ticket with no criteria yet stands, as the one-time comment says it. */
const WHY_NO_CRITERIA: Readonly<Record<string, string>> = {
  deciding: "entail is still deciding it",
  investigating: "it is under investigation, and its questions are answered in an `entail findings` comment on the issue first",
  "on-the-board": "it is waiting for the owner's decision",
};

/** The one-time comment on a PR linking an issue whose ticket has no criteria yet (ADR-0013, ADR-0006). */
export function noCriteriaYetText(pass: Pick<RepoPass, "forge">, ticket: Pick<TicketRecord, "issueNumber" | "state">): string {
  const pr = pass.forge.wording.pullRequest;
  return [
    `This ${pr} links #${ticket.issueNumber}, which has no criteria in force yet: ${WHY_NO_CRITERIA[ticket.state] ?? "it is not cleared"}.`,
    `entail does not check or merge this ${pr} while the issue has no criteria. If the issue is cleared, this ${pr} is checked against the criteria entail posts on it.`,
  ].join("\n\n");
}

/**
 * The one-time comment on a PR linking an issue whose latest ticket ended,
 * declined or cancelled (ADR-0013's amendment, ADR-0020): it names the end
 * state, links the comment that gave its reason where entail posted one, and
 * says the issue has no criteria in force unless the owner pulls it in again
 * and it is cleared.
 */
export function endedText(store: Store, pass: Pick<RepoPass, "forge">, ticket: TicketRecord): string {
  const pr = pass.forge.wording.pullRequest;
  const ending = ticket.stateCallId === null ? null : store.getCall(ticket.stateCallId);
  const reasonUrl = ending?.postedComments.at(-1)?.commentUrl ?? null;
  const why = reasonUrl === null ? "" : ` (see [the comment that gave the reason](${reasonUrl}))`;
  return [
    `This ${pr} links #${ticket.issueNumber}, whose ticket was ${ticket.state}${why}.`,
    `The issue has no criteria in force, so entail does not check or merge this ${pr}, unless the owner pulls the issue in again and it is cleared. If that happens, this ${pr} is checked against the new criteria.`,
  ].join("\n\n");
}

/**
 * The one-time "already merged" comment on a PR linking a merged ticket
 * (ADR-0014): it names the PR that merged where the records name one, and
 * says entail no longer checks this PR and does not close it.
 */
export function alreadyMergedText(store: Store, pass: Pick<RepoPass, "forge">, ticket: TicketRecord): string {
  const pr = pass.forge.wording.pullRequest;
  const ending = ticket.stateCallId === null ? null : store.getCall(ticket.stateCallId);
  const detail = ending?.detail as Partial<MergedByOthersDetail> | null | undefined;
  const merged = detail?.pullRequests?.[0];
  const through = merged === undefined ? "" : typeof detail?.url === "string" ? ` through [#${merged}](${detail.url})` : ` through #${merged}`;
  return [
    `#${ticket.issueNumber} is already merged${through}.`,
    `entail no longer checks this ${pr}, and does not close it.`,
  ].join("\n\n");
}

/**
 * The one comment on an open PR whose ticket a re-check raised to the owner,
 * after the owner answered "don't go ahead" (ADR-0016): the ticket is
 * cancelled, and entail neither checks nor closes the PR.
 */
export function cancelledAfterRecheckText(pass: Pick<RepoPass, "forge">, issueNumber: number): string {
  const pr = pass.forge.wording.pullRequest;
  return [
    `The owner decided not to go ahead with #${issueNumber} after a vision change, so its ticket is cancelled.`,
    `entail does not check or merge this ${pr}, and does not close it.`,
  ].join("\n\n");
}

/** The one-time comment on a PR whose author does not count as an executor in the repo (ADR-0013). */
export function notCountedText(pass: Pick<RepoPass, "forge">, issueNumber: number): string {
  const pr = pass.forge.wording.pullRequest;
  return `This ${pr} links #${issueNumber}, but this repo lands work only from its executors, and the account that opened this ${pr} is not one of them. entail does not check or merge it.`;
}
