import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test, type TestContext } from "node:test";
import { escapeHtml } from "../src/page.ts";
import { BoardPortTakenError, MAX_FORM_BYTES, SERVER_ADDRESS, startServer, TOKEN_FIELD, type LocalServer, type Page } from "../src/server.ts";
import { postForm, send } from "./http-client.ts";

/** A page that echoes what it was posted, to see what reached it. */
function echoPage(posted: URLSearchParams[]): Page {
  return {
    path: "/echo",
    nav: "Echo",
    get: (request) => ({ status: 200, page: { title: "Echo", body: `<p>token=${escapeHtml(request.server.token)}</p>` } }),
    post: (request) => {
      posted.push(request.form);
      return { redirect: "/echo?done=1" };
    },
  };
}

async function serve(t: TestContext, posted: URLSearchParams[] = []): Promise<LocalServer> {
  const server = await startServer({ port: 0, pages: [echoPage(posted), { path: "/read-only", get: echoPage([]).get! }] });
  t.after(() => server.close());
  return server;
}

test("the server listens on 127.0.0.1 only", async (t) => {
  const server = await serve(t);
  assert.equal(SERVER_ADDRESS, "127.0.0.1");
  assert.equal(server.info.origin, `http://127.0.0.1:${server.info.port}`);
  const page = await send(server.info.port, { path: "/echo" });
  assert.equal(page.status, 200);
});

test("the server refuses to start when its port is taken, with a clear message", async (t) => {
  const other = createServer();
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  t.after(() => other.close());
  const { port } = other.address() as { port: number };

  await assert.rejects(startServer({ port, pages: [] }), (error: unknown) => {
    assert.ok(error instanceof BoardPortTakenError);
    assert.equal(error.port, port);
    assert.match(error.message, new RegExp(`board port ${port} on 127\\.0\\.0\\.1 is already in use`));
    return true;
  });
});

test("a request whose Host is not the server's own is refused", async (t) => {
  const server = await serve(t);
  const { port } = server.info;
  for (const host of ["evil.example", `evil.example:${port}`, `127.0.0.1:${port + 1}`, "127.0.0.1", `192.168.1.5:${port}`]) {
    const refused = await send(port, { path: "/echo", host });
    assert.equal(refused.status, 403, host);
    assert.doesNotMatch(refused.body, /token=/, "a refused request sees no page");
  }
  // Node refuses an HTTP/1.1 request with no Host before entail sees it.
  const noHost = await send(port, { path: "/echo", host: null });
  assert.equal(noHost.status, 400, "no Host at all");
  assert.doesNotMatch(noHost.body, /token=/);
  assert.equal((await send(port, { path: "/echo", host: `localhost:${port}` })).status, 200, "localhost is the same machine");
  assert.equal((await send(port, { path: "/echo", host: `LOCALHOST:${port}` })).status, 200);
});

test("a write whose Origin is not the server's own is refused", async (t) => {
  const posted: URLSearchParams[] = [];
  const server = await serve(t, posted);
  const { port, token } = server.info;
  const form = { [TOKEN_FIELD]: token, x: "1" };
  for (const origin of ["http://evil.example", `http://127.0.0.1:${port + 1}`, `https://127.0.0.1:${port}`, "null"]) {
    assert.equal((await postForm(port, "/echo", form, { Origin: origin })).status, 403, origin);
  }
  const noOrigin = await send(port, {
    method: "POST",
    path: "/echo",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  assert.equal(noOrigin.status, 403, "a write with no Origin");
  for (const method of ["PUT", "DELETE", "PATCH"]) {
    assert.equal((await send(port, { method, path: "/echo", headers: { Origin: "http://evil.example" } })).status, 403, method);
  }
  assert.equal(posted.length, 0, "no refused write reached the page");

  const own = await postForm(port, "/echo", form);
  assert.equal(own.status, 303);
  assert.equal(own.headers.location, "/echo?done=1");
  const viaLocalhost = await postForm(port, "/echo", form, { Origin: `http://localhost:${port}`, Host: `localhost:${port}` });
  assert.equal(viaLocalhost.status, 303);
  assert.equal(posted.length, 2);
});

test("a form post without the per-start token is refused", async (t) => {
  const posted: URLSearchParams[] = [];
  const server = await serve(t, posted);
  const { port, token } = server.info;

  assert.equal((await postForm(port, "/echo", { x: "1" })).status, 403, "no token");
  assert.equal((await postForm(port, "/echo", { [TOKEN_FIELD]: "", x: "1" })).status, 403, "an empty token");
  assert.equal((await postForm(port, "/echo", { [TOKEN_FIELD]: `${token}x`, x: "1" })).status, 403, "a longer token");
  assert.equal((await postForm(port, "/echo", { [TOKEN_FIELD]: token.replace(/^./, (c) => (c === "A" ? "B" : "A")) })).status, 403, "a wrong token");

  const another = await serve(t);
  assert.notEqual(another.info.token, token, "each start issues its own token");
  assert.equal((await postForm(port, "/echo", { [TOKEN_FIELD]: another.info.token })).status, 403, "another start's token");
  assert.equal(posted.length, 0);

  assert.equal((await postForm(port, "/echo", { [TOKEN_FIELD]: token, x: "1" })).status, 303);
  assert.equal(posted[0]?.get("x"), "1");
});

test("a write that is not a form, or too large, is refused", async (t) => {
  const posted: URLSearchParams[] = [];
  const server = await serve(t, posted);
  const { port, token } = server.info;
  const origin = { Origin: server.info.origin };

  const json = await send(port, {
    method: "POST",
    path: "/echo",
    headers: { ...origin, "Content-Type": "application/json" },
    body: JSON.stringify({ [TOKEN_FIELD]: token }),
  });
  assert.equal(json.status, 415);
  const large = await postForm(port, "/echo", { [TOKEN_FIELD]: token, x: "y".repeat(MAX_FORM_BYTES) });
  assert.equal(large.status, 413);
  assert.equal(posted.length, 0);
});

test("unknown paths and methods are answered with the shared header", async (t) => {
  const server = await serve(t);
  const { port, token } = server.info;
  const missing = await send(port, { path: "/nowhere" });
  assert.equal(missing.status, 404);
  assert.match(missing.body, /<header class="site">/);
  assert.match(missing.body, /<a href="\/echo">Echo<\/a>/);
  assert.equal((await postForm(port, "/read-only", { [TOKEN_FIELD]: token })).status, 405);
});

test("every page shares one header and is sent with protective headers", async (t) => {
  const server = await serve(t);
  const page = await send(server.info.port, { path: "/echo" });
  assert.match(page.headers["content-type"] as string, /^text\/html; charset=utf-8/);
  assert.match(page.headers["content-security-policy"] as string, /frame-ancestors 'none'/);
  assert.match(page.headers["content-security-policy"] as string, /form-action 'self'/);
  assert.equal(page.headers["x-frame-options"], "DENY");
  // A same-origin form post must still carry its Origin.
  assert.equal(page.headers["referrer-policy"], "same-origin");
  assert.equal(page.headers["cache-control"], "no-store");
  assert.equal(page.body.match(/<header class="site">/g)?.length, 1);
  assert.match(page.body, /<a href="\/echo" aria-current="page">Echo<\/a>/);
  // The board app's own script and stylesheet, and nothing from elsewhere.
  const loaded = [...page.body.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(loaded, ["/ui/app.css", "/ui/app.js"]);
  assert.match(page.headers["content-security-policy"] as string, /script-src 'self';/, "no inline script runs");
});
