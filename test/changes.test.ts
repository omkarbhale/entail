import assert from "node:assert/strict";
import { test } from "node:test";
import { ChangeDeduplicator } from "../src/changes.ts";
import type { Change, Issue, IssueComment } from "../src/forge/forge.ts";

function issueChange(id: number, updatedAt: string): Change {
  const issue = { id, updatedAt } as Issue;
  return { kind: "issue", id, updatedAt, issue };
}

function commentChange(id: number, updatedAt: string): Change {
  return { kind: "issue-comment", id, updatedAt, comment: { id, updatedAt } as IssueComment };
}

test("a change passes once by kind, id and update time", () => {
  const dedup = new ChangeDeduplicator();
  const a = issueChange(1, "2026-11-01T10:00:00.000Z");
  assert.deepEqual(dedup.fresh([a, a]), [a]);
  assert.deepEqual(dedup.fresh([a]), []);
});

test("a later update to the same item passes again, and an older copy does not", () => {
  const dedup = new ChangeDeduplicator();
  const first = issueChange(1, "2026-11-01T10:00:00.000Z");
  const edited = issueChange(1, "2026-11-01T12:00:00.000Z");
  assert.deepEqual(dedup.fresh([first]), [first]);
  assert.deepEqual(dedup.fresh([edited, first]), [edited]);
});

test("an issue and a comment with the same id are different changes", () => {
  const dedup = new ChangeDeduplicator();
  const issue = issueChange(7, "2026-11-01T10:00:00.000Z");
  const comment = commentChange(7, "2026-11-01T10:00:00.000Z");
  assert.deepEqual(dedup.fresh([issue, comment]), [issue, comment]);
});
