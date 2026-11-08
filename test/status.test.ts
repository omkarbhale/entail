import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { HealthCondition, StatusFile } from "../src/health.ts";
import { STATUS_FILE } from "../src/health.ts";
import { checkHostLogin } from "../src/host-login.ts";
import { LOCK_FILE } from "../src/lock.ts";
import { OPERATIONAL_LOG_FILE } from "../src/operational-log.ts";
import { healthStripHtml, renderPage } from "../src/page.ts";
import { RECORDS_PUSH_FILE } from "../src/records-repo.ts";
import type { PageRequest } from "../src/server.ts";
import { readStatus, statusText } from "../src/status.ts";
import { checkTools, loggedIn } from "../src/tool-check.ts";
import { ForgeLoggedOutError, type Actor } from "../src/forge/forge.ts";
import { tempDirectory } from "./git-fixture.ts";
import { actor, IntakeForge, OWNER_ID } from "./pass-fixture.ts";
import type { RepoRecord } from "../src/store.ts";

const HALT: HealthCondition = {
  key: "host:gitlab:gitlab.example.com:unanswered",
  kind: "halt",
  scope: { kind: "host", forge: "gitlab", host: "gitlab.example.com" },
  wrong: "gitlab.example.com is not answering",
  stops: "2 repos are not being read",
  clears: "entail retries every 15 minutes and carries on once a poll succeeds",
  since: "2026-11-09T09:40:00.000Z",
  notify: true,
};

function statusFile(conditions: HealthCondition[]): StatusFile {
  return {
    version: 1,
    pid: 4242,
    startedAt: "2026-11-09T09:00:00.000Z",
    writtenAt: "2026-11-09T10:00:00.000Z",
    lastPass: "2026-11-09T09:59:30.000Z",
    conditions,
    standing: ["Records repo: no remote set. Records stay on this machine only."],
    repos: [{ id: 1, forge: "gitlab", host: "gitlab.example.com", path: "acme/tally", state: "halted: gitlab.example.com is not answering", lastSuccessfulPoll: "2026-11-09T09:39:00.000Z" }],
    unexpectedStops: [],
    keepsStoppingNoticeAt: null,
  };
}

function dataDirectory(t: TestContext, options: { lock?: boolean; status?: StatusFile } = {}): string {
  const dir = tempDirectory(t, "status");
  if (options.lock) writeFileSync(join(dir, LOCK_FILE), `${JSON.stringify({ pid: 4242, startedAt: "2026-11-09T09:00:00.000Z" })}\n`);
  if (options.status) writeFileSync(join(dir, STATUS_FILE), JSON.stringify(options.status));
  return dir;
}

test("entail status exits 2 when entail is not running, whatever the status file says", (t) => {
  const none = readStatus(dataDirectory(t), { isAlive: () => true });
  assert.deepEqual([none.running, none.exitCode, none.stoppedUnexpectedly], [false, 2, false]);

  const left = readStatus(dataDirectory(t, { lock: true, status: statusFile([HALT]) }), { isAlive: () => false });
  assert.deepEqual([left.running, left.exitCode, left.stoppedUnexpectedly, left.pid], [false, 2, true, 4242]);
  assert.equal(left.halts.length, 1, "the last known halts are still shown");
  assert.match(statusText(left), /^entail is not running\. It stopped unexpectedly: pid 4242, started 2026-11-09 09:00 UTC, left its lock behind\.\nWhat follows is as of 2026-11-09 10:00 UTC/);
});

test("entail status exits 0 while running healthy and 1 while halted or warned", (t) => {
  const healthy = readStatus(dataDirectory(t, { lock: true, status: statusFile([]) }), { isAlive: () => true });
  assert.deepEqual([healthy.running, healthy.exitCode], [true, 0]);
  assert.match(statusText(healthy), /No halts or warnings\.\nRecords repo: no remote set\./);

  const halted = readStatus(dataDirectory(t, { lock: true, status: statusFile([HALT]) }), { isAlive: () => true });
  assert.equal(halted.exitCode, 1);
  const warned = readStatus(dataDirectory(t, { lock: true, status: statusFile([{ ...HALT, key: "notices:failed", kind: "warning" }]) }), { isAlive: () => true });
  assert.deepEqual([warned.exitCode, warned.halts.length, warned.warnings.length], [1, 0, 1]);
});

test("entail status prints the running state, last pass, halts with onset, repos, records push and recent warnings, and no tickets", (t) => {
  const dir = dataDirectory(t, { lock: true, status: statusFile([HALT]) });
  writeFileSync(join(dir, RECORDS_PUSH_FILE), JSON.stringify({ lastSuccess: { at: "2026-11-09T08:00:00.000Z", remote: "git@example.org:r.git", commit: "abc" }, lastFailure: null }));
  appendFileSync(join(dir, OPERATIONAL_LOG_FILE), [
    JSON.stringify({ time: "2026-11-09T09:41:00.000Z", level: "info", event: "poll", repoId: 1 }),
    JSON.stringify({ time: "2026-11-09T09:42:00.000Z", level: "warn", event: "poll-failed", repoId: 1 }),
    JSON.stringify({ time: "2026-11-09T09:43:00.000Z", level: "error", event: "host-logged-out", host: "gitlab.example.com" }),
    "",
  ].join("\n"));
  const report = readStatus(dir, { isAlive: () => true });
  assert.deepEqual(report.recentWarnings.map((entry) => entry.event), ["poll-failed", "host-logged-out"]);
  assert.equal(statusText(report), `entail is running: pid 4242, started 2026-11-09 09:00 UTC.
Last pass: 2026-11-09 09:59 UTC.

Halted:
  - gitlab.example.com is not answering. 2 repos are not being read since 2026-11-09 09:40 UTC. entail retries every 15 minutes and carries on once a poll succeeds.
Records repo: no remote set. Records stay on this machine only.

Repos:
  - acme/tally on gitlab.example.com: halted: gitlab.example.com is not answering; last successful poll 2026-11-09 09:39 UTC.
Records repo: last push succeeded 2026-11-09 08:00 UTC, to git@example.org:r.git.

Recent warnings in the operational log:
  2026-11-09T09:42:00.000Z warn poll-failed {"repoId":1}
  2026-11-09T09:43:00.000Z error host-logged-out {"host":"gitlab.example.com"}
`);
  const json = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
  assert.ok(!("tickets" in json), "status lists no tickets");
});

test("the strip shows one line per condition: what is wrong, what it stops, since when, what clears it", () => {
  const html = healthStripHtml([HALT]);
  assert.match(html, /<section class="health-strip" role="status"/);
  assert.match(
    html,
    /<li data-kind="halt" data-key="host:gitlab:gitlab\.example\.com:unanswered"><strong>Halted: gitlab\.example\.com is not answering\.<\/strong> 2 repos are not being read since <time datetime="2026-11-09T09:40:00\.000Z">2026-11-09 09:40 UTC<\/time>\. entail retries every 15 minutes and carries on once a poll succeeds\.<\/li>/,
  );
  assert.equal(healthStripHtml([]), "");
  const request = (health: StatusFile["conditions"]): PageRequest => ({
    url: new URL("http://127.0.0.1:7419/calls"),
    server: { port: 7419, origin: "http://127.0.0.1:7419", token: "t", nav: [], health: () => ({ strip: health, lastPass: "2026-11-09T09:59:30.000Z" }) },
  });
  assert.match(renderPage(request([HALT]), { title: "Calls", body: "" }), /<section class="health-strip"/);
  const healthy = renderPage(request([]), { title: "Calls", body: "" });
  assert.doesNotMatch(healthy, /<section class="health-strip"/);
  assert.match(healthy, /Last pass <time datetime="2026-11-09T09:59:30\.000Z">/);
});

test("the tool check finds git and claude present and claude logged in, or says what is wrong", async (t) => {
  assert.equal(loggedIn('{"loggedIn": true, "authMethod": "claude.ai"}'), true);
  assert.equal(loggedIn('{"loggedIn": false}'), false);
  assert.equal(loggedIn("not json"), false);

  const bin = join(tempDirectory(t, "tools"), "bin");
  mkdirSync(bin);
  const path = process.env.PATH;
  process.env.PATH = bin;
  try {
    assert.deepEqual(
      (await checkTools()).map((p) => [p.tool, p.problem, p.detail]),
      [
        ["git", "missing", "git is not installed or not on the PATH"],
        ["claude", "missing", "claude is not installed or not on the PATH"],
      ],
    );
    const script = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    script("git", "echo git version 2.53.0");
    script("claude", `echo '{"loggedIn": false}'; exit 1`);
    assert.deepEqual((await checkTools()).map((p) => [p.tool, p.problem]), [["claude", "logged-out"]]);
    script("claude", `echo '{"loggedIn": true}'`);
    assert.deepEqual(await checkTools(), []);
  } finally {
    // Restored before the test's own clean-up, which runs programs from the PATH.
    process.env.PATH = path;
  }
});

test("a host's login is checked against the account its repos were enrolled with, by id", async () => {
  const repo = { id: 1, forge: "github", host: "github.com", projectId: 5001, path: "acme/tally", ownerAccountId: OWNER_ID, ownerLogin: "owner", enrolledAt: "" } satisfies RepoRecord;
  const forge = new (class extends IntakeForge {
    login: Actor | null | Error = actor(OWNER_ID);
    override async currentActor(): Promise<Actor | null> {
      if (this.login instanceof Error) throw this.login;
      return this.login;
    }
  })();
  assert.deepEqual(await checkHostLogin(forge, [repo]), { status: "ok" });
  forge.login = { ...actor(OWNER_ID), username: "renamed" };
  assert.deepEqual(await checkHostLogin(forge, [repo]), { status: "ok" }, "a renamed account keeps its id");
  forge.login = null;
  assert.deepEqual(await checkHostLogin(forge, [repo]), { status: "halted", problem: "logged-out", detail: "gh is not logged in to github.com" });
  forge.login = new ForgeLoggedOutError("github.com", "no token");
  assert.equal((await checkHostLogin(forge, [repo])).status, "halted");
  forge.login = actor(2002, "mallory");
  assert.deepEqual(await checkHostLogin(forge, [repo]), {
    status: "halted",
    problem: "other-account",
    detail: "gh is logged in to github.com as mallory, not owner, the account acme/tally was enrolled with",
  });
  forge.login = new Error("connect ECONNREFUSED");
  assert.deepEqual(await checkHostLogin(forge, [repo]), { status: "unknown", error: "connect ECONNREFUSED" });
});
