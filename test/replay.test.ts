import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CASE_BOOK, readCaseBook, type Case } from "../src/case-book.ts";
import { JUDGMENT_KIND, type Verdict } from "../src/judgment.ts";
import { caseInputs, formatReplay, replay } from "../src/replay.ts";
import { ScriptedRunner } from "../src/scripted-runner.ts";

const checkoutOf = async (past: Case) => ({ directory: `/checkouts/${past.visionCommit}`, commit: past.visionCommit });

function verdict(call: Verdict["call"], reason = `entail says ${call}`): Verdict {
  return {
    call,
    reason,
    rests_on: { vision_lines: [], cases: [] },
    large: false,
    large_because: "",
    criteria: [],
    question: call === "ask" ? { question: "Which way?", why: "Two readings." } : null,
  };
}

const ticket = (past: Case) => `${past.repo}#${past.issue}`;

test("every case's prompt holds its own issue, its own vision and every other case as precedent, never itself", async () => {
  const book = await readCaseBook(DEFAULT_CASE_BOOK);
  const runner = new ScriptedRunner();
  for (const past of book) runner.script(JUDGMENT_KIND, ticket(past), { output: verdict(past.call) });

  await replay(runner, book, checkoutOf, { concurrency: 3 });

  assert.equal(runner.requests.length, book.length);
  for (const past of book) {
    const request = runner.requests.find((made) => made.ticket === ticket(past))!;
    assert.ok(request.prompt.includes(past.issueText.trim()), `${past.slug}: its issue`);
    assert.ok(request.prompt.includes(past.vision.trim()), `${past.slug}: its vision in full`);
    assert.ok(request.prompt.includes(`VISION.md at ${past.visionCommit}`), `${past.slug}: the vision's commit`);
    assert.equal(request.sha, past.visionCommit, `${past.slug}: the repo at the vision's commit`);
    assert.ok(!request.prompt.includes(`Case ${past.slug}:`), `${past.slug}: not its own precedent`);
    for (const other of book.filter((other) => other !== past)) {
      assert.ok(request.prompt.includes(`Case ${other.slug}: the owner's call was ${other.call}`), `${past.slug}: precedent ${other.slug}`);
      assert.ok(request.prompt.includes(other.reason), `${past.slug}: the reason of ${other.slug}`);
    }
  }
});

test("replay counts agreement with the owner's calls and prints disagreements first", async () => {
  const book = await readCaseBook(DEFAULT_CASE_BOOK);
  const runner = new ScriptedRunner();
  const [first, second, third, ...rest] = book;
  runner.script(JUDGMENT_KIND, ticket(first!), { output: verdict(first!.call === "go" ? "no" : "go", "entail disagreed here") });
  runner.script(JUDGMENT_KIND, ticket(second!), { failure: { kind: "timeout", message: "too slow" } });
  runner.script(JUDGMENT_KIND, ticket(third!), { output: verdict("ask") });
  for (const past of rest) runner.script(JUDGMENT_KIND, ticket(past), { output: verdict(past.call) });

  const results = await replay(runner, book, checkoutOf);
  assert.deepEqual(
    results.map((result) => result.agrees),
    [false, null, false, ...rest.map(() => true)],
  );

  const lines = formatReplay(results).split("\n");
  assert.match(lines[0]!, new RegExp(`^DISAGREE  ${first!.slug}\\s+owner ${first!.call}, entail \\w+: entail disagreed here$`, "u"));
  assert.match(lines[1]!, new RegExp(`^DISAGREE  ${third!.slug}\\s+owner ${third!.call}, entail ask: entail says ask Question: Which way\\?$`, "u"));
  assert.match(lines[2]!, new RegExp(`^FAILED    ${second!.slug}\\s+owner ${second!.call}, run failed \\(timeout\\): too slow$`, "u"));
  assert.ok(lines.slice(3, 3 + rest.length).every((line) => line.startsWith("agree")));
  assert.equal(lines.at(-1), `agreement: ${rest.length} of ${book.length} (1 failed to run)`);
});

test("a case's inputs read its vision as missing when it had none, and its repo has no pins", async () => {
  const [past] = await readCaseBook(DEFAULT_CASE_BOOK);
  const inputs = caseInputs({ ...past!, vision: "" }, [past!], { directory: "/c", commit: past!.visionCommit });
  assert.equal(inputs.vision, null);
  assert.deepEqual(inputs.pins, []);
  assert.deepEqual(inputs.precedents, []);
});
