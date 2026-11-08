import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import { assertCommentRules, markedTickets } from "../src/comment-rules.ts";
import type { Actor, ChangeBatch, PullRequest } from "../src/forge/forge.ts";
import { CLEARED_LABEL } from "../src/intake-comment.ts";
import { Passes } from "../src/pass.ts";
import { pullRequestFollowing, type MergedByOthersDetail, type PullRequestDetail } from "../src/pull-requests.ts";
import type { RepoSettings } from "../src/repo-settings.ts";
import type { RepoRecord, TicketRecord } from "../src/store.ts";
import type { TicketState } from "../src/ticket-states.ts";
import { actor, IntakeForge, issue, OWNER_ID, passSetup, STILL_HEAD, type PassSetup } from "./pass-fixture.ts";

const EXECUTOR = actor(2001, "executor");
const STRANGER = actor(2002, "stranger");

/** An IntakeForge that also has PRs, each linking the issues the forge's own data says it closes. */
class PullRequestForge extends IntakeForge {
  prs: PullRequest[] = [];
  readonly links = new Map<number, number[]>();
  #clock = Date.now();

  override async changesSince(): Promise<ChangeBatch> {
    const batch = await super.changesSince();
    return {
      changes: [...batch.changes, ...this.prs.map((pr) => ({ kind: "pull-request" as const, id: pr.id, updatedAt: pr.updatedAt, pullRequest: pr }))],
      cursor: batch.cursor,
    };
  }

  override async linkedPullRequests(issueNumber: number): Promise<PullRequest[]> {
    return this.prs.filter((pr) => this.links.get(pr.number)?.includes(issueNumber));
  }

  override async linkedIssues(pullRequestNumber: number): Promise<number[]> {
    return this.links.get(pullRequestNumber) ?? [];
  }

  /** Opens a PR linking `issues`, by `author`. */
  open(number: number, issues: number[], author: Actor = EXECUTOR): void {
    this.links.set(number, issues);
    this.prs.push({
      id: 7000 + number,
      number,
      title: `PR ${number}`,
      body: "",
      state: "open",
      draft: false,
      mergeable: null,
      conflicts: null,
      headSha: `head-${number}`,
      baseBranch: "main",
      author,
      createdAt: this.#tick(),
      updatedAt: this.#tick(),
      url: `https://github.com/acme/tally/pull/${number}`,
    });
  }

  /** Changes a PR, as the forge reports it changed. */
  update(number: number, fields: Partial<PullRequest>): void {
    this.prs = this.prs.map((pr) => (pr.number === number ? { ...pr, ...fields, updatedAt: this.#tick() } : pr));
  }

  /** The bodies of the comments posted on a PR. */
  prComments(number: number): string[] {
    return (this.state.comments[`pr:${number}`] ?? []).map((c) => c.body);
  }

  #tick(): string {
    this.#clock += 1000;
    return new Date(this.#clock).toISOString();
  }
}

interface Harness {
  setup: PassSetup;
  repo: RepoRecord;
  forge: PullRequestForge;
  /** Runs passes until every step started has finished. */
  pass(times?: number): Promise<void>;
  /** Starts entail afresh on the same store and forge, as after a restart. */
  restart(): void;
  /** Takes an issue in and moves its ticket to `state` with calls of the kinds that would. */
  ticket(issueNumber: number, state: TicketState, predecessorId?: number | null): TicketRecord;
  get(ticketId: number): TicketRecord;
  saveSettings(fields: Partial<RepoSettings>): void;
}

async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!done()) {
    if (performance.now() > deadline) assert.fail(`timed out waiting until ${what}`);
    await immediate();
  }
}

/** The calls that move a ticket from deciding to each state. */
const ROUTE: Record<TicketState, { kind: Parameters<PassSetup["store"]["recordCall"]>[0]["kind"]; to: TicketState }[]> = {
  deciding: [],
  investigating: [{ kind: "investigation", to: "investigating" }],
  "on-the-board": [{ kind: "raise", to: "on-the-board" }],
  cleared: [{ kind: "criteria", to: "cleared" }],
  landing: [
    { kind: "criteria", to: "cleared" },
    { kind: "pr-opened", to: "landing" },
  ],
  declined: [{ kind: "decline", to: "declined" }],
  cancelled: [{ kind: "cancel-on-outside-close", to: "cancelled" }],
  merged: [
    { kind: "criteria", to: "cleared" },
    { kind: "merged-by-others", to: "merged" },
  ],
};

function harness(t: TestContext): Harness {
  const setup = passSetup(t);
  const repo = setup.enroll();
  const forge = new PullRequestForge();
  let engine: Passes;
  const start = () => {
    const following = pullRequestFollowing({ store: setup.store, log: setup.log });
    engine = new Passes({
      store: setup.store,
      log: setup.log,
      dataDirectory: setup.dataDirectory,
      forgeFor: () => forge,
      defaultBranchFor: async () => STILL_HEAD,
      planners: [following.planner],
      changeHandlers: [following.onChange],
    });
    t.after(() => engine.stop());
  };
  start();
  return {
    setup,
    repo,
    forge,
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
    ticket(issueNumber, state, predecessorId = null) {
      const ticket = setup.store.takeIn({ repoId: repo.id, issueNumber, predecessorId });
      for (const step of ROUTE[state]) setup.store.recordCall({ ticketId: ticket.id, kind: step.kind, reason: `Moved to ${step.to} for the test.`, stateTo: step.to });
      return setup.store.getTicket(ticket.id)!;
    },
    get: (ticketId) => setup.store.getTicket(ticketId)!,
    saveSettings(fields) {
      const current = setup.store.latestSettings(repo.id)!.settings as RepoSettings;
      setup.store.saveSettings(repo.id, { ...current, ...fields }, "Ada");
    },
  };
}

function lastCall(h: Harness, ticketId: number) {
  return h.setup.store.callsForTicket(ticketId).at(-1)!;
}

test("a cleared ticket moves to landing when a linking PR opens, and back to cleared when it closes unmerged with no other PR open", async (t) => {
  const h = harness(t);
  const ticket = h.ticket(1, "cleared");
  await h.pass();
  assert.equal(h.get(ticket.id).state, "cleared", "no PR yet");

  h.forge.open(12, [1]);
  await h.pass();
  assert.equal(h.get(ticket.id).state, "landing");
  const landed = lastCall(h, ticket.id);
  assert.equal(landed.kind, "pr-opened");
  assert.deepEqual(landed.stateChange, { from: "cleared", to: "landing" });
  assert.deepEqual((landed.detail as PullRequestDetail).pullRequests, [12]);

  h.forge.open(13, [1]);
  h.forge.update(12, { state: "closed" });
  await h.pass();
  assert.equal(h.get(ticket.id).state, "landing", "another PR for it is still open");

  h.forge.update(13, { state: "closed" });
  await h.pass();
  assert.equal(h.get(ticket.id).state, "cleared");
  const back = lastCall(h, ticket.id);
  assert.equal(back.kind, "pr-closed");
  assert.deepEqual(back.stateChange, { from: "landing", to: "cleared" });
  assert.match(back.reason, /closed without merging/);

  // Moving between cleared and landing changes neither the label nor the issue, and posts nothing.
  assert.deepEqual(h.forge.state.sends, { comment: 0, addLabel: 0, removeLabel: 0, close: 0, merge: 0 });
  assert.deepEqual(h.forge.prComments(12), []);

  // A PR the forge does not link to the issue (one that only mentions it, or into another branch) is not its PR.
  h.forge.open(14, []);
  await h.pass();
  assert.equal(h.get(ticket.id).state, "cleared");
});

const MERGES: { name: string; state: TicketState; author: Actor; whoCounts?: RepoSettings["whoCounts"]; label: string | null }[] = [
  { name: "a landing ticket's PR merged by the owner, whether or not it would pass", state: "landing", author: EXECUTOR, label: CLEARED_LABEL },
  { name: "a cleared ticket's PR merged by someone else", state: "cleared", author: actor(OWNER_ID), label: CLEARED_LABEL },
  { name: "a PR from an account that does not count", state: "landing", author: STRANGER, whoCounts: "owner-and-listed", label: CLEARED_LABEL },
  { name: "a PR on an issue under investigation", state: "investigating", author: EXECUTOR, label: "entail:investigate" },
  { name: "a PR on an issue on the board", state: "on-the-board", author: EXECUTOR, label: null },
];

for (const merge of MERGES) {
  test(`a PR merged by anyone else records the ticket as merged, closing the issue and removing its label: ${merge.name}`, async (t) => {
    const h = harness(t);
    if (merge.whoCounts) h.saveSettings({ whoCounts: merge.whoCounts, executors: [] });
    const ticket = h.ticket(1, merge.state);
    h.forge.open(12, [1], merge.author);
    h.forge.update(12, { state: "merged" });
    await h.pass();

    const now = h.get(ticket.id);
    assert.equal(now.state, "merged");
    const call = lastCall(h, ticket.id);
    assert.equal(call.kind, "merged-by-others");
    assert.deepEqual(call.stateChange, { from: merge.state, to: "merged" });
    assert.equal(call.inputs?.prHeadSha, "head-12");
    assert.deepEqual((call.detail as MergedByOthersDetail).pullRequests, [12]);
    assert.equal(h.forge.state.closed[1], "completed", "entail closes the issue if the forge did not");
    assert.equal(h.forge.state.sends.removeLabel, merge.label === null ? 0 : 1);
    const writes = h.setup.store.forgeWritesForCall(call.id);
    assert.deepEqual(
      writes.map((w) => [w.kind, w.payload]),
      [["close", { reason: "completed" }], ...(merge.label === null ? [] : [["label", { action: "remove", label: merge.label }]])],
    );
    assert.deepEqual(h.forge.prComments(12), [], "no comment on a merged PR");
  });
}

test("a merged PR that belongs to the issue's earlier ticket, or merged before the ticket was taken in, does not record it as merged", async (t) => {
  const h = harness(t);
  h.forge.open(12, [1]);
  h.forge.update(12, { state: "merged" });
  const first = h.ticket(1, "cleared");
  await h.pass();
  assert.equal(h.get(first.id).state, "merged");

  // The owner reopens the issue and pulls it in again; the old PR is still the forge's merged PR for it.
  const second = h.ticket(1, "cleared", first.id);
  h.forge.update(12, { title: "PR 12, commented on later" });
  await h.pass();
  assert.equal(h.get(second.id).state, "cleared");

  // A PR merged before a ticket was taken in, and untouched since, is not that ticket's either.
  h.forge.open(20, [2]);
  h.forge.prs = h.forge.prs.map((pr) => (pr.number === 20 ? { ...pr, state: "merged", updatedAt: "2026-01-01T00:00:00.000Z" } : pr));
  const late = h.ticket(2, "cleared");
  await h.pass();
  assert.equal(h.get(late.id).state, "cleared");
});

for (const state of ["deciding", "investigating", "on-the-board"] as const) {
  test(`a PR linking an issue with no criteria in force (${state}) is not checked and gets one comment, never repeated across restarts`, async (t) => {
    const h = harness(t);
    const ticket = h.ticket(1, state);
    h.forge.open(12, [1]);
    await h.pass();

    assert.equal(h.get(ticket.id).state, state, "the ticket does not move");
    const [body, ...more] = h.forge.prComments(12);
    assert.ok(body);
    assert.deepEqual(more, []);
    assertCommentRules(body, "Ada", ticket.id);
    assert.deepEqual(markedTickets(body), [ticket.id]);
    assert.match(body, /This pull request links #1, which has no criteria in force yet/);
    assert.match(body, /does not check or merge this pull request/);

    h.forge.update(12, { body: "Pushed again." });
    await h.pass(2);
    h.restart();
    await h.pass();
    h.forge.update(12, { body: "And again." });
    await h.pass();
    assert.equal(h.forge.prComments(12).length, 1, "once per PR and ticket");

    h.forge.open(13, [1]);
    await h.pass();
    assert.equal(h.forge.prComments(13).length, 1, "another PR gets its own");
  });
}

test("a PR linking an issue whose latest ticket was declined or cancelled gets one comment naming the end state and linking the reason", async (t) => {
  const h = harness(t);
  const declined = h.ticket(1, "declined");
  // The decline's comment, as entail posted it.
  const declineCall = h.get(declined.id).stateCallId!;
  const intent = h.setup.store.recordForgeWriteIntent({ repoId: h.repo.id, ticketId: declined.id, callId: declineCall, kind: "comment", target: "issue", number: 1, payload: { body: "declined" } });
  const reasonUrl = "https://github.com/acme/tally/issues/1#issuecomment-555";
  h.setup.store.confirmForgeWrite({ intentId: intent.id, comment: { id: "555", url: reasonUrl } });
  const cancelled = h.ticket(2, "cancelled");
  h.ticket(3, "merged");

  h.forge.open(12, [1]);
  h.forge.open(13, [2]);
  h.forge.open(14, [3]);
  await h.pass();

  const [onDeclined, ...moreDeclined] = h.forge.prComments(12);
  assert.ok(onDeclined);
  assert.deepEqual(moreDeclined, []);
  assertCommentRules(onDeclined, "Ada", declined.id);
  assert.match(onDeclined, /This pull request links #1, whose ticket was declined \(see \[the comment that gave the reason\]\(https:\/\/github\.com\/acme\/tally\/issues\/1#issuecomment-555\)\)\./);
  assert.match(onDeclined, /no criteria in force, so entail does not check or merge this pull request, unless the owner pulls the issue in again and it is cleared/);

  const [onCancelled] = h.forge.prComments(13);
  assert.ok(onCancelled);
  assertCommentRules(onCancelled, "Ada", cancelled.id);
  assert.match(onCancelled, /This pull request links #2, whose ticket was cancelled\./, "no comment gave the reason for an outside close");

  assert.deepEqual(h.forge.prComments(14), [], "a merged ticket's PRs get the \"already merged\" comment instead");

  h.forge.update(12, { body: "Pushed again." });
  h.restart();
  await h.pass(2);
  assert.equal(h.forge.prComments(12).length, 1, "once per PR and ticket, across restarts");
  assert.equal(h.forge.prComments(13).length, 1);

  // Pulled in again and cleared, the PR links the new ticket and is followed for it.
  const again = h.ticket(1, "cleared", declined.id);
  h.forge.update(12, { body: "Still here." });
  await h.pass();
  assert.equal(h.get(again.id).state, "landing");
  assert.equal(h.forge.prComments(12).length, 1);
});

test("under owner plus listed executors another account's PR is not checked and gets one comment, and tightening comments on each newly excluded PR", async (t) => {
  const h = harness(t);
  const ticket = h.ticket(1, "cleared");
  h.forge.open(12, [1], EXECUTOR);
  h.forge.open(13, [1], STRANGER);
  await h.pass();
  assert.equal(h.get(ticket.id).state, "landing", "anyone counts by default");
  assert.deepEqual(h.forge.prComments(12), []);
  assert.deepEqual(h.forge.prComments(13), []);

  h.saveSettings({ whoCounts: "owner-and-listed", executors: [EXECUTOR] });
  await h.pass();
  assert.equal(h.get(ticket.id).state, "landing", "the listed executor's PR is still open");
  assert.deepEqual(h.forge.prComments(12), []);
  const [excluded] = h.forge.prComments(13);
  assert.ok(excluded);
  assertCommentRules(excluded, "Ada", ticket.id);
  assert.match(excluded, /this repo lands work only from its executors/);
  assert.doesNotMatch(excluded, /no criteria/);

  h.saveSettings({ whoCounts: "owner-and-listed", executors: [] });
  await h.pass(2);
  assert.equal(h.forge.prComments(12).length, 1, "the newly excluded PR gets the comment");
  assert.equal(h.forge.prComments(13).length, 1, "and the one excluded before does not get it again");
  assert.equal(h.get(ticket.id).state, "cleared", "no PR from an account that counts is open");
  assert.match(lastCall(h, ticket.id).reason, /from an account that does not count/);

  h.forge.open(15, [1], actor(OWNER_ID));
  await h.pass();
  assert.equal(h.get(ticket.id).state, "landing", "the owner always counts");
  assert.deepEqual(h.forge.prComments(15), []);

  // On an issue with no criteria in force, such a PR gets only the not-counted comment.
  const deciding = h.ticket(2, "deciding");
  const ended = h.ticket(3, "declined");
  h.forge.open(16, [2], STRANGER);
  h.forge.open(17, [3], STRANGER);
  await h.pass();
  for (const [pr, id] of [
    [16, deciding.id],
    [17, ended.id],
  ] as const) {
    const bodies = h.forge.prComments(pr);
    assert.equal(bodies.length, 1);
    assertCommentRules(bodies[0]!, "Ada", id);
    assert.match(bodies[0]!, /lands work only from its executors/);
  }
});

test("labels and assignment set by others are ignored: entail works from its records and the forge's links alone", async (t) => {
  const h = harness(t);
  // Someone else labels an issue entail never took in, and opens a PR for it.
  h.forge.issues = [issue(5, { author: STRANGER, labels: [CLEARED_LABEL] })];
  h.forge.open(15, [5]);
  // Someone else removes the label from a cleared issue.
  const ticket = h.ticket(1, "cleared");
  h.forge.issues.push(issue(1, { labels: [] }));
  h.forge.open(12, [1]);
  await h.pass(2);

  assert.equal(h.setup.store.latestTicketForIssue(h.repo.id, 5), null, "a label starts nothing");
  assert.deepEqual(h.forge.prComments(15), [], "and gets no comment");
  assert.equal(h.get(ticket.id).state, "landing", "a cleared ticket lands whatever labels the issue carries");
  assert.deepEqual(h.forge.state.sends, { comment: 0, addLabel: 0, removeLabel: 0, close: 0, merge: 0 }, "and entail does not put its label back");
});
