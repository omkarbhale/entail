import assert from "node:assert/strict";
import { test } from "node:test";
import { failingLandingComment, isEntailComment, listedIds } from "./comments.ts";
import type { Comment } from "./forge.ts";

const comment = (id: number, body: string): Comment => ({ id, body, createdAt: `2026-11-08T10:00:0${id}Z`, author: "owner" });

test("entail's comments are known by the attribution line, for any owner's name", () => {
  assert.equal(isEntailComment("Speaking from Omkar's entail:\n\nbody"), true);
  assert.equal(isEntailComment("\nSpeaking from James' entail:\nbody"), true);
  assert.equal(isEntailComment("## entail evidence\n\nC1: x — y"), false);
  assert.equal(isEntailComment("I was Speaking from Omkar's entail: earlier"), false);
});

test("ids are read from the start of a line, whatever markdown entail wraps them in", () => {
  const body = [
    "- **C1** — Reads standard input.",
    "2. `C2`: Exits non-zero.",
    "| C3 | Counts words | changes path `src/**` |",
    "> C4 inside a quote block counts too.",
    "C1 again is ignored",
    "See C5 in the middle of a line.",
    "### G1 The CI job `test` passes.",
  ].join("\n");
  assert.deepEqual(listedIds(body, "C"), [
    { id: "C1", text: "Reads standard input." },
    { id: "C2", text: "Exits non-zero." },
    { id: "C3", text: "Counts words  changes path src/" },
    { id: "C4", text: "inside a quote block counts too." },
  ]);
  assert.deepEqual(listedIds(body, "G").map((g) => g.id), ["G1"]);
  assert.deepEqual(listedIds(body, "Q"), []);
});

test("the failing landing comment is entail's comment naming the head, not a passing one", () => {
  const head = "0123456789abcdef0123456789abcdef01234567";
  const comments = [
    comment(1, `## entail evidence\n\nC1: ran at ${head.slice(0, 7)} — passed`),
    comment(2, `Speaking from Owner's entail:\n\nAll met, merging at \`${head}\`.`),
    comment(3, `Speaking from Owner's entail:\n\nG1 not met. This PR will not be merged at \`${head.slice(0, 7)}\`.`),
  ];
  assert.equal(failingLandingComment(comments, head)?.id, 3);
  assert.equal(failingLandingComment(comments.slice(0, 2), head), undefined);
  assert.equal(failingLandingComment(comments, "fedcba9876543210"), undefined);
});
