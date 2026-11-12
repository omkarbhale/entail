import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createApi } from "../src/api.ts";
import { OWNER_CASE_BOOK, readCaseBook, readLandingCaseBook } from "../src/case-book.ts";
import { appendEntry, readLog, readSettings, type CallEntry, type LandingEntry } from "../src/records.ts";

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

function aLanding(dataDirectory: string, issueCall: number, call: "merge" | "ask"): LandingEntry {
  appendEntry(dataDirectory, "acme/tally", { type: "followed", pr: { number: 14, title: "Count footnotes", url: "https://github.com/acme/tally/pull/14", author: "reporter" }, issue: 12 });
  return appendEntry(dataDirectory, "acme/tally", {
    type: "landing",
    pr: { number: 14, title: "Count footnotes", url: "https://github.com/acme/tally/pull/14", author: "reporter" },
    issue: { number: 12, title: "Count words in footnotes", url: "https://github.com/acme/tally/issues/12" },
    issueCall,
    issueText: "# Count words in footnotes\n\nFootnotes are skipped.\n",
    prText: "# Count footnotes\n\nCloses #12.\n",
    head: "d".repeat(40),
    base: "c".repeat(40),
    vision: { text: "# Vision\n\ntally counts words offline.\n", commit: "c".repeat(40) },
    criteria: [{ source: "reading", criterion: "Footnotes count toward the total.", basis: "One total." }],
    facts: { checks: [{ name: "test", status: "passed", reported: true, url: null }], required: [], files: [{ path: "src/count.ts", status: "modified", previousPath: null, additions: 4, deletions: 1 }] },
    touched: { vision: false, pins: [] },
    call: {
      call,
      reason: "It counts footnotes.",
      restsOn: { visionLines: [], cases: [] },
      solves: { solved: true, evidence: "src/count.ts" },
      criteria: [{ criterion: "Footnotes count toward the total.", met: true, evidence: "src/count.ts" }],
      beyond: [{ change: "A loading line.", sort: "needed", why: "Counting takes time." }],
      needsToChange: [],
      productCall: false,
      question: call === "ask" ? { question: "Merge it?", why: "Unsure." } : null,
      guard: null,
    },
    sendBacks: 0,
    cancel: false,
    confirm: true,
    model: "claude-opus-5-5",
    effort: "low",
    promptVersion: "pr-call-1",
    costUsd: 0.06,
  }) as LandingEntry;
}

test("the board reads a PR's call with its checklist, facts and sort, and confirms, overrides or answers it as merge or send-back", async (t) => {
  const api = await serve(t);
  const issueCall = aCall(api.dataDirectory, true);
  appendEntry(api.dataDirectory, "acme/tally", { type: "enrolled", by: "Omkar", since: "2026-11-12T09:00:00.000Z", confirm: true });
  const landing = aLanding(api.dataDirectory, issueCall.id, "merge");

  const waiting = await api.call("GET", "/api/waiting");
  const item = waiting.body.items.find((i: { kind: string }) => i.kind === "pr");
  assert.equal(item.id, landing.id);
  assert.equal(item.call, "merge");
  assert.equal(item.pr.number, 14);
  assert.deepEqual(item.pr.checklist, [{ criterion: "Footnotes count toward the total.", met: true, evidence: "src/count.ts" }]);
  assert.deepEqual(item.pr.beyond, [{ change: "A loading line.", sort: "needed", why: "Counting takes time." }]);
  assert.equal(item.pr.facts.ciGreen, true);
  assert.equal(item.criteria[0].criterion, "Footnotes count toward the total.");
  const issueItem = waiting.body.items.find((i: { kind: string }) => i.kind === "issue");
  assert.equal(issueItem.pr, null);

  assert.equal((await api.call("GET", `/api/calls/${landing.id}`)).body.pr.head, "d".repeat(40));
  assert.equal((await api.call("POST", `/api/calls/${landing.id}/override`, { call: "go", reason: "x" })).status, 400);
  const overridden = await api.call("POST", `/api/calls/${landing.id}/override`, { call: "send-back", reason: "Footnotes in tables are still skipped." });
  assert.equal(overridden.status, 200);
  assert.equal(overridden.body.to, "send-back");
  const [past] = await readLandingCaseBook(join(api.dataDirectory, OWNER_CASE_BOOK));
  assert.equal(past!.call, "send-back");
  assert.equal(past!.pr, 14);

  const log = await api.call("GET", "/api/log");
  assert.ok(log.body.items.some((i: { kind: string; callKind?: string }) => i.kind === "call" && i.callKind === "pr"));
  assert.ok(log.body.items.some((i: { kind: string; pr: { number: number } | null }) => i.kind === "owner" && i.pr?.number === 14));
  assert.ok(log.body.items.some((i: { kind: string }) => i.kind === "pr"));
});

test("a PR's question is answered merge or send-back, and a merge call is confirmed", async (t) => {
  const api = await serve(t);
  const issueCall = aCall(api.dataDirectory, false);
  const asked = aLanding(api.dataDirectory, issueCall.id, "ask");
  assert.equal((await api.call("POST", `/api/calls/${asked.id}/confirm`, {})).status, 409);
  const answered = await api.call("POST", `/api/calls/${asked.id}/answer`, { call: "merge", answer: "Yes, merge it." });
  assert.equal(answered.status, 200);
  const merge = aLanding(api.dataDirectory, issueCall.id, "merge");
  assert.equal((await api.call("POST", `/api/calls/${asked.id}/answer`, { call: "merge", answer: "again" })).status, 409, "a newer call on the PR replaced it");
  assert.equal((await api.call("POST", `/api/calls/${merge.id}/confirm`, {})).status, 200);
  assert.deepEqual(
    readLog(api.dataDirectory, "acme/tally").flatMap((e) => (e.type === "answered" || e.type === "confirmed" ? [[e.type, e.call]] : [])),
    [
      ["answered", asked.id],
      ["confirmed", merge.id],
    ],
  );
});
