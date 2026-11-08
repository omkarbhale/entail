import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createForge } from "../../src/forge/create-forge.ts";
import { ForgeLoggedOutError, ForgeRequestError, RateLimitedError } from "../../src/forge/forge.ts";
import { GitHubForge } from "../../src/forge/github.ts";
import { GitLabForge } from "../../src/forge/gitlab.ts";
import { type Exchange, RecordedTransport } from "./recorded-transport.ts";

const SETTING = { forge: "github", host: "github.com", path: "acme/tally" } as const;
const ISSUES = "repos/acme/tally/issues?state=all&sort=updated&direction=desc&per_page=100";
const COMMENTS = "repos/acme/tally/issues/comments?sort=updated&direction=desc&per_page=100";

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
  });
  const { forge } = forgeOn(t, [
    { request: { method: "GET", path: ISSUES + since, headers: { "If-None-Match": 'W/"i"' } }, response: { status: 304 } },
    { request: { method: "GET", path: COMMENTS, headers: { "If-None-Match": '"c"' } }, response: { status: 304 } },
  ]);
  const batch = await forge.changesSince(cursor);
  assert.deepEqual(batch, { changes: [], cursor });
});

test("a list with nothing in it keeps its ETag for the next conditional read", async (t) => {
  const { forge } = forgeOn(t, [
    { request: { method: "GET", path: ISSUES }, response: { status: 200, headers: { ETag: '"empty"' }, body: [] } },
    { request: { method: "GET", path: COMMENTS }, response: { status: 200, body: [] } },
  ]);
  const batch = await forge.changesSince(null);
  assert.deepEqual(JSON.parse(batch.cursor), {
    issues: { since: null, etag: '"empty"' },
    comments: { since: null, etag: null },
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

test("the adapter serves only github.com repos with an owner/name path", () => {
  const transport = new RecordedTransport({ host: "github.com", exchanges: [] });
  assert.throws(() => new GitHubForge({ ...SETTING, host: "github.example.com" }, transport), /Enterprise Server/);
  assert.throws(() => new GitHubForge({ ...SETTING, path: "acme/tally/../x" }, transport), /owner\/name/);
  assert.throws(() => new GitHubForge({ ...SETTING, forge: "gitlab" }, transport), /gitlab/);
});

test("createForge picks the adapter from the stated forge", () => {
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
    ]);
    const batch = await forge.changesSince(cursor);
    assert.deepEqual(batch.changes, []);
  });
}
