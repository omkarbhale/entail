import assert from "node:assert/strict";
import { test } from "node:test";
import { main, parseIssueReference } from "../src/cli.ts";

test("an issue reference is owner/repo#number", () => {
  assert.deepEqual(parseIssueReference("omkarbhale/entail#179"), { path: "omkarbhale/entail", number: 179 });
  for (const bad of ["omkarbhale/entail", "entail#3", "a/b#0", "a/b#x", "https://github.com/a/b/issues/3"]) {
    assert.throws(() => parseIssueReference(bad), /not an issue reference/u, bad);
  }
});

test("a usage error exits 2 without reaching a forge or a model", async (t) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (message: string) => errors.push(message));
  t.mock.method(console, "log", () => {});
  assert.equal(await main(["judge"]), 2);
  assert.equal(await main(["judge", "a/b#1", "--effort", "huge"]), 2);
  assert.equal(await main(["replay", "--concurrency", "0"]), 2);
  assert.equal(await main(["replay", "extra"]), 2);
  assert.equal(await main(["frobnicate"]), 2);
  assert.equal(await main([]), 2);
  assert.equal(await main(["--help"]), 0);
  assert.match(errors[1]!, /--effort must be one of low, medium, high, xhigh, max/u);
});
