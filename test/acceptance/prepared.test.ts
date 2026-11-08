import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { FIXTURE_ISSUES, startingTree, type TicketId, type Tree } from "./fixture.ts";
import { applyPrepared, EXPECTED_ANSWERS, EXTRA_ANSWERS, PREPARED_CHANGES, PREPARED_FINDINGS } from "./prepared.ts";
import { runTests, writeTree } from "./tree.ts";

function scratch(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "entail-acceptance-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function testsOf(t: TestContext, tree: Tree) {
  const directory = scratch(t);
  writeTree(directory, tree);
  return { directory, run: runTests(directory) };
}

function tally(directory: string, args: string[], input?: string) {
  return spawnSync(process.execPath, [join(directory, "src/cli.js"), ...args], { encoding: "utf8", input });
}

const ids = [...PREPARED_CHANGES.keys()];

function applyAll(tree: Tree, order: readonly TicketId[]): Tree {
  let next = tree;
  for (const id of order) next = applyPrepared(next, PREPARED_CHANGES.get(id)!);
  return next;
}

test("the starting tree's own tests pass, so CI on the default branch is green", (t) => {
  const { run } = testsOf(t, startingTree());
  assert.equal(run.passed, true, run.output);
  assert.equal(run.pass, 2);
});

test("the starting code has the behaviour the issues report (#28)", (t) => {
  const { directory } = testsOf(t, startingTree());
  writeFileSync(join(directory, "leading.txt"), " one two\n");

  const noFile = tally(directory, [], "one two\n");
  assert.equal(noFile.stdout, "", "it does not read standard input");

  const missing = tally(directory, ["missing.txt"]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /ENOENT[\s\S]*\n\s+at /, "it crashes with a stack trace");

  const leading = tally(directory, [join(directory, "leading.txt")]);
  assert.equal(leading.stdout.trim().split(/ +/)[1], "3", "a leading space counts an extra word");

  assert.match(tally(directory, ["--help"]).stdout, /^Usage: tally/);
});

test("the fixture's VISION.md is the 9-line vision recorded on #28", () => {
  const vision = startingTree().get("VISION.md")!;
  assert.equal(vision.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("## ")).length, 9);
  assert.match(vision, /^A word is a run of characters between whitespace\.$/m);
  assert.match(vision, /^tally never reaches the network\.$/m);
});

test("every prepared change passes tally's tests on the starting tree, except T1's first push", (t) => {
  for (const [id, change] of PREPARED_CHANGES) {
    for (let steps = 1; steps <= change.steps.length; steps += 1) {
      const { run } = testsOf(t, applyPrepared(startingTree(), change, steps));
      const shouldFail = id === "T1" && steps === 1;
      assert.equal(run.passed, !shouldFail, `${id} after ${steps} step(s):\n${run.output}`);
    }
  }
});

test("no prepared change touches VISION.md, and only T9 touches the pinned src/format.js", () => {
  const start = startingTree();
  for (const [id, change] of PREPARED_CHANGES) {
    const after = applyPrepared(start, change);
    assert.equal(after.get("VISION.md"), start.get("VISION.md"), id);
    assert.equal(after.get("src/format.js") !== start.get("src/format.js"), id === "T9", id);
  }
});

test("the prepared changes apply on top of each other in any order of the ones that share code", (t) => {
  const rest: TicketId[] = ["T1", "T2", "T5", "T6", "T9"];
  const shared: TicketId[][] = [
    ["T3", "T11", "T13"],
    ["T3", "T13", "T11"],
    ["T11", "T3", "T13"],
    ["T11", "T13", "T3"],
    ["T13", "T3", "T11"],
    ["T13", "T11", "T3"],
  ];
  for (const order of shared) {
    const { run } = testsOf(t, applyAll(startingTree(), [...order, ...rest]));
    assert.equal(run.passed, true, `${order.join(", ")}:\n${run.output}`);
  }
  const { run } = testsOf(t, applyAll(startingTree(), [...ids].reverse()));
  assert.equal(run.passed, true, run.output);
});

test("open PRs merge without conflicts, except the ones that share the counting code", (t) => {
  const start = startingTree();
  const directory = scratch(t);
  const conflicting = new Set<string>();
  for (const [i, a] of ids.entries()) {
    for (const b of ids.slice(i + 1)) {
      const ours = applyPrepared(start, PREPARED_CHANGES.get(a)!);
      const theirs = applyPrepared(start, PREPARED_CHANGES.get(b)!);
      for (const path of new Set([...ours.keys(), ...theirs.keys()])) {
        const base = start.get(path);
        const mine = ours.get(path);
        const other = theirs.get(path);
        if (mine === base || other === base || mine === other) continue;
        // Both sides changed the file: a three-way merge, as the forge does.
        writeFileSync(join(directory, "base"), base ?? "");
        writeFileSync(join(directory, "ours"), mine ?? "");
        writeFileSync(join(directory, "theirs"), other ?? "");
        const merge = spawnSync("git", ["merge-file", "-p", "ours", "base", "theirs"], { cwd: directory });
        if (merge.status !== 0) conflicting.add(`${a}+${b}`);
      }
    }
  }
  assert.deepEqual([...conflicting].sort(), ["T11+T13", "T3+T11", "T3+T13"]);
});

test("prepared work covers every expected path in the outcomes table", () => {
  for (const issue of FIXTURE_ISSUES) {
    const change = PREPARED_CHANGES.has(issue.id);
    assert.equal(change, issue.expectedEnd === "merged", `${issue.id} has a prepared PR exactly when it is expected to merge`);
  }
  assert.ok(PREPARED_FINDINGS.has("T11"));
  assert.match(PREPARED_FINDINGS.get("T11")!, /a leading space counts as a word/);
  assert.equal(PREPARED_CHANGES.get("T1")!.steps.length, 2, "T1's first PR fails CI and gets a fix");
  assert.deepEqual([...EXPECTED_ANSWERS.keys()].sort(), ["T13", "T7", "T9"]);
  assert.equal(EXPECTED_ANSWERS.has("T8"), false, "T8 is left unanswered");
  for (const issue of FIXTURE_ISSUES.filter((i) => i.expectedEnd === "merged" && !EXPECTED_ANSWERS.has(i.id))) {
    assert.ok(EXTRA_ANSWERS.has(issue.id), `${issue.id} has an answer for an extra board item`);
  }
});
