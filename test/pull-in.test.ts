import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { latestIntakeComment } from "../src/board-item.ts";
import { assertCommentRules, markedReplies, markedTickets } from "../src/comment-rules.ts";
import type { ChangeBatch, ForgeComment, ForgeTarget, Issue, IssueComment } from "../src/forge/forge.ts";
import type { IntakeDetail } from "../src/intake.ts";
import { Passes } from "../src/pass.ts";
import { CLOSED_ISSUE_REPLY, isPullInCommand, pullInOutcome, whyNotCounted } from "../src/pull-in.ts";
import type { RepoRecord, TicketRecord } from "../src/store.ts";
import { StateForge } from "./forge/state-forge.ts";
import { actor, ENROLLED_AT, IntakeForge, issue, OWNER_ID, passSetup, STILL_HEAD, type PassSetup } from "./pass-fixture.ts";

const REPO: RepoRecord = {
  id: 1,
  forge: "github",
  host: "github.com",
  projectId: 5001,
  path: "acme/tally",
  ownerAccountId: OWNER_ID,
  ownerLogin: "owner",
  enrolledAt: ENROLLED_AT,
};
const ENROLLMENT = { enrolledAt: ENROLLED_AT };
const POSTED = "2026-11-08T13:00:00.000Z";

function issueComment(id: number, issueNumber: number, body: string, fields: Partial<IssueComment> = {}): IssueComment {
  return {
    id,
    issueNumber,
    body,
    author: actor(OWNER_ID),
    createdAt: POSTED,
    updatedAt: POSTED,
    url: `https://github.com/acme/tally/issues/${issueNumber}#issuecomment-${id}`,
    ...fields,
  };
}

function ticketIn(state: TicketRecord["state"], stateChangedAt = POSTED): TicketRecord {
  return { id: 3, repoId: 1, issueNumber: 5, predecessorId: null, takenInAt: POSTED, state, stateCallId: 9, stateChangedAt };
}

test("/entail counts only as the whole first line; text after that line is ignored", () => {
  assert.equal(isPullInCommand("/entail"), true);
  assert.equal(isPullInCommand("/entail\nPlease take this one; it matters."), true);
  assert.equal(isPullInCommand("/entail  \r\nwith CRLF line endings"), true);
  assert.equal(isPullInCommand("/entail please"), false, "more on the first line");
  assert.equal(isPullInCommand("Please /entail"), false);
  assert.equal(isPullInCommand("Thanks!\n/entail"), false, "not the first line");
  assert.equal(isPullInCommand("\n/entail"), false, "the first line is blank");
  assert.equal(isPullInCommand("/entailed"), false);
  assert.equal(isPullInCommand("`/entail`"), false);
});

test("only the owner's account counts, compared by numeric id", () => {
  assert.equal(whyNotCounted(issueComment(1, 5, "/entail"), REPO, ENROLLMENT), null);
  assert.equal(whyNotCounted(issueComment(1, 5, "/entail", { author: actor(OWNER_ID, "owner-renamed") }), REPO, ENROLLMENT), null);
  assert.equal(whyNotCounted(issueComment(1, 5, "/entail", { author: actor(1002, "reporter") }), REPO, ENROLLMENT), "not-the-owners");
  assert.equal(whyNotCounted(issueComment(1, 5, "/entail", { author: actor(1003, "owner") }), REPO, ENROLLMENT), "not-the-owners");
  assert.equal(
    whyNotCounted(issueComment(1, 5, "/entail", { author: actor(OWNER_ID, "owner", "gitlab.com") }), REPO, ENROLLMENT),
    "not-the-owners",
    "the owner's id on another host is someone else",
  );
  assert.equal(whyNotCounted(issueComment(1, 5, "Looks good"), REPO, ENROLLMENT), "not-a-pull-in");
});

test("only a newly posted comment counts: an edited one, or one posted before enrollment, does not", () => {
  assert.equal(whyNotCounted(issueComment(1, 5, "/entail", { updatedAt: "2026-11-08T14:00:00.000Z" }), REPO, ENROLLMENT), "edited");
  assert.equal(
    whyNotCounted(issueComment(1, 5, "/entail", { createdAt: "2026-11-08T11:00:00.000Z", updatedAt: "2026-11-08T11:00:00.000Z" }), REPO, ENROLLMENT),
    "posted-before-enrollment",
  );
});

test("what a counted /entail does follows the issue's tickets and state", () => {
  const comment = { createdAt: POSTED };
  assert.deepEqual(pullInOutcome(comment, "open", null, false), { outcome: "pull-in", predecessor: null });
  assert.deepEqual(pullInOutcome(comment, "closed", null, false), { outcome: "closed", latest: null });
  for (const state of ["deciding", "investigating", "on-the-board", "cleared", "landing"] as const) {
    assert.equal(pullInOutcome(comment, "open", ticketIn(state), false).outcome, "in-flight", state);
    assert.equal(pullInOutcome(comment, "closed", ticketIn(state), false).outcome, "in-flight", `${state}, closed`);
  }
  for (const state of ["declined", "cancelled", "merged"] as const) {
    const before = ticketIn(state, "2026-11-08T12:30:00.000Z");
    assert.deepEqual(pullInOutcome(comment, "open", before, false), { outcome: "pull-in", predecessor: before }, state);
    assert.deepEqual(pullInOutcome(comment, "closed", before, false), { outcome: "closed", latest: before }, `${state}, closed`);
    // Posted before, or at, the final call: an old comment never re-triggers intake.
    assert.equal(pullInOutcome(comment, "open", ticketIn(state, "2026-11-08T13:30:00.000Z"), false).outcome, "before-final-call");
    assert.equal(pullInOutcome(comment, "open", ticketIn(state, POSTED), false).outcome, "before-final-call");
    assert.equal(pullInOutcome(comment, "closed", ticketIn(state, "2026-11-08T13:30:00.000Z"), false).outcome, "before-final-call");
  }
  // Each comment counts once, by its forge id.
  assert.deepEqual(pullInOutcome(comment, "open", null, true), { outcome: "counted" });
  assert.deepEqual(pullInOutcome(comment, "closed", null, true), { outcome: "counted" });
});

/**
 * A forge reporting its issues and the comments people post on them as
 * changes, with issues read live and entail's own comments read back.
 */
class CommentForge extends IntakeForge {
  people: IssueComment[] = [];
  readonly live = { issue: 0 };

  override async changesSince(): Promise<ChangeBatch> {
    const batch = await super.changesSince();
    const comments = this.people.map((c) => ({ kind: "issue-comment" as const, id: c.id, updatedAt: c.updatedAt, comment: c }));
    return { changes: [...batch.changes, ...comments], cursor: batch.cursor };
  }

  override async issue(issueNumber: number): Promise<Issue | null> {
    this.live.issue++;
    return this.issues.find((i) => i.number === issueNumber) ?? null;
  }

  override async comments(target: ForgeTarget, number: number): Promise<ForgeComment[]> {
    const theirs = this.people.filter((c) => target === "issue" && c.issueNumber === number).map(({ id, body, author, createdAt, url }) => ({ id, body, author, createdAt, url }));
    return [...theirs, ...(await StateForge.prototype.comments.call(this, target, number))];
  }

  /** Comments entail posted on an issue. */
  posted(issueNumber: number): { id: number; body: string }[] {
    return this.state.comments[`issue:${issueNumber}`] ?? [];
  }

  post(comment: IssueComment): void {
    this.people.push(comment);
  }
}

interface Harness {
  setup: PassSetup;
  repo: RepoRecord;
  forge: CommentForge;
  /** One pass of the current process. */
  pass(): Promise<number[]>;
  /** Starts entail afresh on the same store and forge, as after a restart. */
  restart(): void;
  tickets(issueNumber: number): TicketRecord[];
}

function harness(t: TestContext): Harness {
  const setup = passSetup(t);
  const repo = setup.enroll({ openIssueNumbers: [2] });
  const forge = new CommentForge();
  const start = () =>
    new Passes({ store: setup.store, log: setup.log, dataDirectory: setup.dataDirectory, forgeFor: () => forge, defaultBranchFor: async () => STILL_HEAD });
  let passes = start();
  return {
    setup,
    repo,
    forge,
    async pass() {
      const [outcome] = await passes.runPass();
      assert.equal(outcome?.outcome, "polled", JSON.stringify(outcome));
      return outcome?.outcome === "polled" ? outcome.takenIn : [];
    },
    restart() {
      passes = start();
    },
    tickets(issueNumber) {
      const found: TicketRecord[] = [];
      for (let t = setup.store.latestTicketForIssue(repo.id, issueNumber); t !== null; t = t.predecessorId === null ? null : setup.store.getTicket(t.predecessorId)) found.unshift(t);
      return found;
    },
  };
}

/** A time just after `iso`, as a comment posted then. */
function after(iso: string, ms = 1000): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

/** Ends a ticket declined, as the decider would, with its decline comment posted. */
function decline(h: Harness, ticket: TicketRecord): { ticket: TicketRecord; commentUrl: string } {
  const { store } = h.setup;
  const call = store.recordCall({ ticketId: ticket.id, kind: "decline", reason: "Too large for one PR.", stateTo: "declined" });
  const intent = store.recordForgeWriteIntent({
    repoId: h.repo.id,
    ticketId: ticket.id,
    callId: call.id,
    kind: "comment",
    target: "issue",
    number: ticket.issueNumber,
    payload: { body: "declined" },
  });
  const commentUrl = `https://github.com/acme/tally/issues/${ticket.issueNumber}#issuecomment-555`;
  store.confirmForgeWrite({ intentId: intent.id, comment: { id: "555", url: commentUrl } });
  return { ticket: store.getTicket(ticket.id)!, commentUrl };
}

test("the owner's /entail pulls in an open issue with no ticket, once, recording the comment", async (t) => {
  const h = harness(t);
  // Someone else's issue, open at enrollment: it never enters on its own.
  h.forge.issues.push(issue(2, { author: actor(1002, "reporter"), createdAt: "2026-11-08T11:00:00.000Z" }));
  assert.deepEqual(await h.pass(), []);
  h.forge.post(issueComment(7001, 2, "/entail\nThis one matters."));

  const [id] = await h.pass();
  assert.ok(id !== undefined, "taken in");
  const ticket = h.setup.store.getTicket(id)!;
  assert.equal(ticket.state, "deciding");
  assert.equal(ticket.predecessorId, null);
  const [intake] = h.setup.store.callsForTicket(id);
  assert.equal(intake?.kind, "intake");
  assert.equal(intake?.reason, "The owner pulled this issue in with /entail.");
  const detail = intake?.detail as IntakeDetail;
  assert.deepEqual(detail.pulledInBy, { commentId: 7001, url: "https://github.com/acme/tally/issues/2#issuecomment-7001", createdAt: POSTED });
  assert.equal(detail.predecessor, undefined);
  assert.equal(intake?.inputs?.issueTitle, "Issue 2", "decided at the issue's text as read now");
  assert.deepEqual(h.forge.posted(2), [], "nothing is posted on pulling in");

  // Read again by this process and after a restart: the comment counts once.
  assert.deepEqual(await h.pass(), []);
  h.restart();
  assert.deepEqual(await h.pass(), []);
  assert.equal(h.tickets(2).length, 1);
});

test("someone else's /entail starts nothing and gets no reply, on an open or a closed issue", async (t) => {
  const h = harness(t);
  h.forge.issues.push(issue(2, { author: actor(1002, "reporter"), createdAt: "2026-11-08T11:00:00.000Z" }));
  h.forge.issues.push(issue(3, { author: actor(1002, "reporter"), state: "closed" }));
  h.forge.post(issueComment(7001, 2, "/entail", { author: actor(1002, "reporter") }));
  h.forge.post(issueComment(7002, 3, "/entail", { author: actor(1003, "owner") }));

  assert.deepEqual(await h.pass(), []);
  assert.deepEqual(h.tickets(2), []);
  assert.deepEqual(h.tickets(3), []);
  assert.deepEqual(h.forge.posted(2), []);
  assert.deepEqual(h.forge.posted(3), []);
  assert.equal(h.forge.live.issue, 0, "the issue is not even read");
});

test("an edited comment, or one posted before enrollment, does not pull an issue in", async (t) => {
  const h = harness(t);
  h.forge.issues.push(issue(2, { author: actor(1002, "reporter"), createdAt: "2026-11-08T11:00:00.000Z" }));
  h.forge.post(issueComment(7001, 2, "/entail", { updatedAt: after(POSTED) }));
  h.forge.post(issueComment(7002, 2, "/entail", { createdAt: "2026-11-08T11:30:00.000Z", updatedAt: "2026-11-08T11:30:00.000Z" }));
  assert.deepEqual(await h.pass(), []);
  assert.deepEqual(h.tickets(2), []);
  assert.deepEqual(h.forge.posted(2), []);
});

test("an /entail on a ticket in flight does nothing and posts nothing", async (t) => {
  const h = harness(t);
  h.forge.issues.push(issue(5));
  const [id] = await h.pass();
  h.forge.post(issueComment(7001, 5, "/entail", { createdAt: after(h.setup.store.getTicket(id!)!.takenInAt), updatedAt: after(h.setup.store.getTicket(id!)!.takenInAt) }));
  assert.deepEqual(await h.pass(), []);
  assert.equal(h.tickets(5).length, 1);
  assert.equal(h.setup.store.callsForTicket(id!).length, 1, "no call is recorded");
  assert.deepEqual(h.forge.posted(5), []);
});

test("an /entail on a closed issue gets exactly one reply, and never pulls the issue in later", async (t) => {
  const h = harness(t);
  h.forge.issues.push(issue(3, { author: actor(1002, "reporter"), state: "closed" }));
  h.forge.post(issueComment(7001, 3, "/entail"));

  assert.deepEqual(await h.pass(), []);
  const [reply] = h.forge.posted(3);
  assert.ok(reply, "replied");
  assert.equal(h.forge.posted(3).length, 1);
  assert.ok(reply.body.includes(CLOSED_ISSUE_REPLY));
  // With no ticket to name, its hidden marker names the /entail it answers.
  assertCommentRules(reply.body, "Ada", { reply: 7001 });
  assert.deepEqual(markedReplies(reply.body), [7001]);
  assert.deepEqual(markedTickets(reply.body), []);

  // Read again, after a restart, and after the issue is reopened: one reply, no ticket.
  assert.deepEqual(await h.pass(), []);
  h.restart();
  h.forge.issues = h.forge.issues.map((i) => ({ ...i, state: "open" as const, updatedAt: after(POSTED, 60_000) }));
  assert.deepEqual(await h.pass(), []);
  assert.equal(h.forge.posted(3).length, 1);
  assert.deepEqual(h.tickets(3), [], "reopening pulls nothing in, and the old /entail does not count again");

  // A new /entail on the reopened issue pulls it in.
  h.forge.post(issueComment(7002, 3, "/entail", { createdAt: after(POSTED, 120_000), updatedAt: after(POSTED, 120_000) }));
  assert.equal((await h.pass()).length, 1);
  assert.equal(h.tickets(3).length, 1);
});

test("an /entail on a closed issue whose ticket ended replies under that ticket's marker", async (t) => {
  const h = harness(t);
  h.forge.issues.push(issue(5));
  const [id] = await h.pass();
  const { ticket } = decline(h, h.setup.store.getTicket(id!)!);
  h.forge.issues = h.forge.issues.map((i) => ({ ...i, state: "closed" as const, updatedAt: after(ticket.stateChangedAt) }));
  h.forge.post(issueComment(7001, 5, "/entail", { createdAt: after(ticket.stateChangedAt), updatedAt: after(ticket.stateChangedAt) }));

  assert.deepEqual(await h.pass(), []);
  const posted = h.forge.posted(5);
  assert.equal(posted.length, 1);
  assertCommentRules(posted[0]!.body, "Ada", ticket.id);
  assert.equal(h.tickets(5).length, 1, "no new ticket");
});

test("a finished issue pulled in again is a new ticket linked to its predecessor, naming its last comment", async (t) => {
  const h = harness(t);
  h.forge.issues.push(issue(5));
  const [id] = await h.pass();
  const { ticket: first, commentUrl } = decline(h, h.setup.store.getTicket(id!)!);

  // Posted before the final call: it does not count, then or after a restart.
  h.forge.post(issueComment(7001, 5, "/entail", { createdAt: after(first.stateChangedAt, -1), updatedAt: after(first.stateChangedAt, -1) }));
  assert.deepEqual(await h.pass(), []);
  h.restart();
  assert.deepEqual(await h.pass(), []);
  assert.equal(h.tickets(5).length, 1);

  // The owner narrows the issue and pulls it in again.
  h.forge.issues = h.forge.issues.map((i) => ({ ...i, title: "A narrower issue 5", updatedAt: after(first.stateChangedAt, 5000) }));
  h.forge.post(issueComment(7002, 5, "/entail\nNarrowed it.", { createdAt: after(first.stateChangedAt), updatedAt: after(first.stateChangedAt) }));
  const [againId] = await h.pass();
  assert.ok(againId !== undefined);
  const again = h.setup.store.getTicket(againId)!;
  assert.equal(again.predecessorId, first.id);
  assert.equal(again.state, "deciding");
  assert.equal(h.setup.store.getTicket(first.id)!.state, "declined", "the predecessor stays final");

  const calls = h.setup.store.callsForTicket(again.id);
  const detail = calls[0]!.detail as IntakeDetail;
  assert.equal(calls[0]!.reason, `The owner pulled this issue in again with /entail, after ticket ${first.id} ended declined.`);
  assert.equal(calls[0]!.inputs?.issueTitle, "A narrower issue 5", "taken in fresh at the current text");
  assert.equal(detail.pulledInBy?.commentId, 7002);
  assert.deepEqual(detail.predecessor, { ticketId: first.id, state: "declined", lastIntakeComment: commentUrl });
  // Its first intake comment names the predecessor's last one.
  assert.equal(latestIntakeComment(calls), commentUrl);

  // Neither comment counts again.
  h.restart();
  assert.deepEqual(await h.pass(), []);
  assert.equal(h.tickets(5).length, 2);
  assert.deepEqual(h.forge.posted(5), []);
});

test("an /entail on an issue a fresh start left alone does nothing and posts nothing", async (t) => {
  const h = harness(t);
  h.setup.store.recordFreshStart({ repoId: h.repo.id, confirmedBy: "Ada", markedIssueNumbers: [2, 3] });
  h.forge.issues.push(issue(2, { author: actor(1002, "reporter"), createdAt: "2026-11-08T11:00:00.000Z" }));
  h.forge.issues.push(issue(3, { author: actor(1002, "reporter"), state: "closed" }));
  h.forge.post(issueComment(7001, 2, "/entail"));
  h.forge.post(issueComment(7002, 3, "/entail"));
  assert.deepEqual(await h.pass(), []);
  assert.deepEqual(h.tickets(2), []);
  assert.deepEqual(h.forge.posted(3), []);
});
