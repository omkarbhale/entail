import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { DEFAULT_CASE_BOOK, issueTitle, parseCall, precedentsFor, readCaseBook, renderCall, renderIssue, type Case } from "../src/case-book.ts";

function temporary(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "entail-cases-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the seeded case book holds the owner's six calls on this repo", async () => {
  const book = await readCaseBook(DEFAULT_CASE_BOOK);
  assert.deepEqual(
    book.map((past) => [past.repo, past.issue, past.call]),
    [
      ["omkarbhale/entail", 168, "go"],
      ["omkarbhale/entail", 169, "go"],
      ["omkarbhale/entail", 170, "go"],
      ["omkarbhale/entail", 173, "no"],
      ["omkarbhale/entail", 174, "no"],
      ["omkarbhale/entail", 177, "go"],
    ],
  );
  for (const past of book) {
    assert.match(past.issueText, /^# \S/u, `${past.slug} has its issue`);
    assert.match(past.vision, /^# Vision/u, `${past.slug} has its vision`);
    assert.match(past.visionCommit, /^[0-9a-f]{40}$/u, `${past.slug} names a full vision commit`);
    assert.notEqual(past.reason, "", `${past.slug} has a reason`);
    assert.notEqual(past.reasonFrom, "", `${past.slug} says where its reason comes from`);
  }
  // The owner's edit on #169 asks for React; the case keeps it.
  assert.match(book.find((past) => past.issue === 169)!.issueText, /React/u);
});

test("call.md reads back what was written", () => {
  const call = {
    repo: "acme/tally",
    issue: 7,
    call: "no" as const,
    date: "2026-11-12",
    visionCommit: "a".repeat(40),
    reason: "Telemetry goes against the vision.",
    reasonFrom: "the owner's comment on the issue",
    notes: "## The owner's words\n\n> no network, ever",
  };
  assert.deepEqual(parseCall(renderCall(call)), call);
  assert.deepEqual(parseCall(renderCall({ ...call, notes: "" })), { ...call, notes: "" });
});

test("a call.md without a call the owner makes, a reason or a field is refused, naming what is wrong", () => {
  const good = renderCall({ repo: "acme/tally", issue: 7, call: "go", date: "2026-11-12", visionCommit: "a".repeat(40), reason: "r", reasonFrom: "f", notes: "" });
  assert.throws(() => parseCall(good.replace("call: go", "call: ask")), /not go or no/u);
  assert.throws(() => parseCall(good.replace("\nr\n", "\n")), /no reason/u);
  assert.throws(() => parseCall(good.replace(/reason-from: f\n/u, "")), /no reason-from/u);
  assert.throws(() => parseCall("just text"), /no front matter/u);
});

test("a malformed case is named when the book is read", async (t) => {
  const dir = temporary(t);
  mkdirSync(join(dir, "broken"));
  for (const name of ["issue.md", "vision.md"]) writeFileSync(join(dir, "broken", name), "# x\n");
  writeFileSync(join(dir, "broken", "call.md"), "no front matter\n");
  await assert.rejects(readCaseBook(dir), /case broken: call.md has no front matter/u);
});

test("an issue renders with its title, body and comments in order", () => {
  const text = renderIssue({
    title: "Add a dark theme",
    body: "Please.\r\n",
    comments: [
      { author: "ana", createdAt: "2026-11-01T00:00:00Z", body: "Me too." },
      { author: "bo", createdAt: "2026-11-02T00:00:00Z", body: "Same." },
    ],
  });
  assert.equal(issueTitle(text), "Add a dark theme");
  assert.match(text, /^# Add a dark theme\n\nPlease\.\n\n## Comments\n\n\*\*ana\*\*, 2026-11-01T00:00:00Z:\n\nMe too\.\n\n\*\*bo\*\*/u);
  assert.match(renderIssue({ title: "t", body: "", comments: [] }), /\(no description\)/u);
});

function fakeCase(slug: string, repo: string, issueText: string): Case {
  return { slug, repo, issue: 1, issueText, vision: "", visionCommit: "a".repeat(40), call: "go", reason: "r", reasonFrom: "f", date: "2026-11-12", notes: "" };
}

test("precedents are the same repo's cases first, then the ones sharing the most words", () => {
  const book = [
    fakeCase("a", "acme/other", "# dark theme for the board\n"),
    fakeCase("b", "acme/tally", "# export to csv\n"),
    fakeCase("c", "acme/tally", "# dark theme toggle\n"),
    fakeCase("d", "acme/other", "# unrelated words entirely\n"),
  ];
  assert.deepEqual(
    precedentsFor(book, "acme/tally", "# a dark theme\n").map((past) => past.slug),
    ["c", "b", "a", "d"],
  );
  assert.deepEqual(
    precedentsFor(book, "acme/tally", "# a dark theme\n", 2).map((past) => past.slug),
    ["c", "b"],
  );
});
