import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import type { Issue, PullRequest } from "../src/forge/forge.ts";
import { ForgeWriter, InFlightWrites, RepoUnenrolledError, settleUnconfirmedWrites } from "../src/forge-writer.ts";
import { CLEARED_LABEL } from "../src/intake-comment.ts";
import { outsideCloses } from "../src/outside-close.ts";
import { Passes, type OwedStepPlanner } from "../src/pass.ts";
import { pullRequestFollowing } from "../src/pull-requests.ts";
import { readRepoSettings } from "../src/repo-settings.ts";
import {
  latestResume,
  NotEnrolledError,
  pendingUnenrollLabels,
  recordUnenrollment,
  removeUnenrollLabels,
  setPaused,
  UNENROLL_REASON,
  type UnenrollCancelDetail,
} from "../src/repo-switches.ts";
import type { CallKind, RepoRecord, TicketRecord } from "../src/store.ts";
import type { TicketState } from "../src/ticket-states.ts";
import { withdrawalReason } from "../src/withdraw.ts";
import { actor, IntakeForge, issue, passSetup, STILL_HEAD, type PassSetup } from "./pass-fixture.ts";

/** An IntakeForge whose issues can be closed and whose PRs link issues, read live as the forge reports them. */
class SwitchForge extends IntakeForge {
  prs: PullRequest[] = [];
  #clock = Date.now();

  override async issue(issueNumber: number): Promise<Issue | null> {
    return this.issues.find((i) => i.number === issueNumber) ?? null;
  }

  override async linkedPullRequests(issueNumber: number): Promise<PullRequest[]> {
    return this.prs.filter((pr) => pr.body === `Closes #${issueNumber}`);
  }

  override async linkedIssues(prNumber: number): Promise<number[]> {
    const match = /^Closes #(\d+)$/.exec(this.prs.find((p) => p.number === prNumber)?.body ?? "");
    return match ? [Number(match[1])] : [];
  }

  add(number: number, fields: Partial<Issue> = {}): void {
    this.issues.push(issue(number, { updatedAt: this.#tick(), ...fields }));
  }

  update(number: number, fields: Partial<Issue>): void {
    this.issues = this.issues.map((i) => (i.number === number ? { ...i, ...fields, updatedAt: this.#tick() } : i));
  }

  /** A PR closing `issueNumber`, merged by someone other than entail. */
  merged(number: number, issueNumber: number): void {
    this.prs.push({
      id: 7000 + number,
      number,
      title: `PR ${number}`,
      body: `Closes #${issueNumber}`,
      state: "merged",
      draft: false,
      mergeable: null,
      conflicts: null,
      headSha: `head-${number}`,
      baseBranch: "main",
      author: actor(2001, "executor"),
      createdAt: this.#tick(),
      updatedAt: this.#tick(),
      url: `https://github.com/acme/tally/pull/${number}`,
    });
  }

  #tick(): string {
    this.#clock += 1000;
    return new Date(this.#clock).toISOString();
  }
}

const ROUTE: Record<TicketState, { kind: CallKind; to: TicketState }[]> = {
  deciding: [],
  investigating: [{ kind: "investigation", to: "investigating" }],
  "on-the-board": [{ kind: "raise", to: "on-the-board" }],
  cleared: [{ kind: "criteria", to: "cleared" }],
  landing: [
    { kind: "criteria", to: "cleared" },
    { kind: "pr-opened", to: "landing" },
  ],
  declined: [{ kind: "decline", to: "declined" }],
  cancelled: [{ kind: "close-at-intake", to: "cancelled" }],
  merged: [
    { kind: "criteria", to: "cleared" },
    { kind: "merged-by-others", to: "merged" },
  ],
};

const LABELLED: Partial<Record<TicketState, string>> = { investigating: "entail:investigate", cleared: CLEARED_LABEL, landing: CLEARED_LABEL };
const NOTHING_SENT = { comment: 0, addLabel: 0, removeLabel: 0, close: 0, merge: 0 };

async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!done()) {
    if (performance.now() > deadline) assert.fail(`timed out waiting until ${what}`);
    await immediate();
  }
}

interface Harness {
  setup: PassSetup;
  repo: RepoRecord;
  forge: SwitchForge;
  engine: Passes;
  inFlight: InFlightWrites;
  /** Releases a step the test held open, by ticket id. */
  held: Map<number, () => void>;
  /** Holds the next step owed by the ticket open until the test releases it. */
  hold(ticketId: number): void;
  /** One pass, then waits for every step it started that is not held. */
  pass(): Promise<void>;
  /** Starts entail afresh on the same store and forge, as after a restart. */
  restart(): void;
  ticket(number: number, state: TicketState): TicketRecord;
  get(ticketId: number): TicketRecord;
  pause(): void;
  resume(): void;
}

/**
 * The passes over one enrolled repo with the real outside-close and PR
 * following, behind a planner that holds a step open for each ticket a test
 * asks it to, so the test controls when a running step finishes.
 */
function harness(t: TestContext): Harness {
  const setup = passSetup(t);
  const store = setup.store;
  const repo = setup.enroll();
  const forge = new SwitchForge();
  const inFlight = new InFlightWrites();
  const held = new Map<number, () => void>();
  const holding = new Set<number>();
  const holder: OwedStepPlanner = (ticket) => {
    if (!holding.has(ticket.id)) return null;
    holding.delete(ticket.id);
    return {
      name: "held",
      run: () =>
        new Promise<void>((resolve) => {
          held.set(ticket.id, () => {
            held.delete(ticket.id);
            resolve();
          });
        }),
    };
  };
  const start = () => {
    const closes = outsideCloses({ store, log: setup.log });
    const following = pullRequestFollowing({ store, log: setup.log });
    const engine = new Passes({
      store,
      log: setup.log,
      dataDirectory: setup.dataDirectory,
      forgeFor: () => forge,
      defaultBranchFor: async () => STILL_HEAD,
      planners: [holder, following.planner, closes.planner],
      changeHandlers: [following.onChange, closes.onChange],
      inFlight,
    });
    t.after(() => engine.stop());
    return engine;
  };
  const h: Harness = {
    setup,
    repo,
    forge,
    engine: start(),
    inFlight,
    held,
    hold: (ticketId) => void holding.add(ticketId),
    async pass() {
      await h.engine.runPass();
      await until(() => h.engine.stepsRunning === held.size, "every step started has finished or is held");
    },
    restart() {
      void h.engine.stop();
      h.engine = start();
    },
    ticket(number, state) {
      // Opened before enrollment, so a pass does not take it in on its own.
      forge.add(number, { createdAt: "2026-11-01T00:00:00.000Z" });
      const ticket = store.takeIn({ repoId: repo.id, issueNumber: number });
      for (const step of ROUTE[state]) {
        const call = store.recordCall({ ticketId: ticket.id, kind: step.kind, reason: `Moved to ${step.to} for the test.`, stateTo: step.to });
        if (step.to === "on-the-board") {
          store.raiseBoardItem({ ticketId: ticket.id, callId: call.id, decision: "Should tally count emoji?", whyRaised: "Consequential readings.", snapshot: { version: 1 } });
        }
      }
      const label = LABELLED[state];
      if (label !== undefined) forge.state.labels[number] = [label];
      return store.getTicket(ticket.id)!;
    },
    get: (ticketId) => store.getTicket(ticketId)!,
    pause: () => void setPaused(store, repo.id, true, "Ada"),
    resume: () => void setPaused(store, repo.id, false, "Ada"),
  };
  return h;
}

test("pausing saves a settings version, and saving the same switch again saves nothing", (t) => {
  const h = harness(t);
  const store = h.setup.store;
  const paused = setPaused(store, h.repo.id, true, "Ada")!;
  assert.equal(paused.version, 2);
  assert.equal(paused.savedBy, "Ada");
  assert.equal(readRepoSettings(store, h.repo.id)!.settings.paused, true);
  assert.equal(setPaused(store, h.repo.id, true, "Ada"), null, "already paused: no new version");
  assert.equal(latestResume(store, h.repo.id), null, "a paused repo has no resume in force");

  const resumed = setPaused(store, h.repo.id, false, "Ada")!;
  assert.equal(resumed.version, 3);
  assert.equal(latestResume(store, h.repo.id)?.id, resumed.id);
  store.saveSettings(h.repo.id, { ...readRepoSettings(store, h.repo.id)!.settings, shadow: true }, "Ada");
  assert.equal(latestResume(store, h.repo.id)?.id, resumed.id, "a later save is not a resume; the last resume stays the one in force");
  assert.deepEqual(store.listCalls({ repoId: h.repo.id }), [], "a pause or resume is not a call");
});

test("pause waits for the repo's running steps and their writes, shows as pausing, then reads and writes nothing", async (t) => {
  const h = harness(t);
  const ticket = h.ticket(1, "deciding");
  h.hold(ticket.id);
  await h.pass();
  assert.ok(h.held.has(ticket.id), "the step is running");
  const reads = h.forge.reads.changes;

  h.pause();
  assert.deepEqual(await h.engine.runPass(), [{ repoId: h.repo.id, outcome: "paused" }]);
  assert.equal(h.forge.reads.changes, reads, "a paused repo is not polled");
  assert.equal(h.engine.busy(h.repo.id), true, "the running step keeps the repo pausing");

  // A write the step makes while pausing still goes out, and keeps the repo pausing until it is posted.
  let release!: () => void;
  const write = h.inFlight.track(new Promise<void>((resolve) => (release = resolve)), h.repo.id);
  h.held.get(ticket.id)!();
  await until(() => h.engine.stepsRunning === 0, "the step finished");
  assert.equal(h.engine.busy(h.repo.id), true, "its write is still in flight");
  release();
  await write;
  await until(() => !h.engine.busy(h.repo.id), "the write is posted");

  h.forge.add(9);
  h.forge.update(1, { state: "closed" });
  await h.pass();
  assert.equal(h.forge.reads.changes, reads, "still not polled");
  assert.equal(h.get(ticket.id).state, "deciding", "states are kept: nothing is read, so nothing changes");
  assert.equal(h.setup.store.latestTicketForIssue(h.repo.id, 9), null);
  assert.deepEqual(h.forge.state.sends, NOTHING_SENT);
});

test("resume catches up from the saved cursors: new issues, outside closes and outside merges made during the pause", async (t) => {
  const h = harness(t);
  const onBoard = h.ticket(1, "on-the-board");
  const landing = h.ticket(2, "landing");
  const cleared = h.ticket(3, "cleared");
  await h.pass();
  assert.equal(h.get(onBoard.id).state, "on-the-board");

  h.pause();
  h.forge.add(10);
  h.forge.update(1, { state: "closed" });
  h.forge.merged(12, 2);
  h.forge.update(2, { state: "closed" });
  await h.pass();
  assert.equal(h.get(onBoard.id).state, "on-the-board", "nothing is handled while paused");
  assert.equal(h.setup.store.latestTicketForIssue(h.repo.id, 10), null);

  h.resume();
  assert.equal(h.engine.catchingUp(h.repo.id), true, "items stay locked until the catch-up has run");
  await h.pass();
  await until(() => !h.engine.catchingUp(h.repo.id), "caught up");
  assert.ok(h.setup.store.latestTicketForIssue(h.repo.id, 10), "the owner's new issue is taken in");
  assert.equal(h.get(onBoard.id).state, "cancelled", "an issue closed elsewhere cancels its ticket");
  const withdrawal = h.setup.store.boardItemsForTicket(onBoard.id).at(-1)!.withdrawal;
  assert.equal(withdrawal?.reason, withdrawalReason({ kind: "issue-closed" }), "its board item is withdrawn as usual");
  assert.equal(h.get(landing.id).state, "merged", "a PR merged elsewhere records its ticket merged");
  assert.equal(h.get(cleared.id).state, "cleared");
});

test("a resumed repo's items unlock only once a catch-up pass has polled and the steps of its tickets on the board have finished", async (t) => {
  const h = harness(t);
  const onBoard = h.ticket(1, "on-the-board");
  await h.pass();
  assert.equal(h.engine.catchingUp(h.repo.id), false, "a repo never paused has nothing to catch up with");
  h.pause();
  await h.pass();
  assert.equal(h.engine.catchingUp(h.repo.id), false, "a paused repo's items are locked as paused, not as catching up");
  h.resume();
  assert.equal(h.engine.catchingUp(h.repo.id), true);

  h.forge.failChanges = new Error("the forge is unreachable");
  await h.pass();
  assert.equal(h.engine.catchingUp(h.repo.id), true, "a failed poll has caught up with nothing");

  // After a restart, entail catches up again before items unlock.
  h.restart();
  assert.equal(h.engine.catchingUp(h.repo.id), true);
  h.hold(onBoard.id);
  await h.pass();
  assert.ok(h.held.has(onBoard.id), "the step owed by the ticket on the board is running");
  for (let n = 0; n < 20; n++) await immediate();
  assert.equal(h.engine.catchingUp(h.repo.id), true, "still catching up while that step runs");
  h.held.get(onBoard.id)!();
  await until(() => !h.engine.catchingUp(h.repo.id), "caught up once it finished");
  assert.ok(h.setup.logLines().some((line) => line.event === "caught-up" && line.repoId === h.repo.id));
});

test("unenrolling cancels every in-flight ticket with a logged call, removes their labels, withdraws open items, and posts and closes nothing", async (t) => {
  const h = harness(t);
  const store = h.setup.store;
  const tickets = Object.fromEntries(
    (["deciding", "investigating", "on-the-board", "cleared", "landing", "declined", "merged"] as const).map((state, i) => [state, h.ticket(i + 1, state)]),
  ) as Record<TicketState, TicketRecord>;
  // A comment some step recorded and never sent: after unenrolling it is never posted.
  const stale = store.recordForgeWriteIntent({ repoId: h.repo.id, ticketId: tickets.deciding.id, kind: "comment", target: "issue", number: 1, payload: { body: "late" } });
  const before = store.listCalls({ repoId: h.repo.id });

  const unenrolled = recordUnenrollment(store, h.repo, "Ada");
  assert.equal(store.isEnrolled(h.repo.id), false);
  assert.deepEqual(store.listEnrolledRepos(), []);
  assert.equal(unenrolled.unenrollment.unenrolledBy, "Ada");
  assert.deepEqual(
    unenrolled.cancelled.map((c) => [c.from, c.label]),
    [
      ["deciding", null],
      ["investigating", "entail:investigate"],
      ["on-the-board", null],
      ["cleared", CLEARED_LABEL],
      ["landing", CLEARED_LABEL],
    ],
  );
  for (const state of ["deciding", "investigating", "on-the-board", "cleared", "landing"] as const) {
    const ticket = h.get(tickets[state].id);
    assert.equal(ticket.state, "cancelled", `${state} is cancelled`);
    const call = store.getCall(ticket.stateCallId!)!;
    assert.equal(call.kind, "unenroll-cancel");
    assert.equal(call.reason, UNENROLL_REASON);
    assert.match(call.reason, /repo unenrolled/);
    assert.deepEqual(call.detail as UnenrollCancelDetail, { unenrollmentId: unenrolled.unenrollment.id });
  }
  assert.equal(h.get(tickets.declined.id).state, "declined", "a final ticket is left alone");
  assert.equal(h.get(tickets.merged.id).state, "merged");
  const withdrawal = store.boardItemsForTicket(tickets["on-the-board"].id).at(-1)!.withdrawal!;
  assert.equal(withdrawal.reason, withdrawalReason({ kind: "repo-unenrolled" }));
  assert.equal(store.openBoardItem(tickets["on-the-board"].id), null);
  for (const call of before) assert.deepEqual(store.getCall(call.id), call, "every earlier call stays as it was");
  assert.equal(store.listCalls({ repoId: h.repo.id }).length, before.length + 5, "with one cancel call per in-flight ticket");

  assert.equal(pendingUnenrollLabels(store, h.repo.id).length, 3);
  const writer = new ForgeWriter(store, h.forge, h.repo, "Ada", h.inFlight);
  assert.equal(await removeUnenrollLabels(store, h.repo, writer, h.setup.log), 0);
  assert.equal(pendingUnenrollLabels(store, h.repo.id).length, 0);
  for (const n of [2, 4, 5]) assert.deepEqual(h.forge.state.labels[n], [], `issue ${n} keeps no entail: label`);
  assert.deepEqual(h.forge.state.sends, { ...NOTHING_SENT, removeLabel: 3 });
  assert.deepEqual(h.forge.state.comments, {}, "no comment");
  assert.deepEqual(h.forge.state.closed, {}, "no close");
  assert.deepEqual(await settleUnconfirmedWrites(store, () => h.forge), [], "settling on start sends nothing more there");
  assert.ok(store.unconfirmedForgeWrites().some((w) => w.id === stale.id), "the comment left unsent stays unsent");
  assert.deepEqual(h.forge.state.comments, {});

  // Reading and writing stop.
  const reads = h.forge.reads.changes;
  assert.deepEqual(await h.engine.runPass(), [], "an unenrolled repo is not passed over");
  assert.equal(h.forge.reads.changes, reads);
  await assert.rejects(writer.closeIssue({ ticketId: tickets.deciding.id }, 1, "completed"), RepoUnenrolledError, "a late step's close is refused");
  await assert.rejects(writer.addLabel({ ticketId: tickets.cleared.id }, 4, CLEARED_LABEL), RepoUnenrolledError, "and so is a label");
  assert.deepEqual(h.forge.state.sends, { ...NOTHING_SENT, removeLabel: 3 });
  assert.throws(() => recordUnenrollment(store, h.repo, "Ada"), NotEnrolledError, "an unenrolled repo cannot be unenrolled again");
});

test("a paused repo can be unenrolled directly", async (t) => {
  const h = harness(t);
  const ticket = h.ticket(1, "cleared");
  h.pause();
  await h.pass();
  recordUnenrollment(h.setup.store, h.repo, "Ada");
  assert.equal(h.get(ticket.id).state, "cancelled");
  assert.equal(h.setup.store.isEnrolled(h.repo.id), false);
});

test("a label removal that fails on unenroll stays owed and is settled on the next start", async (t) => {
  const h = harness(t);
  const store = h.setup.store;
  h.ticket(1, "cleared");
  recordUnenrollment(store, h.repo, "Ada");
  const failing = new (class extends SwitchForge {
    override async removeLabel(): Promise<void> {
      throw new Error("the forge is down");
    }
  })();
  const writer = new ForgeWriter(store, failing, h.repo, "Ada");
  assert.equal(await removeUnenrollLabels(store, h.repo, writer, h.setup.log), 1);
  assert.equal(pendingUnenrollLabels(store, h.repo.id).length, 1, "left for the next start's settling");
  assert.ok(h.setup.logLines().some((line) => line.event === "unenroll-label-failed"));
});

test("enrolling an unenrolled repo again keeps its record and records, and takes in only issues opened after it", async (t) => {
  const h = harness(t);
  const store = h.setup.store;
  const old = h.ticket(1, "cleared");
  recordUnenrollment(store, h.repo, "Ada");
  const records = store.listCalls({ repoId: h.repo.id });

  // Issue 2 opened while unenrolled, still open; issue 3 opened after enrolling again.
  h.forge.add(2, { createdAt: new Date(Date.now() - 60_000).toISOString() });
  const again = store.enroll({
    repo: { forge: "github", host: "github.com", projectId: 5001, path: "acme/tally", ownerAccountId: 1001, ownerLogin: "owner" },
    settings: readRepoSettings(store, h.repo.id)!.settings,
    savedBy: "Ada",
    visionSha: "c0ffee",
    visionLines: ["Tally counts words in text."],
    visionOrigin: "owner-stated",
    openIssueNumbers: [1, 2],
  });
  assert.equal(again.repo.id, h.repo.id, "the repo keeps its record, keyed on its project id");
  assert.equal(store.isEnrolled(h.repo.id), true);
  assert.deepEqual(store.listCalls({ repoId: h.repo.id }), records, "its records are unchanged");
  h.forge.add(3, { createdAt: new Date(Date.now() + 60_000).toISOString() });

  await h.pass();
  assert.equal(store.latestTicketForIssue(h.repo.id, 1)?.id, old.id, "an old issue is not taken in again");
  assert.equal(store.latestTicketForIssue(h.repo.id, 2), null, "an issue open at the new enrollment is not taken in");
  assert.ok(store.latestTicketForIssue(h.repo.id, 3), "an issue opened after it is");
});
