import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_MODEL, MACHINE_FAILURE_KINDS, type ModelRunner, type ModelRunRequest } from "../src/model-runner.ts";
import { ScriptedRunner } from "../src/scripted-runner.ts";
import { object, string } from "../src/schema.ts";

const greetingSchema = object({ greeting: string() });

function request(kind: string, ticket: string | null, model = DEFAULT_MODEL): ModelRunRequest<{ greeting: string }> {
  return { kind, ticket, prompt: "p", promptVersion: "v1", schema: greetingSchema, checkout: "/checkout", sha: "a".repeat(40), model };
}

test("the default model is Opus 5.5", () => {
  assert.equal(DEFAULT_MODEL, "claude-opus-5-5");
});

test("recorded outcomes come back in order for their kind and ticket", async () => {
  const runner: ScriptedRunner = new ScriptedRunner()
    .script("issue-call", "t1", { output: { greeting: "first" } }, { output: { greeting: "second" } })
    .script("issue-call", "t2", { output: { greeting: "other ticket" } })
    .script("pr-call", "t1", { output: { greeting: "other kind" } });
  const seam: ModelRunner = runner;

  const first = await seam.run(request("issue-call", "t1"));
  const otherKind = await seam.run(request("pr-call", "t1"));
  const otherTicket = await seam.run(request("issue-call", "t2"));
  const second = await seam.run(request("issue-call", "t1"));

  assert.deepEqual([first, otherKind, otherTicket, second].map((result) => result.ok && result.output.greeting), ["first", "other kind", "other ticket", "second"]);
  assert.equal(runner.remaining("issue-call", "t1"), 0);
  assert.deepEqual(
    runner.requests.map((made) => [made.kind, made.ticket]),
    [
      ["issue-call", "t1"],
      ["pr-call", "t1"],
      ["issue-call", "t2"],
      ["issue-call", "t1"],
    ],
  );
});

test("every machine failure class can be scripted, including a usage limit's reset time", async () => {
  const resetAt = new Date("2026-11-08T15:00:00Z");
  const runner = new ScriptedRunner();
  for (const kind of MACHINE_FAILURE_KINDS) {
    runner.script("grade", "t1", { failure: kind === "usage-limit" ? { kind, message: "limit", resetAt } : { kind, message: kind } });
  }
  const kinds = [];
  for (const _ of MACHINE_FAILURE_KINDS) {
    const result = await runner.run(request("grade", "t1"));
    assert.equal(result.ok, false);
    if (!result.ok) {
      kinds.push(result.failure.kind);
      if (result.failure.kind === "usage-limit") assert.deepEqual(result.failure.resetAt, resetAt);
    }
  }
  assert.deepEqual(kinds, [...MACHINE_FAILURE_KINDS]);
});

test("a run with no ticket is scripted under null", async () => {
  const runner = new ScriptedRunner().script("repo-check", null, { output: { greeting: "repo-wide" } });
  const result = await runner.run(request("repo-check", null));
  assert.equal(result.ok && result.output.greeting, "repo-wide");
});

test("a run nobody scripted rejects instead of inventing a result", async () => {
  const runner = new ScriptedRunner().script("issue-call", "t1", { output: { greeting: "once" } });
  await runner.run(request("issue-call", "t1"));
  await assert.rejects(runner.run(request("issue-call", "t1")), /no scripted outcome for kind issue-call on ticket t1/);
});

test("a recorded output that does not match the schema is the no-structured-output failure", async () => {
  const runner = new ScriptedRunner().script("pr-call", "t1", { output: { greeting: "hi", extra: true } });
  const result = await runner.run(request("pr-call", "t1"));
  assert.equal(!result.ok && result.failure.kind, "no-structured-output");
});

test("facts carry the request's model, with recorded overrides", async () => {
  const runner = new ScriptedRunner().script("issue-call", "t1", { output: { greeting: "hi" }, facts: { estimatedCostUsd: 0.42 } });
  const result = await runner.run(request("issue-call", "t1", "claude-sonnet-5-5"));
  assert.equal(result.facts?.model, "claude-sonnet-5-5");
  assert.equal(result.facts?.estimatedCostUsd, 0.42);
});

test("an interrupted run rejects before it uses an outcome", async () => {
  const runner = new ScriptedRunner().script("issue-call", "t1", { output: { greeting: "hi" } });
  const controller = new AbortController();
  controller.abort(new Error("stopping"));
  await assert.rejects(runner.run(request("issue-call", "t1"), { signal: controller.signal }), /stopping/);
  assert.equal(runner.remaining("issue-call", "t1"), 1);
});
