import assert from "node:assert/strict";
import { test } from "node:test";
import { issueNumbersInBranch, smallerPage } from "../../src/forge/forge.ts";

test("a branch name names the issues its separated runs of digits are, each once", () => {
  assert.deepEqual(issueNumbersInBranch("235-base-branch"), [235]);
  assert.deepEqual(issueNumbersInBranch("fm/entail-235-base-branch"), [235]);
  assert.deepEqual(issueNumbersInBranch("fix/issue#12_and.7-12"), [12, 7]);
  assert.deepEqual(issueNumbersInBranch("v2-docs"), []);
  assert.deepEqual(issueNumbersInBranch("utf8"), []);
  assert.deepEqual(issueNumbersInBranch("0-zero"), []);
});

test("a smaller page starts at the same item: page sizes run 100, 50, 25, 5, 1, and the page number follows", () => {
  assert.equal(smallerPage("projects/a%2Fb/merge_requests?order_by=updated_at&per_page=100"), "projects/a%2Fb/merge_requests?order_by=updated_at&per_page=50");
  assert.equal(smallerPage("issues?per_page=100&page=1"), "issues?per_page=50&page=1");
  assert.equal(smallerPage("issues?per_page=100&page=2"), "issues?per_page=50&page=3");
  assert.equal(smallerPage("issues?per_page=50&page=3"), "issues?per_page=25&page=5");
  assert.equal(smallerPage("issues?per_page=25&page=5"), "issues?per_page=5&page=21");
  assert.equal(smallerPage("issues?per_page=5&page=21"), "issues?per_page=1&page=101");
  assert.equal(smallerPage("commits?sha=main&per_page=7"), "commits?sha=main&per_page=1");
  assert.equal(smallerPage("issues?per_page=1&page=101"), null, "one item is the smallest page");
  assert.equal(smallerPage("issues?state=open"), null, "a path with no page size is not shrunk");
  assert.equal(smallerPage("repos/a/b/pulls/4"), null);
});
