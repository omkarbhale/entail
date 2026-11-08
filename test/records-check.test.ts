import assert from "node:assert/strict";
import { test } from "node:test";
import { hiddenMarker } from "../src/comment-rules.ts";
import { ForgeLoggedOutError, type Change } from "../src/forge/forge.ts";
import { whyNotTakenIn } from "../src/intake.ts";
import { markedIssuesWithoutRecords, RecordsCheck } from "../src/records-check.ts";
import { actor, IntakeForge, issue, issueComment, OWNER_ID, passSetup } from "./pass-fixture.ts";

/** A comment entail posted on an issue for a ticket, as the owner's account. */
function marked(id: number, issueNumber: number, ticketId: number, author = actor(OWNER_ID)) {
  return issueComment(id, issueNumber, author, `Speaking from Ada's entail:\n\nTaken in.\n\n${hiddenMarker(ticketId)}`);
}

function asChanges(...comments: ReturnType<typeof marked>[]): Change[] {
  return comments.map((comment) => ({ kind: "issue-comment", id: comment.id, updatedAt: comment.updatedAt, comment }));
}

test("an issue carrying entail's marker for a ticket the store does not hold on that issue is missing its records", (t) => {
  const setup = passSetup(t);
  const repo = setup.enroll();
  const other = setup.enroll({ projectId: 5002, path: "acme/other" });
  const known = setup.store.takeIn({ repoId: repo.id, issueNumber: 4 });
  const elsewhere = setup.store.takeIn({ repoId: other.id, issueNumber: 6 });

  const missing = markedIssuesWithoutRecords(
    setup.store,
    repo,
    asChanges(
      marked(1, 4, known.id), // its records are here
      marked(2, 3, 99), // no such ticket
      marked(3, 5, known.id), // a ticket the store holds, but on another issue
      marked(4, 6, elsewhere.id), // a ticket the store holds, but in another repo
      marked(5, 7, 98, actor(1002, "someone")), // a marker someone else wrote is not entail's
      issueComment(6, 8, actor(OWNER_ID), "Just a comment from the owner."),
      marked(7, 3, 97), // the same issue twice counts once
    ),
  );
  assert.deepEqual(missing, [3, 5, 6]);

  // A marker on a PR's conversation marks no issue.
  const pr = marked(8, 9, 96);
  assert.deepEqual(
    markedIssuesWithoutRecords(setup.store, repo, [
      { kind: "pull-request-comment", id: 8, updatedAt: pr.updatedAt, comment: { ...pr, pullRequestNumber: 9 } },
    ]),
    [],
  );
});

test("an issue a fresh start left alone is not missing records, and is never taken in", (t) => {
  const setup = passSetup(t);
  const repo = setup.enroll();
  const freshStart = setup.store.recordFreshStart({ repoId: repo.id, confirmedBy: "Ada", markedIssueNumbers: [5, 3, 5] });
  assert.deepEqual(freshStart.markedIssueNumbers, [3, 5]);
  assert.equal(freshStart.confirmedBy, "Ada");
  assert.deepEqual(setup.store.freshStarts(repo.id), [freshStart]);
  assert.equal(setup.store.leftAloneAtFreshStart(repo.id, 3), true);
  assert.equal(setup.store.leftAloneAtFreshStart(repo.id, 4), false);

  assert.deepEqual(markedIssuesWithoutRecords(setup.store, repo, asChanges(marked(1, 3, 99), marked(2, 4, 98))), [4]);
  assert.equal(whyNotTakenIn(issue(3), repo, setup.store.latestEnrollment(repo.id), false, true), "left-alone-at-fresh-start");
});

test("the check reads the repo once, halts a repo missing records, and keeps that standing for the life of the process", async (t) => {
  const setup = passSetup(t);
  const repo = setup.enroll();
  const forge = new IntakeForge();
  forge.commentChanges = [marked(1, 3, 42), marked(2, 7, 43)];
  const check = new RecordsCheck({ store: setup.store, forgeFor: () => forge, log: setup.log, now: () => new Date("2026-11-09T10:00:00.000Z") });

  assert.deepEqual(check.standing(repo.id), { status: "unchecked", lastError: null });
  assert.equal(check.mayAct(repo.id), false, "nothing is done in a repo before its records are checked");
  const [first, second] = await Promise.all([check.check(repo), check.check(repo)]);
  assert.deepEqual(first, { status: "missing", since: "2026-11-09T10:00:00.000Z", markedIssues: [3, 7] });
  assert.equal(second, first, "a check already running is shared");
  assert.equal(forge.reads.changes, 1, "the check is one read of the repo");
  assert.equal(check.mayAct(repo.id), false);

  forge.commentChanges = [];
  assert.deepEqual(await check.check(repo), first, "only the owner clears it: restoring or a fresh start");
  assert.equal(forge.reads.changes, 1, "and it reads nothing more while it waits");
  assert.deepEqual(forge.state.sends, { comment: 0, addLabel: 0, removeLabel: 0, close: 0, merge: 0 }, "and writes nothing");
  assert.ok(setup.logLines().some((line) => line.event === "records-missing" && line.repoId === repo.id));
});

test("a repo whose marked issues all have their records is clear", async (t) => {
  const setup = passSetup(t);
  const repo = setup.enroll();
  const ticket = setup.store.takeIn({ repoId: repo.id, issueNumber: 3 });
  const forge = new IntakeForge();
  forge.commentChanges = [marked(1, 3, ticket.id)];
  const check = new RecordsCheck({ store: setup.store, forgeFor: () => forge, now: () => new Date("2026-11-09T10:00:00.000Z") });
  assert.deepEqual(await check.check(repo), { status: "clear", checkedAt: "2026-11-09T10:00:00.000Z" });
  assert.equal(check.mayAct(repo.id), true);
});

test("a check that cannot read the forge leaves the repo unchecked, and a later check reads it again", async (t) => {
  const setup = passSetup(t);
  const repo = setup.enroll();
  const forge = new IntakeForge();
  forge.failChanges = new ForgeLoggedOutError("github.com", "not logged in");
  const check = new RecordsCheck({ store: setup.store, forgeFor: () => forge, log: setup.log });

  await assert.rejects(check.check(repo), ForgeLoggedOutError);
  const standing = check.standing(repo.id);
  assert.equal(standing.status, "unchecked");
  assert.match(standing.status === "unchecked" ? (standing.lastError ?? "") : "", /not logged in/);
  assert.equal(check.mayAct(repo.id), false);

  assert.equal((await check.check(repo)).status, "clear");
  assert.equal(forge.reads.changes, 2);
});

test("confirming a fresh start records it with the marked issues the check found, and lets entail act again", async (t) => {
  const setup = passSetup(t);
  const repo = setup.enroll();
  const forge = new IntakeForge();
  forge.commentChanges = [marked(1, 3, 42), marked(2, 7, 43)];
  const check = new RecordsCheck({ store: setup.store, forgeFor: () => forge, log: setup.log });
  await check.check(repo);

  const freshStart = check.confirmFreshStart(repo.id, "Ada");
  assert.ok(freshStart);
  assert.deepEqual(freshStart.markedIssueNumbers, [3, 7]);
  assert.deepEqual(setup.store.freshStarts(repo.id), [freshStart]);
  assert.deepEqual(check.standing(repo.id), { status: "clear", checkedAt: freshStart.confirmedAt });
  assert.equal(check.mayAct(repo.id), true);
  assert.equal(check.confirmFreshStart(repo.id, "Ada"), null, "a repo not missing records has no fresh start to confirm");
  assert.equal(setup.store.freshStarts(repo.id).length, 1);

  // The next start's check finds the same marked issues left alone.
  const next = new RecordsCheck({ store: setup.store, forgeFor: () => forge });
  assert.equal((await next.check(repo)).status, "clear");
});
