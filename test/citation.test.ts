import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { cite, citationPermalinks, NotAVisionLineError, verifyCitation, visionPermalink } from "../src/citation.ts";
import { Git } from "../src/git.ts";
import { readVision } from "../src/vision.ts";
import { FixtureRepo } from "./git-fixture.ts";

const VISION = `# Tally

Tally counts words in text.
It prints one number and nothing else.

## Errors

A missing file is an error, not zero.
`;

async function visionRepo(t: TestContext) {
  const repo = new FixtureRepo(t);
  const commit = repo.write("VISION.md", VISION).commit("vision");
  const git = new Git(join(repo.work, ".git"));
  return { repo, commit, git, vision: await readVision(git, commit) };
}

test("a citation stores the commit sha, and per line the heading above, the exact text and the line number", async (t) => {
  const { commit, vision } = await visionRepo(t);
  assert.deepEqual(cite(vision, ["A missing file is an error, not zero.", "  Tally counts  words in text. "]), {
    commit,
    lines: [
      { heading: "Errors", text: "A missing file is an error, not zero.", lineNumber: 8 },
      { heading: "Tally", text: "Tally counts words in text.", lineNumber: 3 },
    ],
  });
});

test("only whole vision lines can be cited", async (t) => {
  const { vision } = await visionRepo(t);
  assert.throws(() => cite(vision, ["A missing file is an error"]), NotAVisionLineError, "part of a line");
  assert.throws(() => cite(vision, ["Errors"]), NotAVisionLineError, "a heading");
});

test("a citation verifies when every quoted line is word for word in VISION.md at its sha", async (t) => {
  const { git, vision, repo } = await visionRepo(t);
  const citation = cite(vision, ["It prints one number and nothing else.", "A missing file is an error, not zero."]);
  // Later edits do not matter: the check reads VISION.md at the citation's sha.
  repo.write("VISION.md", "# Tally\n\nEverything changed.\n").commit("rewrite");
  assert.deepEqual(await verifyCitation(git, citation), { verified: true });
  const reflowed = { ...citation, lines: citation.lines.map((line) => ({ ...line, text: ` ${line.text.replace(/ /gu, "  ")}` })) };
  assert.deepEqual(await verifyCitation(git, reflowed), { verified: true }, "whitespace is collapsed before comparing");
});

test("verifying fails when any quoted line is not word for word in VISION.md at that sha", async (t) => {
  const { git, vision, repo } = await visionRepo(t);
  const citation = cite(vision, ["Tally counts words in text.", "A missing file is an error, not zero."]);

  const changedWord = {
    ...citation,
    lines: [citation.lines[0]!, { ...citation.lines[1]!, text: "A missing file is an error, not a zero." }],
  };
  const result = await verifyCitation(git, changedWord);
  assert.equal(result.verified, false);
  assert.deepEqual(result.verified === false && result.unmatched.map((line) => line.text), [
    "A missing file is an error, not a zero.",
  ]);

  const partial = { ...citation, lines: [{ ...citation.lines[0]!, text: "Tally counts words" }] };
  assert.equal((await verifyCitation(git, partial)).verified, false, "a part of a line is not the line");

  const reworded = repo.write("VISION.md", VISION.replace("not zero", "never zero")).commit("reword");
  assert.equal((await verifyCitation(git, { ...citation, commit: reworded })).verified, false, "the line is gone at the later sha");

  const vanished = repo.remove("VISION.md").commit("remove vision");
  const gone = await verifyCitation(git, { ...citation, commit: vanished });
  assert.deepEqual(gone.verified === false && gone.reason, `VISION.md is missing at ${vanished}`);

  assert.equal((await verifyCitation(git, { ...citation, lines: [] })).verified, false, "a citation quotes at least one line");
});

test("permalinks point at VISION.md at the sha on GitHub, gitlab.com and self-hosted GitLab", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(
    visionPermalink({ forge: "github", host: "github.com", path: "owner/tally" }, sha, 8),
    `https://github.com/owner/tally/blob/${sha}/VISION.md#L8`,
  );
  assert.equal(
    visionPermalink({ forge: "github", host: "github.com", path: "owner/tally" }, sha, 3, 4),
    `https://github.com/owner/tally/blob/${sha}/VISION.md#L3-L4`,
  );
  assert.equal(
    visionPermalink({ forge: "gitlab", host: "gitlab.com", path: "group/sub/tally" }, sha, 8),
    `https://gitlab.com/group/sub/tally/-/blob/${sha}/VISION.md#L8`,
  );
  assert.equal(
    visionPermalink({ forge: "gitlab", host: "git.example.org:8443", path: "team/tally" }, sha, 3, 4),
    `https://git.example.org:8443/team/tally/-/blob/${sha}/VISION.md#L3-4`,
  );
});

test("a citation's permalinks are built at its sha, one per quoted line", async (t) => {
  const { commit, vision } = await visionRepo(t);
  const citation = cite(vision, ["A missing file is an error, not zero."]);
  assert.deepEqual(citationPermalinks({ forge: "github", host: "github.com", path: "owner/tally" }, citation), [
    `https://github.com/owner/tally/blob/${commit}/VISION.md#L8`,
  ]);
});
