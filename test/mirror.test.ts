import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { forgeRemote, Mirror, mirrorPaths, pullRequestHeadRef, type ForgeName } from "../src/mirror.ts";
import { readVision } from "../src/vision.ts";
import { FixtureRepo, git, tempDirectory } from "./git-fixture.ts";

const VISION = "# Tally\n\nTally counts words in text.\n";

function openMirror(t: TestContext, repo: FixtureRepo, forge: ForgeName = "github", projectId = 42): Promise<Mirror> {
  return Mirror.open({
    dataDirectory: tempDirectory(t, "data"),
    key: { forge, host: "forge.example", projectId },
    remote: { url: repo.remote, credentialHelper: null },
  });
}

test("the mirror is a bare repository in the data directory, keyed by forge, host and project id", async (t) => {
  const dataDirectory = tempDirectory(t, "data");
  const key = { forge: "gitlab" as const, host: "Git.Example.org:8443", projectId: 7 };
  assert.deepEqual(mirrorPaths(dataDirectory, key), {
    mirror: join(dataDirectory, "mirrors", "gitlab", "git.example.org%3A8443", "7.git"),
    checkouts: join(dataDirectory, "checkouts", "gitlab", "git.example.org%3A8443", "7"),
  });
  const mirror = await Mirror.open({ dataDirectory, key, remote: { url: "/nowhere", credentialHelper: null } });
  assert.equal(git(mirror.directory, "rev-parse", "--is-bare-repository"), "true");
  const again = await Mirror.open({ dataDirectory, key, remote: { url: "/nowhere", credentialHelper: null } });
  assert.equal(again.directory, mirror.directory, "opening it again reuses it");
  assert.throws(() => mirrorPaths(dataDirectory, { ...key, host: ".." }), RangeError);
  assert.throws(() => mirrorPaths(dataDirectory, { ...key, projectId: -1 }), RangeError);
});

test("the remote is the forge's HTTPS URL, authenticated only through the owner's gh or glab", () => {
  assert.deepEqual(forgeRemote("github", "github.com", "owner/tally"), {
    url: "https://github.com/owner/tally.git",
    credentialHelper: "!gh auth git-credential",
  });
  assert.deepEqual(forgeRemote("gitlab", "git.example.org", "group/sub/tally"), {
    url: "https://git.example.org/group/sub/tally.git",
    credentialHelper: "!glab auth git-credential",
  });
});

test("a PR's head ref is refs/pull/<n>/head on GitHub and refs/merge-requests/<iid>/head on GitLab", () => {
  assert.equal(pullRequestHeadRef("github", 12), "refs/pull/12/head");
  assert.equal(pullRequestHeadRef("gitlab", 12), "refs/merge-requests/12/head");
  assert.throws(() => pullRequestHeadRef("github", 0), RangeError);
});

test("the default branch head is checked with ls-remote, and the mirror fetches only when it moved", async (t) => {
  const repo = new FixtureRepo(t, "trunk");
  const first = repo.write("VISION.md", VISION).commit("vision");
  repo.push("trunk");
  const mirror = await openMirror(t, repo);

  assert.deepEqual(await mirror.remoteDefaultBranch(), { branch: "trunk", commit: first });
  assert.deepEqual(await mirror.updateDefaultBranch(), { branch: "trunk", commit: first, fetched: true });
  assert.deepEqual(await mirror.updateDefaultBranch(), { branch: "trunk", commit: first, fetched: false }, "unmoved head");

  const second = repo.write("VISION.md", `${VISION}It prints one number.\n`).commit("more vision");
  repo.push("trunk");
  assert.deepEqual(await mirror.updateDefaultBranch(), { branch: "trunk", commit: second, fetched: true }, "moved head");
  assert.equal(git(mirror.directory, "rev-parse", "HEAD"), second, "the mirror's HEAD is the checked default-branch head");

  const vision = await readVision(mirror.git, second);
  assert.equal(vision.status, "present");
  assert.deepEqual(vision.status === "present" && vision.lines.map((line) => line.text), [
    "Tally counts words in text.",
    "It prints one number.",
  ]);
});

test("a default branch moved back to a commit the mirror holds needs no fetch", async (t) => {
  const repo = new FixtureRepo(t);
  const first = repo.write("VISION.md", VISION).commit("vision");
  repo.push();
  const mirror = await openMirror(t, repo);
  await mirror.updateDefaultBranch();
  repo.write("README.md", "x\n").commit("more");
  repo.push();
  await mirror.updateDefaultBranch();
  repo.pushRef(first, "refs/heads/main");
  assert.deepEqual(await mirror.updateDefaultBranch(), { branch: "main", commit: first, fetched: false });
});

test("a VISION.md that is missing or empty on the default branch is reported as such", async (t) => {
  const repo = new FixtureRepo(t);
  repo.write("README.md", "tally\n").commit("no vision yet");
  repo.push();
  const mirror = await openMirror(t, repo);
  const head = await mirror.updateDefaultBranch();
  assert.deepEqual(await readVision(mirror.git, head.commit), { status: "missing", commit: head.commit });

  repo.write("VISION.md", "\n").commit("empty vision");
  repo.push();
  const emptyHead = await mirror.updateDefaultBranch();
  assert.equal((await readVision(mirror.git, emptyHead.commit)).status, "empty");
});

/** A repo with a PR branched from main, after which main moved on. */
function repoWithPullRequest(t: TestContext) {
  const repo = new FixtureRepo(t);
  repo
    .write("VISION.md", VISION)
    .write("src/count.js", "export const count = (text) => text.split(/\\s+/).length;\n")
    .write("src/old name.js", "export const name = 'old';\n")
    .commit("start");
  const fork = repo.head();
  repo.push();

  repo.checkout("-b", "feature");
  const bulk = Array.from({ length: 3000 }, (_, index) => `line ${index}`).join("\n");
  repo.write("src/count.js", "export const count = (text) => text.trim().split(/\\s+/).filter(Boolean).length;\n");
  for (let index = 0; index < 300; index++) repo.write(`generated/file-${index}.txt`, `${bulk}\n${index}\n`);
  git(repo.work, "mv", "src/old name.js", "src/névé name.js");
  const head = repo.commit("feature work");

  repo.checkout("main");
  repo.write("README.md", "main moved on after the PR branched\n").commit("main moves");
  repo.push();
  return { repo, fork, head };
}

test("a PR's diff and changed paths come from git at the head ref, identically for GitHub and GitLab refs", async (t) => {
  const { repo, head } = repoWithPullRequest(t);
  repo.pushRef(head, "refs/pull/5/head");
  repo.pushRef(head, "refs/merge-requests/5/head");

  const results = [];
  for (const forge of ["github", "gitlab"] as const) {
    const mirror = await openMirror(t, repo, forge);
    const base = await mirror.updateDefaultBranch();
    const fetched = await mirror.fetchPullRequestHead(5);
    assert.deepEqual(fetched, { commit: head, fetched: true });
    results.push({
      diff: await mirror.pullRequestDiff(base.commit, fetched.commit),
      paths: await mirror.pullRequestChangedPaths(base.commit, fetched.commit),
    });
  }
  const [github, gitlab] = results;
  assert.ok(github && gitlab);
  assert.equal(github.diff, gitlab.diff);
  assert.deepEqual(github.paths, gitlab.paths);

  assert.equal(github.paths.length, 303, "every changed path, never truncated");
  assert.ok(github.paths.includes("src/count.js"));
  assert.ok(github.paths.includes("src/old name.js") && github.paths.includes("src/névé name.js"), "a rename changes both paths");
  assert.ok(!github.paths.includes("README.md"), "what main did after the PR branched is not the PR's change");
  assert.equal(github.diff.match(/^diff --git /gmu)?.length, 303);
  assert.ok(github.diff.includes("+line 2999\n"), "the diff is whole");
});

test("a PR head the mirror already holds is not fetched again", async (t) => {
  const { repo, head } = repoWithPullRequest(t);
  repo.pushRef(head, "refs/pull/9/head");
  const mirror = await openMirror(t, repo);
  await mirror.updateDefaultBranch();
  assert.deepEqual(await mirror.fetchPullRequestHead(9), { commit: head, fetched: true });
  assert.deepEqual(await mirror.fetchPullRequestHead(9, head), { commit: head, fetched: false });

  repo.checkout("feature");
  const pushed = repo.write("src/count.js", "// newer\n").commit("a new push");
  repo.pushRef(pushed, "refs/pull/9/head");
  assert.deepEqual(await mirror.fetchPullRequestHead(9, pushed), { commit: pushed, fetched: true }, "a new head is fetched");
});

test("a read-only checkout at a recorded sha holds the repo as it was then", async (t) => {
  const { repo, fork } = repoWithPullRequest(t);
  const mirror = await openMirror(t, repo);
  const head = await mirror.updateDefaultBranch();

  const checkout = await mirror.checkout(fork);
  assert.equal(checkout.commit, fork);
  assert.equal(readFileSync(join(checkout.directory, "VISION.md"), "utf8"), VISION);
  assert.ok(existsSync(join(checkout.directory, "src", "old name.js")));
  assert.ok(!existsSync(join(checkout.directory, "README.md")), "README.md came after that sha");
  assert.ok(!existsSync(join(checkout.directory, ".git")), "it is a plain tree, not a repository");
  assert.equal(statSync(join(checkout.directory, "VISION.md")).mode & 0o222, 0, "files are read-only");
  assert.equal(statSync(join(checkout.directory, "src")).mode & 0o222, 0, "directories are read-only");

  assert.deepEqual(await mirror.checkout(fork), checkout, "the same sha reuses its checkout");
  const later = await mirror.checkout(head.commit);
  assert.ok(existsSync(join(later.directory, "README.md")));

  await mirror.removeCheckout(fork);
  assert.ok(!existsSync(checkout.directory));
  await assert.rejects(mirror.checkout("main"), RangeError, "a checkout is at a recorded sha, not a branch name");
});
