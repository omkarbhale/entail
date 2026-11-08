import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ciFilesAndBuildScripts,
  describeCheck,
  genericCriteriaProposalPrompt,
  normalizeRow,
  numberGenericCriteria,
  reportedCheckNames,
  rowProblems,
  unseenCheck,
  type GenericCriterionRow,
} from "../src/generic-criteria.ts";
import { Git } from "../src/git.ts";
import { FixtureRepo } from "./git-fixture.ts";

const TEST: GenericCriterionRow = { sentence: "The check `test` passes.", check: { kind: "check_passes", argument: "test" }, sourceFile: "ci.yml" };

test("the CI files and build scripts are found by their usual names", async (t) => {
  const repo = new FixtureRepo(t);
  for (const path of [
    ".github/workflows/ci.yml",
    ".github/workflows/release.yaml",
    ".github/workflows/notes.md",
    ".gitlab-ci.yml",
    ".gitlab/ci/test.yml",
    "package.json",
    "Makefile",
    "pyproject.toml",
    "packages/app/package.json",
    "src/index.js",
  ]) {
    repo.write(path, "x\n");
  }
  const sha = repo.commit("files");
  assert.deepEqual(await ciFilesAndBuildScripts(new Git(`${repo.work}/.git`), sha), [
    ".github/workflows/ci.yml",
    ".github/workflows/release.yaml",
    ".gitlab-ci.yml",
    ".gitlab/ci/test.yml",
    "Makefile",
    "package.json",
    "pyproject.toml",
  ]);
});

test("the checks seen are those that reported on any recent commit, each once", () => {
  assert.deepEqual(
    reportedCheckNames([
      { sha: "a", checks: [{ name: "test", status: "passed", reported: true, url: null }] },
      {
        sha: "b",
        checks: [
          { name: "lint", status: "failed", reported: true, url: null },
          { name: "test", status: "pending", reported: true, url: null },
          { name: "never", status: "pending", reported: false, url: null },
        ],
      },
    ]),
    ["lint", "test"],
  );
});

test("a named check that has not reported on recent default-branch commits is unseen", () => {
  assert.equal(unseenCheck(TEST, ["lint", "test"]), null);
  assert.equal(unseenCheck(TEST, ["lint"]), "test");
  assert.equal(unseenCheck(TEST, []), "test");
  assert.equal(unseenCheck(TEST, null), "test", "unconfirmed when the checks could not be read");
  assert.equal(unseenCheck({ ...TEST, check: null }, []), null, "no check named");
  assert.equal(unseenCheck({ ...TEST, check: { kind: "leaves_path", argument: "dist/**" } }, []), null, "a path check names no check");
});

test("a row is kept on one line, trimmed, with an empty source as none", () => {
  assert.deepEqual(normalizeRow({ sentence: " The check\n `test`  passes. ", check: { kind: "check_passes", argument: " test\n" }, sourceFile: "  " }), {
    sentence: "The check `test` passes.",
    check: { kind: "check_passes", argument: "test" },
    sourceFile: null,
  });
});

test("a row needs a sentence not starting with /, and a check needs its argument", () => {
  assert.deepEqual(rowProblems(TEST), []);
  assert.match(rowProblems({ ...TEST, check: null }).join(), /needs a mechanical check/);
  assert.match(rowProblems({ ...TEST, sentence: "" }).join(), /needs a sentence/);
  assert.match(rowProblems({ ...TEST, sentence: "/label ~bug" }).join(), /cannot start with \//);
  assert.match(rowProblems({ ...TEST, check: { kind: "check_passes", argument: "" } }).join(), /needs a check name/);
  assert.match(rowProblems({ ...TEST, check: { kind: "changes_path", argument: "" } }).join(), /needs a path glob/);
});

test("rows are numbered G1…Gn in order, and checks read plainly", () => {
  assert.deepEqual(
    numberGenericCriteria([TEST, { ...TEST, sentence: "Two." }]).map((c) => [c.id, c.sentence]),
    [
      ["G1", "The check `test` passes."],
      ["G2", "Two."],
    ],
  );
  assert.equal(describeCheck(TEST.check), "the check `test` passes");
  assert.equal(describeCheck({ kind: "leaves_path", argument: "VISION.md" }), "the PR changes no file matching `VISION.md`");
  assert.equal(describeCheck(null), "none");
});

test("the prompt names the files and checks, and says when there are none", () => {
  const prompt = genericCriteriaProposalPrompt({ defaultBranch: "main", sha: "abc", files: [], seenChecks: [] });
  assert.match(prompt, /No CI file or build script was found/);
  assert.match(prompt, /No check reported/);
  assert.doesNotMatch(prompt, /^\//mu, "no line starts with /");
});
