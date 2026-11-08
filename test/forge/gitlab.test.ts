import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { createForge } from "../../src/forge/create-forge.ts";
import { ForgeLoggedOutError, ForgeRequestError, projectKey, RateLimitedError } from "../../src/forge/forge.ts";
import { CHANGE_OVERLAP_MS, GitLabForge, unsupportedGitLabVersion } from "../../src/forge/gitlab.ts";
import { type Exchange, loadRecording, RecordedTransport } from "./recorded-transport.ts";

const SELF_HOSTED = "gitlab.example.org";
const SETTING = { forge: "gitlab", host: SELF_HOSTED, path: "acme/tally" } as const;
const ORDER = "order_by=updated_at&sort=desc&per_page=100";
const ISSUES = `projects/acme%2Ftally/issues?${ORDER}`;
const notesOf = (iid: number) => `projects/acme%2Ftally/issues/${iid}/notes?${ORDER}`;
const after = (time: string) => `${ISSUES}&updated_after=${encodeURIComponent(time)}`;

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
  const cursor = JSON.stringify({ since: "2026-11-01T11:00:00.000Z" });
  const { forge } = forgeOn(t, [{ request: { method: "GET", path: after("2026-11-01T10:58:00.000Z") }, response: list([]) }]);
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
  ]);
  const batch = await forge.changesSince(cursor);
  assert.deepEqual(
    batch.changes.map((c) => `${c.kind} ${c.id}`),
    ["issue 9002", "issue-comment 7005", "issue-comment 7002"],
    "system notes are not comments, and seen notes are not read",
  );
  assert.equal(transport.requests.length, 3, "page 3 is never asked for");
  assert.deepEqual(JSON.parse(batch.cursor), { since: "2026-11-02T09:10:00.000Z" }, "the cursor moves to the newest issue update");
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
  ]);
  const [change] = (await forge.changesSince(null)).changes;
  assert.ok(change?.kind === "issue");
  assert.equal(change.issue.state, "closed");
  assert.deepEqual(change.issue.labels, ["entail:cleared", "bug"]);
});

for (const [name, cursor] of [
  ["not JSON", "garbage{"],
  ["the wrong shape", JSON.stringify({ issues: 1 })],
  ["a since that is not a time", JSON.stringify({ since: "nope" })],
] as const) {
  test(`a cursor that is ${name} costs a full re-scan`, async (t) => {
    const { forge } = forgeOn(t, [{ request: { method: "GET", path: ISSUES }, response: list([]) }]);
    const batch = await forge.changesSince(cursor);
    assert.deepEqual(batch, { changes: [], cursor: JSON.stringify({ since: null }) });
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

/** The Free/CE REST endpoints the adapter reads: nothing that needs Premium or Ultimate (ADR-0015). */
const FREE_ENDPOINTS = [
  /^user$/,
  /^version$/,
  /^projects\/[^/?]+$/,
  /^projects\/[^/?]+\/issues\?/,
  /^projects\/[^/?]+\/issues\/\d+\/notes\?/,
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
