import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunReport } from "./checks.ts";
import { renderRun } from "./report.ts";

test("a run's report shows fixture issue and PR numbers as code, so they never link to entail's own", () => {
  const report: RunReport = {
    forge: "github",
    repo: "o/entail-fixture-tally",
    run: 1,
    startedAt: "2026-11-09T10:00:00Z",
    finishedAt: "2026-11-09T11:00:00Z",
    settled: false,
    tickets: [
      {
        id: "T11",
        issue: 113,
        expectedEnd: "merged",
        endState: "landing",
        path: "deciding → cleared (settled) → landing",
        clearedAutomatically: true,
        clearedAs: "settled",
        wrongClear: false,
        extraItems: 0,
        endsAsExpected: false,
        why: ["T11 ended landing, not merged"],
        modelRuns: 4,
        costUsd: 1.25,
      },
    ],
    checks: [{ id: 7, name: "merges", passed: false, failures: ["PR #119 merged at abc1234 with no merge call"] }],
    extraBoardItems: [{ ticket: "T5", issue: 107, item: 3, whyRaised: "pin", decision: "Go ahead with issue #107?", answered: "x" }],
    modelRuns: 4,
    costUsd: 1.25,
    passed: false,
  };
  const text = renderRun(report);
  assert.doesNotMatch(text, /(?<!`)#\d+/);
  assert.match(text, /`#113`/);
  assert.match(text, /PR `#119` merged/);
  assert.match(text, /issue `#107`\), item 3/);
  assert.match(text, /\$1\.25/);
  assert.match(text, /ended \(stalled or at the time limit\)/);
});
