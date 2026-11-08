import assert from "node:assert/strict";
import { test } from "node:test";
import { evidenceFor, latestEvidence, parseEvidenceSection } from "../src/evidence.ts";
import type { PullRequestComment } from "../src/forge/forge.ts";
import { actor } from "./pass-fixture.ts";

const AUTHOR = actor(2001, "executor");

function prComment(id: number, body: string, fields: Partial<PullRequestComment> = {}): PullRequestComment {
  return {
    id,
    pullRequestNumber: 12,
    body,
    author: AUTHOR,
    createdAt: `2026-11-09T10:${String(id % 60).padStart(2, "0")}:00.000Z`,
    updatedAt: `2026-11-09T10:${String(id % 60).padStart(2, "0")}:00.000Z`,
    url: `https://github.com/acme/tally/pull/12#issuecomment-${id}`,
    ...fields,
  };
}

test("an evidence section is read by id from under its heading, up to the next heading", () => {
  const body = [
    "Counts hyphenated words as one.",
    "",
    "## entail evidence",
    "",
    "C1: ran `tally a-b.txt` — it printed 1",
    "- C2: ran `tally --lines x` — it printed 3",
    "  and the man page says so",
    "**G1**: ran `npm test` — 42 passed",
    "",
    "## Notes",
    "C3: not evidence, this is under another heading",
  ].join("\n");
  const parsed = parseEvidenceSection(body);
  assert.ok(parsed);
  assert.deepEqual(parsed.entries, {
    C1: "ran `tally a-b.txt` — it printed 1",
    C2: "ran `tally --lines x` — it printed 3\nand the man page says so",
    G1: "ran `npm test` — 42 passed",
  });
  assert.match(parsed.section, /^## entail evidence\n/);
  assert.doesNotMatch(parsed.section, /Notes/);
});

test("the heading is matched without case, as a heading, a bold line or a line alone; the last section in a body counts", () => {
  for (const heading of ["# Entail Evidence", "**entail evidence**", "entail evidence:", "### entail evidence ###"]) {
    assert.deepEqual(parseEvidenceSection(`${heading}\nC1: ran it — ok`)?.entries, { C1: "ran it — ok" }, heading);
  }
  const twice = "## entail evidence\nC1: first — failed\n\n## entail evidence\nC1: second — passed\n";
  assert.deepEqual(parseEvidenceSection(twice)?.entries, { C1: "second — passed" });
});

test("a section quoted in a code fence is not a section, and a body without one has no evidence", () => {
  assert.equal(parseEvidenceSection("Report like this:\n\n```\n## entail evidence\nC1: <what> — <result>\n```\n"), null);
  assert.equal(parseEvidenceSection("Just a description."), null);
  assert.deepEqual(parseEvidenceSection("## entail evidence\nC1: first — ok\nC1: again — ignored\n")?.entries, { C1: "first — ok" });
});

test("the latest section counts: an author's comment over the description, the latest comment over earlier ones", () => {
  const pr = { body: "## entail evidence\nC1: from the description — ok", author: AUTHOR };
  assert.deepEqual(latestEvidence(pr, [])?.source, { kind: "description" });
  assert.equal(latestEvidence(pr, [])?.entries.C1, "from the description — ok");

  const comments = [
    prComment(1, "## entail evidence\nC1: first comment — failed"),
    prComment(2, "## entail evidence\nC1: second comment — passed"),
    prComment(3, "Looks good to me."),
  ];
  const latest = latestEvidence(pr, comments);
  assert.equal(latest?.entries.C1, "second comment — passed");
  assert.deepEqual(latest?.source, { kind: "comment", commentId: 2, url: comments[1]!.url, updatedAt: comments[1]!.updatedAt });

  // An earlier comment edited after the later one was posted is the latest written.
  const edited = [comments[0]!, comments[1]!].map((c, i) => (i === 0 ? { ...c, updatedAt: "2026-11-09T11:00:00.000Z" } : c));
  assert.equal(latestEvidence(pr, edited)?.entries.C1, "first comment — failed");
});

test("a section in someone else's comment does not count, whoever they are", () => {
  const pr = { body: "No evidence here.", author: AUTHOR };
  const stranger = prComment(4, "## entail evidence\nC1: ran it — passed", { author: actor(2002, "stranger") });
  const sameName = prComment(5, "## entail evidence\nC1: ran it — passed", { author: actor(2003, "executor") });
  assert.equal(latestEvidence(pr, [stranger, sameName]), null);
});

test("a criterion with no entry is not met", () => {
  const evidence = latestEvidence({ body: "## entail evidence\nC1: ran it — passed", author: AUTHOR }, []);
  assert.deepEqual(evidenceFor(evidence, ["C1", "C2", "G1"]), { C1: "ran it — passed", C2: null, G1: null });
  assert.deepEqual(evidenceFor(null, ["C1"]), { C1: null });
});
