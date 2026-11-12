import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  caseSlug,
  DEFAULT_CASE_BOOK,
  issueTitle,
  landingCaseSlug,
  parseCall,
  parseCriteria,
  precedentsFor,
  readCaseBook,
  readCaseBooks,
  readLandingCaseBook,
  readLandingCaseBooks,
  renderCall,
  renderCriteria,
  renderIssue,
  writeCase,
  writeLandingCase,
  type Case,
  type LandingCase,
} from "../src/case-book.ts";

function temporary(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "entail-cases-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the seeded case book holds the owner's five calls on this repo", async () => {
  const book = await readCaseBook(DEFAULT_CASE_BOOK);
  assert.deepEqual(
    book.map((past) => [past.repo, past.issue, past.call]),
    [
      ["omkarbhale/entail", 168, "go"],
      ["omkarbhale/entail", 169, "go"],
      ["omkarbhale/entail", 170, "go"],
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

test("a case written by the owner reads back, replaces an earlier one of the same issue, and wins over the shipped book", async (t) => {
  const owners = temporary(t);
  const shipped = await readCaseBook(DEFAULT_CASE_BOOK);
  const base = shipped.find((past) => past.slug === "omkarbhale-entail-174")!;
  assert.equal(caseSlug("OmkarBhale/entail", 174), "omkarbhale-entail-174");

  await writeCase(owners, { ...base, call: "go", reason: "First thought.", notes: "" });
  await writeCase(owners, { ...base, call: "go", reason: "On reflection, yes.", notes: "## The owner's words\n\n> yes" });
  const [written] = await readCaseBook(owners);
  assert.equal(written!.reason, "On reflection, yes.");
  assert.equal(written!.issueText, base.issueText);
  assert.equal(written!.vision, base.vision);

  const book = await readCaseBooks([DEFAULT_CASE_BOOK, owners, join(owners, "missing")]);
  assert.equal(book.length, shipped.length);
  assert.equal(book.find((past) => past.slug === base.slug)!.call, "go");
  await assert.rejects(writeCase(owners, { ...base, reason: "" }), /call.md has no reason/u);
});

test("a landing case is written and read back whole, beside issue cases, and a later book's case wins", async (t) => {
  const first = temporary(t);
  const second = temporary(t);
  const past: LandingCase = {
    kind: "landing",
    slug: landingCaseSlug("Acme/Tally", 14),
    repo: "acme/tally",
    issue: 12,
    pr: 14,
    head: "d".repeat(40),
    base: "c".repeat(40),
    issueText: "# Count words in footnotes\n\nFootnotes are skipped.\n",
    vision: "# Vision\n\ntally counts words offline.\n",
    visionCommit: "c".repeat(40),
    criteria: [
      { criterion: "Footnotes count toward the total.", basis: "reading: one total" },
      { criterion: "No new flag.", basis: "" },
    ],
    prText: "# Count footnotes\n\nCloses #12.\n",
    facts: { checks: [{ name: "test", status: "passed", reported: true, url: null }], required: [], files: [{ path: "src/count.ts", status: "modified", previousPath: null, additions: 4, deletions: 1 }] },
    call: "merge",
    reason: "It counts footnotes as the issue asks.",
    reasonFrom: "the owner's confirmation",
    date: "2026-11-12",
    notes: "## Notes\n\nNone.",
  };
  assert.equal(past.slug, "acme-tally-pr-14");
  await writeLandingCase(first, past);
  await writeCase(first, {
    slug: caseSlug("acme/tally", 12),
    repo: "acme/tally",
    issue: 12,
    issueText: past.issueText,
    vision: past.vision,
    visionCommit: past.visionCommit,
    call: "go",
    reason: "Useful.",
    reasonFrom: "the owner",
    date: "2026-11-12",
    notes: "",
  });
  assert.deepEqual(await readLandingCaseBook(first), [past]);
  assert.deepEqual((await readCaseBook(first)).map((c) => c.slug), ["acme-tally-12"], "the issue reader leaves landing cases out");

  await writeLandingCase(second, { ...past, call: "send-back", reason: "Tables are still skipped." });
  const merged = await readLandingCaseBooks([first, second, join(second, "missing")]);
  assert.deepEqual(merged.map((c) => [c.slug, c.call]), [["acme-tally-pr-14", "send-back"]]);
  assert.deepEqual(parseCriteria(renderCriteria(past.criteria)), past.criteria);
  assert.deepEqual(parseCriteria(renderCriteria([])), []);
});

test("a landing case with a call other than merge or send-back is refused, naming the case", async (t) => {
  const dir = temporary(t);
  const caseDir = join(dir, "acme-tally-pr-1");
  mkdirSync(caseDir);
  for (const name of ["issue.md", "vision.md", "criteria.md", "pr.md"]) writeFileSync(join(caseDir, name), "x\n");
  writeFileSync(join(caseDir, "facts.json"), '{"checks":[],"required":[],"files":[]}');
  writeFileSync(join(caseDir, "call.md"), "---\nkind: landing\nrepo: acme/tally\nissue: 1\npr: 2\nhead: h\nbase: b\ncall: go\ndate: 2026-11-12\nvision-commit: c\nreason-from: x\n---\n\nReason.\n");
  await assert.rejects(readLandingCaseBook(dir), /case acme-tally-pr-1: call\.md's call is go, not merge or send-back/u);
});
