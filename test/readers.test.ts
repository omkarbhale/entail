import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { Project } from "../src/forge/forge.ts";
import type { SuggestForge } from "../src/suggest.ts";
import { mirrorReaders, type WatchForge } from "../src/watch.ts";
import { FixtureRepo, tempDirectory } from "./git-fixture.ts";

const SETTING = { forge: "github", host: "github.com", path: "acme/tally" } as const;

/** What the readers need of a forge: its setting, the base branch the owner set, and the project. */
function forgeWith(baseBranch: string | null): WatchForge & SuggestForge {
  const project: Project = { forge: "github", host: "github.com", id: 42, path: "acme/tally", defaultBranch: "main", baseBranch: baseBranch ?? "main" };
  return { setting: SETTING, baseBranch, project: async () => project } as unknown as WatchForge & SuggestForge;
}

/** A repo whose `main` and `develop` say different things in VISION.md, with PR #4 opened from `develop`. */
function twoBranches(t: TestContext) {
  const repo = new FixtureRepo(t);
  const main = repo.write("VISION.md", "# Tally\n\nTally counts words.\n").commit("vision on main");
  repo.push("main");
  const develop = repo.write("VISION.md", "# Tally\n\nTally counts words and lines.\n").write("src/lines.ts", "export {};\n").commit("vision on develop");
  repo.push("develop");
  const head = repo.write("src/stdin.ts", "export {};\n").commit("read standard input");
  repo.pushRef(head, "refs/pull/4/head");
  const release = repo.write("VISION.md", "# Tally\n\nTally counts words, lines and pages.\n").commit("vision on release");
  repo.push("release");
  const readers = mirrorReaders(tempDirectory(t, "data"), { remote: () => ({ url: repo.remote, credentialHelper: null }) });
  return { main, develop, head, release, readers };
}

test("with a base branch set, the call on an issue, the vision re-check, a PR's diff and a suggestion run all read that branch", async (t) => {
  const { develop, head, readers } = twoBranches(t);
  const forge = forgeWith("develop");

  const reading = await readers.reader("acme/tally", forge);
  assert.equal(reading.sha, develop);
  assert.deepEqual(reading.vision, { text: "# Tally\n\nTally counts words and lines.\n", commit: develop }, "VISION.md is read on the base branch, which is what the vision re-check compares");

  const pr = await readers.prReader("acme/tally", forge, 4, head);
  assert.equal(pr.base, develop, "the diff is taken against the base branch's head");
  assert.match(pr.diff, /src\/stdin\.ts/u);
  assert.doesNotMatch(pr.diff, /src\/lines\.ts|VISION\.md/u, "what is already on the base branch is not in the PR's diff");
  assert.equal(pr.vision?.commit, develop);
  await pr.release();

  const suggesting = await readers.suggestReader("acme/tally", forge);
  assert.equal(suggesting.sha, develop);
  assert.ok(suggesting.tree.includes("src/lines.ts"), "the suggestion run reads the base branch's tree");
  assert.equal(suggesting.vision?.text, "# Tally\n\nTally counts words and lines.\n");
  await suggesting.release();
});

test("a drift reading is the base branch's head with the work merged since the last check, and its checkout is released", async (t) => {
  const { develop, readers } = twoBranches(t);
  const forge = forgeWith("develop");
  const first = await readers.driftReader("acme/tally", forge, null);
  assert.equal(first.sha, develop);
  assert.equal(first.vision?.text, "# Tally\n\nTally counts words and lines.\n");
  assert.deepEqual(first.commits.map((commit) => commit.subject), ["vision on develop", "vision on main"], "the base branch's own history, not another branch's");
  assert.deepEqual(first.commits[0]!.paths.sort(), ["VISION.md", "src/lines.ts"]);
  assert.equal(first.since, null);
  await first.release();
  const next = await readers.driftReader("acme/tally", forge, develop);
  assert.deepEqual([next.commits, next.merged, next.since], [[], 0, develop], "nothing merged since the last check");
  await next.release();
});

test("with no base branch set, the readers read the forge's default branch, as before", async (t) => {
  const { main, readers } = twoBranches(t);
  const reading = await readers.reader("acme/tally", forgeWith(null));
  assert.equal(reading.sha, main);
  assert.equal(reading.vision?.text, "# Tally\n\nTally counts words.\n");
});

test("when the base branch changes later, the same mirror fetches the new branch, and the vision and suggestions follow it", async (t) => {
  const { main, develop, release, readers } = twoBranches(t);
  assert.equal((await readers.reader("acme/tally", forgeWith(null))).sha, main);

  const onDevelop = await readers.reader("acme/tally", forgeWith("develop"));
  assert.equal(onDevelop.sha, develop);
  assert.equal(onDevelop.vision?.text, "# Tally\n\nTally counts words and lines.\n");

  const onRelease = await readers.reader("acme/tally", forgeWith("release"));
  assert.equal(onRelease.sha, release, "the release branch is fetched once it is the base branch");
  assert.equal(onRelease.vision?.text, "# Tally\n\nTally counts words, lines and pages.\n");
  const suggesting = await readers.suggestReader("acme/tally", forgeWith("release"));
  assert.equal(suggesting.sha, release);
  await suggesting.release();

  const back = await readers.reader("acme/tally", forgeWith(null));
  assert.equal(back.sha, main, "unset, the forge's default branch again");
  const suggestingOnMain = await readers.suggestReader("acme/tally", forgeWith(null));
  assert.equal(suggestingOnMain.sha, main);
  await suggestingOnMain.release();
  await assert.rejects(readers.reader("acme/tally", forgeWith("gone")), /the remote has no branch gone/u, "a branch the remote lacks fails the read, with why");
});
