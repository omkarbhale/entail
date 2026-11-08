import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { CliTransport, parseIncludedResponse, TransportError } from "../../src/forge/transport.ts";

/** As `gh api --include` prints it: an LF status line, CRLF headers, then the body. */
const NOT_MODIFIED = 'HTTP/2.0 304 Not Modified\nEtag: W/"abc"\r\nX-Ratelimit-Remaining: 4955\r\n\r\n';
const OK = 'HTTP/2.0 200 OK\nContent-Type: application/json\r\nLink: <a>; rel="next"\r\nLink: <b>; rel="last"\r\n\r\n[{"id":1}]';

test("an included response is read for its status, lower-case headers and body", () => {
  assert.deepEqual(parseIncludedResponse(OK), {
    status: 200,
    headers: { "content-type": "application/json", link: '<a>; rel="next", <b>; rel="last"' },
    body: '[{"id":1}]',
  });
  assert.deepEqual(parseIncludedResponse(NOT_MODIFIED), {
    status: 304,
    headers: { etag: 'W/"abc"', "x-ratelimit-remaining": "4955" },
    body: "",
  });
  assert.deepEqual(parseIncludedResponse("HTTP/1.1 404 Not Found\nA: b\n\n{}"), { status: 404, headers: { a: "b" }, body: "{}" });
});

test("output without a status line is no response", () => {
  assert.equal(parseIncludedResponse(""), null);
  assert.equal(parseIncludedResponse("error connecting to api.github.com\n"), null);
});

/** A stand-in for `gh` that records its arguments, prints `stdout` and `stderr`, and exits with `code`. */
function fakeCli(t: TestContext, stdout: string, code: number, stderr = "", delaySeconds = 0): { path: string; args: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), "entail-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "stdout"), stdout);
  writeFileSync(join(dir, "stderr"), stderr);
  const path = join(dir, "gh");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `for arg in "$@"; do printf '%s\\0' "$arg"; done > "${dir}/args"`,
      delaySeconds ? `sleep ${delaySeconds}` : "",
      `cat "${dir}/stdout"`,
      `cat "${dir}/stderr" >&2`,
      `exit ${code}`,
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return { path, args: () => readFileSync(join(dir, "args"), "utf8").split("\0").slice(0, -1) };
}

test("a 304 that gh exits 1 on is a response, read from the HTTP status", async (t) => {
  const cli = fakeCli(t, NOT_MODIFIED, 1, "gh: HTTP 304");
  const transport = new CliTransport("gh", { executable: cli.path });
  const response = await transport.request({
    host: "github.com",
    method: "GET",
    path: "repos/acme/tally/issues?state=all",
    headers: { "If-None-Match": 'W/"abc"' },
  });
  assert.equal(response.status, 304);
  assert.deepEqual(cli.args(), [
    "api",
    "--hostname",
    "github.com",
    "--include",
    "--method",
    "GET",
    "--header",
    'If-None-Match: W/"abc"',
    "repos/acme/tally/issues?state=all",
  ]);
});

test("an error status is a response too", async (t) => {
  const cli = fakeCli(t, 'HTTP/2.0 404 Not Found\nContent-Type: application/json\n\n{"message":"Not Found"}', 1, "gh: Not Found (HTTP 404)");
  const response = await new CliTransport("gh", { executable: cli.path }).request({ host: "github.com", method: "GET", path: "repos/a/b" });
  assert.equal(response.status, 404);
  assert.equal(response.body, '{"message":"Not Found"}');
});

test("gh asking for a login fails as logged out", async (t) => {
  const cli = fakeCli(t, "", 4, "To get started with GitHub CLI, please run:  gh auth login\n");
  await assert.rejects(
    new CliTransport("gh", { executable: cli.path }).request({ host: "github.com", method: "GET", path: "user" }),
    (error: unknown) => error instanceof TransportError && error.loggedOut && /gh auth login/.test(error.message),
  );
});

test("no response for another reason fails, not as logged out", async (t) => {
  const cli = fakeCli(t, "", 1, "error connecting to api.github.com\n");
  await assert.rejects(
    new CliTransport("gh", { executable: cli.path }).request({ host: "github.com", method: "GET", path: "user" }),
    (error: unknown) => error instanceof TransportError && !error.loggedOut && /error connecting/.test(error.message),
  );
});

test("a call that outlives its timeout fails even if it printed a status line", async (t) => {
  const cli = fakeCli(t, OK, 0, "", 5);
  await assert.rejects(
    new CliTransport("gh", { executable: cli.path, timeoutMs: 200 }).request({ host: "github.com", method: "GET", path: "user" }),
    TransportError,
  );
});

test("glab is run the same way, at the self-hosted host it is given", async (t) => {
  const included = 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Next-Page: \r\n\r\n[{"id":1}]';
  const cli = fakeCli(t, included, 0);
  const response = await new CliTransport("glab", { executable: cli.path }).request({
    host: "gitlab.example.org",
    method: "GET",
    path: "projects/acme%2Ftally/issues?order_by=updated_at",
  });
  assert.deepEqual(response, { status: 200, headers: { "content-type": "application/json", "x-next-page": "" }, body: '[{"id":1}]' });
  assert.deepEqual(cli.args(), [
    "api",
    "--hostname",
    "gitlab.example.org",
    "--include",
    "--method",
    "GET",
    "projects/acme%2Ftally/issues?order_by=updated_at",
  ]);
});

test("glab refusing a login it cannot use fails as logged out", async (t) => {
  const cli = fakeCli(
    t,
    "",
    1,
    'the token for "gitlab.example.org" is missing from the operating system keyring; run `glab auth login --hostname gitlab.example.org` to re-authenticate\n',
  );
  await assert.rejects(
    new CliTransport("glab", { executable: cli.path }).request({ host: "gitlab.example.org", method: "GET", path: "user" }),
    (error: unknown) => error instanceof TransportError && error.loggedOut,
  );
});

test("glab failing for another reason fails, not as logged out", async (t) => {
  const cli = fakeCli(t, "", 1, "dial tcp: lookup gitlab.example.org: no such host\n");
  await assert.rejects(
    new CliTransport("glab", { executable: cli.path }).request({ host: "gitlab.example.org", method: "GET", path: "user" }),
    (error: unknown) => error instanceof TransportError && !error.loggedOut && /no such host/.test(error.message),
  );
});
