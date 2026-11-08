import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { createForge } from "../../src/forge/create-forge.ts";
import { ForgeLoggedOutError, ForgeRequestError, projectKey, RateLimitedError } from "../../src/forge/forge.ts";
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
  assert.deepEqual(project, { forge: "gitlab", host: SELF_HOSTED, id: 42, path: "platform/tools/tally", defaultBranch: "trunk" });
  assert.equal(projectKey(project), `gitlab:${SELF_HOSTED}:42`);
  assert.ok(transport.requests.every((r) => r.host === SELF_HOSTED), "every call goes to the instance's own host");
});

test("an instance older than 15.6 is unsupported", async (t) => {
  const { forge } = forgeOn(t, [
    { request: { method: "GET", path: "version" }, response: { status: 200, body: { version: "15.5.4", revision: "abc" } } },
  ]);
  const instance = await forge.instance();
  assert.equal(instance.version, "15.5.4");
  assert.match(instance.unsupported ?? "", /older than 15\.6/);
});

test("which GitLab versions are served", () => {
  for (const version of ["15.6.0", "15.11.13", "16.11.10", "17.5.0-ee", "18.6.0-pre", "16.0.0-rc42-ee", "20.0"]) {
    assert.equal(unsupportedGitLabVersion(version), null, `${version} is served`);
  }
  for (const version of ["15.5.4", "14.10.5-ee", "8.17.0"]) {
    assert.match(unsupportedGitLabVersion(version) ?? "", /older than 15\.6/, `${version} is not served`);
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

/** The Free/CE REST endpoints the adapter reads and writes: nothing that needs Premium or Ultimate (ADR-0015). */
const FREE_ENDPOINTS = [
  /^user$/,
  /^version$/,
  /^projects\/[^/?]+$/,
  /^projects\/[^/?]+\/issues\?/,
  /^projects\/[^/?]+\/issues\/\d+$/,
  /^projects\/[^/?]+\/issues\/\d+\/closed_by\?/,
  /^projects\/[^/?]+\/(issues|merge_requests)\/\d+\/notes(\?|$)/,
  /^projects\/[^/?]+\/labels(\/[^/?]+)?$/,
  /^projects\/[^/?]+\/merge_requests\?/,
  /^projects\/[^/?]+\/merge_requests\/\d+(\/merge|\?with_merge_status_recheck=true)?$/,
  /^projects\/[^/?]+\/merge_requests\/\d+\/closes_issues\?/,
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

const PROJECT = "projects/acme%2Ftally";
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
