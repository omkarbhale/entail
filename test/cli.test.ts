import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createApi } from "../src/api.ts";
import { main, parseIssueReference } from "../src/cli.ts";
import { resolveDataDirectory } from "../src/data-directory.ts";
import { LOCK_FILE } from "../src/lock.ts";
import { appendEntry } from "../src/records.ts";

test("an issue reference is owner/repo#number", () => {
  assert.deepEqual(parseIssueReference("omkarbhale/entail#179"), { path: "omkarbhale/entail", number: 179 });
  for (const bad of ["omkarbhale/entail", "entail#3", "a/b#0", "a/b#x", "https://github.com/a/b/issues/3"]) {
    assert.throws(() => parseIssueReference(bad), /not an issue reference/u, bad);
  }
});

test("a usage error exits 2 without reaching a forge or a model", async (t) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (message: string) => errors.push(message));
  t.mock.method(console, "log", () => {});
  assert.equal(await main(["judge"]), 2);
  assert.equal(await main(["judge", "a/b#1", "--effort", "huge"]), 2);
  assert.equal(await main(["replay", "--concurrency", "0"]), 2);
  assert.equal(await main(["replay", "extra"]), 2);
  assert.equal(await main(["frobnicate"]), 2);
  assert.equal(await main([]), 2);
  assert.equal(await main(["--help"]), 0);
  assert.match(errors[1]!, /--effort must be one of low, medium, high, xhigh, max/u);
});

test("the owner's commands check their arguments before touching anything", async (t) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (message: string) => errors.push(message));
  t.mock.method(console, "log", () => {});
  assert.equal(await main(["enroll"]), 2);
  assert.equal(await main(["enroll", "not-a-repo"]), 2);
  assert.equal(await main(["enroll", "a/b", "--since", "someday"]), 2);
  assert.equal(await main(["run", "--interval", "1"]), 2);
  assert.equal(await main(["run", "--port", "70000"]), 2);
  assert.equal(await main(["override", "a/b#1", "no"]), 2);
  assert.equal(await main(["answer", "a/b#1"]), 2);
  assert.equal(await main(["confirm", "a/b"]), 2);
  assert.match(errors[0]!, /enroll takes one repo/u);
  assert.match(errors[3]!, /--interval is a number of seconds/u);
});

test("from the command line the owner sets their name, reads what waits, confirms it and reads the log", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "entail-cli-"));
  const previous = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, HOME: process.env.HOME };
  process.env.XDG_DATA_HOME = home;
  process.env.HOME = home;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });
  const out: string[] = [];
  t.mock.method(console, "log", (message: string) => out.push(message));
  t.mock.method(console, "error", (message: string) => out.push(`error: ${message}`));
  const dataDirectory = resolveDataDirectory({ platform: process.platform, env: process.env, home });

  assert.equal(await main(["settings", "--owner", "Omkar", "--effort", "medium"]), 0);
  assert.match(out.pop()!, /your name on comments: Omkar\ndefault model: claude-opus-5-5\ndefault effort: medium/u);
  appendEntry(dataDirectory, "acme/tally", { type: "enrolled", by: "Omkar", since: "2026-11-12T09:00:00.000Z", confirm: true });
  appendEntry(dataDirectory, "acme/tally", {
    type: "call",
    issue: { number: 12, title: "Count words in footnotes", url: "https://github.com/acme/tally/issues/12", author: "reporter" },
    trigger: "new",
    mentions: [],
    content: "h",
    issueText: "# Count words in footnotes\n",
    vision: null,
    sha: "c".repeat(40),
    call: { call: "no", reason: "Footnotes are not prose.", restsOn: { visionLines: [], cases: [] } },
    confirm: true,
    owner: null,
    model: "claude-opus-5-5",
    effort: "medium",
    promptVersion: "issue-call-2",
    costUsd: null,
  });

  assert.equal(await main(["settings", "acme/tally", "--confirm", "off", "--model", "default"]), 0);
  assert.equal(out.pop(), "acme/tally: confirm mode off, model claude-opus-5-5 (default), effort medium (default)");
  assert.equal(await main(["repos"]), 0);
  assert.match(out.pop()!, /^acme\/tally: confirm mode off, claude-opus-5-5 \(default\) at medium effort \(default\); 1 calls, 1 waiting on you$/u);

  assert.equal(await main(["waiting"]), 0);
  assert.match(out.pop()!, /acme\/tally#12: Count words in footnotes\n.*\n {2}NO, to confirm \(call \d+\): Footnotes are not prose\./u);
  assert.equal(await main(["confirm", "acme/tally#12"]), 0);
  assert.match(out.pop()!, /acme\/tally#12: your confirmation is recorded under Omkar; entail writes it to the case book and acts on the issue on its next pass/u);
  assert.equal(await main(["confirm", "acme/tally#12"]), 1);
  assert.match(out.pop()!, /not waiting to be confirmed \(confirmed\)/u);
  assert.equal(await main(["confirm", "acme/tally#13"]), 1);
  assert.match(out.pop()!, /entail has made no call on acme\/tally#13/u);

  assert.equal(await main(["calls", "acme/tally"]), 0);
  const log = out.pop()!;
  assert.match(log, /#12 {2}NO by entail: Count words in footnotes\n {6}Footnotes are not prose\.\n {6}confirmed by Omkar/u);
  assert.match(log, /#12 {2}CONFIRMED by Omkar/u);
  assert.match(log, /acme\/tally  Omkar set confirm mode off\n/u, "the model was already the default, so only confirm mode changed");
  assert.ok(!existsSync(join(dataDirectory, "cases", "acme-tally-12", "call.md")), "the case is written when entail acts on the confirmation");
});

/** A scratch home and data directory for one test, with what the CLI prints. */
function scratchHome(t: TestContext): { dataDirectory: string; out: string[] } {
  const home = mkdtempSync(join(tmpdir(), "entail-cli-"));
  const previous = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, HOME: process.env.HOME };
  process.env.XDG_DATA_HOME = join(home, "data");
  process.env.XDG_CONFIG_HOME = join(home, "config");
  process.env.HOME = home;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });
  const out: string[] = [];
  t.mock.method(console, "log", (message: string) => out.push(message));
  t.mock.method(console, "error", (message: string) => out.push(`error: ${message}`));
  return { dataDirectory: resolveDataDirectory({ platform: process.platform, env: process.env, home }), out };
}

test("the start command is set and cleared from the command line, for every repo only", async (t) => {
  const { out } = scratchHome(t);
  assert.equal(await main(["settings", "--start", "examples/start-to-file.sh"]), 0);
  assert.match(out.pop()!, /\nstart work with: examples\/start-to-file\.sh$/u);
  assert.equal(await main(["settings"]), 0);
  assert.match(out.pop()!, /\nnotices: none\nstart work with: examples\/start-to-file\.sh$/u);
  assert.equal(await main(["settings", "--start", "none"]), 0);
  assert.match(out.pop()!, /\nstart work with: none$/u);
  assert.equal(await main(["settings", "acme/tally", "--start", "x"]), 2);
  assert.match(out.pop()!, /--owner, --notice and --start are settings for every repo/u);
});

test("status says entail is not running, lists each enrolled repo with its confirm mode, and what waits", async (t) => {
  const { dataDirectory, out } = scratchHome(t);
  appendEntry(dataDirectory, "acme/tally", { type: "enrolled", by: "Omkar", since: "2026-11-12T09:00:00.000Z", confirm: true });
  appendEntry(dataDirectory, "acme/wordy", { type: "enrolled", by: "Omkar", since: "2026-11-12T09:00:00.000Z", confirm: false });
  appendEntry(dataDirectory, "acme/tally", {
    type: "call",
    issue: { number: 12, title: "Count words in footnotes", url: "https://github.com/acme/tally/issues/12", author: "reporter" },
    trigger: "new",
    mentions: [],
    content: "h",
    issueText: "# Count words in footnotes\n",
    vision: null,
    sha: "c".repeat(40),
    call: { call: "ask", reason: "Two readings.", restsOn: { visionLines: [], cases: [] }, question: "Which?", why: "Counts differ.", large: false, criteria: [] },
    confirm: true,
    owner: null,
    model: "claude-opus-5-5",
    effort: "low",
    promptVersion: "issue-call-2",
    costUsd: null,
  });
  assert.equal(await main(["status", "--port", "4999"]), 0);
  const screen = out.join("\n");
  assert.match(screen, /^entail is not running\. Start it with: entail service install \(or entail run\)\.\nThe board is at http:\/\/127\.0\.0\.1:4999\/ while it runs\./u);
  assert.match(screen, /\nacme\/tally {2}confirm on {3}not checked: entail is not running {2}1 waiting\n/u);
  assert.match(screen, /\nacme\/wordy {2}confirm off {2}not checked: entail is not running {2}0 waiting\n/u);
  assert.match(screen, /\nWaiting on you: 1 question\.\nNotices: none\. Start work with: none\.$/u);
});

test("status reads when each repo was last checked from the running copy's board", async (t) => {
  const { dataDirectory, out } = scratchHome(t);
  appendEntry(dataDirectory, "acme/tally", { type: "enrolled", by: "Omkar", since: "2026-11-12T09:00:00.000Z", confirm: true });
  writeFileSync(join(dataDirectory, LOCK_FILE), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const checked = new Date(Date.now() - 120_000).toISOString();
  const server = createApi({
    dataDirectory,
    owner: async () => "Omkar",
    defaultModel: "claude-opus-5-5",
    book: async () => [],
    board: null,
    loop: { check: async () => ({ repo: "", at: "", judged: 0, posted: 0, failed: false }), schedule: () => {}, wake: () => {}, checkedAt: () => checked, lastPassAt: checked, checking: false },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const port = (server.address() as AddressInfo).port;
  assert.equal(await main(["status", "--port", String(port)]), 0);
  const screen = out.join("\n");
  assert.match(screen, /^entail is running by hand \(pid \d+, since /u);
  assert.match(screen, new RegExp(`\\nThe board: http://127\\.0\\.0\\.1:${port}/\\n`, "u"));
  assert.match(screen, /\nacme\/tally {2}confirm on {3}checked 2 min ago {2}0 waiting\n/u);
  assert.match(screen, /\nNothing waits on you\.\n/u);
});

test("open refuses when entail is not running, since there is no board to open", async (t) => {
  const { out } = scratchHome(t);
  assert.equal(await main(["open", "--port", "4999"]), 1);
  assert.match(out.pop()!, /entail is not running, so the board at http:\/\/127\.0\.0\.1:4999\/ is not there\. Start it with: entail service install/u);
});
