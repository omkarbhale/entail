import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Enroller, parseStatedForge, type CheckResult, type RefusalReason } from "../src/enrollment.ts";
import { GENERIC_CRITERIA_PROPOSAL_PROMPT_VERSION, genericCriteriaProposalSchema } from "../src/generic-criteria.ts";
import { ForgeLoggedOutError, ForgeRequestError } from "../src/forge/forge.ts";
import { TransportError } from "../src/forge/transport.ts";
import { Mirror } from "../src/mirror.ts";
import { preselectedMergeMethod } from "../src/repo-settings.ts";
import { Store } from "../src/store.ts";
import { enrollmentSetup, FakeForge, PROPOSAL } from "./enrollment-fixture.ts";
import { git, tempDirectory } from "./git-fixture.ts";

const GITHUB = { forge: "github", host: "github.com", path: "acme/tally" };
const GITLAB = { forge: "gitlab", host: "gitlab.example.org", path: "acme/tally" };

function refusedFor(result: CheckResult): RefusalReason[] {
  assert.equal(result.ok, false, "the repo is refused");
  return result.ok ? [] : result.refusals.map((r) => r.reason);
}

function assertNothingEnrolled(store: Store): void {
  assert.deepEqual(store.listRepos(), [], "nothing is enrolled");
}

test("a repo that passes every check is reviewed with its project id, owner, vision and merge methods", async (t) => {
  const { enroller, repo, store } = enrollmentSetup(t);
  const result = await enroller.check(GITHUB);
  assert.ok(result.ok);
  const { review } = result;
  assert.deepEqual(review.setting, { forge: "github", host: "github.com", path: "acme/tally" });
  assert.equal(review.project.id, 5001);
  assert.deepEqual(review.owner, { forge: "github", host: "github.com", id: 1001, username: "owner" });
  assert.equal(review.defaultBranch, "main");
  assert.equal(review.visionSha, repo.head());
  assert.deepEqual(review.visionLines, ["Tally counts words in text.", "Tally reads standard input."], "lines by identity");
  assert.deepEqual(review.mergeMethods, ["squash", "merge", "rebase"]);
  assert.equal(review.preselectedMergeMethod, "squash");
  assert.deepEqual(review.warnings, []);
  assertNothingEnrolled(store);
});

test("checking sets up the repo's fetch-only mirror", async (t) => {
  const { enroller, repo, dataDirectory } = enrollmentSetup(t);
  assert.ok((await enroller.check(GITHUB)).ok);
  const mirror = await Mirror.open({
    dataDirectory,
    key: { forge: "github", host: "github.com", projectId: 5001 },
    remote: { url: repo.remote, credentialHelper: null },
  });
  assert.equal(git(mirror.directory, "rev-parse", "HEAD"), repo.head());
});

test("enrolling records the project id, the owner's account id, every line's origin, the merge method and settings version 1", async (t) => {
  const { enroller, store, repo } = enrollmentSetup(t);
  const result = await enroller.check(GITHUB);
  assert.ok(result.ok);
  const confirmed = await enroller.confirm(result.review, { visionOrigin: "owner-stated", mergeMethod: "rebase" });
  assert.ok(confirmed.ok);

  const enrolled = store.findRepo({ forge: "github", host: "github.com", projectId: 5001 });
  assert.ok(enrolled);
  assert.deepEqual(confirmed.repo, enrolled);
  assert.equal(enrolled.path, "acme/tally");
  assert.equal(enrolled.ownerAccountId, 1001);
  assert.equal(enrolled.ownerLogin, "owner");

  const settings = store.latestSettings(enrolled.id);
  assert.equal(settings?.version, 1);
  assert.equal(settings?.savedBy, "Ada", "saved with the owner's display name");
  assert.deepEqual(settings?.settings, {
    visionOrigin: "owner-stated",
    mergeMethod: "rebase",
    genericCriteria: [],
    shadow: false,
    whoCounts: "anyone",
    executors: [],
    pins: [],
    paused: false,
  });

  for (const line of ["Tally counts words in text.", "Tally reads standard input."]) {
    const origin = store.visionLineOrigin(enrolled.id, line);
    assert.equal(origin?.origin, "owner-stated", line);
    assert.equal(origin?.source, "enrollment");
    assert.equal(origin?.commitSha, repo.head());
  }
  assert.equal(confirmed.enrollment.visionSha, repo.head());
  assert.equal(confirmed.enrollment.settingsVersionId, settings?.id);
});

test("issues open at enrollment are recorded as not to be taken in", async (t) => {
  const { enroller, store, world } = enrollmentSetup(t);
  const result = await enroller.check(GITHUB);
  assert.ok(result.ok);
  world.openIssues = [12, 4, 9];
  const confirmed = await enroller.confirm(result.review, { visionOrigin: "agent-proposed-owner-approved", mergeMethod: "squash" });
  assert.ok(confirmed.ok);
  assert.deepEqual(confirmed.enrollment.openIssueNumbers, [4, 9, 12], "read when the owner confirms");
  assert.equal(store.wasOpenAtEnrollment(confirmed.repo.id, 9), true);
  assert.equal(store.wasOpenAtEnrollment(confirmed.repo.id, 13), false);
});

test("a GitLab repo has no merge method setting", async (t) => {
  const { enroller, store } = enrollmentSetup(t, { forge: "gitlab" });
  const result = await enroller.check(GITLAB);
  assert.ok(result.ok);
  assert.equal(result.review.mergeMethods, null);
  assert.equal(result.review.preselectedMergeMethod, null);
  const confirmed = await enroller.confirm(result.review, { visionOrigin: "agent-proposed-owner-approved", mergeMethod: null });
  assert.ok(confirmed.ok);
  assert.equal((store.latestSettings(confirmed.repo.id)?.settings as { mergeMethod: unknown }).mergeMethod, null);
  await assert.rejects(enroller.confirm(result.review, { visionOrigin: "owner-stated", mergeMethod: "squash" }));
});

test("the merge method preselection: the one allowed, else squash, else merge commit before rebase", () => {
  assert.equal(preselectedMergeMethod(["rebase"]), "rebase");
  assert.equal(preselectedMergeMethod(["merge"]), "merge");
  assert.equal(preselectedMergeMethod(["squash", "merge", "rebase"]), "squash");
  assert.equal(preselectedMergeMethod(["squash", "rebase"]), "squash");
  assert.equal(preselectedMergeMethod(["merge", "rebase"]), "merge");
  assert.equal(preselectedMergeMethod([]), "squash", "GitHub did not say");
});

test("a possible lack of permission to merge is a warning, and the repo still enrolls", async (t) => {
  const { enroller, world } = enrollmentSetup(t);
  world.access = { cannotLabelAndComment: null, mayLackMerge: "the logged-in account has no push access, which merging needs" };
  const result = await enroller.check(GITHUB);
  assert.ok(result.ok);
  assert.equal(result.review.warnings.length, 1);
  assert.match(result.review.warnings[0]!, /may lack permission to merge.*no push access/);
  assert.ok((await enroller.confirm(result.review, { visionOrigin: "owner-stated", mergeMethod: "squash" })).ok);
});

test("a host whose CLI is missing is refused", async (t) => {
  const { enroller, world, store } = enrollmentSetup(t);
  world.actor = new TransportError("gh api GET user on github.com: spawn gh ENOENT", false, true);
  const result = await enroller.check(GITHUB);
  assert.deepEqual(refusedFor(result), ["cli-missing"]);
  assert.ok(!result.ok && /`gh` is not installed/.test(result.refusals[0]!.message));
  assertNothingEnrolled(store);
});

test("a host whose CLI is not logged in is refused", async (t) => {
  const { enroller, world, store } = enrollmentSetup(t, { forge: "gitlab" });
  world.actor = null;
  const result = await enroller.check(GITLAB);
  assert.deepEqual(refusedFor(result), ["logged-out"]);
  assert.ok(!result.ok && /glab auth login --hostname gitlab\.example\.org/.test(result.refusals[0]!.message));
  world.actor = new ForgeLoggedOutError("gitlab.example.org", "401");
  assert.deepEqual(refusedFor(await enroller.check(GITLAB)), ["logged-out"]);
  assertNothingEnrolled(store);
});

test("a project that cannot be read is refused", async (t) => {
  const { enroller, world, store } = enrollmentSetup(t);
  world.project = new ForgeRequestError("github.com", 404, "GET", "repos/acme/tally", "Not Found");
  const result = await enroller.check(GITHUB);
  assert.deepEqual(refusedFor(result), ["project-unreadable"]);
  assertNothingEnrolled(store);
});

test("a project git cannot fetch is refused", async (t) => {
  const setup = enrollmentSetup(t);
  const enroller = new Enroller({
    store: setup.store,
    dataDirectory: setup.dataDirectory,
    runner: setup.runner,
    createForge: (setting) => new FakeForge(setting, setup.world),
    remoteFor: () => ({ url: tempDirectory(t, "nowhere"), credentialHelper: null }),
  });
  assert.deepEqual(refusedFor(await enroller.check(GITHUB)), ["project-unreadable"]);
  assertNothingEnrolled(setup.store);
});

test("an account that cannot add labels and comment is refused", async (t) => {
  const { enroller, world, store } = enrollmentSetup(t);
  world.access = { cannotLabelAndComment: "the logged-in account has read access only", mayLackMerge: "no push access" };
  const result = await enroller.check(GITHUB);
  assert.deepEqual(refusedFor(result), ["cannot-label-and-comment"]);
  assert.ok(!result.ok && /cannot add labels and comment in acme\/tally on github\.com as owner/.test(result.refusals[0]!.message));
  assertNothingEnrolled(store);
});

test("a GitLab older than 15.6 is refused", async (t) => {
  const { enroller, world, store } = enrollmentSetup(t, { forge: "gitlab" });
  world.instance = { version: "15.5.9", unsupported: "GitLab 15.5.9 is older than 15.6, the oldest version entail serves" };
  const result = await enroller.check(GITLAB);
  assert.deepEqual(refusedFor(result), ["gitlab-too-old"]);
  assertNothingEnrolled(store);
});

test("a default branch with no VISION.md is refused, pointing to /vision", async (t) => {
  const { enroller, store } = enrollmentSetup(t, { vision: null });
  const result = await enroller.check(GITHUB);
  assert.deepEqual(refusedFor(result), ["no-vision"]);
  assert.ok(!result.ok && /has no VISION\.md\. Write one with \/vision/.test(result.refusals[0]!.message));
  assertNothingEnrolled(store);
});

test("a default branch with an empty VISION.md, or one of headings only, is refused, pointing to /vision", async (t) => {
  for (const vision of ["", "# Tally\n\n## Goals\n"]) {
    const { enroller, store } = enrollmentSetup(t, { vision });
    const result = await enroller.check(GITHUB);
    assert.deepEqual(refusedFor(result), ["empty-vision"], JSON.stringify(vision));
    assert.ok(!result.ok && /\/vision/.test(result.refusals[0]!.message));
    assertNothingEnrolled(store);
  }
});

test("independent refusals are shown together, and a refused repo is not fetched", async (t) => {
  const { enroller, world, dataDirectory } = enrollmentSetup(t, { forge: "gitlab", vision: null });
  world.instance = { version: "15.0.0", unsupported: "GitLab 15.0.0 is older than 15.6, the oldest version entail serves" };
  world.access = { cannotLabelAndComment: "the logged-in account has Guest access only", mayLackMerge: null };
  assert.deepEqual(refusedFor(await enroller.check(GITLAB)), ["gitlab-too-old", "cannot-label-and-comment"]);
  assert.equal(existsSync(join(dataDirectory, "mirrors")), false, "no mirror was set up");
});

test("enrolling is unavailable until the owner's display name is set", async (t) => {
  const { enroller, store, created } = enrollmentSetup(t, { displayName: null });
  assert.deepEqual(refusedFor(await enroller.check(GITHUB)), ["no-display-name"]);
  assert.deepEqual(created, [], "nothing is read from the forge");

  store.saveGlobalSettings({ ownerDisplayName: "Ada" }, "Ada");
  const result = await enroller.check(GITHUB);
  assert.ok(result.ok);
  store.saveGlobalSettings({ ownerDisplayName: null }, "Ada");
  const confirmed = await enroller.confirm(result.review, { visionOrigin: "owner-stated", mergeMethod: "squash" });
  assert.ok(!confirmed.ok && confirmed.refusals[0]?.reason === "no-display-name");
  assertNothingEnrolled(store);
});

test("a repo already enrolled is refused, at the check and at the confirmation", async (t) => {
  const { enroller, store } = enrollmentSetup(t);
  const first = await enroller.check(GITHUB);
  const second = await enroller.check({ ...GITHUB, path: "acme/tally-renamed" });
  assert.ok(first.ok && second.ok);
  assert.ok((await enroller.confirm(first.review, { visionOrigin: "owner-stated", mergeMethod: "squash" })).ok);
  const again = await enroller.confirm(second.review, { visionOrigin: "owner-stated", mergeMethod: "squash" });
  assert.ok(!again.ok && again.refusals[0]?.reason === "already-enrolled", "the same project id under another path");
  assert.deepEqual(refusedFor(await enroller.check(GITHUB)), ["already-enrolled"]);
  assert.equal(store.listRepos().length, 1);
});

test("open issues that cannot be read at the confirmation leave nothing enrolled", async (t) => {
  const { enroller, world, store } = enrollmentSetup(t);
  const result = await enroller.check(GITHUB);
  assert.ok(result.ok);
  world.openIssues = new ForgeLoggedOutError("github.com", "401");
  const confirmed = await enroller.confirm(result.review, { visionOrigin: "owner-stated", mergeMethod: "squash" });
  assert.ok(!confirmed.ok && confirmed.refusals[0]?.reason === "logged-out");
  assertNothingEnrolled(store);
});

test("the stated forge, host and path are checked before any forge is asked", async (t) => {
  assert.equal(typeof parseStatedForge({ forge: "bitbucket", host: "x", path: "a/b" }), "string");
  assert.equal(typeof parseStatedForge({ forge: "github", host: " ", path: "a/b" }), "string");
  assert.equal(typeof parseStatedForge({ forge: "github", host: "github.com", path: "/" }), "string");
  assert.deepEqual(parseStatedForge({ forge: "gitlab", host: " GitLab.Example.org ", path: "/group/sub/tally/" }), {
    forge: "gitlab",
    host: "gitlab.example.org",
    path: "group/sub/tally",
  });

  // The real adapters refuse a GitHub host other than github.com before running any CLI.
  const { store, dataDirectory, runner } = enrollmentSetup(t);
  const enroller = new Enroller({ store, dataDirectory, runner });
  const result = await enroller.check({ forge: "github", host: "github.example.com", path: "acme/tally" });
  assert.deepEqual(refusedFor(result), ["invalid-forge-setting"]);
  assert.ok(!result.ok && /GitHub Enterprise Server is not supported/.test(result.refusals[0]!.message));
});

test("the generic criteria proposal is one read-only model run over the CI files and build scripts, with no challenge", async (t) => {
  const { enroller, runner, repo, store } = enrollmentSetup(t);
  store.saveGlobalSettings({ ownerDisplayName: "Ada", model: "claude-test-model" }, "Ada");
  const result = await enroller.check(GITHUB);
  assert.ok(result.ok);
  assert.equal(runner.requests.length, 1, "one run, and no challenge");
  const [request] = runner.requests;
  assert.equal(request!.kind, "generic-criteria-proposal");
  assert.equal(request!.ticket, null);
  assert.equal(request!.schema, genericCriteriaProposalSchema, "its own schema");
  assert.equal(request!.promptVersion, GENERIC_CRITERIA_PROPOSAL_PROMPT_VERSION);
  assert.equal(request!.model, "claude-test-model", "the model from the global settings");
  assert.equal(request!.sha, repo.head());
  assert.ok(existsSync(join(request!.checkout, ".github", "workflows", "ci.yml")), "it reads a checkout at the vision's commit");
  assert.match(request!.prompt, /- \.github\/workflows\/ci\.yml\n- package\.json/);
  assert.match(request!.prompt, /- lint\n- test/, "it is told the checks seen on recent default-branch commits");

  const { genericCriteria } = result.review;
  assert.deepEqual(genericCriteria.files, [".github/workflows/ci.yml", "package.json"]);
  assert.deepEqual(genericCriteria.seenChecks, ["lint", "test"]);
  assert.equal(genericCriteria.proposal.failure, null);
  assert.deepEqual(genericCriteria.proposal.rows, [
    { sentence: "The check `test` passes.", check: { kind: "check_passes", argument: "test" }, sourceFile: ".github/workflows/ci.yml" },
    { sentence: "The check `lint` passes.", check: { kind: "check_passes", argument: "lint" }, sourceFile: ".github/workflows/ci.yml" },
  ]);
});

test("the confirmed generic criteria are numbered G1…Gn in the settings version, and the proposal is recorded with its full model run", async (t) => {
  const { enroller, store } = enrollmentSetup(t);
  const result = await enroller.check(GITHUB);
  assert.ok(result.ok);
  const [proposed] = result.review.genericCriteria.proposal.rows;
  const confirmed = await enroller.confirm(result.review, {
    visionOrigin: "owner-stated",
    mergeMethod: "squash",
    genericCriteria: [
      { ...proposed!, sentence: "  The check `test`\n passes on the PR's head. " },
      { sentence: "The PR leaves the lockfile alone.", check: { kind: "leaves_path", argument: "package-lock.json" }, sourceFile: null },
    ],
  });
  assert.ok(confirmed.ok);
  assert.deepEqual((store.latestSettings(confirmed.repo.id)?.settings as { genericCriteria: unknown }).genericCriteria, [
    {
      id: "G1",
      sentence: "The check `test` passes on the PR's head.",
      check: { kind: "check_passes", argument: "test" },
      source: ".github/workflows/ci.yml",
    },
    { id: "G2", sentence: "The PR leaves the lockfile alone.", check: { kind: "leaves_path", argument: "package-lock.json" }, source: null },
  ]);

  const [run, ...others] = store.enrollmentModelRuns(confirmed.enrollment.id);
  assert.deepEqual(others, []);
  assert.equal(run!.purpose, "generic-criteria-proposal");
  assert.equal(run!.promptVersion, GENERIC_CRITERIA_PROPOSAL_PROMPT_VERSION);
  assert.equal(run!.model, "claude-opus-5-5");
  assert.equal(run!.sessionId, "scripted-1");
  assert.deepEqual(JSON.parse(run!.output!), PROPOSAL, "the full output");
  assert.equal(run!.failure, null);
  const input = JSON.parse(run!.input) as { prompt: string; sha: string; schema: unknown };
  assert.match(input.prompt, /generic criteria/);
  assert.equal(input.sha, confirmed.enrollment.visionSha);
  assert.deepEqual(input.schema, genericCriteriaProposalSchema.json);
});

test("an empty generic criteria list is accepted", async (t) => {
  const { enroller, store } = enrollmentSetup(t);
  const result = await enroller.check(GITHUB);
  assert.ok(result.ok);
  const confirmed = await enroller.confirm(result.review, { visionOrigin: "owner-stated", mergeMethod: "squash", genericCriteria: [] });
  assert.ok(confirmed.ok);
  assert.deepEqual((store.latestSettings(confirmed.repo.id)?.settings as { genericCriteria: unknown }).genericCriteria, []);
});

test("a row that cannot be kept is refused at the confirmation, and nothing is enrolled", async (t) => {
  const { enroller, store } = enrollmentSetup(t);
  const result = await enroller.check(GITHUB);
  assert.ok(result.ok);
  await assert.rejects(
    enroller.confirm(result.review, {
      visionOrigin: "owner-stated",
      mergeMethod: "squash",
      genericCriteria: [{ sentence: "/close", check: null, sourceFile: null }],
    }),
    /cannot start with \//,
  );
  assertNothingEnrolled(store);
});

for (const [name, outcome] of [
  ["a timeout", { failure: { kind: "timeout", message: "the run took longer than 10 minutes" } }],
  ["output outside the schema", { output: { criteria: [{ sentence: "x" }], reason: "r" } }],
] as const) {
  test(`a machine failure of the proposal (${name}) leaves an empty, editable list and never blocks enrollment`, async (t) => {
    const { enroller, store, runner } = enrollmentSetup(t, { proposals: [outcome] });
    const result = await enroller.check(GITHUB);
    assert.ok(result.ok, "the repo is not refused");
    const { proposal } = result.review.genericCriteria;
    assert.deepEqual(proposal.rows, []);
    assert.ok(proposal.failure);
    assert.equal(runner.requests.length, 1, "not retried");
    const confirmed = await enroller.confirm(result.review, {
      visionOrigin: "owner-stated",
      mergeMethod: "squash",
      genericCriteria: [{ sentence: "The check `test` passes.", check: { kind: "check_passes", argument: "test" }, sourceFile: null }],
    });
    assert.ok(confirmed.ok);
    const [run] = store.enrollmentModelRuns(confirmed.enrollment.id);
    assert.equal(run!.output, null, "the failed run is recorded with its failure");
    assert.equal((run!.failure as { kind: string }).kind, proposal.failure.kind);
  });
}

test("a runner that throws is a machine failure too", async (t) => {
  const { enroller } = enrollmentSetup(t, { proposals: [] });
  const result = await enroller.check(GITHUB);
  assert.ok(result.ok);
  assert.equal(result.review.genericCriteria.proposal.failure?.kind, "error");
  assert.match(result.review.genericCriteria.proposal.failure!.message, /no scripted outcome/);
});

test("checks that cannot be read do not refuse the repo, and the proposal is told so", async (t) => {
  const { enroller, world, runner } = enrollmentSetup(t);
  world.recentChecks = new Error("pipelines are disabled");
  const result = await enroller.check(GITHUB);
  assert.ok(result.ok);
  assert.equal(result.review.genericCriteria.seenChecks, null);
  assert.match(result.review.genericCriteria.seenChecksProblem!, /pipelines are disabled/);
  assert.match(runner.requests[0]!.prompt, /could not be read/);
});
