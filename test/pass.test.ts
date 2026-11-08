import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CURSORS_FILE } from "../src/cursors.ts";
import { ForgeLoggedOutError, RateLimitedError } from "../src/forge/forge.ts";
import { Limiter } from "../src/forge-limit.ts";
import { DEFAULT_GLOBAL_SETTINGS } from "../src/global-settings.ts";
import type { IntakeDetail } from "../src/intake.ts";
import { Mirror } from "../src/mirror.ts";
import { backoffDelay, BACKOFF_MAX_MS, Passes, type DefaultBranchSource, type OwedStepPlanner, type PassesOptions } from "../src/pass.ts";
import { enrollmentSettings } from "../src/repo-settings.ts";
import type { RepoRecord } from "../src/store.ts";
import { FixtureRepo } from "./git-fixture.ts";
import { actor, comment, IntakeForge, issue, issueComment, OWNER_ID, passSetup, STILL_HEAD, type PassSetup } from "./pass-fixture.ts";
import { hiddenMarker } from "../src/comment-rules.ts";
import { RecordsCheck } from "../src/records-check.ts";

function passes(setup: PassSetup, forges: Map<number, IntakeForge> | IntakeForge, options: Partial<PassesOptions> = {}): Passes {
  return new Passes({
    store: setup.store,
    log: setup.log,
    dataDirectory: setup.dataDirectory,
    forgeFor: (repo) => (forges instanceof Map ? forges.get(repo.id)! : forges),
    defaultBranchFor: async () => STILL_HEAD,
    ...options,
  });
}

test("a new issue the owner opened becomes one ticket in deciding, with its text recorded as request text tagged by author", async (t) => {
  const setup = passSetup(t);
  const repo = setup.enroll();
  const forge = new IntakeForge();
  forge.issues = [issue(5, { title: "Count lines too", body: "Add a `--lines` flag." })];
  forge.issueComments.set(5, [comment(7001, 5, actor(1002, "reporter"), "Please also count bytes.")]);

  const outcome = await passes(setup, forge).runPass();
  assert.equal(outcome[0]?.outcome, "polled");

  const ticket = setup.store.latestTicketForIssue(repo.id, 5);
  assert.ok(ticket);
  assert.equal(ticket.state, "deciding");
  assert.equal(ticket.predecessorId, null);
  const calls = setup.store.callsForTicket(ticket.id);
  assert.equal(calls.length, 1, "the call that took it in is recorded");
  const [intake] = calls;
  assert.equal(intake?.kind, "intake");
  assert.equal(intake?.stateChange, null, "a ticket is taken in deciding");
  assert.deepEqual(intake?.inputs, {
    issueTitle: "Count lines too",
    issueBody: "Add a `--lines` flag.",
    visionSha: null,
    pins: null,
    settingsVersionId: setup.store.latestSettings(repo.id)!.id,
    prHeadSha: null,
  });
  const detail = intake?.detail as IntakeDetail;
  assert.deepEqual(detail.request, [
    { part: "title", author: actor(OWNER_ID), text: "Count lines too" },
    { part: "body", author: actor(OWNER_ID), text: "Add a `--lines` flag." },
    {
      part: "comment",
      commentId: 7001,
      author: actor(1002, "reporter"),
      createdAt: "2026-11-08T12:31:00.000Z",
      text: "Please also count bytes.",
    },
  ]);
  assert.equal(detail.issue.number, 5);

  await passes(setup, forge).runPass();
  assert.equal(setup.store.ticketsInFlight(repo.id).length, 1, "a later pass takes nothing in twice");
  assert.deepEqual(forge.state.sends, { comment: 0, addLabel: 0, removeLabel: 0, close: 0, merge: 0 }, "intake posts nothing yet");
});

test("someone else's new issue, an issue open at enrollment, an older one and a transferred-in one start nothing", async (t) => {
  const setup = passSetup(t);
  const repo = setup.enroll({ openIssueNumbers: [2] });
  const forge = new IntakeForge();
  forge.issues = [
    issue(1, { author: actor(1002, "reporter") }),
    // Same username as the owner, another account: identity is the numeric id.
    issue(3, { author: actor(1003, "owner") }),
    issue(2, { createdAt: "2026-11-08T11:00:00.000Z" }),
    issue(4, { createdAt: "2026-11-08T11:59:59.000Z" }),
    issue(8),
    issue(9, { state: "closed" }),
  ];
  forge.transferred.add(8);

  const [outcome] = await passes(setup, forge).runPass();
  assert.deepEqual(outcome, { repoId: repo.id, outcome: "polled", takenIn: [], started: [] });
  for (const number of [1, 2, 3, 4, 8, 9]) {
    assert.equal(setup.store.latestTicketForIssue(repo.id, number), null, `issue #${number} has no ticket`);
  }
  assert.deepEqual(forge.state.sends, { comment: 0, addLabel: 0, removeLabel: 0, close: 0, merge: 0 }, "and gets no comment");
  assert.equal(forge.reads.transferred, 1, "only an owner's new open issue is asked about");
});

test("killing entail mid-pass and starting again loses no ticket and duplicates none", async (t) => {
  const setup = passSetup(t);
  const repo = setup.enroll();
  const forge = new IntakeForge();
  forge.issues = [issue(5), issue(6), issue(7)];
  forge.failComments.set(6, new Error("killed"));

  const [first] = await passes(setup, forge).runPass();
  assert.equal(first?.outcome, "failed");
  assert.ok(setup.store.latestTicketForIssue(repo.id, 5), "issue #5 was taken in before the kill");
  assert.equal(setup.store.latestTicketForIssue(repo.id, 6), null);
  assert.ok(!existsSync(join(setup.dataDirectory, CURSORS_FILE)), "the cursor is saved only once every change was handled");

  // A restart: nothing in memory survives, only the store and the cursors.
  forge.failComments.clear();
  const [second] = await passes(setup, forge).runPass();
  assert.equal(second?.outcome, "polled");
  // Killed after the take-ins were recorded but before the cursor was saved.
  rmSync(join(setup.dataDirectory, CURSORS_FILE));
  await passes(setup, forge).runPass();

  for (const number of [5, 6, 7]) {
    const tickets = setup.store.ticketsInFlight(repo.id).filter((ticket) => ticket.issueNumber === number);
    assert.equal(tickets.length, 1, `issue #${number} has exactly one ticket`);
    assert.equal(setup.store.callsForTicket(tickets[0]!.id).length, 1, `and one intake call`);
  }
});

test("a pass retried in the same process after a failure reads every change again", async (t) => {
  const setup = passSetup(t);
  const repo = setup.enroll();
  const forge = new IntakeForge();
  forge.issues = [issue(5), issue(6)];
  forge.failComments.set(6, new Error("connection reset"));
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-08T13:00:00Z") });
  const engine = passes(setup, forge);

  await engine.runPass();
  forge.failComments.clear();
  t.mock.timers.tick(backoffDelay(1));
  await engine.runPass();
  assert.ok(setup.store.latestTicketForIssue(repo.id, 6), "the change that failed is handled on the next poll");
});

test("a rate limit is honoured until its reset, on that host only", async (t) => {
  const setup = passSetup(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-08T13:00:00Z") });
  const limited = setup.enroll({ projectId: 5001 });
  const sameHost = setup.enroll({ projectId: 5002, path: "acme/other" });
  const elsewhere = setup.enroll({ projectId: 5003, host: "gitlab.example.org", path: "acme/third" });
  const forges = new Map([
    [limited.id, new IntakeForge()],
    [sameHost.id, new IntakeForge()],
    [elsewhere.id, new IntakeForge("gitlab.example.org", "acme/third")],
  ]);
  const resetAt = new Date("2026-11-08T13:20:00Z");
  forges.get(limited.id)!.failChanges = new RateLimitedError("github.com", resetAt);
  const engine = passes(setup, forges);

  const first = await engine.runPass();
  assert.deepEqual(first[0], { repoId: limited.id, outcome: "rate-limited", until: resetAt.toISOString() });

  t.mock.timers.tick(19 * 60_000);
  const before = await engine.runPass();
  assert.deepEqual(
    before.map((o) => o.outcome),
    ["rate-limited", "rate-limited", "polled"],
    "the host's repos wait for the reset; another host's repo is polled",
  );
  const reads = forges.get(limited.id)!.reads.changes;
  t.mock.timers.tick(60_000);
  const after = await engine.runPass();
  assert.deepEqual(after.map((o) => o.outcome), ["polled", "polled", "polled"]);
  assert.equal(forges.get(limited.id)!.reads.changes, reads + 1);
  assert.ok(setup.logLines().some((line) => line.event === "rate-limited" && line.until === resetAt.toISOString()));
});

test("any other failure backs off that repo alone, doubling up to 15 minutes", async (t) => {
  const setup = passSetup(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-08T13:00:00Z") });
  const failing = setup.enroll({ projectId: 5001 });
  const healthy = setup.enroll({ projectId: 5002, path: "acme/other" });
  const failingForge = new IntakeForge();
  const healthyForge = new IntakeForge();
  const engine = passes(
    setup,
    new Map([
      [failing.id, failingForge],
      [healthy.id, healthyForge],
    ]),
  );

  const waits: number[] = [];
  for (let failure = 1; failure <= 6; failure++) {
    failingForge.failChanges = new Error("the host did not answer");
    const [outcome] = await engine.runPass();
    assert.equal(outcome?.outcome, "failed", `failure ${failure}`);
    // Poll every minute until the repo is polled again.
    let waited = 0;
    for (;;) {
      t.mock.timers.tick(60_000);
      waited += 60_000;
      const [next] = await engine.runPass();
      if (next?.outcome !== "backing-off") {
        // That poll succeeded; fail the next one again.
        break;
      }
    }
    waits.push(waited);
  }
  assert.deepEqual(
    waits.map((ms) => ms / 60_000),
    [1, 1, 1, 1, 1, 1],
    "a success clears the backoff",
  );

  // Failures in a row double the wait, up to 15 minutes.
  const inARow: number[] = [];
  let last = Date.now();
  for (let failure = 1; failure <= 6; failure++) {
    failingForge.failChanges = new Error("the host did not answer");
    for (;;) {
      const [outcome] = await engine.runPass();
      if (outcome?.outcome === "failed") break;
      t.mock.timers.tick(60_000);
    }
    inARow.push((Date.now() - last) / 60_000);
    last = Date.now();
  }
  assert.deepEqual(inARow, [0, 1, 2, 4, 8, 15]);
  assert.equal(backoffDelay(10), BACKOFF_MAX_MS);
  assert.ok(healthyForge.reads.changes > 12, "the healthy repo was polled on every pass throughout");
  const failures = setup.logLines().filter((line) => line.event === "poll-failed");
  assert.equal(failures.length, 12, "every failure is in the operational log");
  assert.equal(failures.at(-1)?.retryAt, new Date(Date.now() + BACKOFF_MAX_MS).toISOString());
});

test("polls, backoffs and failures go to the operational log, not the records", async (t) => {
  const setup = passSetup(t);
  const repo = setup.enroll();
  const forge = new IntakeForge();
  const engine = passes(setup, forge);
  await engine.runPass();
  forge.failChanges = new Error("boom");
  await engine.runPass();

  const events = setup.logLines().map((line) => line.event);
  assert.ok(events.includes("poll"));
  assert.ok(events.includes("poll-failed"));
  assert.equal(setup.store.ticketsInFlight(repo.id).length, 0, "no ticket and so no call was recorded");
});

test("at most four forge subprocesses run at once across all repos", async (t) => {
  const setup = passSetup(t);
  const forges = new Map<number, IntakeForge>();
  for (let n = 0; n < 7; n++) {
    const repo = setup.enroll({ projectId: 6000 + n, path: `acme/repo${n}` });
    forges.set(repo.id, new IntakeForge());
  }
  let running = 0;
  let peak = 0;
  const slowHead: DefaultBranchSource = {
    async updateDefaultBranch() {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running--;
      return { branch: "main", commit: "c0ffee", fetched: false };
    },
  };
  const limiter = new Limiter();
  const outcomes = await passes(setup, forges, { limiter, defaultBranchFor: async () => slowHead }).runPass();
  assert.equal(outcomes.length, 7);
  assert.equal(peak, 4);
  assert.equal(limiter.peak, 4);
});

test("each pass checks the default branch head with git ls-remote and fetches only when it moved", async (t) => {
  const setup = passSetup(t);
  setup.enroll();
  const remote = new FixtureRepo(t);
  remote.write("VISION.md", "Tally counts words in text.\n");
  const first = remote.commit("start");
  remote.push();
  const heads: { commit: string; fetched: boolean }[] = [];
  const engine = passes(setup, new IntakeForge(), {
    defaultBranchFor: async (repo: RepoRecord) => {
      const mirror = await Mirror.open({
        dataDirectory: setup.dataDirectory,
        key: { forge: repo.forge, host: repo.host, projectId: repo.projectId },
        remote: { url: remote.remote, credentialHelper: null },
      });
      return {
        async updateDefaultBranch() {
          const head = await mirror.updateDefaultBranch();
          heads.push({ commit: head.commit, fetched: head.fetched });
          return head;
        },
      };
    },
  });

  await engine.runPass();
  await engine.runPass();
  remote.write("VISION.md", "Tally counts words in text.\nTally reads standard input.\n");
  const second = remote.commit("vision");
  remote.push();
  await engine.runPass();
  assert.deepEqual(heads, [
    { commit: first, fetched: true },
    { commit: first, fetched: false },
    { commit: second, fetched: true },
  ]);
});

test("repo settings are re-read on every pass: a paused repo is not read", async (t) => {
  const setup = passSetup(t);
  const repo = setup.enroll();
  const forge = new IntakeForge();
  forge.issues = [issue(5)];
  const engine = passes(setup, forge);

  setup.store.saveSettings(repo.id, { ...enrollmentSettings("owner-stated", "squash"), paused: true }, "Ada");
  assert.deepEqual(await engine.runPass(), [{ repoId: repo.id, outcome: "paused" }]);
  assert.equal(forge.reads.changes, 0);
  assert.equal(setup.store.latestTicketForIssue(repo.id, 5), null);

  setup.store.saveSettings(repo.id, enrollmentSettings("owner-stated", "squash"), "Ada");
  await engine.runPass();
  assert.ok(setup.store.latestTicketForIssue(repo.id, 5), "on resume the owner's new issue is taken in");
});

test("the poll interval comes from the global settings, re-read before each wait", async (t) => {
  const setup = passSetup(t);
  setup.enroll();
  const forge = new IntakeForge();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse("2026-11-08T13:00:00Z") });
  const engine = passes(setup, forge);
  t.after(() => engine.stop());

  const settle = async () => {
    // Lets the pass run between timer ticks.
    for (let n = 0; n < 5; n++) await new Promise((resolve) => setImmediate(resolve));
  };
  engine.start();
  t.mock.timers.tick(0);
  await settle();
  assert.equal(forge.reads.changes, 1, "the first pass runs at once");

  t.mock.timers.tick(59_000);
  await settle();
  assert.equal(forge.reads.changes, 1);
  t.mock.timers.tick(1_000);
  await settle();
  assert.equal(forge.reads.changes, 2, "then every 60 seconds by default");

  setup.store.saveGlobalSettings({ ...DEFAULT_GLOBAL_SETTINGS, ownerDisplayName: "Ada", pollIntervalSeconds: 10 }, "Ada");
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(forge.reads.changes, 3);
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(forge.reads.changes, 4, "a saved interval takes effect from the next pass");

  await engine.stop();
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(forge.reads.changes, 4, "a stopped engine starts no pass");
});

test("each non-final ticket's owed step is started once while it runs, and re-derived after a restart", async (t) => {
  const setup = passSetup(t);
  const repo = setup.enroll();
  const forge = new IntakeForge();
  forge.issues = [issue(5)];
  let started = 0;
  let finish!: () => void;
  // Owed while the ticket is deciding, as its records say.
  const planner: OwedStepPlanner = (ticket) =>
    ticket.state === "deciding"
      ? {
          name: "verdict",
          run: () => {
            started++;
            return new Promise<void>((resolve) => (finish = resolve));
          },
        }
      : null;

  const engine = passes(setup, forge, { planners: [planner] });
  const [first] = await engine.runPass();
  const ticket = setup.store.latestTicketForIssue(repo.id, 5)!;
  assert.deepEqual(first, { repoId: repo.id, outcome: "polled", takenIn: [ticket.id], started: [ticket.id] });
  const [second] = await engine.runPass();
  assert.deepEqual(second, { repoId: repo.id, outcome: "polled", takenIn: [], started: [] }, "not started again while it runs");
  assert.equal(started, 1);

  // A restart loses the step in flight; the records still say it is owed.
  const restarted = passes(setup, forge, { planners: [planner] });
  await restarted.runPass();
  assert.equal(started, 2, "the owed step is derived from the records again");
  finish();
  await restarted.stop();
  await restarted.runPass();
  assert.equal(started, 2, "a stopping engine starts no new work");
});

test("a host whose CLI is logged out is reported halted and clears after a successful poll", async (t) => {
  const setup = passSetup(t);
  setup.enroll();
  const forge = new IntakeForge();
  forge.failChanges = new ForgeLoggedOutError("github.com", "401");
  const engine = passes(setup, forge);

  assert.equal(engine.hostHalted("github.com"), false);
  await engine.runPass();
  assert.equal(engine.hostHalted("github.com"), true);
  assert.equal(engine.hostHalted("gitlab.example.org"), false);

  const after = await engine.runPass();
  assert.equal(after[0]?.outcome, "polled");
  assert.equal(engine.hostHalted("github.com"), false);
});

test("a repo missing its records is left alone after the check, and after a fresh start only new issues are taken in", async (t) => {
  const setup = passSetup(t);
  const repo = setup.enroll();
  const forge = new IntakeForge();
  // Issue 3 would be taken in on its own, but entail acted on it before, from records this store does not hold.
  forge.issues = [issue(3), issue(5)];
  forge.commentChanges = [issueComment(8001, 3, actor(OWNER_ID), `Speaking from Ada's entail:\n\nTaken in.\n\n${hiddenMarker(42)}`)];
  const recordsCheck = new RecordsCheck({ store: setup.store, forgeFor: () => forge, log: setup.log });
  const run = passes(setup, forge, { recordsCheck });

  for (let pass = 0; pass < 2; pass++) {
    const [outcome] = await run.runPass();
    assert.equal(outcome?.outcome, "waiting-for-records");
    assert.deepEqual(outcome?.outcome === "waiting-for-records" ? outcome.markedIssues : null, [3]);
  }
  assert.equal(forge.reads.changes, 1, "no forge read beyond the check");
  assert.deepEqual(forge.reads, { changes: 1, transferred: 0, comments: 0 });
  assert.deepEqual(forge.state.sends, { comment: 0, addLabel: 0, removeLabel: 0, close: 0, merge: 0 }, "and no write");
  assert.deepEqual(setup.store.ticketsInFlight(repo.id), []);

  recordsCheck.confirmFreshStart(repo.id, "Ada");
  const [outcome] = await run.runPass();
  assert.equal(outcome?.outcome, "polled");
  assert.equal(setup.store.latestTicketForIssue(repo.id, 3), null, "the marked issue is left alone");
  assert.ok(setup.store.latestTicketForIssue(repo.id, 5), "a new issue is taken in");
});

test("a repo whose records check failed at start is checked on its next pass before it is polled", async (t) => {
  const setup = passSetup(t);
  const repo = setup.enroll();
  const forge = new IntakeForge();
  forge.issues = [issue(5)];
  const recordsCheck = new RecordsCheck({ store: setup.store, forgeFor: () => forge, log: setup.log });
  forge.failChanges = new Error("host unreachable");
  await assert.rejects(recordsCheck.check(repo));

  const [outcome] = await passes(setup, forge, { recordsCheck }).runPass();
  assert.equal(outcome?.outcome, "polled");
  assert.equal(recordsCheck.mayAct(repo.id), true);
  assert.equal(forge.reads.changes, 3, "the failed check, the check on the pass, then the poll");
  assert.ok(setup.store.latestTicketForIssue(repo.id, 5));
});
