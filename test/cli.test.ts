import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main, parseIssueReference } from "../src/cli.ts";
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
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  const out: string[] = [];
  t.mock.method(console, "log", (message: string) => out.push(message));
  t.mock.method(console, "error", (message: string) => out.push(`error: ${message}`));
  const dataDirectory = join(home, "entail");

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
  assert.match(out.pop()!, /acme\/tally#12: your confirmation is recorded under Omkar and written to the case book/u);
  assert.equal(await main(["confirm", "acme/tally#12"]), 1);
  assert.match(out.pop()!, /not waiting to be confirmed \(confirmed\)/u);
  assert.equal(await main(["confirm", "acme/tally#13"]), 1);
  assert.match(out.pop()!, /entail has made no call on acme\/tally#13/u);

  assert.equal(await main(["calls", "acme/tally"]), 0);
  const log = out.pop()!;
  assert.match(log, /#12 {2}NO by entail: Count words in footnotes\n {6}Footnotes are not prose\.\n {6}confirmed by Omkar/u);
  assert.match(log, /#12 {2}CONFIRMED by Omkar/u);
  assert.match(log, /acme\/tally  Omkar set confirm mode off\n/u, "the model was already the default, so only confirm mode changed");
  assert.ok(existsSync(join(dataDirectory, "cases", "acme-tally-12", "call.md")));
});
