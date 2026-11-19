import assert from "node:assert/strict";
import { test } from "node:test";
import { issueNumbersInBranch } from "../../src/forge/forge.ts";

test("a branch name names the issues its separated runs of digits are, each once", () => {
  assert.deepEqual(issueNumbersInBranch("235-base-branch"), [235]);
  assert.deepEqual(issueNumbersInBranch("fm/entail-235-base-branch"), [235]);
  assert.deepEqual(issueNumbersInBranch("fix/issue#12_and.7-12"), [12, 7]);
  assert.deepEqual(issueNumbersInBranch("v2-docs"), []);
  assert.deepEqual(issueNumbersInBranch("utf8"), []);
  assert.deepEqual(issueNumbersInBranch("0-zero"), []);
});
