import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { answerCall, confirmCall, formatLog, latestCallOn, logItems, logPage, overrideCall } from "../src/owner.ts";
import { appendEntry, readLog, type ActedEntry, type StartedEntry } from "../src/records.ts";
import { runStart, type Handoff } from "../src/starts.ts";
import { harness, OWNER, REPO, SHA, verdict } from "./watch-fixture.ts";

const EXAMPLE = fileURLToPath(new URL("../examples/start-to-file.sh", import.meta.url));

/** A start command that records each handoff instead of running anything. */
function recorder(exit = 0): { handoffs: { command: string; handoff: Handoff }[]; startWork: (command: string, handoff: Handoff) => Promise<{ exit: number | null; error?: string }> } {
  const handoffs: { command: string; handoff: Handoff }[] = [];
  return {
    handoffs,
    startWork: async (command, handoff) => {
      handoffs.push({ command, handoff });
      return exit === 0 ? { exit } : { exit, error: `exited ${exit}: no executor` };
    },
  };
}

const started = (dataDirectory: string): StartedEntry[] => readLog(dataDirectory, REPO).filter((entry): entry is StartedEntry => entry.type === "started");

const CRITERION = { source: "reading" as const, criterion: "Footnote words count toward the total.", basis: "The total is what users see." };

test("with confirm mode off a go starts work at once, with the handoff on standard input, and only once", async (t) => {
  const h = harness(t, { confirm: false, settings: { start: "my-executor --queue" } });
  const start = recorder();
  h.forge.file(12, "Count words in footnotes", "Footnotes are skipped today.");
  h.script(12, verdict({ criteria: [CRITERION] }));

  await h.pass({ startWork: start.startWork });
  assert.equal(h.forge.posted.length, 1, "the go is posted first");
  assert.equal(start.handoffs.length, 1);
  const call = readLog(h.dataDirectory, REPO).find((entry) => entry.type === "call")!;
  assert.deepEqual(start.handoffs[0], {
    command: "my-executor --queue",
    handoff: {
      repo: REPO,
      issue: { number: 12, url: "https://github.com/acme/tally/issues/12", title: "Count words in footnotes" },
      vision: SHA,
      call: call.id,
      by: "entail",
      reason: "Counting words in more places makes tally more useful.",
      criteria: [CRITERION],
    },
  });
  const [entry] = started(h.dataDirectory);
  assert.equal(entry!.command, "my-executor --queue");
  assert.equal(entry!.exit, 0);
  assert.equal(entry!.issue, 12);

  await h.pass({ startWork: start.startWork });
  assert.equal(start.handoffs.length, 1, "nothing starts twice");

  // An edit judged go again does not start the work again.
  h.forge.edit(12, { body: "Footnotes and endnotes are skipped today." });
  h.script(12, verdict({ criteria: [CRITERION] }));
  await h.pass({ startWork: start.startWork });
  assert.equal(h.forge.posted.length, 2);
  assert.equal(start.handoffs.length, 1, "work starts once per issue");

  const log = formatLog(logItems(h.dataDirectory, []), { repoColumn: false });
  assert.match(log, /#12 {2}started work with: my-executor --queue/u);
});

test("no and ask never start work, and nothing starts without a start command", async (t) => {
  const h = harness(t, { confirm: false, settings: { start: "my-executor" } });
  const start = recorder();
  h.forge.file(12, "Make tally a desktop app");
  h.forge.file(13, "Word counts are sometimes wrong");
  h.script(12, verdict({ call: "no", reason: "Another product." }));
  h.script(13, verdict({ call: "ask", reason: "Two readings.", question: { question: "Does a non-breaking space separate words?", why: "Counts differ." } }));
  await h.pass({ startWork: start.startWork });
  assert.equal(h.forge.posted.length, 2);
  assert.deepEqual(start.handoffs, []);

  const none = harness(t, { confirm: false });
  none.forge.file(12, "Count words in footnotes");
  none.script(12, verdict());
  await none.pass({ startWork: start.startWork });
  assert.equal(none.forge.posted.length, 1);
  assert.deepEqual(start.handoffs, []);
  assert.equal(readLog(none.dataDirectory, REPO).some((entry) => entry.type === "acted" && entry.start !== undefined), false);
});

test("in confirm mode a go starts work only once the owner confirms it", async (t) => {
  const h = harness(t, { settings: { start: "my-executor" } });
  const start = recorder();
  h.forge.file(12, "Count words in footnotes");
  h.script(12, verdict({ criteria: [CRITERION] }));
  await h.pass({ startWork: start.startWork });
  assert.equal(h.forge.posted.length, 1);
  assert.equal(start.handoffs.length, 0, "a go waiting to be confirmed starts nothing");

  const id = latestCallOn(h.dataDirectory, REPO, 12);
  const confirmed = await confirmCall(h.dataDirectory, id, OWNER, new Date("2026-11-12T12:00:00Z"), { holdMs: 10_000 });
  await h.pass({ startWork: start.startWork, now: () => new Date("2026-11-12T12:00:05Z") });
  assert.equal(start.handoffs.length, 0, "nothing starts while the confirmation can still be undone");
  await h.pass({ startWork: start.startWork, now: () => new Date("2026-11-12T12:00:11Z") });
  assert.equal(h.forge.posted.length, 2);
  assert.equal(start.handoffs.length, 1);
  assert.equal(start.handoffs[0]!.handoff.by, "owner");
  assert.equal(start.handoffs[0]!.handoff.call, confirmed.id);
  assert.deepEqual(start.handoffs[0]!.handoff.criteria, [CRITERION]);
  const row = logPage(h.dataDirectory, []).rows.find((candidate) => candidate.call.issue.number === 12)!;
  assert.ok(row.trail.some((step) => step.text === "Started work: my-executor"), "the start shows on the call's trail");
});

test("a confirmed no starts nothing", async (t) => {
  const h = harness(t, { settings: { start: "my-executor" } });
  const start = recorder();
  h.forge.file(14, "Make tally a desktop app");
  h.script(14, verdict({ call: "no", reason: "Another product." }));
  await h.pass({ startWork: start.startWork });
  await confirmCall(h.dataDirectory, latestCallOn(h.dataDirectory, REPO, 14), OWNER);
  await h.pass({ startWork: start.startWork });
  assert.deepEqual(h.forge.closed, [14]);
  assert.deepEqual(start.handoffs, []);
});

test("a go made differently starts work with the owner's line as the criterion", async (t) => {
  const h = harness(t, { settings: { start: "my-executor" } });
  const start = recorder();
  h.forge.file(12, "Count words in footnotes");
  h.script(12, verdict({ criteria: [CRITERION] }));
  await h.pass({ startWork: start.startWork });
  await overrideCall(h.dataDirectory, latestCallOn(h.dataDirectory, REPO, 12), OWNER, "go", "Count footnotes separately, after the body.", new Date(), { differently: true });
  await h.pass({ startWork: start.startWork });
  assert.equal(start.handoffs.length, 1);
  const { handoff } = start.handoffs[0]!;
  assert.equal(handoff.by, "owner");
  assert.deepEqual(handoff.criteria, [{ criterion: "Count footnotes separately, after the body.", source: "owner", basis: "the owner's go, made differently, word for word" }]);
});

test("the owner's go answer starts work once the judgment has run again on it", async (t) => {
  const h = harness(t, { settings: { start: "my-executor" } });
  const start = recorder();
  h.forge.file(11, "Word counts are sometimes wrong");
  h.script(
    11,
    verdict({ call: "ask", reason: "Two readings.", question: { question: "Does a non-breaking space separate words?", why: "Counts differ." } }),
    verdict({ reason: "The owner chose: a non-breaking space separates words.", criteria: [{ source: "answer", criterion: "A non-breaking space separates words.", basis: "The owner's answer." }] }),
  );
  await h.pass({ startWork: start.startWork });
  assert.equal(start.handoffs.length, 0);
  await answerCall(h.dataDirectory, latestCallOn(h.dataDirectory, REPO, 11), OWNER, "go", "Yes: any whitespace a reader sees separates words.");
  await h.pass({ startWork: start.startWork });
  assert.equal(start.handoffs.length, 1);
  assert.equal(start.handoffs[0]!.handoff.reason, "The owner chose: a non-breaking space separates words.");
  assert.equal(start.handoffs[0]!.handoff.criteria[0]!.source, "answer");
  const row = logPage(h.dataDirectory, []).rows.find((candidate) => candidate.call.issue.number === 11)!;
  assert.ok(row.trail.some((step) => step.text === "Started work: my-executor"), "the start shows on the call the owner answered");
});

test("a failing start command is recorded and never holds up the call, and a later go tries again", async (t) => {
  const h = harness(t, { confirm: false, settings: { start: "broken" } });
  const failing = recorder(127);
  h.forge.file(12, "Count words in footnotes");
  h.script(12, verdict());
  const report = await h.pass({ startWork: failing.startWork });
  assert.deepEqual(report.failed, [], "the pass finishes");
  assert.equal(h.forge.posted.length, 1);
  const [entry] = started(h.dataDirectory);
  assert.equal(entry!.exit, 127);
  assert.match(entry!.error!, /no executor/u);
  assert.ok(h.printed.some((line) => /the start command failed .*; the call stands/u.test(line)));

  await h.pass({ startWork: failing.startWork });
  assert.equal(failing.handoffs.length, 1, "a failed start is not run again by itself");

  const working = recorder();
  h.forge.edit(12, { title: "Count words in footnotes and endnotes" });
  h.script(12, verdict());
  await h.pass({ startWork: working.startWork });
  assert.equal(working.handoffs.length, 1, "the next go on the issue starts it");
});

test("a start that timed out without an exit status does not count as started, so a later go starts again", async (t) => {
  const h = harness(t, { confirm: false, settings: { start: "hangs" } });
  h.forge.file(12, "Count words in footnotes");
  h.script(12, verdict());
  await h.pass({ startWork: async () => ({ exit: null, error: "stopped by SIGTERM" }) });
  assert.equal(started(h.dataDirectory)[0]!.exit, null);

  const working = recorder();
  h.forge.edit(12, { title: "Count words in footnotes and endnotes" });
  h.script(12, verdict());
  await h.pass({ startWork: working.startWork });
  assert.equal(working.handoffs.length, 1);
});

test("a start recorded with its go but not run, as after a crash, runs at the next pass", async (t) => {
  const h = harness(t, { confirm: false, settings: { start: "my-executor" } });
  const start = recorder();
  const handoff: Handoff = { repo: REPO, issue: { number: 12, url: "https://github.com/acme/tally/issues/12", title: "T" }, call: 1, by: "entail", reason: "R", criteria: [], vision: null };
  const acted = appendEntry(h.dataDirectory, REPO, { type: "acted", for: 1, issue: 12, comment: { id: 5, url: "https://github.com/acme/tally/issues/12#issuecomment-5" }, closed: false, start: { command: "my-executor", handoff } }) as ActedEntry;
  await h.pass({ startWork: start.startWork });
  assert.deepEqual(start.handoffs, [{ command: "my-executor", handoff }]);
  assert.equal(started(h.dataDirectory)[0]!.for, acted.id);
});

test("a dry run prints the start it would make and runs nothing", async (t) => {
  const h = harness(t, { confirm: false, settings: { start: "my-executor" } });
  const start = recorder();
  h.forge.file(12, "Count words in footnotes");
  h.script(12, verdict());
  await h.pass({ dryRun: true, startWork: start.startWork });
  assert.deepEqual(start.handoffs, []);
  assert.ok(h.printed.some((line) => line.startsWith("would start work on acme/tally#12 with: my-executor")));
  assert.deepEqual(readLog(h.dataDirectory, REPO).map((entry) => entry.type), ["enrolled"]);
});

function scratch(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "entail-start-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const HANDOFF: Handoff = {
  repo: REPO,
  issue: { number: 12, url: "https://github.com/acme/tally/issues/12", title: "Count words in footnotes" },
  call: 42,
  by: "entail",
  reason: "Counting words in more places makes tally more useful.\nSecond line.",
  criteria: [{ ...CRITERION }],
  vision: SHA,
};

const WINDOWS = process.platform === "win32";

/** A command line that runs a Node script, the same under /bin/sh and cmd.exe. */
function nodeCommand(directory: string, name: string, script: string): string {
  const path = join(directory, name);
  writeFileSync(path, script);
  return `"${process.execPath}" "${path}"`;
}

test("the start command runs under /bin/sh (cmd.exe on Windows) with the handoff as one line of JSON on standard input", async (t) => {
  const dir = scratch(t);
  const out = join(dir, "handoff.json");
  const copy = nodeCommand(dir, "copy.cjs", `const fs = require("node:fs");\nfs.writeFileSync(${JSON.stringify(out)}, fs.readFileSync(0));\n`);
  assert.deepEqual(await runStart(copy, HANDOFF), { exit: 0 });
  const text = readFileSync(out, "utf8");
  assert.equal(text.split("\n").length, 2, "one line, ending in a newline");
  assert.deepEqual(JSON.parse(text), HANDOFF);

  const failed = await runStart(nodeCommand(dir, "fail.cjs", 'process.stderr.write("no executor here\\n");\nprocess.exit(3);\n'), HANDOFF);
  assert.equal(failed.exit, 3);
  assert.match(failed.error!, /exited 3: no executor here/u);
  assert.equal((await runStart(nodeCommand(dir, "ignore.cjs", ""), HANDOFF)).exit, 0, "a command that ignores its input still succeeds");
  const before = Date.now();
  const slow = await runStart(nodeCommand(dir, "slow.cjs", "setTimeout(() => {}, 5000);\n"), HANDOFF, 200);
  assert.equal(slow.exit, null);
  assert.match(slow.error!, WINDOWS ? /stopped by taskkill/u : /stopped by SIGTERM/u);
  assert.ok(Date.now() - before < 2000, "a command still running at the timeout is stopped");
});

test("a start command that traps SIGTERM is killed after the grace period, on Windows with its process tree at once, and the result is given", async (t) => {
  const dir = scratch(t);
  const before = Date.now();
  const stubborn = WINDOWS ? nodeCommand(dir, "stubborn.cjs", "setInterval(() => {}, 1000);\n") : "trap '' TERM; sleep 30";
  const result = await runStart(stubborn, HANDOFF, 200, 300);
  assert.equal(result.exit, null);
  assert.match(result.error!, WINDOWS ? /stopped by taskkill/u : /stopped by SIGKILL/u);
  assert.ok(Date.now() - before < 3000);
});

test("a start command that hands off to a process left running returns at once", async (t) => {
  const dir = scratch(t);
  const marker = join(dir, "pid");
  const before = Date.now();
  const handOff = nodeCommand(
    dir,
    "hand-off.cjs",
    [
      'const { spawn } = require("node:child_process");',
      // On Windows Node kills a child with its parent unless it is detached.
      `const worker = spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], { stdio: "ignore", detached: ${WINDOWS} });`,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(worker.pid));`,
      "worker.unref();",
      "",
    ].join("\n"),
  );
  assert.deepEqual(await runStart(handOff, HANDOFF, 10_000), { exit: 0 });
  assert.ok(Date.now() - before < 1500, "entail does not wait for what the command left running");
  process.kill(Number(readFileSync(marker, "utf8").trim()));
});

test("the example start command appends each handoff to a file, one line each", async (t) => {
  const dir = scratch(t);
  const file = join(dir, "starts.jsonl");
  let command: string;
  if (WINDOWS) {
    command = `set "ENTAIL_START_FILE=${file}" && "${EXAMPLE.replace(/\.sh$/u, ".cmd")}"`;
  } else {
    command = join(dir, "start.sh");
    writeFileSync(command, `#!/bin/sh\nENTAIL_START_FILE='${file}' exec '${EXAMPLE}'\n`);
    chmodSync(command, 0o755);
  }
  assert.equal((await runStart(command, HANDOFF)).exit, 0);
  assert.equal((await runStart(command, { ...HANDOFF, issue: { ...HANDOFF.issue, number: 13 } })).exit, 0);
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.deepEqual(lines.map((line) => (JSON.parse(line) as Handoff).issue.number), [12, 13]);
});
