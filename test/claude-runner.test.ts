import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { claudeArguments, ClaudeRunner, usageLimit } from "../src/claude-runner.ts";
import { DEFAULT_MODEL, type ModelRunRequest } from "../src/model-runner.ts";
import { Mirror } from "../src/mirror.ts";
import { emitJsonSchema, object, string } from "../src/schema.ts";
import { FixtureRepo, tempDirectory } from "./git-fixture.ts";

const greetingSchema = object({ greeting: string() });

function temporary(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A read-only checkout the git mirror made of a repo with one commit, and
 * that commit's sha: what every real run reads.
 */
async function checkout(t: TestContext): Promise<{ path: string; sha: string }> {
  const repo = new FixtureRepo(t);
  repo.write("VISION.md", "# tally\n\ntally never reaches the network.\n").commit("vision");
  repo.push();
  const mirror = await Mirror.open({
    dataDirectory: tempDirectory(t, "data"),
    key: { forge: "github", host: "forge.example", projectId: 42 },
    remote: { url: repo.remote, credentialHelper: null },
  });
  const made = await mirror.checkout((await mirror.updateDefaultBranch()).commit);
  return { path: made.directory, sha: made.commit };
}

type Behaviour =
  | { print: { stdout?: string; stderr?: string; code?: number } }
  /** Never finishes on its own; ignores SIGINT, and SIGTERM too when stubborn. */
  | { hang: { stubborn?: boolean } };

/**
 * Writes a stand-in for `claude` that records how it was invoked (arguments,
 * working directory, stdin and the signals it got) next to itself.
 */
function fakeClaude(t: TestContext, behaviour: Behaviour): { command: string; invocation: () => { argv: string[]; cwd: string; stdin: string }; signals: () => string[] } {
  const dir = temporary(t, "entail-fake-claude-");
  const command = join(dir, "claude");
  const invocationFile = join(dir, "invocation.json");
  const signalsFile = join(dir, "signals.txt");
  writeFileSync(
    command,
    `#!/usr/bin/env node
const fs = require("node:fs");
const behaviour = ${JSON.stringify(behaviour)};
if (behaviour.hang) {
  const record = (signal) => fs.appendFileSync(${JSON.stringify(signalsFile)}, signal + "\\n");
  process.on("SIGINT", () => record("SIGINT"));
  process.on("SIGTERM", () => { record("SIGTERM"); if (!behaviour.hang.stubborn) process.exit(143); });
}
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(invocationFile)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin }));
  if (behaviour.print) {
    const { stdout = "", stderr = "", code = 0 } = behaviour.print;
    process.stderr.write(stderr);
    process.stdout.write(stdout, () => process.exit(code));
    return;
  }
  setInterval(() => {}, 1000);
});
`,
  );
  chmodSync(command, 0o755);
  return {
    command,
    invocation: () => JSON.parse(readFileSync(invocationFile, "utf8")) as { argv: string[]; cwd: string; stdin: string },
    signals: () => (existsSync(signalsFile) ? readFileSync(signalsFile, "utf8").split("\n").filter((line) => line !== "") : []),
  };
}

function request(at: { path: string; sha: string }, overrides: Partial<ModelRunRequest<{ greeting: string }>> = {}): ModelRunRequest<{ greeting: string }> {
  return {
    kind: "issue-call",
    ticket: "ticket-1",
    prompt: "Judge the ticket.",
    promptVersion: "issue-call-v1",
    schema: greetingSchema,
    checkout: at.path,
    sha: at.sha,
    model: DEFAULT_MODEL,
    ...overrides,
  };
}

/** A `claude -p --output-format json` result line, as the CLI prints it. */
function resultJson(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    stop_reason: "end_turn",
    api_error_status: null,
    duration_ms: 1712,
    session_id: "d0c86ecf-cbe1-4a28-b26c-09b6c429bc7d",
    total_cost_usd: 0.0132,
    usage: { input_tokens: 2, output_tokens: 56 },
    modelUsage: { "claude-opus-5-5": { inputTokens: 2, outputTokens: 56, costUSD: 0.0132 } },
    result: '{"greeting":"Hello!"}',
    structured_output: { greeting: "Hello!" },
    ...fields,
  });
}

test("a run passes exactly the structured output, model, tool and isolation flags", () => {
  const at = { path: "/checkout", sha: "a".repeat(40) };
  assert.deepEqual(claudeArguments(request(at, { model: "claude-sonnet-5-5" })), [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    emitJsonSchema(greetingSchema),
    "--model",
    "claude-sonnet-5-5",
    "--tools",
    "Read,Grep,Glob",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
  ]);
});

test("a run asked for an effort passes it to claude", () => {
  const at = { path: "/checkout", sha: "a".repeat(40) };
  const argv = claudeArguments(request(at, { effort: "low" }));
  assert.deepEqual(argv.slice(argv.indexOf("--model"), argv.indexOf("--tools")), ["--model", DEFAULT_MODEL, "--effort", "low"]);
});

test("a run in the checkout returns the structured output with its facts", async (t) => {
  const at = await checkout(t);
  const fake = fakeClaude(t, { print: { stdout: resultJson() } });
  const result = await new ClaudeRunner({ command: fake.command }).run(request(at));

  assert.deepEqual(result, {
    ok: true,
    output: { greeting: "Hello!" },
    facts: {
      sessionId: "d0c86ecf-cbe1-4a28-b26c-09b6c429bc7d",
      model: "claude-opus-5-5",
      durationMs: 1712,
      estimatedCostUsd: 0.0132,
      usage: { input_tokens: 2, output_tokens: 56 },
    },
  });
  const invocation = fake.invocation();
  assert.equal(realpathSync(invocation.cwd), realpathSync(at.path), "the run reads the checkout");
  assert.equal(invocation.stdin, "Judge the ticket.", "the prompt goes on stdin");
  assert.deepEqual(invocation.argv, claudeArguments(request(at)));
});

test("the model reported for a run is the one that ran it", async (t) => {
  const at = await checkout(t);
  const fake = fakeClaude(t, { print: { stdout: resultJson({ modelUsage: { "claude-opus-5-5-20261001": {} } }) } });
  const result = await new ClaudeRunner({ command: fake.command }).run(request(at));
  assert.equal(result.facts?.model, "claude-opus-5-5-20261001");
});

test("a checkout that is not at the recorded sha is an error, and claude is not run", async (t) => {
  const at = await checkout(t);
  const fake = fakeClaude(t, { print: { stdout: resultJson() } });
  const result = await new ClaudeRunner({ command: fake.command }).run(request({ path: at.path, sha: "b".repeat(40) }));
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.failure.kind, "error");
  assert.match(!result.ok ? result.failure.message : "", /not the recorded sha/);
  assert.throws(() => fake.invocation(), "claude never started");
});

test("a directory the git mirror did not make is an error, even a repository at the sha, and claude is not run", async (t) => {
  const repo = new FixtureRepo(t);
  const sha = repo.write("VISION.md", "# tally\n").commit("vision");
  const fake = fakeClaude(t, { print: { stdout: resultJson() } });
  for (const path of [repo.work, join(repo.work, "missing")]) {
    const result = await new ClaudeRunner({ command: fake.command }).run(request({ path, sha }));
    assert.equal(!result.ok && result.failure.kind, "error");
    assert.match(!result.ok ? result.failure.message : "", /not a read-only checkout made by the git mirror/);
  }
  assert.throws(() => fake.invocation(), "claude never started");
});

const failures: { name: string; behaviour: Behaviour; kind: string; message?: RegExp }[] = [
  { name: "a missing structured_output", behaviour: { print: { stdout: resultJson({ structured_output: undefined }) } }, kind: "no-structured-output" },
  {
    name: "a structured output that does not match the schema",
    behaviour: { print: { stdout: resultJson({ structured_output: { greeting: 3 } }) } },
    kind: "no-structured-output",
    message: /\$\.greeting is not a string/,
  },
  {
    name: "running out of structured output retries",
    behaviour: { print: { stdout: resultJson({ subtype: "error_max_structured_output_retries", is_error: true, structured_output: undefined }), code: 1 } },
    kind: "no-structured-output",
  },
  {
    name: "an error result",
    behaviour: { print: { stdout: resultJson({ subtype: "error_during_execution", is_error: true, result: "API Error: 500 overloaded" }), code: 1 } },
    kind: "error",
    message: /overloaded/,
  },
  { name: "an exit without a result", behaviour: { print: { stderr: "Segmentation fault", code: 1 } }, kind: "error", message: /code 1.*Segmentation fault/ },
  {
    name: "an exit for want of a login",
    behaviour: { print: { stderr: "Invalid API key · Please run /login", code: 1 } },
    kind: "logged-out",
    message: /not logged in.*Invalid API key/,
  },
  {
    name: "an authentication error result",
    behaviour: { print: { stdout: resultJson({ is_error: true, subtype: "error_during_execution", api_error_status: 401, result: "OAuth token has expired" }), code: 1 } },
    kind: "logged-out",
  },
  {
    name: "a refusal",
    behaviour: { print: { stdout: resultJson({ stop_reason: "refusal", structured_output: undefined, result: "I can't help with that." }) } },
    kind: "refusal",
  },
  {
    name: "a usage limit result",
    behaviour: { print: { stdout: resultJson({ is_error: true, subtype: "error_during_execution", api_error_status: 429, result: "You've hit your limit" }), code: 1 } },
    kind: "usage-limit",
  },
  { name: "a usage limit with no result", behaviour: { print: { stdout: "Claude AI usage limit reached|1794153600", code: 1 } }, kind: "usage-limit" },
];

for (const { name, behaviour, kind, message } of failures) {
  test(`${name} is the ${kind} machine failure`, async (t) => {
    const at = await checkout(t);
    const fake = fakeClaude(t, behaviour);
    const result = await new ClaudeRunner({ command: fake.command }).run(request(at));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.kind, kind);
    if (message) assert.match(result.failure.message, message);
  });
}

test("a failure with a result keeps the run's facts, so its cost is still recorded", async (t) => {
  const at = await checkout(t);
  const fake = fakeClaude(t, { print: { stdout: resultJson({ structured_output: undefined }) } });
  const result = await new ClaudeRunner({ command: fake.command }).run(request(at));
  assert.equal(result.facts?.estimatedCostUsd, 0.0132);
  assert.equal(result.facts?.sessionId, "d0c86ecf-cbe1-4a28-b26c-09b6c429bc7d");
});

test("a usage limit carries the reset time claude reported", async (t) => {
  const at = await checkout(t);
  const fake = fakeClaude(t, { print: { stdout: "Claude AI usage limit reached|1794153600", code: 1 } });
  const result = await new ClaudeRunner({ command: fake.command }).run(request(at));
  assert.deepEqual(!result.ok && result.failure.resetAt, new Date(1794153600 * 1000));
});

test("the usage-limit reset time is read from epoch seconds or an ISO time, and left out otherwise", () => {
  assert.deepEqual(usageLimit("Claude AI usage limit reached|1794153600").resetAt, new Date(1794153600 * 1000));
  assert.deepEqual(usageLimit("Usage limit reached; resets at 2026-11-08T15:00:00Z").resetAt, new Date("2026-11-08T15:00:00Z"));
  assert.equal(usageLimit("You've hit your limit").resetAt, undefined);
  assert.equal(usageLimit("You've hit your limit").kind, "usage-limit");
});

test("a claude that cannot be started is an error", async (t) => {
  const at = await checkout(t);
  const result = await new ClaudeRunner({ command: join(temporary(t, "entail-missing-"), "claude") }).run(request(at));
  assert.equal(!result.ok && result.failure.kind, "error");
  assert.match(!result.ok ? result.failure.message : "", /could not be started/);
});

test("a timed-out run is ended with SIGINT, then SIGTERM after the grace period", async (t) => {
  const at = await checkout(t);
  const fake = fakeClaude(t, { hang: {} });
  const result = await new ClaudeRunner({ command: fake.command, timeoutMs: 1500, graceMs: 300 }).run(request(at));
  assert.equal(!result.ok && result.failure.kind, "timeout");
  assert.deepEqual(fake.signals(), ["SIGINT", "SIGTERM"]);
});

test("a run that ignores SIGTERM too is killed, so it never holds a slot forever", async (t) => {
  const at = await checkout(t);
  const fake = fakeClaude(t, { hang: { stubborn: true } });
  const result = await new ClaudeRunner({ command: fake.command, timeoutMs: 1500, graceMs: 300 }).run(request(at));
  assert.equal(!result.ok && result.failure.kind, "timeout");
  assert.deepEqual(fake.signals(), ["SIGINT", "SIGTERM"]);
});

test("an interrupted run is ended the same way and rejects with the signal's reason", async (t) => {
  const at = await checkout(t);
  const fake = fakeClaude(t, { hang: {} });
  const controller = new AbortController();
  const running = new ClaudeRunner({ command: fake.command, graceMs: 300 }).run(request(at), { signal: controller.signal });
  // Interrupt once the run has read its prompt and set up its handlers.
  while (!existsSync(join(fake.command, "..", "invocation.json"))) await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const reason = new Error("entail is stopping");
  controller.abort(reason);
  await assert.rejects(running, reason);
  assert.deepEqual(fake.signals(), ["SIGINT", "SIGTERM"]);
});
