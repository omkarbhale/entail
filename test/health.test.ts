import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { hiddenMarker } from "../src/comment-rules.ts";
import { ForgeLoggedOutError, type Actor } from "../src/forge/forge.ts";
import { DEFAULT_GLOBAL_SETTINGS } from "../src/global-settings.ts";
import { Health, readStatusFile, STATUS_FILE, type HealthCondition } from "../src/health.ts";
import type { LockTakeover } from "../src/lock.ts";
import type { ModelRunRequest } from "../src/model-runner.ts";
import { ModelRuns } from "../src/model-runs.ts";
import { makeNotice, Notifier, type Notice, type NoticeConnector } from "../src/notice.ts";
import { Passes, VISION_HALTED_STEPS, type OwedStep, type PassesOptions } from "../src/pass.ts";
import { RecordsCheck } from "../src/records-check.ts";
import { exportRecords } from "../src/records.ts";
import { RECORDS_PUSH_FILE } from "../src/records-repo.ts";
import { object, string } from "../src/schema.ts";
import { ScriptedRunner } from "../src/scripted-runner.ts";
import type { ToolProblem } from "../src/tool-check.ts";
import { actor, IntakeForge, issue, issueComment, OWNER_ID, passSetup, STILL_HEAD, type PassSetup } from "./pass-fixture.ts";

const START = Date.parse("2026-11-09T09:00:00.000Z");
const REPOS_LINK = "http://127.0.0.1:7419/repos";
const MINUTE = 60_000;

/** A forge whose login and polls a test sets. */
class HealthForge extends IntakeForge {
  /** What the CLI reports as logged in: an account, none, or an error. */
  login: Actor | null | Error = actor(OWNER_ID);
  /** Thrown by every read of changes while set. */
  down: Error | null = null;

  override async currentActor(): Promise<Actor | null> {
    if (this.login instanceof Error) throw this.login;
    return this.login;
  }

  override async changesSince() {
    if (this.down) {
      this.reads.changes++;
      throw this.down;
    }
    return super.changesSince();
  }
}

/** A notice connector that keeps what it was handed, or fails while told to. */
class RecordingConnector implements NoticeConnector {
  readonly name = "file";
  readonly sent: Notice[] = [];
  failing: Error | null = null;
  async send(notice: Notice): Promise<void> {
    if (this.failing) throw this.failing;
    this.sent.push(notice);
  }
}

interface Fixture {
  setup: PassSetup;
  forge: HealthForge;
  passes: Passes;
  modelRuns: ModelRuns;
  runner: ScriptedRunner;
  recordsCheck: RecordsCheck;
  connector: RecordingConnector;
  notifier: Notifier;
  health: Health;
  /** What the tool check finds; none by default. */
  tools: ToolProblem[];
  /** What VISION.md is at the head a poll sees: present, gone, or unreadable. */
  vision: boolean | null;
  /** Evaluates health and returns the keys of the conditions now. */
  keys(): Promise<string[]>;
  condition(key: string): HealthCondition | undefined;
}

function fixture(t: TestContext, options: { takeover?: LockTakeover | null; passes?: Partial<PassesOptions>; mockTime?: boolean } = {}): Fixture {
  if (options.mockTime !== false) t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: START });
  const setup = passSetup(t);
  setup.enroll();
  const forge = new HealthForge();
  const runner = new ScriptedRunner();
  const modelRuns = new ModelRuns({ runner, log: setup.log });
  // The temp directory, and the log in it, may be gone by then.
  t.after(() => modelRuns.stop().catch(() => undefined));
  const recordsCheck = new RecordsCheck({ store: setup.store, forgeFor: () => forge, log: setup.log });
  const connector = new RecordingConnector();
  const notifier = new Notifier({ connectorName: () => "file", connectors: { file: connector }, dataDirectory: setup.dataDirectory, log: setup.log });
  const f = { tools: [] as ToolProblem[], vision: true as boolean | null };
  const passes = new Passes({
    store: setup.store,
    log: setup.log,
    dataDirectory: setup.dataDirectory,
    forgeFor: () => forge,
    defaultBranchFor: async () => STILL_HEAD,
    modelRuns,
    recordsCheck,
    toolCheck: async () => f.tools,
    checkHostLogins: true,
    visionPresent: async () => f.vision,
    ...options.passes,
  });
  const health = new Health({
    store: setup.store,
    dataDirectory: setup.dataDirectory,
    log: setup.log,
    lock: { holder: { pid: 4242, startedAt: new Date(START).toISOString() }, takeover: options.takeover ?? null },
    passes,
    modelRuns,
    recordsCheck,
    notifier,
    reposLink: () => REPOS_LINK,
  });
  return Object.assign(f, {
    setup,
    forge,
    passes,
    modelRuns,
    runner,
    recordsCheck,
    connector,
    notifier,
    health,
    keys: async () => (await health.evaluate()).map((c) => c.key),
    condition: (key: string) => health.conditions().find((c) => c.key === key),
  });
}

const greeting = object({ greeting: string() });

function request(ticket: string): ModelRunRequest {
  return { kind: "verdict", ticket, prompt: "p", promptVersion: "v1", schema: greeting, checkout: "/c", sha: "a".repeat(40), model: "claude-opus-5-5" };
}

/** Lets promise callbacks run without moving the mocked clock. */
async function settle(): Promise<void> {
  for (let n = 0; n < 10; n++) await new Promise((resolve) => setImmediate(resolve));
}

test("git or claude missing or logged out halts all of entail: no forge read and no model run, until a pass's check finds it fine", async (t) => {
  const f = fixture(t);
  f.tools = [{ tool: "claude", problem: "logged-out", detail: "claude auth status reports no login" }];
  f.runner.script("verdict", "t1", { output: { greeting: "hi" } });

  const outcomes = await f.passes.runPass();
  assert.deepEqual(outcomes.map((o) => o.outcome), ["halted"]);
  assert.equal(f.forge.reads.changes, 0, "no forge read");
  const run = f.modelRuns.run(request("t1"), { priority: "intake", since: new Date(START).toISOString() });
  await settle();
  assert.equal(f.runner.requests.length, 0, "no model run starts");

  assert.deepEqual(await f.keys(), ["entail:claude"]);
  const halt = f.condition("entail:claude")!;
  assert.equal(halt.kind, "halt");
  assert.equal(halt.wrong, "claude is not logged in");
  assert.match(halt.stops, /Nothing is read, decided or merged/);
  assert.equal(f.connector.sent.length, 1, "one health notice when the halt begins");
  assert.deepEqual({ ...f.connector.sent[0] }, { kind: "health", text: "claude is not logged in", repo: null, link: REPOS_LINK });

  t.mock.timers.tick(MINUTE);
  await f.passes.runPass();
  assert.deepEqual(await f.keys(), ["entail:claude"]);
  assert.equal(halt.since, f.condition("entail:claude")!.since, "the onset is kept while it lasts");
  assert.equal(f.connector.sent.length, 1, "the notice does not repeat while the halt lasts");

  f.tools = [];
  const [outcome] = await f.passes.runPass();
  assert.equal(outcome?.outcome, "polled", "work resumes by itself");
  assert.deepEqual(await f.keys(), []);
  assert.equal(f.connector.sent.length, 1, "nothing is sent when it clears");
  await run;
  assert.equal(f.runner.requests.length, 1, "held model work goes once the halt clears");
});

test("git missing is its own halt, naming what the check saw", async (t) => {
  const f = fixture(t);
  f.tools = [{ tool: "git", problem: "missing", detail: "git is not installed or not on the PATH" }];
  await f.passes.runPass();
  assert.deepEqual(await f.keys(), ["entail:git"]);
  assert.equal(f.condition("entail:git")!.wrong, "git is not installed or not on the PATH");
  assert.equal(f.connector.sent.length, 1);
});

test("claude refusing a run for want of a login halts model work until a pass's check finds it logged in", async (t) => {
  const f = fixture(t);
  f.runner.script("verdict", "t1", { failure: { kind: "logged-out", message: "claude is not logged in: Please run /login" } }, { output: { greeting: "hi" } });
  const run = f.modelRuns.run(request("t1"), { priority: "intake", since: new Date(START).toISOString() });
  await settle();
  assert.equal(f.runner.requests.length, 1);
  assert.deepEqual(await f.keys(), ["entail:claude"]);
  assert.equal(f.modelRuns.retryState("t1"), null, "it is not the ticket's failure, retried forever");
  assert.equal(f.connector.sent.length, 1);

  f.tools = [];
  await f.passes.runPass();
  await run;
  assert.equal(f.runner.requests.length, 2, "the run goes again once the check passes");
  assert.deepEqual(await f.keys(), []);
});

test("the usage limit halts model work until the reset claude reported, or 30 minutes, and never notifies", async (t) => {
  const f = fixture(t);
  f.runner.script("verdict", "t1", { failure: { kind: "usage-limit", message: "limit reached" } }, { output: { greeting: "hi" } });
  const run = f.modelRuns.run(request("t1"), { priority: "intake", since: new Date(START).toISOString() });
  await settle();
  assert.deepEqual(await f.keys(), ["model:usage-limit"]);
  const halt = f.condition("model:usage-limit")!;
  assert.deepEqual([halt.kind, halt.since, halt.stops], ["halt", new Date(START).toISOString(), "No model run starts"]);
  assert.match(halt.clears, /2026-11-09 09:30 UTC/);

  t.mock.timers.tick(29 * MINUTE);
  assert.deepEqual(await f.keys(), ["model:usage-limit"]);
  t.mock.timers.tick(MINUTE);
  await run;
  assert.deepEqual(await f.keys(), []);
  assert.equal(f.connector.sent.length, 0, "a wait that clears on its own never notifies");
});

test("a host's CLI logged out, or logged in as another account, halts its repos until a pass's check passes", async (t) => {
  const f = fixture(t);
  f.forge.login = null;
  const [loggedOut] = await f.passes.runPass();
  assert.deepEqual(loggedOut, { repoId: 1, outcome: "halted", why: "host" });
  assert.equal(f.forge.reads.changes, 0, "the halted host's repos are not read");
  assert.ok(f.passes.hostHalted("github.com"), "the board locks its items");
  assert.deepEqual(await f.keys(), ["host:github:github.com:logged-out"]);
  assert.equal(f.condition("host:github:github.com:logged-out")!.wrong, "gh is not logged in to github.com");
  assert.equal(f.connector.sent.length, 1);

  f.forge.login = actor(2002, "someone");
  await f.passes.runPass();
  assert.deepEqual(await f.keys(), ["host:github:github.com:other-account"]);
  assert.match(f.condition("host:github:github.com:other-account")!.wrong, /logged in to github\.com as someone, not owner/);
  assert.equal(f.connector.sent.length, 2, "another account is a new halt, with its own notice");

  f.forge.login = new ForgeLoggedOutError("github.com", "token expired");
  await f.passes.runPass();
  assert.deepEqual(await f.keys(), ["host:github:github.com:logged-out"]);

  f.forge.login = actor(OWNER_ID);
  f.forge.down = new Error("connect ETIMEDOUT");
  await f.passes.runPass();
  assert.ok(f.passes.hostHalted("github.com"), "the board stays locked until a poll has caught up");
  assert.deepEqual(await f.keys(), ["host:github:github.com:logged-out"]);

  f.forge.down = null;
  t.mock.timers.tick(MINUTE);
  const [polled] = await f.passes.runPass();
  assert.equal(polled?.outcome, "polled");
  assert.ok(!f.passes.hostHalted("github.com"));
  assert.deepEqual(await f.keys(), []);
  assert.equal(f.connector.sent.length, 3, "nothing is sent when it clears");
});

test("a repo failing to poll is only logged below 15 minutes, warned from 15, and its host halted at an hour until a poll succeeds", async (t) => {
  const f = fixture(t);
  f.forge.down = new Error("connect ETIMEDOUT");
  const poll = async (minutes: number) => {
    t.mock.timers.tick(minutes * MINUTE);
    await f.passes.runPass();
    return f.keys();
  };
  assert.deepEqual(await poll(0), []);
  assert.deepEqual(await poll(14), [], "ordinary network noise is only logged");
  assert.deepEqual(await poll(1), ["repo:1:polling"]);
  const warning = f.condition("repo:1:polling")!;
  assert.deepEqual([warning.kind, warning.since], ["warning", new Date(START).toISOString()]);
  assert.match(warning.wrong, /acme\/tally on github\.com has failed to poll: connect ETIMEDOUT/);
  assert.equal(f.connector.sent.length, 0);
  assert.ok(!f.passes.hostHalted("github.com"));

  assert.deepEqual(await poll(44), ["repo:1:polling"]);
  assert.deepEqual(await poll(1), ["host:github:github.com:unanswered"], "at an hour it becomes the host's halt");
  const halt = f.condition("host:github:github.com:unanswered")!;
  assert.deepEqual([halt.since, halt.wrong, halt.stops], [new Date(START).toISOString(), "github.com is not answering", "1 repo is not being read"]);
  assert.ok(f.passes.hostHalted("github.com"));
  assert.equal(f.connector.sent.length, 1, "the owner is told: a VPN or token may need fixing");

  f.forge.down = null;
  assert.deepEqual(await poll(15), []);
  assert.ok(!f.passes.hostHalted("github.com"));
  assert.equal(f.connector.sent.length, 1);
});

test("marked issues with no records halt the repo until the owner confirms a fresh start", async (t) => {
  const f = fixture(t);
  f.forge.commentChanges = [issueComment(8001, 3, actor(OWNER_ID), `Speaking from Ada's entail:\n\nTaken in.\n\n${hiddenMarker(77)}`)];
  const [outcome] = await f.passes.runPass();
  assert.equal(outcome?.outcome, "waiting-for-records");
  assert.deepEqual(await f.keys(), ["repo:1:records"]);
  assert.match(f.condition("repo:1:records")!.clears, /Restore the records with entail restore, or confirm a fresh start/);
  assert.deepEqual({ ...f.connector.sent[0] }, { kind: "health", text: "acme/tally on github.com has issues marked by entail with no records behind them", repo: "acme/tally", link: REPOS_LINK });

  f.recordsCheck.confirmFreshStart(1, "Ada");
  assert.deepEqual(await f.keys(), []);
  assert.equal(f.connector.sent.length, 1);
});

test("a vanished VISION.md halts the repo until a vision is back", async (t) => {
  const f = fixture(t);
  f.vision = false;
  await f.passes.runPass();
  assert.deepEqual(await f.keys(), ["repo:1:vision"]);
  assert.equal(f.condition("repo:1:vision")!.wrong, "VISION.md in acme/tally on github.com is gone or empty");
  assert.equal(f.connector.sent.length, 1);

  f.vision = null;
  await f.passes.runPass();
  assert.deepEqual(await f.keys(), ["repo:1:vision"], "a head that cannot be read changes nothing");
});

test("a vanished vision holds deciding and landing in its repo, and a vision back at a new head clears it", async (t) => {
  const f = fixture(t);
  f.forge.issues = [issue(4)];
  let head = "c0ffee";
  let present = false;
  const started: string[] = [];
  const verdict = (): OwedStep => ({ name: "verdict", run: async () => void started.push("verdict") });
  const passes = new Passes({
    store: f.setup.store,
    log: f.setup.log,
    dataDirectory: f.setup.dataDirectory,
    forgeFor: () => f.forge,
    defaultBranchFor: async () => ({ updateDefaultBranch: async () => ({ branch: "main", commit: head, fetched: true }) }),
    visionPresent: async () => present,
    planners: [verdict],
  });
  await passes.runPass();
  await settle();
  assert.equal(passes.visionGoneSince(1), new Date(START).toISOString());
  assert.deepEqual(started, [], "nothing new is decided");
  present = true;
  await passes.runPass();
  assert.notEqual(passes.visionGoneSince(1), null, "an unmoved head is not read again");
  head = "beef";
  await passes.runPass();
  await settle();
  assert.equal(passes.visionGoneSince(1), null);
  assert.deepEqual(started, ["verdict"], "the held step starts once the vision is back");
  assert.deepEqual(
    [...VISION_HALTED_STEPS],
    ["verdict", "findings", "criteria", "landing-check", "merge", "re-check", "withdraw-for-vision-change", "withdraw-for-pin-change"],
    "deciding, writing criteria, re-checking and landing are held",
  );
});

test("no records push succeeding for 24 hours while a remote is set is warned, with one notice", async (t) => {
  const f = fixture(t);
  const since = new Date(START - 24 * 60 * MINUTE).toISOString();
  writeFileSync(
    join(f.setup.dataDirectory, RECORDS_PUSH_FILE),
    JSON.stringify({ lastSuccess: null, lastFailure: { at: new Date(START).toISOString(), remote: "git@example.org:r.git", error: "Connection refused", since } }),
  );
  assert.deepEqual(await f.keys(), [], "no remote is set: the copy may stay local on purpose");
  assert.deepEqual(readStatusFile(f.setup.dataDirectory)?.standing, ["Records repo: no remote set. Records stay on this machine only."]);

  f.setup.store.saveGlobalSettings({ ...DEFAULT_GLOBAL_SETTINGS, ownerDisplayName: "Ada", recordsRemote: "git@example.org:r.git" }, "Ada");
  assert.deepEqual(await f.keys(), ["records:push"]);
  const warning = f.condition("records:push")!;
  assert.deepEqual([warning.kind, warning.since], ["warning", since]);
  assert.match(warning.clears, /Connection refused/);
  assert.equal(f.connector.sent.length, 1);
  assert.deepEqual(readStatusFile(f.setup.dataDirectory)?.standing, []);
});

test("a ticket's model step failing for an hour, or every run for 15 minutes, is warned with a count and the last error, never the tickets", async (t) => {
  const f = fixture(t);
  f.runner.script("verdict", "ticket-41", ...Array.from({ length: 20 }, () => ({ failure: { kind: "error" as const, message: "API Error: 500 overloaded" } })));
  void f.modelRuns.run(request("ticket-41"), { priority: "intake", since: new Date(START).toISOString() }).catch(() => undefined);
  await settle();
  assert.deepEqual(await f.keys(), []);

  // Retries after 1, 2, 4 and 8 minutes: every run has now failed for 15 minutes.
  for (const minutes of [1, 2, 4, 8]) {
    t.mock.timers.tick(minutes * MINUTE);
    await settle();
  }
  assert.deepEqual(await f.keys(), ["model:failing"]);
  assert.equal(f.condition("model:failing")!.wrong, "Every model run has failed for 15 minutes or more");

  for (const minutes of [16, 30]) {
    t.mock.timers.tick(minutes * MINUTE);
    await settle();
  }
  assert.deepEqual(await f.keys(), ["model:failing"]);
  const warning = f.condition("model:failing")!;
  assert.match(warning.clears, /overloaded/);
  assert.ok(![warning.wrong, warning.stops, warning.clears].some((text) => text.includes("ticket-41")), "never which tickets wait");
  assert.equal(f.connector.sent.length, 0);
});

test("one ticket failing for an hour while other runs succeed is counted", async (t) => {
  const f = fixture(t);
  f.runner.script("verdict", "a", ...Array.from({ length: 10 }, () => ({ failure: { kind: "timeout" as const, message: "the run did not finish" } })));
  f.runner.script("verdict", "b", { output: { greeting: "hi" } });
  void f.modelRuns.run(request("a"), { priority: "intake", since: new Date(START).toISOString() }).catch(() => undefined);
  await settle();
  // Retries after 1, 2, 4, 8, 16 and 30 minutes: failing for an hour in a row.
  for (const minutes of [1, 2, 4, 8, 16, 30]) {
    t.mock.timers.tick(minutes * MINUTE);
    await settle();
  }
  await f.modelRuns.run(request("b"), { priority: "intake", since: new Date(START).toISOString() });
  assert.deepEqual(await f.keys(), ["model:failing"]);
  assert.equal(f.condition("model:failing")!.wrong, "1 ticket's model step has failed for an hour or more");
});

test("the last notice failing is warned where the owner looks, until a notice goes through", async (t) => {
  const f = fixture(t);
  f.connector.failing = new Error("notify-send failed: no display");
  f.vision = false;
  await f.passes.runPass();
  assert.deepEqual(await f.keys(), ["repo:1:vision"]);
  assert.deepEqual(await f.keys(), ["repo:1:vision", "notices:failed"]);
  assert.equal(f.condition("notices:failed")!.wrong, "The last file notice failed: notify-send failed: no display");

  f.connector.failing = null;
  assert.equal(await f.notifier.notify(makeNotice({ kind: "board-item", text: "A decision is waiting", repo: "acme/tally", link: REPOS_LINK })), true);
  assert.deepEqual(await f.keys(), ["repo:1:vision"]);
});

test("an unexpected stop is warned until the end of its day", async (t) => {
  const detectedAt = new Date(START).toISOString();
  const f = fixture(t, { takeover: { previous: { pid: 11, startedAt: "2026-11-09T08:00:00.000Z" }, detectedAt } });
  assert.deepEqual(await f.keys(), ["entail:unexpected-stop"]);
  assert.match(f.condition("entail:unexpected-stop")!.wrong, /^entail restarted after an unexpected stop at 2026-11-09 09:00 UTC$/);
  assert.equal(await f.health.noticeKeepsStopping(), false, "one stop is not entail that keeps stopping");
  t.mock.timers.tick(2 * 24 * 60 * MINUTE);
  assert.deepEqual(await f.keys(), []);
  assert.equal(f.connector.sent.length, 0);
});

test("three unexpected stops within 10 minutes send one notice, entail keeps stopping", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: START });
  const setup = passSetup(t);
  const connector = new RecordingConnector();
  const notifier = new Notifier({ connectorName: () => "file", connectors: { file: connector }, dataDirectory: setup.dataDirectory, log: setup.log });
  const start = (minutes: number) => {
    t.mock.timers.setTime(START + minutes * MINUTE);
    const at = new Date().toISOString();
    return new Health({
      store: setup.store,
      dataDirectory: setup.dataDirectory,
      log: setup.log,
      lock: { holder: { pid: 100 + minutes, startedAt: at }, takeover: { previous: null, detectedAt: at } },
      notifier,
      reposLink: () => REPOS_LINK,
    });
  };
  for (const minutes of [0, 4]) {
    const health = start(minutes);
    await health.evaluate();
    assert.equal(await health.noticeKeepsStopping(), false);
  }
  const third = start(8);
  await third.evaluate();
  assert.equal(await third.noticeKeepsStopping(), true);
  assert.deepEqual(connector.sent.map((notice) => notice.text), ["entail keeps stopping: 3 unexpected stops within 10 minutes"]);
  const fourth = start(9);
  await fourth.evaluate();
  assert.equal(await fourth.noticeKeepsStopping(), false, "one notice for one run of stops");
  assert.equal(readStatusFile(setup.dataDirectory)?.unexpectedStops.length, 4);
});

test("a halt carried over a restart keeps its onset and sends no second notice", async (t) => {
  const f = fixture(t);
  f.vision = false;
  await f.passes.runPass();
  await f.keys();
  assert.equal(f.connector.sent.length, 1);

  t.mock.timers.tick(10 * MINUTE);
  const passes = new Passes({
    store: f.setup.store,
    log: f.setup.log,
    dataDirectory: f.setup.dataDirectory,
    forgeFor: () => f.forge,
    defaultBranchFor: async () => STILL_HEAD,
    visionPresent: async () => false,
  });
  const again = new Health({
    store: f.setup.store,
    dataDirectory: f.setup.dataDirectory,
    log: f.setup.log,
    lock: { holder: { pid: 4243, startedAt: new Date().toISOString() }, takeover: null },
    passes,
    notifier: f.notifier,
    reposLink: () => REPOS_LINK,
  });
  await passes.runPass();
  const [halt] = await again.evaluate();
  assert.equal(halt?.key, "repo:1:vision");
  assert.equal(halt.since, new Date(START).toISOString());
  assert.equal(f.connector.sent.length, 1);
});

test("the status file holds the running state, every condition, each repo's state and last successful poll", async (t) => {
  const f = fixture(t);
  f.vision = false;
  await f.passes.runPass();
  t.mock.timers.tick(MINUTE);
  await f.passes.runPass();
  await f.keys();
  const status = readStatusFile(f.setup.dataDirectory)!;
  assert.equal(status.pid, 4242);
  assert.equal(status.lastPass, new Date(START + MINUTE).toISOString());
  assert.deepEqual(status.conditions.map((c) => c.key), ["repo:1:vision"]);
  assert.deepEqual(status.repos, [
    { id: 1, forge: "github", host: "github.com", path: "acme/tally", state: "halted: no vision", lastSuccessfulPoll: new Date(START + MINUTE).toISOString() },
  ]);
});

test("health never reaches the forge, the board or the records", async (t) => {
  const f = fixture(t, { takeover: { previous: null, detectedAt: new Date(START).toISOString() } });
  f.forge.commentChanges = [issueComment(8001, 3, actor(OWNER_ID), `Speaking from Ada's entail:\n\nTaken in.\n\n${hiddenMarker(77)}`)];
  const before = exportRecords(f.setup.store.path);
  await f.passes.runPass();
  f.tools = [{ tool: "git", problem: "missing", detail: "git is not installed or not on the PATH" }];
  await f.passes.runPass();
  const conditions = await f.health.evaluate();
  assert.ok(conditions.length >= 3, "several halts and warnings at once");
  assert.deepEqual(f.forge.state.sends, { comment: 0, addLabel: 0, removeLabel: 0, close: 0, merge: 0 });
  assert.deepEqual(exportRecords(f.setup.store.path), before, "no record, call or board item is written");
  assert.ok(f.connector.sent.every((notice) => notice.kind === "health"));
  assert.ok(readStatusFile(f.setup.dataDirectory) !== null, `the status file ${STATUS_FILE} holds them instead`);
});
