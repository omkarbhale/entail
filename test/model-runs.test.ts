import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import type { ModelRunner, ModelRunRequest, ModelRunResult, RunKind, RunOptions } from "../src/model-runner.ts";
import {
  MODEL_RUN_PRIORITIES,
  modelRunRecord,
  ModelRuns,
  ModelRunsStoppedError,
  RETRY_MAX_MS,
  retryDelay,
  USAGE_LIMIT_PAUSE_MS,
  type ModelRunPriority,
} from "../src/model-runs.ts";
import { OperationalLog } from "../src/operational-log.ts";
import { Passes, type OwedStepPlanner } from "../src/pass.ts";
import { object, string } from "../src/schema.ts";
import { ScriptedRunner } from "../src/scripted-runner.ts";
import { tempDirectory } from "./git-fixture.ts";
import { IntakeForge, issue, passSetup, STILL_HEAD, type PassSetup } from "./pass-fixture.ts";

const MINUTE = 60_000;
const NOW = Date.parse("2026-11-08T13:00:00Z");
const greetingSchema = object({ greeting: string() });
type Greeting = { greeting: string };

function request(kind: RunKind, ticket: string | null): ModelRunRequest<Greeting> {
  return { kind, ticket, prompt: `${kind} for ${ticket}`, promptVersion: "v1", schema: greetingSchema, checkout: "/checkout", sha: "a".repeat(40), model: "claude-opus-5-5" };
}

function schedule(priority: ModelRunPriority = "intake", since = "2026-11-08T12:00:00Z") {
  return { priority, since };
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Lets every settled promise run its callbacks; not mocked by `t.mock.timers` with the APIs these tests mock. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await immediate();
}

function logFor(t: TestContext): { log: OperationalLog; lines(event?: string): Record<string, unknown>[] } {
  const raw: string[] = [];
  const log = new OperationalLog(tempDirectory(t, "model-runs"), { echo: (line) => raw.push(line) });
  return {
    log,
    lines: (event) => raw.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => event === undefined || line.event === event),
  };
}

/** Wraps a runner to count the runs in flight, and the most there ever were. */
class CountingRunner implements ModelRunner {
  current = 0;
  peak = 0;
  readonly perTicket = new Map<string | null, number>();
  peakPerTicket = 0;
  readonly inner: ModelRunner;
  constructor(inner: ModelRunner) {
    this.inner = inner;
  }

  async run<T>(request: ModelRunRequest<T>, options?: RunOptions): Promise<ModelRunResult<T>> {
    this.current++;
    this.peak = Math.max(this.peak, this.current);
    const onTicket = (this.perTicket.get(request.ticket) ?? 0) + 1;
    this.perTicket.set(request.ticket, onTicket);
    this.peakPerTicket = Math.max(this.peakPerTicket, onTicket);
    try {
      return await this.inner.run(request, options);
    } finally {
      this.current--;
      this.perTicket.set(request.ticket, this.perTicket.get(request.ticket)! - 1);
    }
  }
}

test("concurrency never exceeds the global limit, read again before each run starts", async (t) => {
  const { log } = logFor(t);
  const scripted = new ScriptedRunner();
  const gates = ["t1", "t2", "t3", "t4", "t5", "t6"].map((ticket) => {
    const gate = deferred();
    scripted.script("verdict", ticket, { output: { greeting: ticket }, until: gate.promise });
    return { ticket, gate };
  });
  const runner = new CountingRunner(scripted);
  let limit = 2;
  const runs = new ModelRuns({ runner, log, limit: () => limit });

  const results = gates.map(({ ticket }) => runs.run(request("verdict", ticket), schedule()));
  await flush();
  assert.equal(runs.inFlight, 2);
  assert.equal(runs.waiting, 4);
  assert.deepEqual(scripted.requests.map((r) => r.ticket), ["t1", "t2"]);

  limit = 3;
  gates[0]!.gate.resolve();
  await flush();
  assert.equal(runs.inFlight, 3, "a raised limit takes effect when the next run starts");
  assert.deepEqual(scripted.requests.map((r) => r.ticket), ["t1", "t2", "t3", "t4"]);

  limit = 1;
  gates[1]!.gate.resolve();
  gates[2]!.gate.resolve();
  await flush();
  assert.equal(runs.inFlight, 1, "a lowered limit lets runs in flight finish and starts none past it");

  for (const { gate } of gates) gate.resolve();
  const outputs = await Promise.all(results);
  assert.deepEqual(outputs.map((run) => run.output.greeting), ["t1", "t2", "t3", "t4", "t5", "t6"]);
  assert.equal(runner.peak, 3);
});

test("a ticket never has two model runs at once: its challenge waits for its verdict, while other tickets use the free slot", async (t) => {
  const { log } = logFor(t);
  const verdictDone = deferred();
  const scripted = new ScriptedRunner()
    .script("verdict", "t1", { output: { greeting: "verdict" }, until: verdictDone.promise })
    .script("challenge", "t1", { output: { greeting: "challenge" } })
    .script("verdict", "t2", { output: { greeting: "other" } });
  const runner = new CountingRunner(scripted);
  const runs = new ModelRuns({ runner, log, limit: () => 3 });

  const verdict = runs.run(request("verdict", "t1"), schedule("intake", "2026-11-08T12:00:00Z"));
  const challenge = runs.run(request("challenge", "t1"), schedule("intake", "2026-11-08T12:00:00Z"));
  const other = runs.run(request("verdict", "t2"), schedule("intake", "2026-11-08T12:30:00Z"));
  await other;
  await flush();
  assert.deepEqual(
    scripted.requests.map((r) => [r.kind, r.ticket]),
    [
      ["verdict", "t1"],
      ["verdict", "t2"],
    ],
    "the challenge waits although a slot is free",
  );

  verdictDone.resolve();
  assert.equal((await verdict).output.greeting, "verdict");
  assert.equal((await challenge).output.greeting, "challenge");
  assert.equal(runner.peakPerTicket, 1);
});

test("waiting runs start landing checks first, then criteria after an answer, then new intake, oldest first within each", async (t) => {
  const { log } = logFor(t);
  const blocker = deferred();
  const scripted = new ScriptedRunner().script("verdict", "busy", { output: { greeting: "busy" }, until: blocker.promise });
  const runs = new ModelRuns({ runner: scripted, log, limit: () => 1 });
  const busy = runs.run(request("verdict", "busy"), schedule());
  await flush();

  const waiting: [RunKind, string, ModelRunPriority, string][] = [
    ["verdict", "intake-newer", "intake", "2026-11-08T12:10:00Z"],
    ["grade", "landing-newer", "landing", "2026-11-08T12:30:00Z"],
    ["verdict", "intake-older", "intake", "2026-11-08T12:00:00Z"],
    ["criteria", "criteria", "criteria-after-answer", "2026-11-08T12:20:00Z"],
    ["grade", "landing-older", "landing", "2026-11-08T12:05:00Z"],
  ];
  const results = waiting.map(([kind, ticket, priority, since]) => {
    scripted.script(kind, ticket, { output: { greeting: ticket } });
    return runs.run(request(kind, ticket), { priority, since });
  });
  blocker.resolve();
  await Promise.all([busy, ...results]);

  assert.deepEqual(MODEL_RUN_PRIORITIES, ["landing", "criteria-after-answer", "intake"]);
  assert.deepEqual(
    scripted.requests.map((r) => r.ticket),
    ["busy", "landing-older", "landing-newer", "criteria", "intake-older", "intake-newer"],
  );
});

test("machine failures are retried after 1, 2, 4… minutes, capped at 30, with no attempt limit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const { log, lines } = logFor(t);
  const kinds = ["error", "timeout", "refusal", "no-structured-output", "error", "error", "error", "error"] as const;
  const scripted = new ScriptedRunner().script(
    "verdict",
    "t1",
    ...kinds.map((kind) => ({ failure: { kind, message: `it failed: ${kind}` }, facts: { estimatedCostUsd: 0.25 } })),
    { output: { greeting: "at last" }, facts: { estimatedCostUsd: 0.5 } },
  );
  const runs = new ModelRuns({ runner: scripted, log });
  const result = runs.run(request("verdict", "t1"), schedule());
  await flush();
  assert.equal(scripted.requests.length, 1);

  const expectedMinutes = [1, 2, 4, 8, 16, 30, 30, 30];
  let elapsed = 0;
  for (const [i, minutes] of expectedMinutes.entries()) {
    const state = runs.retryState("t1");
    assert.equal(state?.failures, i + 1);
    assert.equal(state?.failingSince, new Date(NOW).toISOString(), "failing since the first failure in a row");
    assert.equal(state?.lastFailure.kind, kinds[i]);
    assert.equal(state?.retryAt, new Date(NOW + elapsed + minutes * MINUTE).toISOString());

    t.mock.timers.tick(minutes * MINUTE - 1);
    await flush();
    assert.equal(scripted.requests.length, i + 1, `not retried before ${minutes} minutes`);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(scripted.requests.length, i + 2, `retried after ${minutes} minutes`);
    elapsed += minutes * MINUTE;
  }

  const run = await result;
  assert.equal(run.output.greeting, "at last");
  assert.equal(runs.retryState("t1"), null, "a success clears the retry state");
  assert.deepEqual(
    lines("machine-failure").map((line) => [line.failure, line.estimatedCostUsd]),
    kinds.map((kind) => [kind, 0.25]),
    "every failed attempt and its cost is logged",
  );
  assert.deepEqual(lines("model-run-retry").map((line) => line.failures), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(lines("model-run-recovered").length, 1);
  assert.equal(lines("model-run-done")[0]?.estimatedCostUsd, 0.5);
  assert.equal(retryDelay(1000), RETRY_MAX_MS);
});

test("a usage limit pauses all model work until the reported reset, and the run that hit it waits in line again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const { log, lines } = logFor(t);
  const resetAt = new Date(NOW + 45 * MINUTE);
  const scripted = new ScriptedRunner()
    .script("verdict", "t1", { failure: { kind: "usage-limit", message: "limit reached", resetAt } }, { output: { greeting: "t1" } })
    .script("grade", "t2", { output: { greeting: "t2" } });
  const runs = new ModelRuns({ runner: scripted, log });

  const first = runs.run(request("verdict", "t1"), schedule());
  await flush();
  assert.equal(runs.pausedUntil, resetAt.toISOString());
  assert.equal(runs.retryState("t1"), null, "a usage limit is not the ticket's failure");

  const second = runs.run(request("grade", "t2"), schedule("landing"));
  t.mock.timers.tick(45 * MINUTE - 1);
  await flush();
  assert.equal(scripted.requests.length, 1, "nothing runs while paused, whichever ticket");
  assert.equal(runs.waiting, 2);

  t.mock.timers.tick(1);
  assert.deepEqual((await Promise.all([first, second])).map((run) => run.output.greeting), ["t1", "t2"]);
  assert.equal(runs.pausedUntil, null);
  assert.deepEqual(lines("usage-limit-pause").map((line) => [line.until, line.reported]), [[resetAt.toISOString(), true]]);
  assert.equal(lines("usage-limit-pause-ended").length, 1);
});

test("a usage limit with no reset time, or one already past, pauses model work for 30 minutes", async (t) => {
  for (const resetAt of [undefined, new Date(NOW - MINUTE)]) {
    await t.test(resetAt ? "a past reset time" : "no reset time", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
      const { log } = logFor(t);
      const scripted = new ScriptedRunner().script(
        "verdict",
        "t1",
        { failure: { kind: "usage-limit", message: "limit reached", ...(resetAt ? { resetAt } : {}) } },
        { output: { greeting: "t1" } },
      );
      const runs = new ModelRuns({ runner: scripted, log });
      const result = runs.run(request("verdict", "t1"), schedule());
      await flush();
      assert.equal(runs.pausedUntil, new Date(NOW + USAGE_LIMIT_PAUSE_MS).toISOString());
      t.mock.timers.tick(USAGE_LIMIT_PAUSE_MS - 1);
      await flush();
      assert.equal(scripted.requests.length, 1);
      t.mock.timers.tick(1);
      assert.equal((await result).output.greeting, "t1");
    });
  }
});

test("stopping interrupts runs in flight and discards waiting ones; a new start runs them again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const { log, lines } = logFor(t);
  const never = new Promise<void>(() => {});
  const scripted = new ScriptedRunner()
    .script("verdict", "in-flight", { output: { greeting: "never" }, until: never })
    .script("verdict", "retrying", { failure: { kind: "timeout", message: "timed out" } })
    .script("verdict", "waiting", { output: { greeting: "never" } });
  const signals: AbortSignal[] = [];
  const runner: ModelRunner = {
    run(req, options) {
      if (options?.signal) signals.push(options.signal);
      return scripted.run(req, options);
    },
  };
  const runs = new ModelRuns({ runner, log, limit: () => 1 });
  const retrying = runs.run(request("verdict", "retrying"), schedule("landing"));
  await flush();
  const inFlight = runs.run(request("verdict", "in-flight"), schedule());
  await flush();
  const waiting = runs.run(request("verdict", "waiting"), schedule());
  await flush();
  assert.equal(runs.inFlight, 1);
  assert.equal(runs.waiting, 2);

  await runs.stop();
  for (const discarded of [inFlight, retrying, waiting]) await assert.rejects(discarded, ModelRunsStoppedError);
  assert.equal(signals.at(-1)?.aborted, true, "the run in flight is interrupted");
  assert.deepEqual(lines("model-runs-interrupted").map((line) => [line.interrupted, line.discarded]), [[1, 2]]);
  await assert.rejects(runs.run(request("verdict", "late"), schedule()), ModelRunsStoppedError, "nothing starts after stopping");
  t.mock.timers.tick(RETRY_MAX_MS);
  await flush();
  assert.equal(scripted.requests.length, 2, "the discarded retry is not tried again");

  // The next start knows nothing of them; the work is still owed and runs again.
  const again = new ScriptedRunner().script("verdict", "in-flight", { output: { greeting: "ran again" } });
  const restarted = new ModelRuns({ runner: again, log });
  assert.equal((await restarted.run(request("verdict", "in-flight"), schedule())).output.greeting, "ran again");
});

test("a run discarded through its signal frees its slot and its ticket", async (t) => {
  const { log } = logFor(t);
  const scripted = new ScriptedRunner()
    .script("verdict", "t1", { output: { greeting: "never" }, until: new Promise(() => {}) })
    .script("challenge", "t1", { output: { greeting: "challenge" } });
  const runs = new ModelRuns({ runner: scripted, log, limit: () => 1 });
  const controller = new AbortController();
  const verdict = runs.run(request("verdict", "t1"), { ...schedule(), signal: controller.signal });
  const challenge = runs.run(request("challenge", "t1"), schedule());
  await flush();
  controller.abort(new Error("the issue was edited"));
  await assert.rejects(verdict, /the issue was edited/);
  assert.equal((await challenge).output.greeting, "challenge");
  assert.equal(runs.inFlight, 0);
});

test("a run's estimated cost and the rest of its facts are recorded on the call", async (t) => {
  const { log } = logFor(t);
  const scripted = new ScriptedRunner().script("verdict", "t1", {
    output: { greeting: "hi" },
    facts: { sessionId: "s-1", durationMs: 1200, estimatedCostUsd: 0.42 },
  });
  const runs = new ModelRuns({ runner: scripted, log });
  const req = request("verdict", "t1");
  const run = await runs.run(req, schedule());
  const record = modelRunRecord(req, run);
  assert.deepEqual(
    { ...record, startedAt: typeof record.startedAt },
    {
      purpose: "verdict",
      model: "claude-opus-5-5",
      promptVersion: "v1",
      sessionId: "s-1",
      input: "verdict for t1",
      output: JSON.stringify({ greeting: "hi" }),
      startedAt: "string",
      durationMs: 1200,
      estimatedCostUsd: 0.42,
    },
  );
});

function passesWith(setup: PassSetup, forge: IntakeForge, runs: ModelRuns, planner: OwedStepPlanner): Passes {
  return new Passes({
    store: setup.store,
    log: setup.log,
    dataDirectory: setup.dataDirectory,
    forgeFor: () => forge,
    defaultBranchFor: async () => STILL_HEAD,
    planners: [planner],
    modelRuns: runs,
  });
}

/** A step that asks for a verdict run, as the decider will. */
const verdictStep: OwedStepPlanner = (ticket, pass) =>
  ticket.state === "deciding"
    ? {
        name: "verdict",
        run: async () => {
          await pass.modelRuns.run(request("verdict", String(ticket.id)), { priority: "intake", since: ticket.takenInAt });
        },
      }
    : null;

test("machine failures go to the operational log and the ticket's retry state, never the board; the ticket stays deciding", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const setup = passSetup(t);
  const repo = setup.enroll();
  const forge = new IntakeForge();
  forge.issues = [issue(5)];
  const scripted = new ScriptedRunner();
  const runs = new ModelRuns({ runner: scripted, log: setup.log });
  const engine = passesWith(setup, forge, runs, verdictStep);

  // Scripted under the ticket id the pass is about to take in.
  scripted.script(
    "verdict",
    "1",
    { failure: { kind: "refusal", message: "refused" } },
    { failure: { kind: "usage-limit", message: "limit reached" } },
    { output: { greeting: "done" }, until: new Promise(() => {}) },
  );
  await engine.runPass();
  await flush();
  const ticket = setup.store.latestTicketForIssue(repo.id, 5)!;
  assert.equal(ticket.id, 1);
  const calls = setup.store.callsForTicket(ticket.id).length;

  assert.equal(runs.retryState("1")?.lastFailure.kind, "refusal");
  t.mock.timers.tick(MINUTE);
  await flush();
  assert.notEqual(runs.pausedUntil, null);

  const after = setup.store.latestTicketForIssue(repo.id, 5)!;
  assert.equal(after.state, "deciding");
  assert.equal(setup.store.callsForTicket(ticket.id).length, calls, "no call is recorded for a machine failure");
  assert.equal(setup.store.openBoardItem(ticket.id), null, "nothing reaches the board");
  const events = setup.logLines().map((line) => line.event);
  assert.ok(events.includes("machine-failure"));
  assert.ok(events.includes("model-run-retry"));
  assert.ok(events.includes("usage-limit-pause"));
  await engine.stop();
});

test("stopping the passes interrupts the model runs in flight; on restart the owed step runs them again", async (t) => {
  const setup = passSetup(t);
  const repo = setup.enroll();
  const forge = new IntakeForge();
  forge.issues = [issue(5)];
  const first = new ScriptedRunner().script("verdict", "1", { output: { greeting: "never" }, until: new Promise(() => {}) });
  const engine = passesWith(setup, forge, new ModelRuns({ runner: first, log: setup.log }), verdictStep);
  await engine.runPass();
  await flush();
  assert.equal(first.requests.length, 1);

  await engine.stop();
  await flush();
  const failed = setup.logLines().find((line) => line.event === "step-failed");
  assert.match(String(failed?.error), /interrupted and discarded/);
  assert.equal(setup.store.latestTicketForIssue(repo.id, 5)!.state, "deciding");

  const second = new ScriptedRunner().script("verdict", "1", { output: { greeting: "done" } });
  const restarted = passesWith(setup, forge, new ModelRuns({ runner: second, log: setup.log }), verdictStep);
  await restarted.runPass();
  await flush();
  assert.equal(second.requests.length, 1, "the interrupted run is run again");
  await restarted.stop();
});

test("a failing run discarded while it waits for a retry clears the ticket's retry state, so a later run starts at 1 minute", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const { log } = logFor(t);
  const scripted = new ScriptedRunner()
    .script("verdict", "t1", { failure: { kind: "refusal", message: "no" } }, { failure: { kind: "refusal", message: "no" } })
    .script("verdict", "t1", { failure: { kind: "refusal", message: "no" } }, { output: { greeting: "ok" } });
  const runs = new ModelRuns({ runner: scripted, log });
  const controller = new AbortController();
  const first = runs.run(request("verdict", "t1"), { ...schedule(), signal: controller.signal });
  const rejected = assert.rejects(first, /withdrawn/);
  await flush();
  t.mock.timers.tick(MINUTE);
  await flush();
  assert.equal(runs.retryState("t1")?.failures, 2);

  controller.abort(new Error("withdrawn"));
  await rejected;
  assert.equal(runs.retryState("t1"), null, "no retry state outlives its run");

  const second = runs.run(request("verdict", "t1"), schedule());
  await flush();
  assert.equal(runs.retryState("t1")?.failures, 1, "the next run starts its backoff afresh");
  t.mock.timers.tick(MINUTE);
  await flush();
  assert.equal((await second).output.greeting, "ok");
});
