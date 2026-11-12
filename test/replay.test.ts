import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CASE_BOOK, readCaseBook, readLandingCaseBook, type Case, type LandingCase } from "../src/case-book.ts";
import { JUDGMENT_KIND, type Verdict } from "../src/judgment.ts";
import { LANDING_KIND, type LandingAnswer } from "../src/landing.ts";
import { caseInputs, formatReplay, landingCaseInputs, replay, replayLandings } from "../src/replay.ts";
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
  assert.match(lines[0]!, new RegExp(`^DISAGREE  issue    ${first!.slug}\\s+owner ${first!.call}, entail \\w+: entail disagreed here$`, "u"));
  assert.match(lines[1]!, new RegExp(`^DISAGREE  issue    ${third!.slug}\\s+owner ${third!.call}, entail ask: entail says ask Question: Which way\\?$`, "u"));
  assert.match(lines[2]!, new RegExp(`^FAILED    issue    ${second!.slug}\\s+owner ${second!.call}, run failed \\(timeout\\): too slow$`, "u"));
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

const landingReading = async (past: LandingCase) => ({ checkout: `/checkouts/${past.head}`, diff: `diff --git a/x b/x\n+the diff of ${past.slug}\n` });

function landing(past: LandingCase, call: LandingAnswer["call"]): LandingAnswer {
  return {
    call,
    reason: `entail says ${call}`,
    solves: { solved: call === "merge", evidence: "" },
    criteria: past.criteria.map((c) => ({ criterion: c.criterion, met: true, evidence: "" })),
    beyond: [],
    needs_to_change: call === "send-back" ? ["Change it."] : [],
    product_call: false,
    question: call === "ask" ? { question: "Merge?", why: "Unsure." } : null,
    rests_on: { vision_lines: [], cases: [] },
  };
}

test("the shipped book holds landing cases for PRs #172 and #175, both merged by the owner's call, and issue replay leaves them out", async () => {
  const landings = await readLandingCaseBook(DEFAULT_CASE_BOOK);
  assert.deepEqual(
    landings.map((past) => [past.slug, past.pr, past.issue, past.call]),
    [
      ["omkarbhale-entail-pr-172", 172, 168, "merge"],
      ["omkarbhale-entail-pr-175", 175, 169, "merge"],
    ],
  );
  const issues = await readCaseBook(DEFAULT_CASE_BOOK);
  assert.ok(issues.every((past) => !past.slug.includes("-pr-")));
  const board = landings[1]!;
  assert.equal(board.criteria.length, 5);
  assert.ok(board.facts.checks.every((check) => check.status === "passed"), "CI passed at the judged head");
  assert.ok(board.facts.files.some((file) => file.path === "package.json"));
});

test("every landing case is judged at its PR's head, against its own criteria, vision and recorded facts, with the other cases as precedent", async () => {
  const book = await readLandingCaseBook(DEFAULT_CASE_BOOK);
  const runner = new ScriptedRunner();
  for (const past of book) runner.script(LANDING_KIND, `${past.repo}#${past.pr}`, { output: landing(past, past.call) });
  const results = await replayLandings(runner, book, landingReading);
  assert.deepEqual(results.map((result) => result.agrees), book.map(() => true));
  for (const past of book) {
    const request = runner.requests.find((made) => made.ticket === `${past.repo}#${past.pr}`)!;
    assert.equal(request.sha, past.head);
    assert.equal(request.checkout, `/checkouts/${past.head}`);
    assert.ok(request.prompt.includes(`the diff of ${past.slug}`));
    assert.ok(request.prompt.includes(past.vision.trim()));
    for (const criterion of past.criteria) assert.ok(request.prompt.includes(criterion.criterion));
    assert.ok(request.prompt.includes("CI: green."));
    assert.ok(!request.prompt.includes(`Case ${past.slug}:`), "not its own precedent");
    for (const other of book.filter((o) => o !== past)) assert.ok(request.prompt.includes(`Case ${other.slug}: the owner's call was ${other.call}`));
  }
  const inputs = landingCaseInputs(book[0]!, book, { checkout: "/c", diff: "" });
  assert.deepEqual(inputs.pins, []);
  assert.deepEqual(inputs.sendBacks, []);
});

test("the replay report names each case's kind, disagreements first, with what entail would have changed", async () => {
  const issues = await readCaseBook(DEFAULT_CASE_BOOK);
  const landings = await readLandingCaseBook(DEFAULT_CASE_BOOK);
  const runner = new ScriptedRunner();
  for (const past of issues) runner.script(JUDGMENT_KIND, ticket(past), { output: verdict(past.call) });
  const [refused, merged] = landings;
  runner.script(LANDING_KIND, `${refused!.repo}#${refused!.pr}`, {
    output: { ...landing(refused!, "send-back"), beyond: [{ change: "A hover style.", sort: "unwanted", why: "Not asked for." }], needs_to_change: ["Drop the hover style."] },
  });
  runner.script(LANDING_KIND, `${merged!.repo}#${merged!.pr}`, { output: landing(merged!, "merge") });
  const results = await replay(runner, issues, checkoutOf);
  const landed = await replayLandings(runner, landings, landingReading);
  const lines = formatReplay(results, landed).split("\n");
  assert.match(lines[0]!, new RegExp(`^DISAGREE  landing  ${refused!.slug}\\s+owner merge, entail send-back: entail says send-back Needs to change: Drop the hover style\\. Unwanted: A hover style\\.$`, "u"));
  assert.ok(lines.some((line) => new RegExp(`^agree     landing  ${merged!.slug}\\s+owner merge, entail merge$`, "u").test(line)));
  assert.equal(lines.at(-1), `agreement: ${issues.length + 1} of ${issues.length + 2}`);
});
