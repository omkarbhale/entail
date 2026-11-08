import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Git } from "../src/git.ts";
import { collapseWhitespace, readVision, readVisionChange, splitVisionLines } from "../src/vision.ts";
import { FixtureRepo } from "./git-fixture.ts";

function gitOf(repo: FixtureRepo): Git {
  return new Git(join(repo.work, ".git"));
}

const VISION = `# Tally

Tally counts words in text.
It prints one number and nothing else.

## Errors

A missing file is an error, not zero.
`;

test("a vision line is every stating line, with the heading above it, the exact text and its line number", () => {
  assert.deepEqual(splitVisionLines(VISION), [
    { text: "Tally counts words in text.", identity: "Tally counts words in text.", lineNumber: 3, heading: "Tally" },
    {
      text: "It prints one number and nothing else.",
      identity: "It prints one number and nothing else.",
      lineNumber: 4,
      heading: "Tally",
    },
    {
      text: "A missing file is an error, not zero.",
      identity: "A missing file is an error, not zero.",
      lineNumber: 8,
      heading: "Errors",
    },
  ]);
});

test("headings underlined with = or -, closing #s, thematic breaks and blank lines are not vision lines", () => {
  const lines = splitVisionLines("Tally\n=====\n\nCounts words.\n\n***\n\nOutput\n------\n- Prints a number.\n\n## Scope ##\r\nOnly text files.\r\n");
  assert.deepEqual(
    lines.map((line) => [line.heading, line.text, line.lineNumber]),
    [
      ["Tally", "Counts words.", 4],
      ["Output", "- Prints a number.", 10],
      ["Scope", "Only text files.", 13],
    ],
  );
});

test("a line's identity is its text with whitespace collapsed", () => {
  assert.equal(collapseWhitespace("  It prints \t one   number.  "), "It prints one number.");
  const [line] = splitVisionLines("   It prints \t one   number.   ");
  assert.equal(line?.text, "   It prints \t one   number.   ");
  assert.equal(line?.identity, "It prints one number.");
});

test("moving a line or renaming its heading keeps its identity, so it is no vision change", (t) => {
  const repo = new FixtureRepo(t);
  const before = repo.write("VISION.md", VISION).commit("vision");
  const after = repo
    .write(
      "VISION.md",
      `# Tally, the word counter

## Failures

A missing file is an error, not zero.

## Output

It prints one number and nothing else.
Tally counts   words in text.
`,
    )
    .commit("move lines and rename headings");
  return readVisionChange(gitOf(repo), before, after).then((change) => {
    assert.deepEqual(change, { removed: [], added: [] });
  });
});

test("any change of words makes a new line, and a reworded line is one removed and one added", async (t) => {
  const repo = new FixtureRepo(t);
  const before = repo.write("VISION.md", VISION).commit("vision");
  const after = repo
    .write("VISION.md", VISION.replace("It prints one number", "It prints one number,").concat("Counting is by whitespace.\n"))
    .commit("reword a line and add one");
  const change = await readVisionChange(gitOf(repo), before, after);
  assert.deepEqual(
    change.removed.map((line) => line.text),
    ["It prints one number and nothing else."],
  );
  assert.deepEqual(
    change.added.map((line) => [line.text, line.lineNumber, line.heading]),
    [
      ["It prints one number, and nothing else.", 4, "Tally"],
      ["Counting is by whitespace.", 9, "Errors"],
    ],
  );
});

test("a line repeated in the file is one vision line", async (t) => {
  const repo = new FixtureRepo(t);
  const before = repo.write("VISION.md", "One.\n").commit("one");
  const after = repo.write("VISION.md", "One.\nTwo.\nTwo.\n").commit("two twice");
  const change = await readVisionChange(gitOf(repo), before, after);
  assert.deepEqual(
    change.added.map((line) => line.text),
    ["Two."],
  );
  const removedOne = await readVisionChange(gitOf(repo), after, repo.write("VISION.md", "One.\nTwo.\n").commit("two once"));
  assert.deepEqual(removedOne, { removed: [], added: [] });
});

test("VISION.md is read with its commit and blob at a sha", async (t) => {
  const repo = new FixtureRepo(t);
  const commit = repo.write("VISION.md", VISION).commit("vision");
  repo.write("VISION.md", "Something else.\n").commit("later");
  const vision = await readVision(gitOf(repo), commit);
  assert.equal(vision.status, "present");
  assert.equal(vision.commit, commit);
  if (vision.status !== "present") return;
  assert.match(vision.blob, /^[0-9a-f]{40}$/u);
  assert.equal(vision.lines.length, 3, "it reads the file as it was at that sha, not later");
});

test("a VISION.md that is missing, empty, blank or only headings is reported as such", async (t) => {
  const repo = new FixtureRepo(t);
  const git = gitOf(repo);
  const none = repo.write("README.md", "readme\n").commit("no vision");
  assert.deepEqual(await readVision(git, none), { status: "missing", commit: none });

  for (const content of ["", "  \n\n\t\n", "# Vision\n\n## Nothing yet\n"]) {
    const commit = repo.write("VISION.md", content).commit("empty vision");
    const vision = await readVision(git, commit);
    assert.equal(vision.status, "empty", JSON.stringify(content));
  }

  const dir = repo.remove("VISION.md").write("VISION.md/notes.md", "Not a vision.\n").commit("vision is a directory");
  assert.equal((await readVision(git, dir)).status, "missing");
});
