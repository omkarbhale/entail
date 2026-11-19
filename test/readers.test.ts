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
  const readers = mirrorReaders(tempDirectory(t, "data"), { remote: () => ({ url: repo.remote, credentialHelper: null }) });
  return { main, develop, head, readers };
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

test("with no base branch set, the readers read the forge's default branch, as before", async (t) => {
  const { main, readers } = twoBranches(t);
  const reading = await readers.reader("acme/tally", forgeWith(null));
  assert.equal(reading.sha, main);
  assert.equal(reading.vision?.text, "# Tally\n\nTally counts words.\n");
});
