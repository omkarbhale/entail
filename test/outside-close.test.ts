import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import { recordBoardAnswer } from "../src/answer.ts";
import { readBoard } from "../src/board-page.ts";
import type { ChangeBatch, Issue, PullRequest } from "../src/forge/forge.ts";
import { CLEARED_LABEL } from "../src/intake-comment.ts";
import { ISSUE_RECHECK_MS, outsideCloses, type OutsideCloseDetail } from "../src/outside-close.ts";
import { Passes } from "../src/pass.ts";
import { pullRequestFollowing } from "../src/pull-requests.ts";
import type { BoardItemRecord, CallKind, RepoRecord, TicketRecord } from "../src/store.ts";
import type { TicketState } from "../src/ticket-states.ts";
import { withdrawalReason, withdrawOpenItem, type WithdrawalBasis } from "../src/withdraw.ts";
import { actor, IntakeForge, issue, passSetup, STILL_HEAD, type PassSetup } from "./pass-fixture.ts";

/**
 * An IntakeForge whose issues can be closed, reopened, deleted or moved
 * elsewhere, read live as the forge reports them, with PRs linking them.
 */
class CloseForge extends IntakeForge {
  /** Issues gone from the repo: deleted, transferred or converted. They report no change and read as null. */
  readonly gone = new Set<number>();
  prs: PullRequest[] = [];
  /** How many times an issue, and an issue's PRs, were read live. */
  readonly live = { issue: 0, linked: 0 };
  #clock = Date.now();

  override async changesSince(): Promise<ChangeBatch> {
    const batch = await super.changesSince();
    return { changes: batch.changes.filter((c) => c.kind !== "issue" || !this.gone.has(c.issue.number)), cursor: batch.cursor };
  }

  override async issue(issueNumber: number): Promise<Issue | null> {
    this.live.issue++;
    if (this.gone.has(issueNumber)) return null;
    return this.issues.find((i) => i.number === issueNumber) ?? null;
  }

  override async linkedPullRequests(issueNumber: number): Promise<PullRequest[]> {
    this.live.linked++;
    return this.prs.filter((pr) => pr.body === `Closes #${issueNumber}`);
  }

  override async linkedIssues(prNumber: number): Promise<number[]> {
    const pr = this.prs.find((p) => p.number === prNumber);
    const match = pr ? /^Closes #(\d+)$/.exec(pr.body) : null;
    return match ? [Number(match[1])] : [];
  }

  /** Adds an issue, open and by the owner unless `fields` say otherwise. */
  add(number: number, fields: Partial<Issue> = {}): void {
    this.issues.push(issue(number, { updatedAt: this.#tick(), ...fields }));
  }

  /** Changes an issue, as the forge reports it changed. */
  update(number: number, fields: Partial<Issue>): void {
    this.issues = this.issues.map((i) => (i.number === number ? { ...i, ...fields, updatedAt: this.#tick() } : i));
  }

  /** A merged PR closing `issueNumber`. */
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

interface Harness {
  setup: PassSetup;
  repo: RepoRecord;
  forge: CloseForge;
  clock: { now: number };
  pass(times?: number): Promise<void>;
  /** Starts entail afresh on the same store and forge, as after a restart. */
  restart(): void;
  /** Takes issue `number` in and moves its ticket to `state` with calls of the kinds that would, raising a board item on the board. */
  ticket(number: number, state: TicketState): TicketRecord;
  get(ticketId: number): TicketRecord;
  item(ticketId: number): BoardItemRecord | null;
  /** Every call the ticket has, by kind. */
  kinds(ticketId: number): CallKind[];
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

async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!done()) {
    if (performance.now() > deadline) assert.fail(`timed out waiting until ${what}`);
    await immediate();
  }
}

function harness(t: TestContext, options: { followPullRequests?: boolean } = {}): Harness {
  const setup = passSetup(t);
  const repo = setup.enroll();
  const forge = new CloseForge();
  const clock = { now: Date.parse("2026-11-09T09:00:00.000Z") };
  let engine!: Passes;
  const start = () => {
    const closes = outsideCloses({ store: setup.store, log: setup.log, now: () => clock.now });
    const following = pullRequestFollowing({ store: setup.store, log: setup.log });
    engine = new Passes({
      store: setup.store,
      log: setup.log,
      dataDirectory: setup.dataDirectory,
      forgeFor: () => forge,
      defaultBranchFor: async () => STILL_HEAD,
      planners: options.followPullRequests ? [following.planner, closes.planner] : [closes.planner],
      changeHandlers: options.followPullRequests ? [following.onChange, closes.onChange] : [closes.onChange],
    });
    const running = engine;
    t.after(() => running.stop());
  };
  start();
  const store = setup.store;
  return {
    setup,
    repo,
    forge,
    clock,
    async pass(times = 1) {
      for (let i = 0; i < times; i++) {
        await engine.runPass();
        await until(() => engine.stepsRunning === 0, "every step started has finished");
      }
    },
    restart() {
      void engine.stop();
      start();
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
    item: (ticketId) => store.boardItemsForTicket(ticketId).at(-1)?.item ?? null,
    kinds: (ticketId) => store.callsForTicket(ticketId).map((c) => c.kind),
  };
}

function cancelCall(h: Harness, ticketId: number) {
  const call = h.setup.store.callsForTicket(ticketId).at(-1)!;
  assert.equal(call.kind, "cancel-on-outside-close");
  return call;
}

const NOTHING_SENT = { comment: 0, addLabel: 0, removeLabel: 0, close: 0, merge: 0 };

for (const state of ["deciding", "investigating", "on-the-board", "cleared", "landing"] as const) {
  test(`closing the issue of a ticket in ${state} cancels it with a logged call, removes its label and posts nothing`, async (t) => {
    const h = harness(t);
    const ticket = h.ticket(1, state);
    await h.pass();
    assert.equal(h.get(ticket.id).state, state, "an open issue cancels nothing");

    h.forge.update(1, { state: "closed" });
    await h.pass();
    assert.equal(h.get(ticket.id).state, "cancelled");
    const call = cancelCall(h, ticket.id);
    assert.deepEqual(call.stateChange, { from: state, to: "cancelled" });
    assert.equal(call.reason, "Cancelled: someone other than entail closed the issue.");
    assert.deepEqual(call.detail as OutsideCloseDetail, { issue: "closed" });
    assert.ok(
      h.setup.logLines().some((line) => line.event === "ticket-cancelled-outside-close" && line.ticketId === ticket.id && line.how === "closed"),
      "the cancel is in the operational log too",
    );

    const label = LABELLED[state];
    assert.deepEqual(h.forge.state.labels[1] ?? [], [], "no entail: label is left on the issue");
    assert.deepEqual(h.forge.state.sends, { ...NOTHING_SENT, removeLabel: label === undefined ? 0 : 1 });
    assert.deepEqual(h.forge.state.comments, {}, "nothing is posted on the issue");
    assert.deepEqual(h.forge.state.closed, {}, "entail does not close what is already closed");

    // Reading the close again, or the pass after, records nothing more.
    await h.pass(2);
    assert.equal(h.kinds(ticket.id).filter((k) => k === "cancel-on-outside-close").length, 1);
    assert.deepEqual(h.forge.state.sends, { ...NOTHING_SENT, removeLabel: label === undefined ? 0 : 1 });
  });
}

for (const [how, basis] of [
  ["deleted", { kind: "issue-gone" }],
  ["transferred to another repo", { kind: "issue-gone" }],
  ["converted to a discussion", { kind: "issue-gone" }],
] as const) {
  test(`an issue ${how} cancels its ticket and withdraws its open board item, with no label write`, async (t) => {
    const h = harness(t);
    const ticket = h.ticket(1, "on-the-board");
    const cleared = h.ticket(2, "cleared");
    await h.pass();
    assert.equal(h.get(ticket.id).state, "on-the-board");

    // Gone from the repo: it reports no change, and reads as no issue.
    h.forge.gone.add(1);
    h.forge.gone.add(2);
    h.clock.now += ISSUE_RECHECK_MS;
    await h.pass();
    for (const id of [ticket.id, cleared.id]) {
      assert.equal(h.get(id).state, "cancelled");
      const call = cancelCall(h, id);
      assert.deepEqual(call.detail as OutsideCloseDetail, { issue: "gone" });
      assert.match(call.reason, /deleted, transferred to another repo or converted to a discussion/);
    }
    const withdrawal = h.setup.store.boardItemsForTicket(ticket.id).at(-1)!.withdrawal!;
    assert.equal(withdrawal.reason, withdrawalReason(basis));
    assert.equal(withdrawal.callId, cancelCall(h, ticket.id).id);
    assert.deepEqual(h.forge.state.sends, NOTHING_SENT, "a gone issue has no label to remove and nothing to post on");
    assert.equal(h.forge.live.linked, 0, "a gone issue has no PRs here to read");
  });
}

test("an outside close withdraws the open board item: the board shows why and what happens next, and refuses an answer", async (t) => {
  const h = harness(t);
  const ticket = h.ticket(1, "on-the-board");
  const item = h.item(ticket.id)!;
  h.forge.update(1, { state: "closed" });
  await h.pass();

  const history = h.setup.store.boardItem(item.id)!;
  assert.equal(history.withdrawal?.reason, "Someone other than entail closed the issue.");
  assert.equal(history.withdrawal?.callId, cancelCall(h, ticket.id).id);
  assert.equal(h.setup.store.openBoardItem(ticket.id), null);

  const board = readBoard({ store: h.setup.store });
  assert.deepEqual(board.open, []);
  const entry = board.endedToday.find((e) => e.history.item.id === item.id)!;
  assert.equal(entry.status, "withdrawn");
  assert.equal(entry.next, "The ticket is cancelled, so nothing more is asked.");

  const answer = { shape: "dont-go-ahead" as const, optionId: null, text: null, note: null, showNoteOnIssue: false };
  const result = recordBoardAnswer(h.setup.store, { itemId: item.id, shownVersion: 1, answeredBy: "Ada", answer, locked: null });
  assert.deepEqual(result, { refused: { kind: "withdrawn", reason: "Someone other than entail closed the issue." } });
  assert.equal(h.setup.store.answerFor(item.id), null);
});

test("an issue gone from the repo is found by reading it live: once after each start, then again only after the recheck interval", async (t) => {
  const h = harness(t);
  const ticket = h.ticket(1, "cleared");
  await h.pass();
  assert.equal(h.forge.live.issue, 1, "read once after start");
  await h.pass(3);
  assert.equal(h.forge.live.issue, 1, "not read again before the interval");

  h.forge.gone.add(1);
  h.clock.now += ISSUE_RECHECK_MS - 1;
  await h.pass();
  assert.equal(h.get(ticket.id).state, "cleared");
  h.clock.now += 1;
  await h.pass();
  assert.equal(h.forge.live.issue, 2);
  assert.equal(h.get(ticket.id).state, "cancelled");
});

test("a close the change feed missed is found by the live read", async (t) => {
  const h = harness(t);
  const ticket = h.ticket(1, "investigating");
  await h.pass();
  // Closed, but its change is not reported, as after a lost cursor's re-scan has passed it.
  h.forge.issues = h.forge.issues.map((i) => (i.number === 1 ? { ...i, state: "closed" } : i));
  h.clock.now += ISSUE_RECHECK_MS;
  await h.pass();
  assert.equal(h.get(ticket.id).state, "cancelled");
  assert.deepEqual(cancelCall(h, ticket.id).detail, { issue: "closed" });
  assert.deepEqual(h.forge.state.labels[1], []);
});

for (const state of ["merged", "declined", "cancelled"] as const) {
  test(`a ${state} ticket is unaffected by its issue closing, being deleted or reopening`, async (t) => {
    const h = harness(t);
    const ticket = h.ticket(1, state);
    const calls = h.kinds(ticket.id);
    h.forge.update(1, { state: "closed" });
    await h.pass();
    h.forge.update(1, { state: "open" });
    await h.pass();
    h.forge.gone.add(1);
    h.clock.now += ISSUE_RECHECK_MS;
    await h.pass();
    assert.equal(h.get(ticket.id).state, state);
    assert.deepEqual(h.kinds(ticket.id), calls, "no call is recorded");
    assert.deepEqual(h.forge.state.sends, NOTHING_SENT);
    assert.equal(h.setup.store.successorOf(ticket.id), null);
  });
}

test("an issue closed because its PR merged is not cancelled: the merge ends the ticket", async (t) => {
  const h = harness(t, { followPullRequests: true });
  const ticket = h.ticket(1, "landing");
  await h.pass();
  h.forge.merged(12, 1);
  h.forge.update(1, { state: "closed" });
  await h.pass();
  assert.equal(h.get(ticket.id).state, "merged");
  assert.ok(!h.kinds(ticket.id).includes("cancel-on-outside-close"));
});

test("an issue closed while entail's own merge for the ticket is in flight is not cancelled", async (t) => {
  const h = harness(t);
  const ticket = h.ticket(1, "landing");
  h.forge.merged(12, 1);
  h.setup.store.recordForgeWriteIntent({ repoId: h.repo.id, ticketId: ticket.id, callId: null, kind: "merge", target: "pr", number: 12, payload: { sha: "head-12", method: "squash" } });
  h.forge.update(1, { state: "closed" });
  await h.pass();
  assert.equal(h.get(ticket.id).state, "landing", "left for the merge to record");
});

test("a PR merged for an earlier ticket of the issue does not stop an outside close cancelling the new one", async (t) => {
  const h = harness(t);
  h.forge.merged(12, 1);
  const first = h.ticket(1, "merged");
  const second = h.setup.store.takeIn({ repoId: h.repo.id, issueNumber: 1, predecessorId: first.id });
  h.setup.store.recordCall({ ticketId: second.id, kind: "criteria", reason: "Cleared for the test.", stateTo: "cleared" });
  // The first ticket's merge is recorded with its PR.
  const merged = h.setup.store.callsForTicket(first.id).find((c) => c.kind === "merged-by-others")!;
  assert.ok(merged);
  h.setup.store.recordForgeWriteIntent({ repoId: h.repo.id, ticketId: first.id, callId: merged.id, kind: "merge", target: "pr", number: 12, payload: { sha: "head-12", method: null } });
  h.forge.update(1, { state: "closed" });
  await h.pass();
  assert.equal(h.get(second.id).state, "cancelled");
});

test("reopening an issue, by anyone, starts nothing and posts nothing", async (t) => {
  const h = harness(t);
  // The owner's new issue, taken in on its own, then closed by someone else.
  h.forge.add(1);
  await h.pass();
  const ticket = h.setup.store.latestTicketForIssue(h.repo.id, 1)!;
  assert.equal(ticket.state, "deciding");
  h.forge.update(1, { state: "closed" });
  await h.pass();
  assert.equal(h.get(ticket.id).state, "cancelled");

  // Who reopened is never read: the forge reports only that the issue is open again.
  for (let round = 0; round < 2; round++) {
    h.forge.update(1, { state: "open" });
    await h.pass();
    h.forge.update(1, { state: "closed" });
    await h.pass();
  }
  h.forge.update(1, { state: "open" });
  h.clock.now += ISSUE_RECHECK_MS;
  await h.pass(2);
  assert.equal(h.setup.store.latestTicketForIssue(h.repo.id, 1)!.id, ticket.id, "no new ticket");
  assert.equal(h.get(ticket.id).state, "cancelled");
  assert.equal(h.kinds(ticket.id).filter((k) => k === "cancel-on-outside-close").length, 1);
  assert.deepEqual(h.forge.state.sends, NOTHING_SENT);
});

test("an issue closed and reopened between two passes cancels nothing", async (t) => {
  const h = harness(t);
  const ticket = h.ticket(1, "cleared");
  await h.pass();
  h.forge.update(1, { state: "closed" });
  h.forge.update(1, { state: "open" });
  h.clock.now += ISSUE_RECHECK_MS;
  await h.pass();
  assert.equal(h.get(ticket.id).state, "cleared");
  assert.deepEqual(h.forge.state.sends, NOTHING_SENT);
});

test("a label removal that fails is sent again when the close is read again, with no second cancel", async (t) => {
  const h = harness(t);
  const ticket = h.ticket(1, "cleared");
  await h.pass();
  let fail = true;
  const original = h.forge.removeLabel.bind(h.forge);
  h.forge.removeLabel = async (number, label) => {
    if (fail) throw new Error("the forge refused");
    return original(number, label);
  };
  h.forge.update(1, { state: "closed" });
  await h.pass();
  assert.equal(h.get(ticket.id).state, "cancelled", "the cancel is recorded before the write");
  assert.deepEqual(h.forge.state.labels[1], [CLEARED_LABEL]);

  // The failed pass backs the repo off; a restart reads the close again at once.
  fail = false;
  h.restart();
  await h.pass();
  assert.deepEqual(h.forge.state.labels[1], []);
  assert.equal(h.kinds(ticket.id).filter((k) => k === "cancel-on-outside-close").length, 1);
  const writes = h.setup.store.forgeWritesOn(h.repo.id, "issue", 1);
  assert.equal(writes.length, 1, "the one intent was resumed");
  assert.ok(writes[0]!.confirmed);
});

test("withdrawing gives each basis its reason, and does nothing for a ticket with no open item", (t) => {
  const setup = passSetup(t);
  const repo = setup.enroll();
  const { store } = setup;
  const ticket = store.takeIn({ repoId: repo.id, issueNumber: 1 });
  const raise = store.recordCall({ ticketId: ticket.id, kind: "raise", reason: "Raised.", stateTo: "on-the-board" });
  const item = store.raiseBoardItem({ ticketId: ticket.id, callId: raise.id, decision: "Go ahead?", whyRaised: "pin", snapshot: { version: 1 } });
  const back = store.recordCall({ ticketId: ticket.id, kind: "verdict", reason: "Decided again.", stateTo: "deciding" });
  const withdrawn = store.transaction(() => withdrawOpenItem(store, { ticketId: ticket.id, callId: back.id, basis: { kind: "issue-edited" } }));
  assert.equal(withdrawn?.id, item.id);
  assert.equal(store.boardItem(item.id)!.withdrawal!.reason, withdrawalReason({ kind: "issue-edited" }));
  assert.equal(withdrawOpenItem(store, { ticketId: ticket.id, callId: back.id, basis: { kind: "issue-edited" } }), null);

  const bases: WithdrawalBasis[] = [
    { kind: "issue-closed" },
    { kind: "issue-gone" },
    { kind: "issue-edited" },
    { kind: "vision-change" },
    { kind: "pin-change", pin: "src/**" },
    { kind: "new-push" },
    { kind: "repo-unenrolled" },
  ];
  const reasons = bases.map(withdrawalReason);
  assert.equal(new Set(reasons).size, bases.length, "each basis has its own reason");
  assert.match(withdrawalReason({ kind: "pin-change", pin: "src/**" }), /src\/\*\*/);
});
