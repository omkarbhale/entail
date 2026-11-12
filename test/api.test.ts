import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createApi } from "../src/api.ts";
import { OWNER_CASE_BOOK, readCaseBook } from "../src/case-book.ts";
import { appendEntry, readLog, readSettings, type CallEntry } from "../src/records.ts";

async function serve(t: TestContext) {
  const dataDirectory = mkdtempSync(join(tmpdir(), "entail-api-"));
  t.after(() => rmSync(dataDirectory, { recursive: true, force: true }));
  let woken = 0;
  const server = createApi({
    dataDirectory,
    owner: async () => "Omkar",
    defaultModel: "claude-opus-5-5",
    book: async () => [],
    wake: () => woken++,
    now: () => new Date("2026-11-12T12:00:00Z"),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  return { dataDirectory, base, call, woken: () => woken };
}

function aCall(dataDirectory: string, confirm: boolean): CallEntry {
  return appendEntry(dataDirectory, "acme/tally", {
    type: "call",
    issue: { number: 12, title: "Count words in footnotes", url: "https://github.com/acme/tally/issues/12", author: "reporter" },
    trigger: "new",
    mentions: [],
    content: "h",
    issueText: "# Count words in footnotes\n\nFootnotes are skipped.\n",
    vision: { text: "# Vision\n\ntally counts words offline.\n", commit: "c".repeat(40) },
    sha: "c".repeat(40),
    call: { call: "go", reason: "More useful.", restsOn: { visionLines: ["tally counts words offline."], cases: [] }, criteria: [] },
    confirm,
    owner: null,
    model: "claude-opus-5-5",
    effort: "low",
    promptVersion: "issue-call-2",
    costUsd: 0.04,
  }) as CallEntry;
}

test("the board enrolls a repo, changes its settings and unenrolls it, each under the owner's name", async (t) => {
  const api = await serve(t);
  const enrolled = await api.call("POST", "/api/repos", { repo: "Acme/Tally", since: "2026-11-12T09:00:00Z" });
  assert.equal(enrolled.status, 201);
  assert.deepEqual(enrolled.body, { repo: "acme/tally", enrolled: true, since: "2026-11-12T09:00:00.000Z", confirm: true, model: null, effort: null });
  assert.equal((await api.call("POST", "/api/repos", { repo: "acme/tally" })).status, 409);

  const patched = await api.call("PATCH", "/api/repos/acme/tally", { confirm: false, effort: "medium" });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.confirm, false);
  assert.equal((await api.call("PATCH", "/api/repos/acme/tally", { effort: "huge" })).status, 400);

  const { body } = await api.call("GET", "/api/repos");
  assert.deepEqual(body.repos.map((repo: any) => [repo.repo, repo.confirm, repo.uses]), [["acme/tally", false, { model: "claude-opus-5-5", effort: "medium" }]]);

  assert.equal((await api.call("DELETE", "/api/repos/acme/tally", {})).status, 200);
  assert.deepEqual((await api.call("GET", "/api/repos")).body.repos, []);
  assert.deepEqual(
    readLog(api.dataDirectory, "acme/tally").map((entry) => [entry.type, "by" in entry ? entry.by : null]),
    [
      ["enrolled", "Omkar"],
      ["settings", "Omkar"],
      ["unenrolled", "Omkar"],
    ],
  );
  assert.equal(api.woken(), 3);
});

test("the board reads what waits, confirms a call, and the confirmation lands in the log and the case book", async (t) => {
  const api = await serve(t);
  await api.call("POST", "/api/repos", { repo: "acme/tally" });
  const entry = aCall(api.dataDirectory, true);

  const waiting = await api.call("GET", "/api/waiting");
  assert.equal(waiting.body.items.length, 1);
  const [item] = waiting.body.items;
  assert.equal(item.id, entry.id);
  assert.equal(item.issue.url, "https://github.com/acme/tally/issues/12");
  assert.equal(item.reason, "More useful.");
  assert.equal(item.issueText, "# Count words in footnotes\n\nFootnotes are skipped.\n");
  assert.equal(item.visionCommit, "c".repeat(40));
  assert.equal(item.restsOn.visionLines[0].url, `https://github.com/acme/tally/blob/${"c".repeat(40)}/VISION.md#L3`);

  assert.equal((await api.call("GET", `/api/calls/${entry.id}`)).body.status, "waiting");
  const confirmed = await api.call("POST", `/api/calls/${entry.id}/confirm`, {});
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.by, "Omkar");
  assert.equal((await api.call("POST", `/api/calls/${entry.id}/confirm`, {})).status, 409);
  assert.deepEqual((await api.call("GET", "/api/waiting")).body.items, []);

  const log = await api.call("GET", "/api/log?repo=acme/tally");
  assert.deepEqual(
    log.body.items.map((logged: any) => logged.kind),
    ["repo", "call", "owner"],
  );
  const [past] = await readCaseBook(join(api.dataDirectory, OWNER_CASE_BOOK));
  assert.equal(past!.call, "go");
});

test("an override needs a reason and an answer needs words, and both are recorded as the owner's", async (t) => {
  const api = await serve(t);
  await api.call("POST", "/api/repos", { repo: "acme/tally" });
  const entry = aCall(api.dataDirectory, false);
  assert.equal((await api.call("POST", `/api/calls/${entry.id}/override`, { call: "no" })).status, 400);
  assert.equal((await api.call("POST", `/api/calls/${entry.id}/answer`, { call: "no", answer: "x" })).status, 409);
  const overridden = await api.call("POST", `/api/calls/${entry.id}/override`, { call: "no", reason: "Footnotes are not prose." });
  assert.equal(overridden.status, 200);
  assert.deepEqual([overridden.body.type, overridden.body.to, overridden.body.reason, overridden.body.by], ["overridden", "no", "Footnotes are not prose.", "Omkar"]);
  assert.equal((await api.call("POST", "/api/calls/1/confirm", {})).status, 404);
});

test("the settings for every repo are read and changed", async (t) => {
  const api = await serve(t);
  assert.deepEqual((await api.call("GET", "/api/settings")).body, { owner: null, model: "claude-opus-5-5", effort: "low" });
  const changed = await api.call("PATCH", "/api/settings", { owner: "Omkar", effort: "medium" });
  assert.deepEqual(changed.body, { owner: "Omkar", model: "claude-opus-5-5", effort: "medium" });
  assert.deepEqual(readSettings(api.dataDirectory, { model: "x" }), { owner: "Omkar", model: "claude-opus-5-5", effort: "medium" });
  assert.equal((await api.call("PATCH", "/api/settings", { owner: "two\nlines" })).status, 400);
});

test("no web page can act as the owner: writes take JSON from no other origin, and only the loopback host is answered", async (t) => {
  const api = await serve(t);
  // A form post from a page: no JSON.
  const form = await fetch(`${api.base}/api/repos`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: '{"repo":"acme/tally"}' });
  assert.equal(form.status, 415);
  const foreign = await api.call("POST", "/api/repos", { repo: "acme/tally" }, { Origin: "https://evil.example" });
  assert.equal(foreign.status, 403);
  assert.equal((await api.call("POST", "/api/repos", { repo: "acme/tally" }, { Origin: api.base })).status, 201);

  // A name that resolves here but is not the loopback host, as DNS rebinding would send.
  const port = Number(new URL(api.base).port);
  const status = await new Promise<number>((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path: "/api/waiting", headers: { Host: `evil.example:${port}` } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
    request.end();
  });
  assert.equal(status, 403);
  assert.equal((await api.call("GET", "/api/nothing")).status, 404);
  assert.equal((await api.call("PUT", "/api/settings", {})).status, 405);
});
