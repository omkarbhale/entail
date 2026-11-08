import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Git } from "../src/git.ts";
import { originFromTrailer, ORIGINS, readAddedLineOrigins, readOriginTrailer } from "../src/vision-origin.ts";
import { FixtureRepo, git } from "./git-fixture.ts";

function gitOf(repo: FixtureRepo): Git {
  return new Git(join(repo.work, ".git"));
}

const BASE = "# Tally\n\nTally counts words in text.\n";

for (const origin of ORIGINS) {
  test(`the trailer value ${origin} applies to every line its commit adds`, async (t) => {
    const repo = new FixtureRepo(t);
    const from = repo.write("VISION.md", BASE).commit("vision");
    const to = repo
      .write("VISION.md", `${BASE}It prints one number.\n\n## Errors\n\nA missing file is an error.\n`)
      .commit(`Add output and error lines\n\nSome body text.\n\nVision-Origin: ${origin}\n`);
    const origins = await readAddedLineOrigins(gitOf(repo), from, to);
    assert.deepEqual(
      origins.map((entry) => [entry.line.text, entry.origin, entry.commit, entry.rawTrailer]),
      [
        ["It prints one number.", origin, to, origin],
        ["A missing file is an error.", origin, to, origin],
      ],
    );
  });
}

test("a line added with no trailer is stated by the owner, with no raw trailer", async (t) => {
  const repo = new FixtureRepo(t);
  const from = repo.write("VISION.md", BASE).commit("vision");
  const to = repo.write("VISION.md", `${BASE}It prints one number.\n`).commit("A hand edit");
  const [entry, ...rest] = await readAddedLineOrigins(gitOf(repo), from, to);
  assert.deepEqual(rest, []);
  assert.deepEqual(entry && [entry.origin, entry.commit, entry.rawTrailer], ["owner-stated", to, null]);
});

test("an unknown trailer value is stated by the owner, and the raw trailer is kept", async (t) => {
  const repo = new FixtureRepo(t);
  const from = repo.write("VISION.md", BASE).commit("vision");
  const to = repo
    .write("VISION.md", `${BASE}It prints one number.\n`)
    .commit("Agent edit\n\nVision-Origin: agent-wrote-it-trust-me\n");
  const [entry] = await readAddedLineOrigins(gitOf(repo), from, to);
  assert.deepEqual(entry && [entry.origin, entry.rawTrailer], ["owner-stated", "agent-wrote-it-trust-me"]);
});

test("trailer values that disagree record the line as stated by the owner, keeping both", () => {
  assert.deepEqual(originFromTrailer(["automatic-owner-notified", "owner-stated"]), {
    origin: "owner-stated",
    rawTrailer: "automatic-owner-notified\nowner-stated",
  });
  assert.deepEqual(originFromTrailer(["automatic-owner-notified", "automatic-owner-notified"]), {
    origin: "automatic-owner-notified",
    rawTrailer: "automatic-owner-notified\nautomatic-owner-notified",
  });
  assert.deepEqual(originFromTrailer([]), { origin: "owner-stated", rawTrailer: null });
});

test("a trailer outside the trailer block is not a trailer", async (t) => {
  const repo = new FixtureRepo(t);
  repo.write("VISION.md", BASE);
  const commit = repo.commit("Mention it\n\nVision-Origin: automatic-owner-notified\n\nThis paragraph ends the message.\n");
  assert.deepEqual(await readOriginTrailer(gitOf(repo), commit), []);
});

test("each added line takes the trailer of the commit that added it, across several commits", async (t) => {
  const repo = new FixtureRepo(t);
  const from = repo.write("VISION.md", BASE).commit("vision");
  const first = repo
    .write("VISION.md", `${BASE}It prints one number.\n`)
    .commit("Add output\n\nVision-Origin: agent-proposed-owner-approved\n");
  repo.write("README.md", "unrelated\n").commit("An unrelated change");
  const second = repo
    .write("VISION.md", `# Tally\n\n## Output\n\nIt prints one number.\nTally counts words in text.\nErrors go to stderr.\n`)
    .commit("Move lines and add one\n\nVision-Origin: automatic-owner-notified\n");
  const origins = await readAddedLineOrigins(gitOf(repo), from, second);
  assert.deepEqual(
    origins.map((entry) => [entry.line.text, entry.origin, entry.commit]),
    [
      ["It prints one number.", "agent-proposed-owner-approved", first],
      ["Errors go to stderr.", "automatic-owner-notified", second],
    ],
    "a moved line keeps the commit that added it, and a line already in the vision is not added",
  );
});

test("a line removed and added back takes the commit that added it back", async (t) => {
  const repo = new FixtureRepo(t);
  const from = repo.write("VISION.md", BASE).commit("vision");
  repo.write("VISION.md", `${BASE}It prints one number.\n`).commit("Add\n\nVision-Origin: automatic-owner-notified\n");
  repo.write("VISION.md", BASE).commit("Remove");
  const back = repo.write("VISION.md", `${BASE}It prints one number.\n`).commit("Add back by hand");
  const [entry] = await readAddedLineOrigins(gitOf(repo), from, back);
  assert.deepEqual(entry && [entry.origin, entry.commit], ["owner-stated", back]);
});

test("lines merged from a branch take the trailer of the branch commit, not the merge's", async (t) => {
  const repo = new FixtureRepo(t);
  const from = repo.write("VISION.md", BASE).commit("vision");
  repo.checkout("-b", "agent");
  const branchCommit = repo
    .write("VISION.md", `${BASE}It prints one number.\n`)
    .commit("Agent edit\n\nVision-Origin: agent-proposed-owner-approved\n");
  repo.checkout("main");
  repo.write("README.md", "meanwhile\n").commit("Meanwhile on main");
  git(repo.work, "merge", "--quiet", "--no-ff", "-m", "Merge the agent's branch", "agent");
  const merge = repo.head();
  const [entry, ...rest] = await readAddedLineOrigins(gitOf(repo), from, merge);
  assert.deepEqual(rest, []);
  assert.deepEqual(entry && [entry.line.text, entry.origin, entry.commit], [
    "It prints one number.",
    "agent-proposed-owner-approved",
    branchCommit,
  ]);
});

test("a vision change that adds nothing reads no origins", async (t) => {
  const repo = new FixtureRepo(t);
  const from = repo.write("VISION.md", `${BASE}It prints one number.\n`).commit("vision");
  const to = repo.write("VISION.md", BASE).commit("Remove a line\n\nVision-Origin: owner-stated\n");
  assert.deepEqual(await readAddedLineOrigins(gitOf(repo), from, to), []);
});
