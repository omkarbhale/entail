import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { createForge } from "../../src/forge/create-forge.ts";
import { ForgeCutOffError, ForgeLoggedOutError, ForgeRequestError, ForgeUntrustedCertificateError, projectKey, RateLimitedError } from "../../src/forge/forge.ts";
import { CHANGE_OVERLAP_MS, GitLabForge, REQUIRED_PIPELINE, unsupportedGitLabVersion } from "../../src/forge/gitlab.ts";
import { type Exchange, loadRecording, RecordedTransport } from "./recorded-transport.ts";

const SELF_HOSTED = "gitlab.example.org";
const SETTING = { forge: "gitlab", host: SELF_HOSTED, path: "acme/tally" } as const;
const ORDER = "order_by=updated_at&sort=desc&per_page=100";
const ISSUES = `projects/acme%2Ftally/issues?${ORDER}`;
const notesOf = (iid: number) => `projects/acme%2Ftally/issues/${iid}/notes?${ORDER}`;
const after = (time: string) => `${ISSUES}&updated_after=${encodeURIComponent(time)}`;
const MERGE_REQUESTS = `projects/acme%2Ftally/merge_requests?${ORDER}`;
const mergeRequestsAfter = (time: string) => `${MERGE_REQUESTS}&updated_after=${encodeURIComponent(time)}`;
/** The merge request list read on a pass with no merge requests changed. */
const NO_MERGE_REQUESTS: Exchange = { request: { method: "GET", path: MERGE_REQUESTS }, response: { status: 200, headers: { "X-Next-Page": "" }, body: [] } };

function forgeOn(t: TestContext, exchanges: Exchange[]): { forge: GitLabForge; transport: RecordedTransport } {
  const transport = new RecordedTransport({ host: SELF_HOSTED, exchanges });
  t.after(() => transport.assertDone());
  return { forge: new GitLabForge(SETTING, transport), transport };
}

const OWNER = { id: 7, username: "owner" };

function issue(iid: number, updatedAt: string, notes: number, extra: Record<string, unknown> = {}) {
  return {
    id: 9000 + iid,
    iid,
    title: `Issue ${iid}`,
    description: null,
    state: "opened",
    author: OWNER,
    labels: [],
    user_notes_count: notes,
    created_at: updatedAt,
    updated_at: updatedAt,
    web_url: `https://${SELF_HOSTED}/acme/tally/-/issues/${iid}`,
    ...extra,
  };
}

function note(id: number, updatedAt: string, system = false) {
  return { id, body: `note ${id}`, author: OWNER, system, created_at: updatedAt, updated_at: updatedAt, noteable_type: "Issue" };
}

const list = (body: unknown[], nextPage = "") => ({ status: 200, headers: { "X-Next-Page": nextPage }, body });

test("change detection re-reads issues updated within an overlap window of at least two minutes before the cursor", async (t) => {
  assert.ok(CHANGE_OVERLAP_MS >= 2 * 60_000);
  const cursor = JSON.stringify({ since: "2026-11-01T11:00:00.000Z", mergeRequestsSince: "2026-11-01T12:00:00.000Z" });
  const { forge } = forgeOn(t, [
    { request: { method: "GET", path: after("2026-11-01T10:58:00.000Z") }, response: list([]) },
    { request: { method: "GET", path: mergeRequestsAfter("2026-11-01T11:58:00.000Z") }, response: list([]) },
  ]);
  const batch = await forge.changesSince(cursor);
  assert.deepEqual(batch, { changes: [], cursor }, "with nothing in the window, the cursor stays");
});

test("an issue's notes are paged newest first until reaching notes already seen", async (t) => {
  const cursor = JSON.stringify({ since: "2026-11-02T09:00:00.000Z" });
  // Seen before: anything last updated before 08:58, the cursor less the overlap.
  const { forge, transport } = forgeOn(t, [
    { request: { method: "GET", path: after("2026-11-02T08:58:00.000Z") }, response: list([issue(2, "2026-11-02T09:10:00.000Z", 4)]) },
    {
      request: { method: "GET", path: notesOf(2) },
      response: list([note(7005, "2026-11-02T09:10:00.000Z"), note(7004, "2026-11-02T09:05:00.000Z", true)], "2"),
    },
    {
      request: { method: "GET", path: `${notesOf(2)}&page=2` },
      // 7002 was edited inside the window, so it is read again; 7001 was seen, so paging stops there.
      response: list([note(7002, "2026-11-02T08:59:00.000Z"), note(7001, "2026-11-01T11:05:00.000Z")], "3"),
    },
    NO_MERGE_REQUESTS,
  ]);
  const batch = await forge.changesSince(cursor);
  assert.deepEqual(
    batch.changes.map((c) => `${c.kind} ${c.id}`),
    ["issue 9002", "issue-comment 7005", "issue-comment 7002"],
    "system notes are not comments, and seen notes are not read",
  );
  assert.equal(transport.requests.length, 4, "page 3 is never asked for");
  assert.deepEqual(
    JSON.parse(batch.cursor),
    { since: "2026-11-02T09:10:00.000Z", mergeRequestsSince: null },
    "the cursor moves to the newest issue update",
  );
  const comment = batch.changes[1];
  assert.ok(comment?.kind === "issue-comment");
  assert.equal(comment.comment.issueNumber, 2);
  assert.equal(comment.comment.url, `https://${SELF_HOSTED}/acme/tally/-/issues/2#note_7005`);
});

test("with no cursor every issue and every page of notes is read, skipping issues with no notes by people", async (t) => {
  const { forge } = forgeOn(t, [
    { request: { method: "GET", path: ISSUES }, response: list([issue(2, "2026-11-01T11:00:00.000Z", 2)], "2") },
    { request: { method: "GET", path: `${ISSUES}&page=2` }, response: list([issue(1, "2026-11-01T10:00:00.000Z", 0)]) },
    { request: { method: "GET", path: notesOf(2) }, response: list([note(7002, "2026-11-01T11:00:00.000Z")], "2") },
    { request: { method: "GET", path: `${notesOf(2)}&page=2` }, response: list([note(7001, "2020-01-01T00:00:00.000Z")]) },
    NO_MERGE_REQUESTS,
  ]);
  const batch = await forge.changesSince(null);
  assert.deepEqual(
    batch.changes.map((c) => `${c.kind} ${c.id}`),
    ["issue 9002", "issue-comment 7002", "issue-comment 7001", "issue 9001"],
  );
  const first = batch.changes[0];
  assert.ok(first?.kind === "issue");
  assert.equal(first.issue.body, "", "a missing description reads as empty");
});

test("issues map GitLab's states and either form of labels", async (t) => {
  const { forge } = forgeOn(t, [
    {
      request: { method: "GET", path: ISSUES },
      response: list([issue(4, "2026-11-01T10:00:00.000Z", 0, { state: "closed", labels: [{ id: 1, name: "entail:cleared" }, "bug"] })]),
    },
    NO_MERGE_REQUESTS,
  ]);
  const [change] = (await forge.changesSince(null)).changes;
  assert.ok(change?.kind === "issue");
  assert.equal(change.issue.state, "closed");
  assert.deepEqual(change.issue.labels, ["entail:cleared", "bug"]);
});

for (const [name, cursor] of [
  ["not JSON", "garbage{"],
  ["the wrong shape", JSON.stringify({ issues: 1 })],
  ["a since that is not a time", JSON.stringify({ since: "nope", mergeRequestsSince: 7 })],
] as const) {
  test(`a cursor that is ${name} costs a full re-scan`, async (t) => {
    const { forge } = forgeOn(t, [{ request: { method: "GET", path: ISSUES }, response: list([]) }, NO_MERGE_REQUESTS]);
    const batch = await forge.changesSince(cursor);
    assert.deepEqual(batch, { changes: [], cursor: JSON.stringify({ since: null, mergeRequestsSince: null }) });
  });
}

test("a self-hosted Community Edition instance is read at its own host, with its version", async (t) => {
  const transport = new RecordedTransport(loadRecording(new URL("./recordings/gitlab/self-hosted-ce.json", import.meta.url)));
  t.after(() => transport.assertDone());
  const forge = new GitLabForge({ forge: "gitlab", host: SELF_HOSTED, path: "platform/tools/tally" }, transport);

  assert.deepEqual(await forge.instance(), { version: "16.11.10", unsupported: null });
  assert.deepEqual(await forge.currentActor(), { forge: "gitlab", host: SELF_HOSTED, id: 7, username: "owner" });
  const project = await forge.project();
  assert.deepEqual(project, { forge: "gitlab", host: SELF_HOSTED, id: 42, path: "platform/tools/tally", defaultBranch: "trunk", baseBranch: "trunk" });
  assert.equal(projectKey(project), `gitlab:${SELF_HOSTED}:42`);
  assert.ok(transport.requests.every((r) => r.host === SELF_HOSTED), "every call goes to the instance's own host");
});

test("an instance older than 15.7 is unsupported", async (t) => {
  const { forge } = forgeOn(t, [
    { request: { method: "GET", path: "version" }, response: { status: 200, body: { version: "15.6.8", revision: "abc" } } },
  ]);
  const instance = await forge.instance();
  assert.equal(instance.version, "15.6.8");
  assert.match(instance.unsupported ?? "", /older than 15\.7/);
});

test("which GitLab versions are served", () => {
  for (const version of ["15.7.0", "15.11.13", "16.11.10", "17.5.0-ee", "18.6.0-pre", "16.0.0-rc42-ee", "20.0"]) {
    assert.equal(unsupportedGitLabVersion(version), null, `${version} is served`);
  }
  for (const version of ["15.6.8", "15.5.4", "14.10.5-ee", "8.17.0"]) {
    assert.match(unsupportedGitLabVersion(version) ?? "", /older than 15\.7/, `${version} is not served`);
  }
  for (const version of ["", "sixteen", "16"]) {
    assert.match(unsupportedGitLabVersion(version) ?? "", /cannot read/, `${JSON.stringify(version)} cannot be read`);
  }
});

test("a 429 with only Retry-After waits that long, and one with no reset time waits a minute", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-08T10:00:00Z") });
  const { forge } = forgeOn(t, [
    { request: { method: "GET", path: ISSUES }, response: { status: 429, headers: { "Retry-After": "120" }, body: "Retry later\n" } },
    { request: { method: "GET", path: "user" }, response: { status: 429, body: "Retry later\n" } },
  ]);
  await assert.rejects(forge.changesSince(null), (error: unknown) => {
    return error instanceof RateLimitedError && error.resetAt.toISOString() === "2026-11-08T10:02:00.000Z";
  });
  await assert.rejects(forge.currentActor(), (error: unknown) => {
    return error instanceof RateLimitedError && error.resetAt.toISOString() === "2026-11-08T10:01:00.000Z";
  });
});

test("glab refusing a login it cannot use gives no actor, and reads fail as logged out", async (t) => {
  const message = `glab api GET user on ${SELF_HOSTED}: the token for "${SELF_HOSTED}" is missing from the operating system keyring; run \`glab auth login --hostname ${SELF_HOSTED}\` to re-authenticate`;
  const { forge } = forgeOn(t, [
    { request: { method: "GET", path: "user" }, error: { message, loggedOut: true } },
    { request: { method: "GET", path: "version" }, error: { message, loggedOut: true } },
  ]);
  assert.equal(await forge.currentActor(), null);
  await assert.rejects(forge.instance(), ForgeLoggedOutError);
});

test("an error status that is not a login or rate limit is a request error with GitLab's message", async (t) => {
  const { forge } = forgeOn(t, [
    { request: { method: "GET", path: "projects/acme%2Ftally" }, response: { status: 404, body: { message: "404 Project Not Found" } } },
    { request: { method: "GET", path: "user" }, error: { message: `could not reach ${SELF_HOSTED}`, loggedOut: false } },
  ]);
  await assert.rejects(forge.project(), (error: unknown) => {
    return error instanceof ForgeRequestError && error.status === 404 && /404 Project Not Found/.test(error.message);
  });
  await assert.rejects(forge.currentActor(), /could not reach/, "a transport failure is not taken for no actor");
});

test("the forge setting is a host name and a project path, never a base URL", () => {
  const transport = new RecordedTransport({ host: SELF_HOSTED, exchanges: [] });
  for (const host of ["https://gitlab.example.org", "gitlab.example.org:8443", "gitlab.example.org/gitlab", ""]) {
    assert.throws(() => new GitLabForge({ ...SETTING, host }, transport), /host name/, `${host} is refused`);
  }
  for (const path of ["tally", "acme/../tally", "acme/tally/", "/acme/tally", "acme//tally"]) {
    assert.throws(() => new GitLabForge({ ...SETTING, path }, transport), /namespace\/name/, `${path} is refused`);
  }
  assert.throws(() => new GitLabForge({ ...SETTING, forge: "github" }, transport), /github/);
  assert.ok(new GitLabForge({ ...SETTING, path: "group/sub.group/my_tally" }, transport));
});

test("createForge picks the GitLab adapter for gitlab.com and self-hosted hosts alike", () => {
  const transport = new RecordedTransport({ host: SELF_HOSTED, exchanges: [] });
  assert.ok(createForge({ forge: "gitlab", host: "gitlab.com", path: "acme/tally" }, transport) instanceof GitLabForge);
  assert.ok(createForge(SETTING, transport) instanceof GitLabForge);
});

/** The Free/CE REST endpoints the adapter reads and writes: nothing that needs Premium or Ultimate. */
const FREE_ENDPOINTS = [
  /^user$/,
  /^version$/,
  /^users\?username=[^&]+$/,
  /^projects\/[^/?]+$/,
  /^projects\/[^/?]+\/issues\?/,
  /^projects\/[^/?]+\/issues\/\d+$/,
  /^projects\/[^/?]+\/issues\/\d+\/closed_by\?/,
  /^projects\/[^/?]+\/issues\/\d+\/resource_state_events\?/,
  /^projects\/[^/?]+\/(issues|merge_requests)\/\d+\/notes(\?|$)/,
  /^projects\/[^/?]+\/labels(\/[^/?]+)?$/,
  /^projects\/[^/?]+\/merge_requests\?/,
  /^projects\/[^/?]+\/merge_requests\/\d+(\/merge|\?with_merge_status_recheck=true)?$/,
  /^projects\/[^/?]+\/merge_requests\/\d+\/closes_issues\?/,
  /^projects\/[^/?]+\/merge_requests\/\d+\/diffs\?/,
  /^projects\/[^/?]+\/pipelines\?/,
  /^projects\/[^/?]+\/pipelines\/\d+\/jobs\?/,
];

test("every recorded GitLab request is a Free/CE endpoint", () => {
  const dir = new URL("./recordings/gitlab/", import.meta.url);
  const paths = readdirSync(dir).flatMap((file) => loadRecording(new URL(file, dir)).exchanges.map((e) => e.request.path));
  assert.ok(paths.length > 0);
  for (const path of paths) {
    assert.ok(
      FREE_ENDPOINTS.some((endpoint) => endpoint.test(path)),
      `${path} is a Free/CE endpoint`,
    );
  }
});

const SHA = "4f1c0c3e9b2a7d6e5f4a3b2c1d0e9f8a7b6c5d4e";
const PROJECT = "projects/acme%2Ftally";

function mergeRequest(iid: number, extra: Record<string, unknown> = {}) {
  return {
    id: 8000 + iid,
    iid,
    project_id: 5001,
    title: `Merge request ${iid}`,
    description: null,
    state: "opened",
    draft: false,
    sha: SHA,
    target_branch: "main",
    source_branch: "topic",
    author: OWNER,
    user_notes_count: 0,
    detailed_merge_status: "mergeable",
    has_conflicts: false,
    created_at: "2026-11-02T09:00:00.000Z",
    updated_at: "2026-11-02T09:00:00.000Z",
    web_url: `https://${SELF_HOSTED}/acme/tally/-/merge_requests/${iid}`,
    ...extra,
  };
}

function job(name: string, status: string, allowFailure = false) {
  return { id: name.length, name, status, allow_failure: allowFailure, web_url: `https://${SELF_HOSTED}/acme/tally/-/jobs/1` };
}

test("a job allowed to fail follows GitLab's pipeline status, and a blocking manual job holds the pipeline", async (t) => {
  const { forge } = forgeOn(t, [
    { request: { method: "GET", path: PROJECT }, response: { status: 200, body: { id: 5001, default_branch: "main" } } },
    {
      request: { method: "GET", path: `${PROJECT}/merge_requests/4` },
      response: { status: 200, body: mergeRequest(4, { head_pipeline: { id: 61, sha: SHA, status: "manual" } }) },
    },
    {
      request: { method: "GET", path: `${PROJECT}/pipelines/61/jobs?per_page=100` },
      response: list([
        job("optional-canceled", "canceled", true),
        job("canceled", "canceled"),
        job("optional-manual", "manual", true),
        job("release", "manual"),
        job("queued", "created"),
        job("waiting", "waiting_for_resource"),
        job("later", "scheduled"),
      ]),
    },
  ]);
  const report = await forge.checks(4, SHA, []);
  assert.deepEqual(
    report.checks.map((check) => `${check.name} ${check.status}`),
    [
      "canceled failed",
      "later pending",
      "optional-canceled passed",
      "optional-manual passed",
      "queued pending",
      "release pending",
      "waiting pending",
    ],
  );
  assert.deepEqual(report.required, [], "with \"pipelines must succeed\" off, GitLab requires nothing");
});

test("a merge request with no pipeline has no checks, and the required pipeline has not reported", async (t) => {
  const { forge } = forgeOn(t, [
    {
      request: { method: "GET", path: PROJECT },
      response: { status: 200, body: { id: 5001, default_branch: "main", only_allow_merge_if_pipeline_succeeds: true } },
    },
    { request: { method: "GET", path: `${PROJECT}/merge_requests/4` }, response: { status: 200, body: mergeRequest(4, { head_pipeline: null }) } },
  ]);
  const report = await forge.checks(4, SHA, []);
  assert.deepEqual(report, { sha: SHA, checks: [], required: [{ name: REQUIRED_PIPELINE, reported: false }] });
});

test("a merge request's mergeability is unknown while GitLab is still checking it, and a locked one is still open", async (t) => {
  const { forge } = forgeOn(t, [
    {
      request: { method: "GET", path: `${PROJECT}/merge_requests/4?with_merge_status_recheck=true` },
      response: { status: 200, body: mergeRequest(4, { detailed_merge_status: "checking", has_conflicts: false }) },
    },
    {
      request: { method: "GET", path: `${PROJECT}/merge_requests/5?with_merge_status_recheck=true` },
      response: { status: 200, body: mergeRequest(5, { state: "locked", detailed_merge_status: "ci_still_running" }) },
    },
    {
      request: { method: "GET", path: `${PROJECT}/merge_requests/6?with_merge_status_recheck=true` },
      response: { status: 200, body: mergeRequest(6, { detailed_merge_status: "need_rebase", has_conflicts: true }) },
    },
  ]);
  const checking = await forge.pullRequest(4);
  assert.deepEqual({ mergeable: checking.mergeable, conflicts: checking.conflicts }, { mergeable: null, conflicts: null });
  const locked = await forge.pullRequest(5);
  assert.deepEqual({ state: locked.state, mergeable: locked.mergeable }, { state: "open", mergeable: false });
  const behind = await forge.pullRequest(6);
  assert.deepEqual({ mergeable: behind.mergeable, conflicts: behind.conflicts }, { mergeable: false, conflicts: true });
  assert.equal(behind.body, "", "a missing description reads as empty");
});

test("merge request notes are paged newest first until reaching notes already seen, and one with no notes by people is not read", async (t) => {
  const cursor = JSON.stringify({ since: null, mergeRequestsSince: "2026-11-02T09:00:00.000Z" });
  const notesOfMergeRequest = (iid: number) => `${PROJECT}/merge_requests/${iid}/notes?${ORDER}`;
  const { forge } = forgeOn(t, [
    { request: { method: "GET", path: ISSUES }, response: list([]) },
    {
      request: { method: "GET", path: mergeRequestsAfter("2026-11-02T08:58:00.000Z") },
      response: list([mergeRequest(4, { user_notes_count: 2, updated_at: "2026-11-02T09:10:00.000Z" }), mergeRequest(5)]),
    },
    {
      request: { method: "GET", path: notesOfMergeRequest(4) },
      response: list([note(7005, "2026-11-02T09:10:00.000Z"), note(7004, "2026-11-02T09:05:00.000Z", true), note(7001, "2026-11-01T11:05:00.000Z")]),
    },
  ]);
  const batch = await forge.changesSince(cursor);
  assert.deepEqual(
    batch.changes.map((c) => `${c.kind} ${c.id}`),
    ["pull-request 8004", "pull-request-comment 7005", "pull-request 8005"],
  );
  const comment = batch.changes[1];
  assert.ok(comment?.kind === "pull-request-comment");
  assert.equal(comment.comment.url, `https://${SELF_HOSTED}/acme/tally/-/merge_requests/4#note_7005`);
  assert.deepEqual(JSON.parse(batch.cursor), { since: null, mergeRequestsSince: "2026-11-02T09:10:00.000Z" });
});

test("a commit run more than once on the default branch keeps its newest pipeline", async (t) => {
  const pipelines = `${PROJECT}/pipelines?ref=main&order_by=id&sort=desc&per_page=3`;
  const { forge } = forgeOn(t, [
    { request: { method: "GET", path: PROJECT }, response: { status: 200, body: { id: 5001, default_branch: "main" } } },
    {
      request: { method: "GET", path: pipelines },
      response: list([
        { id: 73, sha: SHA },
        { id: 72, sha: SHA },
        { id: 71, sha: "1c1c1c1c2d2d2d2d3e3e3e3e4f4f4f4f50505050" },
      ]),
    },
    { request: { method: "GET", path: `${PROJECT}/pipelines/73/jobs?per_page=100` }, response: list([job("test", "success")]) },
    { request: { method: "GET", path: `${PROJECT}/pipelines/71/jobs?per_page=100` }, response: list([job("test", "failed")]) },
  ]);
  const recent = await forge.recentDefaultBranchChecks(3);
  assert.deepEqual(
    recent.map((commit) => `${commit.sha.slice(0, 4)} ${commit.checks.map((c) => c.status).join()}`),
    ["4f1c passed", "1c1c failed"],
  );
});

function accessOn(t: TestContext, user: Record<string, unknown>, project: Record<string, unknown>) {
  return forgeOn(t, [
    { request: { method: "GET", path: "user" }, response: { status: 200, body: { ...OWNER, ...user } } },
    { request: { method: "GET", path: PROJECT }, response: { status: 200, body: { id: 5001, issues_enabled: true, ...project } } },
  ]).forge;
}
const level = (project: number | null, group: number | null = null) => ({
  permissions: {
    project_access: project === null ? null : { access_level: project, notification_level: 3 },
    group_access: group === null ? null : { access_level: group, notification_level: 3 },
  },
});

test("a Maintainer, through the project or its group, can label, comment and merge", async (t) => {
  assert.deepEqual(await accessOn(t, {}, level(40)).access(), { cannotLabelAndComment: null, mayLackMerge: null });
  assert.deepEqual(await accessOn(t, {}, level(20, 50)).access(), { cannotLabelAndComment: null, mayLackMerge: null });
});

test("a Developer or Reporter can label and comment, and may lack permission to merge", async (t) => {
  const developer = await accessOn(t, {}, level(30)).access();
  assert.equal(developer.cannotLabelAndComment, null);
  assert.match(developer.mayLackMerge ?? "", /Developer access/);
  const reporter = await accessOn(t, {}, level(20)).access();
  assert.equal(reporter.cannotLabelAndComment, null);
  assert.match(reporter.mayLackMerge ?? "", /less than Developer/);
});

test("a Guest, a non-member, or a project with issues turned off cannot label and comment", async (t) => {
  assert.match((await accessOn(t, {}, level(10)).access()).cannotLabelAndComment ?? "", /Guest access only/);
  assert.match((await accessOn(t, {}, level(null)).access()).cannotLabelAndComment ?? "", /not a member/);
  const off = await accessOn(t, {}, { ...level(50), issues_enabled: false, issues_access_level: "disabled" }).access();
  assert.match(off.cannotLabelAndComment ?? "", /issues turned off/);
});

test("an instance administrator can do everything without being a member", async (t) => {
  assert.deepEqual(await accessOn(t, { is_admin: true }, level(null)).access(), { cannotLabelAndComment: null, mayLackMerge: null });
});

test("GitLab has no merge method setting, and its open issues are read page by page", async (t) => {
  const open = `${PROJECT}/issues?state=opened&per_page=100`;
  const { forge } = forgeOn(t, [
    { request: { method: "GET", path: open }, response: list([{ iid: 9 }, { iid: 4 }], "2") },
    { request: { method: "GET", path: `${open}&page=2` }, response: list([{ iid: 1 }]) },
  ]);
  assert.equal(await forge.mergeMethods(), null);
  assert.deepEqual(await forge.openIssueNumbers(), [1, 4, 9]);
});

test("a username lookup matches the exact username whatever its case, and a name GitLab cannot have is not looked up", async (t) => {
  const { forge, transport } = forgeOn(t, [
    {
      request: { method: "GET", path: "users?username=Executor" },
      response: { status: 200, body: [{ id: 12, username: "executor", name: "Executor" }] },
    },
    { request: { method: "GET", path: "users?username=ghost.user" }, response: { status: 200, body: [{ id: 13, username: "ghost-user" }] } },
  ]);
  assert.deepEqual(await forge.actorByUsername("Executor"), { forge: "gitlab", host: SELF_HOSTED, id: 12, username: "executor" });
  assert.equal(await forge.actorByUsername("ghost.user"), null, "a near match is not the user");
  for (const name of ["", "-lead", "a b", "x/y", "user&x=1"]) assert.equal(await forge.actorByUsername(name), null, name);
  assert.equal(transport.requests.length, 2);
});

test("a merge request's changed files are read from GitLab's diffs: a mode change is changed, and a diff GitLab leaves out counts no lines", async (t) => {
  const diff = (extra: Record<string, unknown>) => ({ diff: "", new_path: "x", old_path: "x", a_mode: "100644", b_mode: "100644", new_file: false, renamed_file: false, deleted_file: false, ...extra });
  const { forge } = forgeOn(t, [
    {
      request: { method: "GET", path: `${PROJECT}/merge_requests/4/diffs?per_page=100` },
      response: {
        status: 200,
        body: [
          diff({ new_path: "bin/tally", old_path: "bin/tally", a_mode: "100644", b_mode: "100755" }),
          diff({ new_path: "data/words.txt", old_path: "data/words.txt", too_large: true }),
          diff({ new_path: "src/count.ts", old_path: "src/count.ts", diff: "@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n context\n" }),
        ],
      },
    },
  ]);
  assert.deepEqual(await forge.pullRequestFiles(4), [
    { path: "bin/tally", status: "changed", previousPath: null, additions: 0, deletions: 0 },
    { path: "data/words.txt", status: "modified", previousPath: null, additions: 0, deletions: 0 },
    { path: "src/count.ts", status: "modified", previousPath: null, additions: 1, deletions: 1 },
  ]);
});

test("reopening an issue and closing a merge request send GitLab's state events", async (t) => {
  const { forge, transport } = forgeOn(t, [
    { request: { method: "PUT", path: `${PROJECT}/issues/7`, body: { state_event: "reopen" } }, response: { status: 200, body: {} } },
    { request: { method: "PUT", path: `${PROJECT}/merge_requests/4`, body: { state_event: "close" } }, response: { status: 200, body: {} } },
  ]);
  await forge.reopenIssue(7);
  await forge.closePullRequest(4);
  assert.equal(transport.requests.length, 2);
});

test("an issue's blockers are its links of type is_blocked_by, with each blocker's project path and state", async (t) => {
  const link = (iid: number, full: string, link_type: string, state = "opened") => ({ ...issue(iid, "2026-11-01T10:00:00Z", 0), state, link_type, references: { full } });
  const { forge } = forgeOn(t, [
    {
      request: { method: "GET", path: "projects/acme%2Ftally/issues/5/links" },
      response: {
        status: 200,
        body: [link(3, "acme/tally#3", "is_blocked_by"), link(9, "acme/libs/core#9", "is_blocked_by", "closed"), link(4, "acme/tally#4", "relates_to"), link(6, "acme/tally#6", "blocks")],
      },
    },
    { request: { method: "GET", path: "projects/acme%2Ftally/issues/6/links" }, response: { status: 200, body: [link(4, "acme/tally#4", "relates_to")] } },
    { request: { method: "GET", path: "projects/acme%2Ftally/issues/7/links" }, response: { status: 403, body: { message: "403 Forbidden" } } },
  ]);
  assert.deepEqual(await forge.blockedBy(5), [
    { path: "acme/tally", number: 3, state: "open" },
    { path: "acme/libs/core", number: 9, state: "closed" },
  ]);
  assert.deepEqual(await forge.blockedBy(6), [], "a Free-tier project's links only relate: read, and none blocks");
  assert.equal(await forge.blockedBy(7), null, "links GitLab will not list are no links to read: only the text counts");
});

test("a blocker's state is read from its issue in any project on the host, and a missing one is null", async (t) => {
  const { forge } = forgeOn(t, [
    { request: { method: "GET", path: "projects/acme%2Flibs%2Fcore/issues/9" }, response: { status: 200, body: { ...issue(9, "2026-11-01T10:00:00Z", 0), state: "closed" } } },
    { request: { method: "GET", path: "projects/acme%2Ftally/issues/77" }, response: { status: 404, body: { message: "404 Not found" } } },
  ]);
  assert.equal(await forge.issueState("acme/libs/core", 9), "closed");
  assert.equal(await forge.issueState("acme/tally", 77), null);
  assert.equal(await forge.issueState("no-namespace", 1), null);
});

test("the open issues and the issues carrying an entail: label are read in full, oldest first", async (t) => {
  const order = "order_by=created_at&sort=asc&per_page=100";
  const { forge } = forgeOn(t, [
    { request: { method: "GET", path: `${PROJECT}/issues?state=opened&${order}` }, response: list([issue(3, "2026-11-01T10:00:00Z", 0)], "2") },
    { request: { method: "GET", path: `${PROJECT}/issues?state=opened&${order}&page=2` }, response: list([issue(5, "2026-11-02T10:00:00Z", 0)]) },
    {
      request: { method: "GET", path: `${PROJECT}/issues?state=all&labels=entail%3Asuggested&${order}` },
      response: list([issue(7, "2026-11-03T10:00:00Z", 0, { state: "closed", labels: ["entail:suggested", "entail:no"] })]),
    },
  ]);
  assert.deepEqual((await forge.openIssues()).map((one) => one.number), [3, 5]);
  const labelled = await forge.labelledIssues("entail:suggested");
  assert.deepEqual(labelled.map((one) => [one.number, one.state, one.labels]), [[7, "closed", ["entail:suggested", "entail:no"]]]);
  await assert.rejects(forge.labelledIssues("bug"), /entail writes only its own labels/);
});

test("a new issue is filed with its entail: labels, each created in the project first when missing", async (t) => {
  const { forge, transport } = forgeOn(t, [
    { request: { method: "GET", path: `${PROJECT}/labels/entail%3Asuggested` }, response: { status: 404, body: { message: "404 Label Not Found" } } },
    {
      request: { method: "POST", path: `${PROJECT}/labels`, body: { name: "entail:suggested", color: "#5319e7", description: "Set by entail: see its latest comment on the issue" } },
      response: { status: 201, body: { name: "entail:suggested" } },
    },
    {
      request: { method: "POST", path: `${PROJECT}/issues`, body: { title: "Count words in PDFs", description: "Why.\n\n<!-- entail suggestion 7.0 -->", labels: "entail:suggested" } },
      response: { status: 201, body: issue(12, "2026-11-04T10:00:00Z", 0, { title: "Count words in PDFs", labels: ["entail:suggested"] }) },
    },
  ]);
  const filed = await forge.createIssue("Count words in PDFs", "Why.\n\n<!-- entail suggestion 7.0 -->", ["entail:suggested"]);
  assert.equal(filed.number, 12);
  assert.equal(filed.url, `https://${SELF_HOSTED}/acme/tally/-/issues/12`);
  assert.deepEqual(filed.labels, ["entail:suggested"]);
  await assert.rejects(forge.createIssue("x", "y", ["bug"]), /entail writes only its own labels/);
  assert.equal(transport.requests.length, 3);
});

test("with a base branch set, only merge requests into it link issues, and one GitLab closes none for is matched by the issue its source branch names", async (t) => {
  const transport = new RecordedTransport({
    host: SELF_HOSTED,
    exchanges: [
      { request: { method: "GET", path: PROJECT }, response: { status: 200, body: { id: 5001, default_branch: "main" } } },
      { request: { method: "GET", path: PROJECT }, response: { status: 200, body: { id: 5001, default_branch: "main" } } },
      { request: { method: "GET", path: `${PROJECT}/merge_requests/7` }, response: { status: 200, body: mergeRequest(7, { target_branch: "develop", source_branch: "12-word-count-5" }) } },
      { request: { method: "GET", path: `${PROJECT}/merge_requests/7/closes_issues?per_page=100` }, response: { status: 200, body: [] } },
      { request: { method: "GET", path: `${PROJECT}/issues/12` }, response: { status: 200, body: issue(12, "2026-11-01T09:00:00.000Z", 0) } },
      { request: { method: "GET", path: `${PROJECT}/issues/5` }, response: { status: 404, body: { message: "404 Not found" } } },
      { request: { method: "GET", path: PROJECT }, response: { status: 200, body: { id: 5001, default_branch: "main" } } },
      { request: { method: "GET", path: `${PROJECT}/merge_requests/8` }, response: { status: 200, body: mergeRequest(8, { source_branch: "12-word-count" }) } },
    ],
  });
  t.after(() => transport.assertDone());
  const forge = new GitLabForge(SETTING, transport, { baseBranch: "develop" });
  assert.deepEqual(await forge.project(), { forge: "gitlab", host: SELF_HOSTED, id: 5001, path: "acme/tally", defaultBranch: "main", baseBranch: "develop" });
  assert.deepEqual(await forge.linkedIssues(7), [12], "#5 is no issue here");
  assert.deepEqual(await forge.linkedIssues(8), [], "a merge request into the default branch is not one into the base branch");
});

test("the open merge requests into the base branch are listed filtered on it", async (t) => {
  const transport = new RecordedTransport({
    host: SELF_HOSTED,
    exchanges: [
      { request: { method: "GET", path: PROJECT }, response: { status: 200, body: { id: 5001, default_branch: "main" } } },
      {
        request: { method: "GET", path: `${PROJECT}/merge_requests?state=opened&target_branch=main&order_by=created_at&sort=asc&per_page=100` },
        response: { status: 200, body: [mergeRequest(5), mergeRequest(6, { draft: true })] },
      },
    ],
  });
  t.after(() => transport.assertDone());
  const forge = new GitLabForge(SETTING, transport);
  assert.deepEqual(
    (await forge.openPullRequests()).map((pr) => [pr.number, pr.baseBranch, pr.draft, pr.mergeable]),
    [
      [5, "main", false, null],
      [6, "main", true, null],
    ],
  );
});

const CUT_OFF: Exchange["error"] = {
  message: "glab api GET … on gitlab.example.org: the connection was dropped after 250000 characters of the response (Stream error: stream ID 1; INTERNAL_ERROR; received from peer.)",
  loggedOut: false,
  cutOff: true,
};

test("a merge request list cut off mid-stream is read again in smaller pages from the same place, and the rest follows at that size", async (t) => {
  const smaller = MERGE_REQUESTS.replace("per_page=100", "per_page=50");
  const { forge } = forgeOn(t, [
    { request: { method: "GET", path: ISSUES }, response: list([]) },
    { request: { method: "GET", path: MERGE_REQUESTS }, error: CUT_OFF },
    { request: { method: "GET", path: smaller }, response: list([mergeRequest(9, { updated_at: "2026-11-03T09:00:00.000Z" })], "2") },
    { request: { method: "GET", path: `${smaller}&page=2` }, response: list([mergeRequest(8)]) },
  ]);
  const batch = await forge.changesSince(null);
  assert.deepEqual(
    batch.changes.map((change) => `${change.kind} ${change.id}`),
    ["pull-request 8009", "pull-request 8008"],
  );
});

test("a later page cut off inside its JSON is asked for again at the smaller size from its first item", async (t) => {
  const order = "order_by=created_at&sort=asc";
  const { forge } = forgeOn(t, [
    { request: { method: "GET", path: `${PROJECT}/issues?state=opened&${order}&per_page=100` }, response: list([issue(3, "2026-11-01T10:00:00Z", 0)], "2") },
    // The CLI exited cleanly but the body stops inside a string.
    { request: { method: "GET", path: `${PROJECT}/issues?state=opened&${order}&per_page=100&page=2` }, response: { status: 200, headers: { "X-Next-Page": "3" }, body: '[{"iid":5,"title":"Iss' } },
    { request: { method: "GET", path: `${PROJECT}/issues?state=opened&${order}&per_page=50&page=3` }, response: list([issue(5, "2026-11-02T10:00:00Z", 0)], "4") },
    { request: { method: "GET", path: `${PROJECT}/issues?state=opened&${order}&per_page=50&page=4` }, response: list([issue(6, "2026-11-02T11:00:00Z", 0)]) },
  ]);
  assert.deepEqual((await forge.openIssues()).map((one) => one.number), [3, 5, 6]);
});

test("a list cut off even one item at a time fails as a dropped connection, not as a body that is not JSON", async (t) => {
  const order = "order_by=created_at&sort=asc";
  const sizes = [100, 50, 25, 5, 1];
  const { forge } = forgeOn(
    t,
    sizes.map((size) => ({ request: { method: "GET", path: `${PROJECT}/issues?state=opened&${order}&per_page=${size}` }, response: { status: 200, body: '[{"iid":' } })),
  );
  await assert.rejects(forge.openIssues(), (error: unknown) => {
    assert.ok(error instanceof ForgeCutOffError);
    assert.match(error.message, /per_page=1 on gitlab\.example\.org: the connection was dropped partway through the response/);
    assert.doesNotMatch(error.message, /not JSON/);
    return true;
  });
});

test("a single read cut off mid-stream is a dropped connection, and a body that is not JSON at all is still a request error", async (t) => {
  const { forge } = forgeOn(t, [
    { request: { method: "GET", path: `${PROJECT}/merge_requests/4?with_merge_status_recheck=true` }, error: CUT_OFF },
    { request: { method: "GET", path: `${PROJECT}/merge_requests/5?with_merge_status_recheck=true` }, response: { status: 200, body: "<html>maintenance</html>" } },
  ]);
  await assert.rejects(forge.pullRequest(4), (error: unknown) => error instanceof ForgeCutOffError && /Stream error/.test(error.message));
  await assert.rejects(forge.pullRequest(5), (error: unknown) => error instanceof ForgeRequestError && /not JSON/.test(error.message));
});

test("a host whose certificate glab does not trust is explained in plain words, with the step that makes glab trust it", async (t) => {
  const message = `glab api GET projects/acme%2Ftally on ${SELF_HOSTED}: ERROR Get "https://${SELF_HOSTED}/api/v4/projects/acme%2Ftally": tls: failed to verify certificate: x509: certificate signed by unknown authority.`;
  const { forge } = forgeOn(t, [{ request: { method: "GET", path: "projects/acme%2Ftally" }, error: { message, untrustedCertificate: true } }]);
  await assert.rejects(forge.project(), (error: unknown) => {
    assert.ok(error instanceof ForgeUntrustedCertificateError);
    assert.equal(error.host, SELF_HOSTED);
    assert.equal(error.cli, "glab");
    assert.match(error.message, /glab does not trust the certificate of gitlab\.example\.org/u);
    assert.match(error.message, /git trusting the host does not carry over/u);
    assert.match(error.message, /glab config set ca_cert \/path\/to\/ca\.pem --host gitlab\.example\.org/u);
    return true;
  });
});

const PROJECT_READ: Exchange = { request: { method: "GET", path: PROJECT }, response: { status: 200, body: { id: 5001, default_branch: "main" } } };
const encoded = (text: string) => Buffer.from(text, "utf8").toString("base64");

test("updateFile reads the file on the base branch, commits the change pinned to its last commit, and reads the commit it made", async (t) => {
  const { forge } = forgeOn(t, [
    PROJECT_READ,
    { request: { method: "GET", path: `${PROJECT}/repository/files/VISION.md?ref=main` }, response: { status: 200, body: { encoding: "base64", content: encoded("# Vision\n\nOne.\n"), last_commit_id: "old1" } } },
    { request: { method: "PUT", path: `${PROJECT}/repository/files/VISION.md`, body: { branch: "main", content: "# Vision\n\nOne.\nTwo.\n", commit_message: "Add a line", last_commit_id: "old1" } }, response: { status: 200, body: { file_path: "VISION.md", branch: "main" } } },
    { request: { method: "GET", path: `${PROJECT}/repository/files/VISION.md?ref=main` }, response: { status: 200, body: { encoding: "base64", content: encoded("# Vision\n\nOne.\nTwo.\n"), last_commit_id: "new2" } } },
  ]);
  assert.deepEqual(await forge.updateFile("VISION.md", (current) => `${current}Two.\n`, "Add a line"), { changed: true, commit: "new2", branch: "main" });
});

test("updateFile on GitLab refuses a file that moved since it was read", async (t) => {
  const { forge } = forgeOn(t, [
    PROJECT_READ,
    { request: { method: "GET", path: `${PROJECT}/repository/files/VISION.md?ref=main` }, response: { status: 200, body: { encoding: "base64", content: encoded("A.\n"), last_commit_id: "old1" } } },
    { request: { method: "PUT", path: `${PROJECT}/repository/files/VISION.md`, body: { branch: "main", content: "A.\nB.\n", commit_message: "m", last_commit_id: "old1" } }, response: { status: 400, body: { message: "You are attempting to update a file that has changed since you started editing it." } } },
  ]);
  await assert.rejects(forge.updateFile("VISION.md", (current) => `${current}B.\n`, "m"), (error: unknown) => error instanceof ForgeRequestError && error.status === 400);
});

test("commitsTouching lists the base branch's newest commits on a file with their full messages", async (t) => {
  const { forge } = forgeOn(t, [
    PROJECT_READ,
    { request: { method: "GET", path: `${PROJECT}/repository/commits?ref_name=main&path=VISION.md&per_page=30` }, response: { status: 200, body: [{ id: "c2", message: "Add\n\nLine." }] } },
  ]);
  assert.deepEqual(await forge.commitsTouching("VISION.md"), [{ commit: "c2", message: "Add\n\nLine." }]);
});
