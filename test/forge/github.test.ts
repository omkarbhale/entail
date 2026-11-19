import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createForge } from "../../src/forge/create-forge.ts";
import { ForgeLoggedOutError, ForgeRequestError, MergePendingError, RateLimitedError } from "../../src/forge/forge.ts";
import { GitHubForge } from "../../src/forge/github.ts";
import { GitLabForge } from "../../src/forge/gitlab.ts";
import { type Exchange, RecordedTransport } from "./recorded-transport.ts";

const SETTING = { forge: "github", host: "github.com", path: "acme/tally" } as const;
const ISSUES = "repos/acme/tally/issues?state=all&sort=updated&direction=desc&per_page=100";
const COMMENTS = "repos/acme/tally/issues/comments?sort=updated&direction=desc&per_page=100";
const PULLS = "repos/acme/tally/pulls?state=all&sort=updated&direction=desc&per_page=100";
/** The PR list read on a pass with no PRs at all. */
const NO_PULLS: Exchange = { request: { method: "GET", path: PULLS }, response: { status: 200, body: [] } };

function forgeOn(t: TestContext, exchanges: Exchange[]): { forge: GitHubForge; transport: RecordedTransport } {
  const transport = new RecordedTransport({ host: "github.com", exchanges });
  t.after(() => transport.assertDone());
  return { forge: new GitHubForge(SETTING, transport), transport };
}

function issue(id: number, updatedAt: string) {
  return {
    id,
    number: id - 9000,
    title: `Issue ${id}`,
    body: null,
    state: "open",
    user: { login: "owner", id: 1001 },
    labels: [],
    created_at: updatedAt,
    updated_at: updatedAt,
    html_url: `https://github.com/acme/tally/issues/${id - 9000}`,
  };
}

test("a 304 keeps the cursor exactly and reports nothing", async (t) => {
  const since = "&since=2026-11-01T11%3A00%3A00Z";
  const cursor = JSON.stringify({
    issues: { since: "2026-11-01T11:00:00Z", etag: 'W/"i"' },
    comments: { since: null, etag: '"c"' },
    pulls: { since: "2026-11-01T10:00:00Z", etag: '"p"' },
  });
  const { forge } = forgeOn(t, [
    { request: { method: "GET", path: ISSUES + since, headers: { "If-None-Match": 'W/"i"' } }, response: { status: 304 } },
    { request: { method: "GET", path: COMMENTS, headers: { "If-None-Match": '"c"' } }, response: { status: 304 } },
    { request: { method: "GET", path: PULLS, headers: { "If-None-Match": '"p"' } }, response: { status: 304 } },
  ]);
  const batch = await forge.changesSince(cursor);
  assert.deepEqual(batch, { changes: [], cursor });
});

test("a list with nothing in it keeps its ETag for the next conditional read", async (t) => {
  const { forge } = forgeOn(t, [
    { request: { method: "GET", path: ISSUES }, response: { status: 200, headers: { ETag: '"empty"' }, body: [] } },
    { request: { method: "GET", path: COMMENTS }, response: { status: 200, body: [] } },
    NO_PULLS,
  ]);
  const batch = await forge.changesSince(null);
  assert.deepEqual(JSON.parse(batch.cursor), {
    issues: { since: null, etag: '"empty"' },
    comments: { since: null, etag: null },
    pulls: { since: null, etag: null },
  });
});

test("the next page is read from the Link header as a path on the same host", async (t) => {
  const page2 = "repositories/5001/issues?state=all&page=2";
  const { forge, transport } = forgeOn(t, [
    {
      request: { method: "GET", path: ISSUES },
      response: {
        status: 200,
        headers: { Link: `<https://api.github.com/${page2}>; rel="next", <https://api.github.com/${page2}>; rel="last"` },
        body: [issue(9002, "2026-11-01T11:00:00Z")],
      },
    },
    { request: { method: "GET", path: page2 }, response: { status: 200, body: [issue(9001, "2026-11-01T10:00:00Z")] } },
    { request: { method: "GET", path: COMMENTS }, response: { status: 200, body: [] } },
    NO_PULLS,
  ]);
  const batch = await forge.changesSince(null);
  assert.deepEqual(
    batch.changes.map((c) => c.id),
    [9002, 9001],
  );
  assert.ok(transport.requests.every((r) => r.host === "github.com"));
  const first = batch.changes[0];
  assert.ok(first?.kind === "issue");
  assert.equal(first.issue.body, "", "a missing body reads as empty");
});

test("a secondary rate limit's retry-after is turned into a reset time", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-08T10:00:00Z") });
  const { forge } = forgeOn(t, [
    {
      request: { method: "GET", path: ISSUES },
      response: { status: 403, headers: { "Retry-After": "120" }, body: { message: "You have exceeded a secondary rate limit." } },
    },
  ]);
  await assert.rejects(forge.changesSince(null), (error: unknown) => {
    return error instanceof RateLimitedError && error.resetAt.toISOString() === "2026-11-08T10:02:00.000Z";
  });
});

test("a 429 with no reset time waits a minute", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-08T10:00:00Z") });
  const { forge } = forgeOn(t, [{ request: { method: "GET", path: "user" }, response: { status: 429, body: "" } }]);
  await assert.rejects(forge.currentActor(), (error: unknown) => {
    return error instanceof RateLimitedError && error.resetAt.toISOString() === "2026-11-08T10:01:00.000Z";
  });
});

test("a 403 that is not a rate limit is a request error with the forge's message", async (t) => {
  const { forge } = forgeOn(t, [
    {
      request: { method: "GET", path: "repos/acme/tally" },
      response: { status: 403, headers: { "X-RateLimit-Remaining": "4000" }, body: { message: "Resource not accessible" } },
    },
  ]);
  await assert.rejects(forge.project(), (error: unknown) => {
    return error instanceof ForgeRequestError && error.status === 403 && /Resource not accessible/.test(error.message);
  });
});

test("a 401 means the login was refused: no actor, and reads fail as logged out", async (t) => {
  const refused = { status: 401, body: { message: "Bad credentials" } };
  const { forge } = forgeOn(t, [
    { request: { method: "GET", path: "user" }, response: refused },
    { request: { method: "GET", path: "repos/acme/tally" }, response: refused },
  ]);
  assert.equal(await forge.currentActor(), null);
  await assert.rejects(forge.project(), ForgeLoggedOutError);
});

test("a transport failure that is not a logout is passed on, not taken for no actor", async (t) => {
  const { forge } = forgeOn(t, [
    { request: { method: "GET", path: "user" }, error: { message: "error connecting to api.github.com", loggedOut: false } },
  ]);
  await assert.rejects(forge.currentActor(), /error connecting/);
});

test("the adapter serves github.com and a GitHub Enterprise Server's repos with an owner/name path", () => {
  const transport = new RecordedTransport({ host: "github.com", exchanges: [] });
  assert.doesNotThrow(() => new GitHubForge({ ...SETTING, host: "ghe.example.com" }, transport));
  assert.throws(() => new GitHubForge({ ...SETTING, path: "acme/tally/../x" }, transport), /owner\/name/);
  assert.throws(() => new GitHubForge({ ...SETTING, forge: "gitlab" }, transport), /gitlab/);
});

test("createForge serves GitHub and GitLab, each through its own adapter", () => {
  const transport = new RecordedTransport({ host: "github.com", exchanges: [] });
  assert.ok(createForge(SETTING, transport) instanceof GitHubForge);
  assert.ok(createForge({ forge: "gitlab", host: "gitlab.com", path: "acme/tally" }, transport) instanceof GitLabForge);
});

test("github.com has no version to read and is always served", async (t) => {
  const { forge } = forgeOn(t, []);
  assert.deepEqual(await forge.instance(), { version: null, unsupported: null });
});

for (const [name, cursor] of [
  ["not JSON", "garbage{"],
  ["the wrong shape", JSON.stringify({ issues: 1 })],
  ["a since that is not a time", JSON.stringify({ issues: { since: "nope", etag: null }, comments: { since: null, etag: null } })],
] as const) {
  test(`a cursor that is ${name} costs a full re-scan`, async (t) => {
    const { forge } = forgeOn(t, [
      { request: { method: "GET", path: ISSUES }, response: { status: 200, body: [] } },
      { request: { method: "GET", path: COMMENTS }, response: { status: 200, body: [] } },
      NO_PULLS,
    ]);
    const batch = await forge.changesSince(cursor);
    assert.deepEqual(batch.changes, []);
  });
}

test("a merge still pending after the wait is no outcome: merge() throws the pending error instead of refusing", async (t) => {
  const sha = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const uuid = "6f1c2a9e-3b7d-4c55-9a1e-0d2f8b7c4e10";
  const pending = { status: "pending", details: { message: "The merge request has been accepted and is being processed.", uuid } };
  const transport = new RecordedTransport({
    host: "github.com",
    exchanges: [
      {
        request: {
          method: "PUT",
          path: "repos/acme/tally/pulls/4/merge-async",
          body: { sha, merge_action: "direct_merge", bypass_rules: false },
        },
        response: { status: 202, body: pending },
      },
    ],
  });
  t.after(() => transport.assertDone());
  const forge = new GitHubForge(SETTING, transport, { mergePollIntervalMs: 0, mergeWaitMs: 0 });
  await assert.rejects(forge.merge(4, sha), (error: unknown) => error instanceof MergePendingError && error.prNumber === 4);
});

const SHA = "4f1c0c3e9b2a7d6e5f4a3b2c1d0e9f8a7b6c5d4e";

function pull(number: number, updatedAt: string, extra: Record<string, unknown> = {}) {
  return {
    id: 8000 + number,
    number,
    title: `PR ${number}`,
    body: null,
    state: "open",
    draft: false,
    merged_at: null,
    head: { ref: "topic", sha: SHA },
    base: { ref: "main", sha: "0".repeat(40) },
    user: { login: "reporter", id: 1002 },
    created_at: updatedAt,
    updated_at: updatedAt,
    html_url: `https://github.com/acme/tally/pull/${number}`,
    ...extra,
  };
}

/** The reads `checks` makes before the checks themselves: the default branch and what its rules require. */
function noRequiredChecks(): Exchange[] {
  return [
    { request: { method: "GET", path: "repos/acme/tally" }, response: { status: 200, body: { id: 5001, default_branch: "main" } } },
    { request: { method: "GET", path: "repos/acme/tally/branches/main" }, response: { status: 200, body: { name: "main", protected: false } } },
    { request: { method: "GET", path: "repos/acme/tally/rules/branches/main?per_page=100" }, response: { status: 200, body: [] } },
  ];
}

function run(name: string, status: string, conclusion: string | null) {
  return { id: name.length, name, status, conclusion, html_url: "https://github.com/acme/tally/actions/runs/1/job/1" };
}

test("check runs count as passed only when successful, neutral or skipped, and a status's error is a failure", async (t) => {
  const { forge } = forgeOn(t, [
    ...noRequiredChecks(),
    {
      request: { method: "GET", path: `repos/acme/tally/commits/${SHA}/check-runs?filter=latest&per_page=100` },
      response: {
        status: 200,
        body: {
          total_count: 8,
          check_runs: [
            run("queued", "queued", null),
            run("waiting", "waiting", null),
            run("needs-action", "completed", "action_required"),
            run("cancelled", "completed", "cancelled"),
            run("timed-out", "completed", "timed_out"),
            run("stale", "completed", "stale"),
            run("both", "completed", "success"),
            run("both-pending", "completed", "success"),
          ],
        },
      },
    },
    {
      request: { method: "GET", path: `repos/acme/tally/commits/${SHA}/status?per_page=100` },
      response: {
        status: 200,
        body: {
          state: "failure",
          statuses: [
            { context: "errored", state: "error", target_url: "" },
            { context: "both", state: "failure", target_url: null },
            { context: "both-pending", state: "pending", target_url: null },
          ],
        },
      },
    },
  ]);
  const report = await forge.checks(4, SHA, []);
  assert.deepEqual(
    report.checks.map((check) => `${check.name} ${check.status}`),
    [
      "both failed",
      "both-pending pending",
      "cancelled failed",
      "errored failed",
      "needs-action failed",
      "queued pending",
      "stale failed",
      "timed-out failed",
      "waiting pending",
    ],
    "a check run and a status under one name are one check, failed if either failed",
  );
  assert.equal(report.checks.find((c) => c.name === "errored")?.url, null, "an empty target URL is no link");
  assert.deepEqual(report.required, []);
});

const PLAN_REFUSAL = {
  status: 403,
  body: {
    message: "Upgrade to GitHub Pro or make this repository public to enable this feature.",
    documentation_url: "https://docs.github.com/rest/repos/rules#get-rules-for-a-branch",
    status: "403",
  },
};

function noCheckRuns(): Exchange[] {
  return [
    {
      request: { method: "GET", path: `repos/acme/tally/commits/${SHA}/check-runs?filter=latest&per_page=100` },
      response: { status: 200, body: { total_count: 1, check_runs: [run("test", "completed", "success")] } },
    },
    { request: { method: "GET", path: `repos/acme/tally/commits/${SHA}/status?per_page=100` }, response: { status: 200, body: { state: "success", statuses: [] } } },
  ];
}

test("a private repo whose plan has no rulesets or branch protection requires no check from them", async (t) => {
  // Recorded from a private repo on GitHub Free: both reads answer 403 for the plan.
  const { forge } = forgeOn(t, [
    { request: { method: "GET", path: "repos/acme/tally" }, response: { status: 200, body: { id: 5001, default_branch: "main" } } },
    { request: { method: "GET", path: "repos/acme/tally/branches/main" }, response: PLAN_REFUSAL },
    { request: { method: "GET", path: "repos/acme/tally/rules/branches/main?per_page=100" }, response: PLAN_REFUSAL },
    ...noCheckRuns(),
  ]);
  const report = await forge.checks(4, SHA, []);
  assert.deepEqual(report.required, []);
  assert.deepEqual(
    report.checks.map((check) => `${check.name} ${check.status}`),
    ["test passed"],
    "the checks at the head are still read and still gate",
  );
});

test("any other refusal to read the rules still fails the read", async (t) => {
  const { forge } = forgeOn(t, [
    { request: { method: "GET", path: "repos/acme/tally" }, response: { status: 200, body: { id: 5001, default_branch: "main" } } },
    { request: { method: "GET", path: "repos/acme/tally/branches/main" }, response: { status: 200, body: { name: "main", protected: false } } },
    {
      request: { method: "GET", path: "repos/acme/tally/rules/branches/main?per_page=100" },
      response: { status: 403, body: { message: "Resource not accessible by integration" } },
    },
  ]);
  await assert.rejects(forge.checks(4, SHA, []), /HTTP 403: Resource not accessible by integration/);
});

test("a sha that is not a commit sha never reaches a path", async (t) => {
  const { forge } = forgeOn(t, []);
  await assert.rejects(forge.checks(4, "../../user", []), /not a commit sha/);
});

test("the PR list is read until a PR last updated before the cursor, and keeps its ETag", async (t) => {
  const cursor = JSON.stringify({
    issues: { since: null, etag: null },
    comments: { since: null, etag: null },
    pulls: { since: "2026-11-02T09:00:00Z", etag: '"p0"' },
  });
  const page2 = "repositories/5001/pulls?state=all&sort=updated&direction=desc&per_page=100&page=2";
  const { forge, transport } = forgeOn(t, [
    { request: { method: "GET", path: ISSUES }, response: { status: 200, body: [] } },
    { request: { method: "GET", path: COMMENTS }, response: { status: 200, body: [] } },
    {
      request: { method: "GET", path: PULLS, headers: { "If-None-Match": '"p0"' } },
      response: {
        status: 200,
        headers: { ETag: '"p1"', Link: `<https://api.github.com/${page2}>; rel="next"` },
        body: [pull(6, "2026-11-02T09:30:00Z"), pull(5, "2026-11-02T09:00:00Z"), pull(4, "2026-11-01T10:45:00Z")],
      },
    },
  ]);
  const batch = await forge.changesSince(cursor);
  assert.deepEqual(
    batch.changes.map((c) => `${c.kind} ${c.id}`),
    ["pull-request 8006", "pull-request 8005"],
    "a PR updated at the cursor is read again; the core drops it",
  );
  assert.equal(transport.requests.length, 3, "the next page is never asked for");
  assert.deepEqual(JSON.parse(batch.cursor).pulls, { since: "2026-11-02T09:30:00Z", etag: '"p1"' });
});

test("a PR list cut off mid-stream is read again in smaller pages without the ETag, which then is not kept", async (t) => {
  const cursor = JSON.stringify({
    issues: { since: null, etag: null },
    comments: { since: null, etag: null },
    pulls: { since: "2026-11-02T09:00:00Z", etag: '"p0"' },
  });
  const smaller = PULLS.replace("per_page=100", "per_page=50");
  const page2 = "repositories/5001/pulls?state=all&sort=updated&direction=desc&per_page=50&page=2";
  const { forge } = forgeOn(t, [
    { request: { method: "GET", path: ISSUES }, response: { status: 200, body: [] } },
    { request: { method: "GET", path: COMMENTS }, response: { status: 200, body: [] } },
    {
      request: { method: "GET", path: PULLS, headers: { "If-None-Match": '"p0"' } },
      error: { message: "gh api GET … on github.com: the connection was dropped after 250000 characters of the response (stream error)", loggedOut: false, cutOff: true },
    },
    {
      request: { method: "GET", path: smaller },
      response: { status: 200, headers: { ETag: '"p50"', Link: `<https://api.github.com/${page2}>; rel="next"` }, body: [pull(6, "2026-11-02T09:30:00Z")] },
    },
    { request: { method: "GET", path: page2 }, response: { status: 200, body: [pull(5, "2026-11-02T09:10:00Z"), pull(4, "2026-11-01T10:45:00Z")] } },
  ]);
  const batch = await forge.changesSince(cursor);
  assert.deepEqual(
    batch.changes.map((c) => `${c.kind} ${c.id}`),
    ["pull-request 8006", "pull-request 8005"],
  );
  assert.deepEqual(JSON.parse(batch.cursor).pulls, { since: "2026-11-02T09:30:00Z", etag: null }, "the smaller page's ETag belongs to another request");
});

test("a page of a list cut off inside its JSON is read again at the smaller size from its first item", async (t) => {
  const first = "repos/acme/tally/issues?state=open&sort=created&direction=asc&per_page=100";
  const page2 = "repositories/5001/issues?state=open&sort=created&direction=asc&per_page=100&page=2";
  const { forge } = forgeOn(t, [
    { request: { method: "GET", path: first }, response: { status: 200, headers: { Link: `<https://api.github.com/${page2}>; rel="next"` }, body: [issue(9003, "2026-11-01T10:00:00Z")] } },
    { request: { method: "GET", path: page2 }, response: { status: 200, body: '[{"id":9005,"title":"Iss' } },
    {
      request: { method: "GET", path: page2.replace("per_page=100&page=2", "per_page=50&page=3") },
      response: { status: 200, body: [issue(9005, "2026-11-02T10:00:00Z")] },
    },
  ]);
  assert.deepEqual((await forge.openIssues()).map((one) => one.number), [3, 5]);
});

test("a cursor from before PRs were read keeps its issues and comments and reads every PR", async (t) => {
  const cursor = JSON.stringify({ issues: { since: null, etag: '"i"' }, comments: { since: null, etag: '"c"' } });
  const { forge } = forgeOn(t, [
    { request: { method: "GET", path: ISSUES, headers: { "If-None-Match": '"i"' } }, response: { status: 304 } },
    { request: { method: "GET", path: COMMENTS, headers: { "If-None-Match": '"c"' } }, response: { status: 304 } },
    { request: { method: "GET", path: PULLS }, response: { status: 200, body: [pull(4, "2026-11-01T10:45:00Z", { state: "closed", merged_at: "2026-11-01T10:45:00Z" })] } },
  ]);
  const [change] = (await forge.changesSince(cursor)).changes;
  assert.ok(change?.kind === "pull-request");
  assert.equal(change.pullRequest.state, "merged");
  assert.equal(change.pullRequest.body, "", "a missing description reads as empty");
});

test("a PR GitHub has not worked out, or that its rules block, is not known to be mergeable", async (t) => {
  const { forge } = forgeOn(t, [
    { request: { method: "GET", path: "repos/acme/tally/pulls/4" }, response: { status: 200, body: pull(4, "2026-11-02T09:00:00Z", { mergeable: null, mergeable_state: "unknown" }) } },
    { request: { method: "GET", path: "repos/acme/tally/pulls/5" }, response: { status: 200, body: pull(5, "2026-11-02T09:00:00Z", { mergeable: true, mergeable_state: "blocked" }) } },
    { request: { method: "GET", path: "repos/acme/tally/pulls/6" }, response: { status: 200, body: pull(6, "2026-11-02T09:00:00Z", { mergeable: true, mergeable_state: "unstable" }) } },
  ]);
  const unknown = await forge.pullRequest(4);
  assert.deepEqual([unknown.mergeable, unknown.conflicts], [null, null]);
  const blocked = await forge.pullRequest(5);
  assert.deepEqual([blocked.mergeable, blocked.conflicts], [false, false]);
  const unstable = await forge.pullRequest(6);
  assert.deepEqual([unstable.mergeable, unstable.conflicts], [true, false], "failing checks GitHub does not require do not stop it");
});

/** A transport that answers GraphQL queries in order, whatever their text, and records them. */
function graphqlTransport(t: TestContext, responses: { status?: number; headers?: Record<string, string>; body: unknown }[], baseBranch: string | null = null) {
  const requests: { path: string; variables: unknown }[] = [];
  const transport = {
    async request(request: { method: string; path: string; body?: unknown }) {
      const next = responses.shift();
      assert.ok(next, `unexpected request ${request.method} ${request.path}`);
      requests.push({ path: request.path, variables: request.body ? (request.body as { variables: unknown }).variables : undefined });
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(next.headers ?? {})) headers[name.toLowerCase()] = value;
      return { status: next.status ?? 200, headers, body: JSON.stringify(next.body) };
    },
  };
  t.after(() => assert.deepEqual(responses, [], "every response was asked for"));
  return { forge: new GitHubForge(SETTING, transport, { baseBranch }), requests };
}

test("closing references are paged until GraphQL says there are no more", async (t) => {
  const repository = (pullRequest: unknown) => ({ data: { repository: { databaseId: 5001, defaultBranchRef: { name: "main" }, pullRequest } } });
  const { forge, requests } = graphqlTransport(t, [
    {
      body: repository({
        baseRefName: "main",
        closingIssuesReferences: { nodes: [{ number: 3, repository: { databaseId: 5001 } }], pageInfo: { hasNextPage: true, endCursor: "Mg" } },
      }),
    },
    {
      body: repository({
        baseRefName: "main",
        closingIssuesReferences: {
          nodes: [
            { number: 1, repository: { databaseId: 5001 } },
            { number: 2, repository: { databaseId: 6001 } },
          ],
          pageInfo: { hasNextPage: false, endCursor: "Mw" },
        },
      }),
    },
  ]);
  assert.deepEqual(await forge.linkedIssues(4), [1, 3], "an issue in another repo is not this repo's ticket");
  assert.deepEqual(
    requests.map((r) => r.variables),
    [
      { owner: "acme", name: "tally", number: 4, after: null },
      { owner: "acme", name: "tally", number: 4, after: "Mg" },
    ],
  );
});

test("a GraphQL error is a request error, and a GraphQL rate limit is surfaced with its reset time", async (t) => {
  const { forge } = graphqlTransport(t, [
    { body: { data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to an Issue with the number of 99." }] } },
    { headers: { "X-RateLimit-Reset": "1794139200" }, body: { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] } },
  ]);
  await assert.rejects(forge.linkedPullRequests(99), (error: unknown) => {
    return error instanceof ForgeRequestError && error.method === "POST" && /Could not resolve/.test(error.message);
  });
  await assert.rejects(forge.linkedIssues(4), (error: unknown) => {
    return error instanceof RateLimitedError && error.resetAt.toISOString() === "2026-11-08T12:00:00.000Z";
  });
});

test("with a base branch set, only PRs into it link issues, and one GitHub links to none is matched by the issue its head branch names", async (t) => {
  const repository = (pullRequest: unknown) => ({ data: { repository: { databaseId: 5001, defaultBranchRef: { name: "main" }, pullRequest } } });
  const none = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
  const { forge, requests } = graphqlTransport(
    t,
    [
      { body: { id: 5001, default_branch: "main" } },
      { body: repository({ baseRefName: "develop", closingIssuesReferences: none }) },
      { body: pull(7, "2026-11-02T09:00:00Z", { head: { ref: "fix/12-after-5", sha: SHA }, base: { ref: "develop", sha: "0".repeat(40) } }) },
      { body: issue(9012, "2026-11-01T09:00:00Z") },
      { body: { ...issue(9005, "2026-11-01T09:00:00Z"), pull_request: { url: "https://api.github.com/repos/acme/tally/pulls/5" } } },
      { body: repository({ baseRefName: "main", closingIssuesReferences: { nodes: [{ number: 3, repository: { databaseId: 5001 } }], pageInfo: { hasNextPage: false, endCursor: null } } }) },
      { body: repository({ baseRefName: "develop", closingIssuesReferences: { nodes: [{ number: 3, repository: { databaseId: 5001 } }], pageInfo: { hasNextPage: false, endCursor: null } } }) },
    ],
    "develop",
  );
  assert.deepEqual(await forge.project(), { forge: "github", host: "github.com", id: 5001, path: "acme/tally", defaultBranch: "main", baseBranch: "develop" });
  assert.deepEqual(await forge.linkedIssues(7), [12], "#5 is a pull request, not an issue");
  assert.deepEqual(
    requests.slice(2).map((request) => request.path),
    ["repos/acme/tally/pulls/7", "repos/acme/tally/issues/12", "repos/acme/tally/issues/5"],
    "the head branch is read from the forge, never from the PR's text",
  );
  assert.deepEqual(await forge.linkedIssues(8), [], "a PR into the forge's default branch is not one into the base branch");
  assert.deepEqual(await forge.linkedIssues(9), [3], "the forge's own link comes first, with no head branch read");
});

const REPO = "repos/acme/tally";
const repoWith = (body: Record<string, unknown>) => [{ request: { method: "GET" as const, path: REPO }, response: { status: 200, body: { id: 5001, ...body } } }];
const ALL = { admin: false, maintain: false, push: false, triage: false, pull: true };

test("an account with push access can label, comment and merge", async (t) => {
  const { forge } = forgeOn(t, repoWith({ has_issues: true, permissions: { ...ALL, push: true, triage: true } }));
  assert.deepEqual(await forge.access(), { cannotLabelAndComment: null, mayLackMerge: null });
});

test("an account with triage access can label and comment, and may lack permission to merge", async (t) => {
  const { forge } = forgeOn(t, repoWith({ has_issues: true, permissions: { ...ALL, triage: true } }));
  const access = await forge.access();
  assert.equal(access.cannotLabelAndComment, null);
  assert.match(access.mayLackMerge ?? "", /no push access/);
});

test("an account with read access only, or a repo with issues turned off, cannot label and comment", async (t) => {
  const readOnly = forgeOn(t, repoWith({ has_issues: true, permissions: ALL })).forge;
  assert.match((await readOnly.access()).cannotLabelAndComment ?? "", /read access only/);
  const noIssues = forgeOn(t, repoWith({ has_issues: false, permissions: { ...ALL, admin: true } })).forge;
  assert.match((await noIssues.access()).cannotLabelAndComment ?? "", /issues turned off/);
  const unknown = forgeOn(t, repoWith({ has_issues: true })).forge;
  assert.match((await unknown.access()).cannotLabelAndComment ?? "", /did not report/);
});

test("the merge methods are the ones the repo allows, and none when GitHub does not say", async (t) => {
  const some = forgeOn(t, repoWith({ allow_squash_merge: false, allow_merge_commit: true, allow_rebase_merge: true })).forge;
  assert.deepEqual(await some.mergeMethods(), ["merge", "rebase"]);
  const hidden = forgeOn(t, repoWith({ allow_squash_merge: null, allow_merge_commit: null, allow_rebase_merge: null })).forge;
  assert.deepEqual(await hidden.mergeMethods(), []);
});

test("the open issues are read page by page, leaving pull requests out", async (t) => {
  const first = "repos/acme/tally/issues?state=open&per_page=100";
  const page2 = "repositories/5001/issues?state=open&per_page=100&page=2";
  const { forge } = forgeOn(t, [
    {
      request: { method: "GET", path: first },
      response: {
        status: 200,
        headers: { Link: `<https://api.github.com/${page2}>; rel="next"` },
        body: [{ number: 7 }, { number: 6, pull_request: {} }],
      },
    },
    { request: { method: "GET", path: page2 }, response: { status: 200, body: [{ number: 2 }] } },
  ]);
  assert.deepEqual(await forge.openIssueNumbers(), [2, 7]);
});

test("an organization names no executor, and a name GitHub cannot have is not looked up", async (t) => {
  const { forge, transport } = forgeOn(t, [
    { request: { method: "GET", path: "users/acme" }, response: { status: 200, body: { login: "acme", id: 2001, type: "Organization" } } },
    {
      request: { method: "GET", path: "users/dependabot[bot]" },
      response: { status: 200, body: { login: "dependabot[bot]", id: 49699333, type: "Bot" } },
    },
  ]);
  assert.equal(await forge.actorByUsername("acme"), null);
  assert.deepEqual(await forge.actorByUsername("dependabot[bot]"), { forge: "github", host: "github.com", id: 49699333, username: "dependabot[bot]" });
  for (const name of ["", "-lead", "a--b", "x/../user", "a b", "user?x=1"]) assert.equal(await forge.actorByUsername(name), null, name);
  assert.equal(transport.requests.length, 2);
});

test("a username lookup the forge refuses for its rate limit is not taken for an unknown user", async (t) => {
  const { forge } = forgeOn(t, [
    {
      request: { method: "GET", path: "users/executor" },
      response: { status: 403, headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1794139200" }, body: { message: "API rate limit exceeded" } },
    },
  ]);
  await assert.rejects(forge.actorByUsername("executor"), RateLimitedError);
});

test("the open issues and the issues carrying a label are read in full, oldest first, leaving pull requests out", async (t) => {
  const { forge } = forgeOn(t, [
    {
      request: { method: "GET", path: "repos/acme/tally/issues?state=open&sort=created&direction=asc&per_page=100" },
      response: { status: 200, body: [issue(9003, "2026-11-01T10:00:00Z"), { ...issue(9004, "2026-11-01T10:00:00Z"), pull_request: {} }] },
    },
    {
      request: { method: "GET", path: "repos/acme/tally/issues?state=all&labels=entail%3Asuggested&sort=created&direction=asc&per_page=100" },
      response: { status: 200, body: [{ ...issue(9005, "2026-11-01T10:00:00Z"), state: "closed" }] },
    },
  ]);
  assert.deepEqual((await forge.openIssues()).map((one) => one.number), [3]);
  const labelled = await forge.labelledIssues("entail:suggested");
  assert.deepEqual(labelled.map((one) => [one.number, one.state]), [[5, "closed"]]);
  await assert.rejects(forge.labelledIssues("bug"), /entail writes only its own labels/);
});

test("a new issue is filed with its entail: labels, each created first when missing", async (t) => {
  const { forge, transport } = forgeOn(t, [
    { request: { method: "GET", path: "repos/acme/tally/labels/entail%3Asuggested" }, response: { status: 404, body: { message: "Not Found" } } },
    {
      request: { method: "POST", path: "repos/acme/tally/labels", body: { name: "entail:suggested", color: "5319e7", description: "Set by entail: see its latest comment on the issue" } },
      response: { status: 201, body: { name: "entail:suggested" } },
    },
    {
      request: { method: "POST", path: "repos/acme/tally/issues", body: { title: "Count words in PDFs", body: "Why.\n\n<!-- entail suggestion 7.0 -->", labels: ["entail:suggested"] } },
      response: { status: 201, body: { ...issue(9012, "2026-11-01T10:00:00Z"), title: "Count words in PDFs" } },
    },
  ]);
  const filed = await forge.createIssue("Count words in PDFs", "Why.\n\n<!-- entail suggestion 7.0 -->", ["entail:suggested"]);
  assert.equal(filed.number, 12);
  assert.equal(filed.url, "https://github.com/acme/tally/issues/12");
  await assert.rejects(forge.createIssue("x", "y", ["bug"]), /entail writes only its own labels/);
  assert.equal(transport.requests.length, 3);
});

test("an issue's blockers come from GitHub's issue dependencies, paged, with each blocker's repo and state", async (t) => {
  const page = (nodes: unknown[], hasNextPage: boolean) => ({ data: { repository: { issue: { blockedBy: { nodes, pageInfo: { hasNextPage, endCursor: "Mg" } } } } } });
  const { forge, requests } = graphqlTransport(t, [
    { body: page([{ number: 3, state: "OPEN", repository: { nameWithOwner: "acme/tally" } }], true) },
    { body: page([{ number: 9, state: "CLOSED", repository: { nameWithOwner: "acme/core" } }], false) },
  ]);
  assert.deepEqual(await forge.blockedBy(5), [
    { path: "acme/tally", number: 3, state: "open" },
    { path: "acme/core", number: 9, state: "closed" },
  ]);
  assert.deepEqual(requests.map((r) => r.variables), [
    { owner: "acme", name: "tally", number: 5, after: null },
    { owner: "acme", name: "tally", number: 5, after: "Mg" },
  ]);
});

test("an API without issue dependencies reads as no blocking links, so only the text counts; other errors still throw", async (t) => {
  const { forge } = graphqlTransport(t, [
    { body: { errors: [{ message: "Field 'blockedBy' doesn't exist on type 'Issue'" }] } },
    { body: { data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to an Issue with the number of 99." }] } },
  ]);
  assert.equal(await forge.blockedBy(5), null);
  await assert.rejects(forge.blockedBy(99), ForgeRequestError);
});

test("a blocker's state is read from its issue in any repo, and a missing one is null", async (t) => {
  const { forge } = forgeOn(t, [
    { request: { method: "GET", path: "repos/acme/core/issues/9" }, response: { status: 200, body: { ...issue(9009, "2026-11-01T10:00:00Z"), state: "closed" } } },
    { request: { method: "GET", path: "repos/acme/tally/issues/77" }, response: { status: 404, body: { message: "Not Found" } } },
  ]);
  assert.equal(await forge.issueState("acme/core", 9), "closed");
  assert.equal(await forge.issueState("acme/tally", 77), null);
  assert.equal(await forge.issueState("not a path", 1), null);
});

test("the open PRs into the base branch are listed by the pulls API filtered on it", async (t) => {
  const transport = new RecordedTransport({
    host: "github.com",
    exchanges: [
      { request: { method: "GET", path: "repos/acme/tally" }, response: { status: 200, body: { id: 5001, default_branch: "main" } } },
      {
        request: { method: "GET", path: "repos/acme/tally/pulls?state=open&base=develop&sort=created&direction=asc&per_page=100" },
        response: { status: 200, body: [pull(5, "2026-11-02T09:00:00Z", { base: { ref: "develop", sha: "0".repeat(40) } }), pull(6, "2026-11-02T10:00:00Z", { draft: true, base: { ref: "develop", sha: "0".repeat(40) } })] },
      },
    ],
  });
  t.after(() => transport.assertDone());
  const forge = new GitHubForge(SETTING, transport, { baseBranch: "develop" });
  assert.deepEqual(
    (await forge.openPullRequests()).map((pr) => [pr.number, pr.baseBranch, pr.draft, pr.mergeable]),
    [
      [5, "develop", false, null],
      [6, "develop", true, null],
    ],
  );
});
