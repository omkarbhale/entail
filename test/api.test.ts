import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createApi, type ApiOptions, type BoardLoop } from "../src/api.ts";
import type { BoardEvent } from "../src/api-types.ts";
import { OWNER_CASE_BOOK, readCaseBook } from "../src/case-book.ts";
import { EventBus } from "../src/events.ts";
import { appendEntry, readLog, readSettings, type CallEntry, type LandingEntry } from "../src/records.ts";

const NOON = Date.parse("2026-11-12T12:00:00Z");

async function serve(t: TestContext, overrides: Partial<ApiOptions> = {}) {
  const dataDirectory = mkdtempSync(join(tmpdir(), "entail-api-"));
  t.after(() => rmSync(dataDirectory, { recursive: true, force: true }));
  let woken = 0;
  let clock = NOON;
  const scheduled: string[] = [];
  const loop: BoardLoop = {
    check: async (repo) => ({ repo, at: new Date(clock).toISOString(), judged: 2, posted: 1, failed: false }),
    schedule: (at) => scheduled.push(at.toISOString()),
    wake: () => woken++,
    checkedAt: () => "2026-11-12T11:59:20.000Z",
    lastPassAt: "2026-11-12T11:59:20.000Z",
    checking: false,
  };
  const opened: string[] = [];
  const server = createApi({
    dataDirectory,
    owner: async () => "Omkar",
    defaultModel: "claude-opus-5-5",
    book: async () => [],
    now: () => new Date(clock),
    loop,
    board: null,
    forgeFor: (repo) => ({
      project: async () => {
        opened.push(repo);
        if (repo === "acme/missing") throw new Error("gh: Not Found (HTTP 404)");
        return { forge: "github", host: "github.com", id: 77, path: repo, defaultBranch: "main" };
      },
      openIssueNumbers: async () => [3, 5, 8],
    }),
    ...overrides,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: any = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not JSON: a page of the board.
    }
    return { status: response.status, body: parsed as Record<string, any>, headers: response.headers };
  };
  return { dataDirectory, base, call, woken: () => woken, scheduled, opened, advance: (ms: number) => (clock += ms) };
}

function aCall(dataDirectory: string, confirm: boolean, overrides: Partial<CallEntry> = {}, at = new Date(NOON - 3600_000)): CallEntry {
  return appendEntry(
    dataDirectory,
    "acme/tally",
    {
      type: "call",
      issue: { number: 12, title: "Count words in footnotes", url: "https://github.com/acme/tally/issues/12", author: "reporter", createdAt: "2026-11-10T09:00:00Z" },
      trigger: "new",
      mentions: [],
      content: "h",
      issueText: "# Count words in footnotes\n\nFootnotes are skipped.\n\n## Comments\n\n**someone**, 2026-11-11:\n\nMe too.\n",
      vision: { text: "# Vision\n\ntally counts words offline.\n", commit: "c".repeat(40) },
      sha: "c".repeat(40),
      call: { call: "go", reason: "More useful.", restsOn: { visionLines: ["tally counts words offline."], cases: [] }, criteria: [] },
      confirm,
      owner: null,
      model: "claude-opus-5-5",
      effort: "low",
      promptVersion: "issue-call-2",
      costUsd: 0.04,
      ...overrides,
    } as Omit<CallEntry, "id" | "at">,
    at,
  ) as CallEntry;
}

test("the board enrolls a repo it can read on GitHub, changes its settings and unenrolls it, each under the owner's name", async (t) => {
  const api = await serve(t);
  const missing = await api.call("POST", "/api/repos", { repo: "acme/missing" });
  assert.equal(missing.status, 502);
  assert.match(missing.body.error, /entail could not read acme\/missing on GitHub: gh: Not Found/u);
  assert.deepEqual(readLog(api.dataDirectory, "acme/missing"), [], "nothing is enrolled when GitHub cannot be read");

  const enrolled = await api.call("POST", "/api/repos", { repo: "Acme/Tally", since: "2026-11-12T09:00:00Z" });
  assert.equal(enrolled.status, 201);
  assert.equal(enrolled.body.openIssues, 3, "the open issues are counted, for the board to offer them");
  assert.deepEqual([enrolled.body.repo.repo, enrolled.body.repo.confirm, enrolled.body.repo.since], ["acme/tally", true, "2026-11-12T09:00:00.000Z"]);
  assert.equal((await api.call("POST", "/api/repos", { repo: "acme/tally" })).status, 409);

  const patched = await api.call("PATCH", "/api/repos/acme/tally", { confirm: false, effort: "medium" });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.confirm, false);
  assert.equal((await api.call("PATCH", "/api/repos/acme/tally", { effort: "huge" })).status, 400);

  const { body } = await api.call("GET", "/api/repos");
  const [repo] = body.repos;
  assert.deepEqual([repo.repo, repo.confirm, repo.uses, repo.checkedAt], ["acme/tally", false, { model: "claude-opus-5-5", effort: "medium" }, "2026-11-12T11:59:20.000Z"]);
  assert.deepEqual(repo.pins.topics, []);
  assert.match(repo.pins.file, /pins\/github\.com\/acme\/tally\.md$/u);

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

test("an answer is recorded at once and held ten seconds: it can be undone until entail acts, and is acted on when the window closes", async (t) => {
  const api = await serve(t);
  await api.call("POST", "/api/repos", { repo: "acme/tally" });
  const entry = aCall(api.dataDirectory, true);

  const waiting = await api.call("GET", "/api/waiting");
  assert.equal(waiting.body.items.length, 1);
  const [item] = waiting.body.items;
  assert.equal(item.id, entry.id);
  assert.equal(item.body, "Footnotes are skipped.", "the request is the issue's own words, without its title or comments");
  assert.equal(item.issue.createdAt, "2026-11-10T09:00:00Z");
  assert.deepEqual(item.restsOn.visionLines[0], { text: "tally counts words offline.", url: `https://github.com/acme/tally/blob/${"c".repeat(40)}/VISION.md#L3`, line: 3 });

  const confirmed = await api.call("POST", `/api/calls/${entry.id}/confirm`, {});
  assert.equal(confirmed.status, 200);
  assert.deepEqual([confirmed.body.type, confirmed.body.by, confirmed.body.holdUntil], ["confirmed", "Omkar", "2026-11-12T12:00:10.000Z"]);
  assert.deepEqual(api.scheduled, ["2026-11-12T12:00:10.000Z"], "entail acts the moment the window closes");
  assert.equal((await api.call("POST", `/api/calls/${entry.id}/confirm`, {})).status, 409);

  const during = await api.call("GET", "/api/waiting");
  assert.deepEqual(during.body.items, []);
  assert.deepEqual(during.body.held.map((held: any) => [held.item.id, held.action.type, held.holdUntil]), [[entry.id, "confirmed", "2026-11-12T12:00:10.000Z"]]);
  assert.ok(!existsSync(join(api.dataDirectory, "cases")), "nothing reaches the case book while the answer can be undone");

  api.advance(9_000);
  const undone = await api.call("POST", `/api/calls/${entry.id}/undo`, {});
  assert.equal(undone.status, 200);
  assert.equal(undone.body.call.status, "waiting");
  assert.equal((await api.call("GET", "/api/waiting")).body.items.length, 1, "undone, the call waits again");

  const again = await api.call("POST", `/api/calls/${entry.id}/confirm`, {});
  api.advance(10_001);
  assert.deepEqual((await api.call("GET", "/api/waiting")).body.held, [], "the window closed");
  const late = await api.call("POST", `/api/calls/${entry.id}/undo`, {});
  assert.equal(late.status, 409);
  assert.match(late.body.error, /too late to undo/u);
  assert.deepEqual(
    readLog(api.dataDirectory, "acme/tally")
      .filter((logged) => logged.type !== "enrolled" && logged.type !== "call")
      .map((logged) => logged.type),
    ["confirmed", "undone", "confirmed"],
  );
  assert.equal(again.body.holdUntil, "2026-11-12T12:00:19.000Z");
});

test("an override needs a reason, a go can be made differently with the owner's line, and an answer needs words", async (t) => {
  const api = await serve(t);
  await api.call("POST", "/api/repos", { repo: "acme/tally" });
  const entry = aCall(api.dataDirectory, false);
  assert.equal((await api.call("POST", `/api/calls/${entry.id}/override`, { call: "no" })).status, 400);
  assert.equal((await api.call("POST", `/api/calls/${entry.id}/answer`, { call: "no", answer: "x" })).status, 409);
  assert.equal((await api.call("POST", `/api/calls/${entry.id}/override`, { call: "go", reason: "x" })).status, 409, "a go cannot be overridden with a plain go");
  const differently = await api.call("POST", `/api/calls/${entry.id}/override`, { call: "go", reason: "Count footnotes separately, after the body.", differently: true });
  assert.equal(differently.status, 200);
  assert.deepEqual([differently.body.type, differently.body.to, differently.body.differently, differently.body.reason], ["overridden", "go", true, "Count footnotes separately, after the body."]);
  assert.equal((await api.call("POST", `/api/calls/${entry.id}/override`, { call: "no", reason: "Changed my mind." })).status, 409);
  assert.equal((await api.call("POST", "/api/calls/1/confirm", {})).status, 404);
});

test("the log is paged by whole days in the owner's time zone, newest first, and never trimmed", async (t) => {
  const api = await serve(t);
  await api.call("POST", "/api/repos", { repo: "acme/tally" });
  for (let day = 1; day <= 4; day++) {
    for (let index = 0; index < 20; index++) {
      aCall(api.dataDirectory, false, { issue: { number: day * 100 + index, title: `Issue ${day}-${index}`, url: "u", author: "a" } }, new Date(`2026-11-0${day}T23:${String(index).padStart(2, "0")}:00Z`));
    }
  }
  const first = await api.call("GET", "/api/log?tz=Asia/Kolkata");
  assert.equal(first.status, 200);
  // 23:00Z is the next morning in Kolkata: the four days of calls fall on 2 to 5 November there.
  assert.deepEqual([...new Set(first.body.rows.map((row: any) => row.day))], ["2026-11-05", "2026-11-04"]);
  assert.equal(first.body.rows.length, 40);
  assert.equal(first.body.next, "2026-11-04");
  assert.deepEqual(first.body.counts, { all: 80, waiting: 0, overridden: 0, questions: 0, prs: 0 });
  assert.deepEqual(first.body.rows[0].trail.map((step: any) => step.text), ["Judged: go · claude-opus-5-5, low"]);
  const second = await api.call("GET", `/api/log?tz=Asia/Kolkata&before=${first.body.next}`);
  assert.deepEqual([...new Set(second.body.rows.map((row: any) => row.day))], ["2026-11-03", "2026-11-02"]);
  assert.equal(second.body.next, null);
  assert.equal((await api.call("GET", "/api/log?filter=sideways")).status, 400);
  assert.equal((await api.call("GET", "/api/log?before=yesterday")).status, 400);
});

test("check now runs a pass for the repo, and the backlog asks entail to judge the issues open on GitHub", async (t) => {
  const api = await serve(t);
  assert.equal((await api.call("POST", "/api/repos/acme/tally/check", {})).status, 404);
  await api.call("POST", "/api/repos", { repo: "acme/tally" });
  aCall(api.dataDirectory, true, { issue: { number: 5, title: "Five", url: "u", author: "a" } });
  const checked = await api.call("POST", "/api/repos/acme/tally/check", {});
  assert.deepEqual(checked.body, { repo: "acme/tally", at: "2026-11-12T12:00:00.000Z", judged: 2, posted: 1, failed: false });

  const backlog = await api.call("POST", "/api/repos/acme/tally/backlog", {});
  assert.equal(backlog.status, 200);
  assert.deepEqual(backlog.body.issues, [3, 8], "an issue entail already called on is not judged again");
  assert.equal((await api.call("GET", "/api/repos")).body.repos[0].backlogAsked, true);

  const noLoop = await serve(t, { loop: undefined });
  await noLoop.call("POST", "/api/repos", { repo: "acme/tally" });
  assert.match((await noLoop.call("POST", "/api/repos/acme/tally/check", {})).body.error, /entail is not watching/u);
  assert.equal((await noLoop.call("GET", "/api/status")).body.watching, false);
});

test("the settings for every repo are read and changed, the notice and start commands only read", async (t) => {
  const api = await serve(t);
  assert.deepEqual((await api.call("GET", "/api/settings")).body, { owner: null, model: "claude-opus-5-5", effort: "low", notice: null, start: null });
  const changed = await api.call("PATCH", "/api/settings", { owner: "Omkar", effort: "medium" });
  assert.deepEqual(changed.body, { owner: "Omkar", model: "claude-opus-5-5", effort: "medium", notice: null, start: null });
  assert.deepEqual(readSettings(api.dataDirectory, { model: "x" }), { owner: "Omkar", model: "claude-opus-5-5", effort: "medium", notice: null, start: null });
  assert.equal((await api.call("PATCH", "/api/settings", { owner: "two\nlines" })).status, 400);
  const refused = await api.call("PATCH", "/api/settings", { owner: "Other", notice: "touch /tmp/x" });
  assert.equal(refused.status, 400);
  assert.match(String(refused.body.error), /entail settings --notice/u);
  const noStart = await api.call("PATCH", "/api/settings", { start: "touch /tmp/x" });
  assert.equal(noStart.status, 400);
  assert.match(String(noStart.body.error), /entail settings --start/u);
  assert.deepEqual(readSettings(api.dataDirectory, { model: "x" }), { owner: "Omkar", model: "claude-opus-5-5", effort: "medium", notice: null, start: null });
});

test("the board hears every change live, over server-sent events", async (t) => {
  const events = new EventBus();
  const api = await serve(t, { events });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${api.base}/api/events`, { signal: controller.signal });
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const received: BoardEvent[] = [];
  const next = async (): Promise<BoardEvent> => {
    let buffer = "";
    for (;;) {
      const match = /data: (.*)\n\n/u.exec(buffer);
      if (match) return JSON.parse(match[1]!) as BoardEvent;
      const { value } = await reader.read();
      buffer += decoder.decode(value);
    }
  };
  await api.call("POST", "/api/repos", { repo: "acme/tally" });
  received.push(await next());
  events.emit({ type: "checked", repo: "acme/tally", at: "t", judged: 1, posted: 0, failed: false });
  received.push(await next());
  assert.deepEqual(received.map((event) => event.type), ["changed", "checked"]);
});

test("the built board is served at /, with a policy that runs only its own scripts, and nothing outside it", async (t) => {
  const board = mkdtempSync(join(tmpdir(), "entail-board-"));
  t.after(() => rmSync(board, { recursive: true, force: true }));
  mkdirSync(join(board, "assets"));
  writeFileSync(join(board, "index.html"), "<!doctype html><title>entail</title>");
  writeFileSync(join(board, "assets", "index-abc.js"), "console.log(1)");
  const api = await serve(t, { board });
  const page = await api.call("GET", "/");
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(page.headers.get("content-security-policy")!, /script-src 'self'/u);
  const script = await api.call("GET", "/assets/index-abc.js");
  assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.match(script.headers.get("cache-control")!, /immutable/u);
  assert.equal((await api.call("GET", "/assets/%2e%2e/%2e%2e/etc/passwd")).status, 404);
  assert.equal((await api.call("GET", "/nothing.js")).status, 404);

  const unbuilt = await serve(t, { board: null });
  const missing = await unbuilt.call("GET", "/");
  assert.equal(missing.status, 503);
  assert.match(String(missing.body), /board is not built/u);
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
  for (const path of ["/api/waiting", "/"]) {
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({ host: "127.0.0.1", port, path, headers: { Host: `evil.example:${port}` } }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal(status, 403);
  }
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
  // Held for the undo window, as an issue's call is: nothing is written to the case book yet.
  assert.equal(typeof overridden.body.holdUntil, "string");
  assert.equal(existsSync(join(api.dataDirectory, OWNER_CASE_BOOK)), false);

  const log = await api.call("GET", "/api/log?filter=prs");
  const row = log.body.rows.find((r: { call: { kind: string } }) => r.call.kind === "pr");
  assert.equal(row.call.pr.number, 14);
  assert.equal(row.call.status, "overridden");
  assert.equal(log.body.counts.prs, 1);
  assert.ok(row.trail.some((step: { text: string }) => /Omkar overrode: send-back/u.test(step.text)));
});

test("an action on a PR's call is held, shown as held, and undone like an issue's", async (t) => {
  const api = await serve(t);
  const issueCall = aCall(api.dataDirectory, true);
  appendEntry(api.dataDirectory, "acme/tally", { type: "enrolled", by: "Omkar", since: "2026-11-12T09:00:00.000Z", confirm: true });
  const landing = aLanding(api.dataDirectory, issueCall.id, "merge");
  const confirmed = await api.call("POST", `/api/calls/${landing.id}/confirm`, {});
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.holdUntil, "2026-11-12T12:00:10.000Z");
  assert.deepEqual(api.scheduled, ["2026-11-12T12:00:10.000Z"], "the loop is told when the window closes");

  const during = (await api.call("GET", "/api/waiting")).body;
  assert.equal(during.held.length, 1);
  assert.equal(during.held[0].item.kind, "pr");
  assert.equal(during.held[0].item.id, landing.id);
  assert.equal(during.items.some((i: { kind: string }) => i.kind === "pr"), false);

  const undone = await api.call("POST", `/api/calls/${landing.id}/undo`, {});
  assert.equal(undone.status, 200);
  assert.equal(undone.body.call.status, "waiting");
  const after = (await api.call("GET", "/api/waiting")).body;
  assert.equal(after.held.length, 0);
  assert.equal(after.items.find((i: { kind: string }) => i.kind === "pr").id, landing.id);

  // An undo after the window closed is refused: entail is acting on it.
  assert.equal((await api.call("POST", `/api/calls/${landing.id}/confirm`, {})).status, 200);
  api.advance(10_000);
  assert.equal((await api.call("POST", `/api/calls/${landing.id}/undo`, {})).status, 409);
  // A go made differently is for an issue's go only.
  assert.equal((await api.call("POST", `/api/calls/${landing.id}/override`, { call: "send-back", reason: "x", differently: true })).status, 409);
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
