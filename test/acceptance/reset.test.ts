import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { FakeForge } from "./fake-forge.ts";
import { FIXTURE_ISSUES } from "./fixture.ts";
import { ForgeError } from "./forge.ts";
import { buildStartingCommit, fileFixtureIssues, NotAFixtureError, resetFixture, setupFixture, startingStateDifferences } from "./reset.ts";
import { git } from "./tree.ts";

function fake(t: TestContext, options?: ConstructorParameters<typeof FakeForge>[0]): FakeForge {
  const forge = new FakeForge(options);
  t.after(() => rmSync(forge.remote, { recursive: true, force: true }));
  return forge;
}

/** Leaves a fixture repo as a finished run would: merged work, entail's labels, comments, a branch and a PR. */
async function dirty(forge: FakeForge): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "entail-dirty-"));
  try {
    git(work, ["init", "--quiet", "--initial-branch", "main"]);
    git(work, ["-c", "user.name=x", "-c", "user.email=x@example.com", "commit", "--quiet", "--allow-empty", "-m", "merged work"]);
    git(work, ["push", "--quiet", forge.remote, "HEAD:refs/heads/main", "HEAD:refs/heads/executor/t1-issue-1"]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const issue = await forge.createIssue("Read from standard input when no file is given", "old body");
  forge.issues[0]!.labels.push("entail:cleared");
  forge.labels.push("entail:cleared", "entail:investigate");
  forge.entailComment("issue", issue.number, "C1: something");
  const pr = await forge.createPullRequest({ branch: "executor/t1-issue-1", base: "main", title: "x", body: "Closes #1" });
  forge.entailComment("pr", pr.number, "will not be merged");
  forge.issues.push({ number: 99, title: "Something else", body: "", state: "closed", labels: [] });
}

test("the reset refuses entail's own repo, a public repo and a repo without the fixture marker", async (t) => {
  await assert.rejects(resetFixture(fake(t, { path: "owner/entail" })), NotAFixtureError);
  await assert.rejects(resetFixture(fake(t, { repo: { private: false } })), /not private/);
  await assert.rejects(resetFixture(fake(t, { repo: { description: "my real project" } })), /not a fixture repo/);
  await assert.rejects(resetFixture(fake(t, { repo: null })), /does not exist/);
});

test("the starting commit is the same commit every time", (t) => {
  const a = mkdtempSync(join(tmpdir(), "entail-start-"));
  const b = mkdtempSync(join(tmpdir(), "entail-start-"));
  t.after(() => [a, b].forEach((d) => rmSync(d, { recursive: true, force: true })));
  assert.equal(buildStartingCommit(a), buildStartingCommit(b));
  assert.match(git(a, ["ls-tree", "HEAD", "src/cli.js"]), /^100755 /, "the command is executable");
});

for (const kind of ["github", "gitlab"] as const) {
  test(`the reset brings a used ${kind} fixture repo back to the starting state, and is idempotent`, async (t) => {
    const forge = fake(t, { kind });
    await dirty(forge);
    assert.notDeepEqual(await startingStateDifferences(forge), []);

    const first = await resetFixture(forge);
    assert.deepEqual(await startingStateDifferences(forge), []);
    assert.equal(first.pushed, true);
    assert.deepEqual(
      first.issues.map((i) => i.id),
      FIXTURE_ISSUES.map((i) => i.id),
    );
    assert.equal(forge.labels.includes("bug"), true, "labels other than entail's stay");
    assert.equal(forge.labels.some((l) => l.startsWith("entail:")), false);
    assert.deepEqual(await forge.listBranches(), ["main"]);
    assert.equal((await forge.listPullRequests("open")).length, 0);
    assert.deepEqual([...forge.prComments.values()].flat(), [], "entail's comments on old PRs are gone");

    const second = await resetFixture(forge);
    assert.deepEqual(await startingStateDifferences(forge), []);
    assert.equal(second.pushed, false, "the default branch already holds the starting commit");
    assert.equal(second.startingSha, first.startingSha);
    assert.deepEqual(
      (await forge.listIssues("all")).map((i) => i.title),
      FIXTURE_ISSUES.map((i) => i.title),
      "the issues are filed again, once each",
    );
  });
}

test("the reset waits until the forge lists exactly the issues it filed, and skips issues already deleted", async (t) => {
  const forge = fake(t);
  await resetFixture(forge);
  // The list lags as GitHub's does: it still names a deleted issue, then misses a new one.
  const real = forge.listIssues.bind(forge);
  let reads = 0;
  forge.listIssues = async (state) => {
    reads += 1;
    const issues = await real(state);
    if (reads === 1) return [...issues, { number: 500, title: "deleted", body: "", state: "closed", labels: [] }];
    if (reads === 2) return issues.slice(0, -1);
    return issues;
  };
  const deleteIssue = forge.deleteIssue.bind(forge);
  forge.deleteIssue = async (number) => {
    if (number === 500) throw new ForgeError("Not Found (HTTP 404)", true);
    return deleteIssue(number);
  };
  const result = await resetFixture(forge, () => {}, { delayMs: 1 });
  assert.equal(reads, 3);
  assert.equal(result.removed.issues, FIXTURE_ISSUES.length);
  await assert.rejects(
    resetFixture(Object.assign(fake(t), { listIssues: async () => [] }), () => {}, { delayMs: 1, attempts: 2 }),
    /still lists issues/,
  );
});

test("setup creates a missing fixture repo privately, with the marker, then resets it", async (t) => {
  const forge = fake(t, { repo: null });
  await setupFixture(forge);
  assert.deepEqual(forge.calls.slice(0, 1), ["createPrivateRepo"]);
  assert.equal(forge.repoInfo?.private, true);
  assert.deepEqual(await startingStateDifferences(forge), []);
});

test("the acceptance run resets without the issues, then files T1–T13 once the repo is enrolled", async (t) => {
  const forge = fake(t);
  await dirty(forge);
  const reset = await resetFixture(forge, () => {}, { fileIssues: false, delayMs: 1 });
  assert.deepEqual(reset.issues, []);
  assert.deepEqual(await forge.listIssues("all"), []);
  const filed = await fileFixtureIssues(forge, { delayMs: 1 });
  assert.deepEqual(
    filed.map((i) => i.id),
    FIXTURE_ISSUES.map((i) => i.id),
  );
  assert.deepEqual(await startingStateDifferences(forge), []);
});
