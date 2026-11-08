import assert from "node:assert/strict";
import { test } from "node:test";
import { comparableIssueText, editedRequest, isIssueEdit, issueEditSince, latestIssueEditId, recordedIssueText } from "../src/issue-edit.ts";
import type { RequestPart } from "../src/intake.ts";
import type { CallRecord } from "../src/store.ts";
import { actor } from "./pass-fixture.ts";

const TEXT = {
  title: "Read from standard input",
  body: "When no file is given, read standard input.\n\n- [ ] read stdin\n- [x] keep files working\n",
};

test("whitespace-only changes are not edits: spaces, blank lines, line endings and indentation", () => {
  assert.equal(isIssueEdit(TEXT, { ...TEXT }), false);
  assert.equal(isIssueEdit(TEXT, { title: "  Read from   standard input ", body: TEXT.body }), false);
  assert.equal(isIssueEdit(TEXT, { title: TEXT.title, body: TEXT.body.replace(/\n/gu, "\r\n") }), false);
  assert.equal(isIssueEdit(TEXT, { title: TEXT.title, body: `\n\n${TEXT.body.replace("read stdin", "read  stdin")}\n\n\n` }), false);
  assert.equal(isIssueEdit(TEXT, { title: TEXT.title, body: TEXT.body.replace("- [ ] read", "  - [ ] read") }), false);
});

test("ticking or unticking a task-list checkbox is not an edit, whatever the bullet", () => {
  assert.equal(isIssueEdit(TEXT, { title: TEXT.title, body: TEXT.body.replace("- [ ] read stdin", "- [x] read stdin") }), false);
  assert.equal(isIssueEdit(TEXT, { title: TEXT.title, body: TEXT.body.replace("- [x] keep", "- [ ] keep") }), false);
  assert.equal(isIssueEdit(TEXT, { title: TEXT.title, body: TEXT.body.replace("- [ ] read stdin", "- [X] read stdin") }), false);
  for (const bullet of ["*", "+", "1.", "2)"]) {
    const before = `${bullet} [ ] a task`;
    assert.equal(isIssueEdit({ title: "t", body: before }, { title: "t", body: `${bullet} [x] a task` }), false, `${bullet} ticked`);
  }
  assert.equal(comparableIssueText("- [x] a\n* [X] b\n3. [x] c"), "- [ ] a * [ ] b 3. [ ] c");
});

test("a change to the title or the body's words is an edit, even alongside a tick", () => {
  assert.equal(isIssueEdit(TEXT, { title: "Read from stdin", body: TEXT.body }), true, "the title");
  assert.equal(isIssueEdit(TEXT, { title: TEXT.title, body: TEXT.body.replace("read standard input", "read standard input, or fail") }), true, "the body");
  assert.equal(isIssueEdit(TEXT, { title: TEXT.title, body: TEXT.body.replace("- [ ] read stdin", "- [x] read stdin, and stdin only") }), true, "a tick with new words");
  assert.equal(isIssueEdit(TEXT, { title: TEXT.title, body: TEXT.body.replace("- [ ] read stdin", "- [ ] read stdin\n- [ ] a new task") }), true, "a new task");
  assert.equal(isIssueEdit(TEXT, { title: TEXT.title, body: TEXT.body.replace("read stdin", "readstdin") }), true, "joining two words is no whitespace-only change");
  // A checkbox-like text that is no task-list item is words like any other.
  assert.equal(isIssueEdit({ title: "t", body: "use [ ] for empty" }, { title: "t", body: "use [x] for empty" }), true);
});

function call(id: number, kind: CallRecord["kind"], inputs: CallRecord["inputs"]): CallRecord {
  return { id, kind, inputs } as CallRecord;
}

test("an edit since a judgment is the text recorded since against the text it read; an issue edited back has none", () => {
  const judgment = call(2, "criteria", { issueTitle: "A", issueBody: "B", visionSha: "v" });
  const calls = [call(1, "intake", { issueTitle: "A", issueBody: "B" }), judgment];
  assert.equal(issueEditSince(judgment, calls), null);
  assert.equal(latestIssueEditId(calls), 0);

  const edited = [...calls, call(3, "issue-edit", { issueTitle: "A", issueBody: "B, edited" })];
  assert.deepEqual(issueEditSince(judgment, edited), { from: { title: "A", body: "B" }, to: { title: "A", body: "B, edited" }, editCallIds: [3] });
  assert.equal(latestIssueEditId(edited), 3);
  assert.deepEqual(recordedIssueText(edited), { title: "A", body: "B, edited" });
  assert.deepEqual(recordedIssueText([...edited, call(9, "raise", { issueTitle: "A", issueBody: "B" })]), { title: "A", body: "B, edited" }, "a raise repeats an older call's inputs");

  const twice = [...edited, call(4, "issue-edit", { issueTitle: "A2", issueBody: "B, edited" })];
  assert.deepEqual(issueEditSince(judgment, twice)?.editCallIds, [3, 4], "a second edit is judged with the first");
  assert.equal(issueEditSince(judgment, [...edited, call(4, "issue-edit", { issueTitle: "A", issueBody: "B " })]), null, "edited back to the text judged");
});

test("the edited request replaces the title and body, keeping their authors and the comments", () => {
  const author = actor(1001);
  const parts: RequestPart[] = [
    { part: "title", author, text: "Old title" },
    { part: "body", author, text: "Old body" },
    { part: "comment", commentId: 5, author: actor(2), createdAt: "2026-11-08T12:31:00.000Z", text: "A comment." },
  ];
  assert.deepEqual(editedRequest({ title: "Old title", body: "Old body", parts }, { title: "New title", body: "New body" }), [
    { part: "title", author, text: "New title" },
    { part: "body", author, text: "New body" },
    parts[2],
  ]);
});
