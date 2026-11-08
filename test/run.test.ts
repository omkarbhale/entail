import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { DEFAULT_GLOBAL_SETTINGS, type GlobalSettings } from "../src/global-settings.ts";
import { LOCK_FILE } from "../src/lock.ts";
import { makeNotice, NOTICES_FILE } from "../src/notice.ts";
import { OPERATIONAL_LOG_FILE } from "../src/operational-log.ts";
import { startRun, type RunningEntail } from "../src/run.ts";
import { BoardPortTakenError } from "../src/server.ts";
import { CALLS_PATH } from "../src/calls-page.ts";
import { SETTINGS_PATH } from "../src/settings-page.ts";
import { Store } from "../src/store.ts";
import { readRecordsPushState, RECORDS_BRANCH, RECORDS_DIRECTORY } from "../src/records-repo.ts";
import { git, tempDirectory } from "./git-fixture.ts";
import { enrollmentSettings } from "../src/repo-settings.ts";
import { freePort, send } from "./http-client.ts";
import { actor, IntakeForge, issue, issueComment, OWNER_ID, STILL_HEAD } from "./pass-fixture.ts";
import { hiddenMarker } from "../src/comment-rules.ts";

const running = new WeakMap<TestContext, RunningEntail[]>();

/** `git` and `claude` found present and logged in, so these tests never depend on the machine's own. */
const NO_TOOL_PROBLEMS = async () => [];

/** A data directory removed after the test, once every entail started in it has stopped. */
function dataDirectory(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "entail-run-"));
  const started: RunningEntail[] = [];
  running.set(t, started);
  t.after(async () => {
    for (const run of started) {
      run.stop("test over");
      await run.stopped;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function saveSettings(dir: string, changes: Partial<GlobalSettings>): void {
  const store = Store.openIn(dir);
  // Notices go to a file, so a halt never shows on this machine's desktop.
  store.saveGlobalSettings({ ...DEFAULT_GLOBAL_SETTINGS, ownerDisplayName: "Ada", noticeConnector: "file", ...changes }, "Ada");
  store.close();
}

async function start(t: TestContext, dir: string): Promise<RunningEntail> {
  const run = await startRun({ dataDirectory: dir, log: { echo: null }, toolCheck: NO_TOOL_PROBLEMS });
  running.get(t)!.push(run);
  return run;
}

test("entail run serves the global settings page on the board port from the settings", async (t) => {
  const dir = dataDirectory(t);
  const port = await freePort();
  saveSettings(dir, { boardPort: port });
  const entail = await start(t, dir);

  assert.equal(entail.server.info.port, port);
  assert.equal(entail.server.info.origin, `http://127.0.0.1:${port}`);
  const page = await send(port, { path: SETTINGS_PATH });
  assert.equal(page.status, 200);
  assert.match(page.body, /Global settings/);
  const started = readFileSync(join(dir, OPERATIONAL_LOG_FILE), "utf8").split("\n").find((line) => line.includes('"started"'));
  assert.ok(started?.includes(`"board":"http://127.0.0.1:${port}/"`), "the start names the board's address");
  const calls = await send(port, { path: CALLS_PATH });
  assert.equal(calls.status, 200, "the same process serves the Calls page");
  assert.match(calls.body, /No call has been recorded yet\./);
});

test("settings are re-read on every read, except the port, which takes effect on the next start", async (t) => {
  const dir = dataDirectory(t);
  const [first, second] = [await freePort(), await freePort()];
  saveSettings(dir, { boardPort: first });
  const entail = await start(t, dir);

  entail.store.saveGlobalSettings({ ...DEFAULT_GLOBAL_SETTINGS, ownerDisplayName: "Ada", model: "claude-sonnet-5-5", modelRunLimit: 4, boardPort: second }, "Ada");
  assert.equal(entail.globalSettings().model, "claude-sonnet-5-5", "a saved model is in force at once");
  assert.equal(entail.globalSettings().modelRunLimit, 4);
  assert.equal(entail.globalSettings().boardPort, second);
  assert.equal(entail.server.info.port, first, "the running server keeps its port");
  assert.equal((await send(first, { path: SETTINGS_PATH })).status, 200);

  entail.stop("restart");
  await entail.stopped;
  const restarted = await start(t, dir);
  assert.equal(restarted.server.info.port, second, "the saved port is used from the next start");
  assert.equal((await send(second, { path: SETTINGS_PATH })).status, 200);
});

test("entail run fails with a clear message and releases the lock when the board port is taken", async (t) => {
  const dir = dataDirectory(t);
  const other = createServer();
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  t.after(() => other.close());
  const { port } = other.address() as { port: number };
  saveSettings(dir, { boardPort: port });

  await assert.rejects(startRun({ dataDirectory: dir, log: { echo: null }, toolCheck: NO_TOOL_PROBLEMS }), (error: unknown) => {
    assert.ok(error instanceof BoardPortTakenError);
    assert.match(error.message, new RegExp(`board port ${port} on 127\\.0\\.0\\.1 is already in use`));
    return true;
  });
  assert.ok(!existsSync(join(dir, LOCK_FILE)), "the lock is released");
  assert.match(readFileSync(join(dir, OPERATIONAL_LOG_FILE), "utf8"), /"event":"board-server-failed"/);
  // The store was closed, so it opens again.
  Store.openIn(dir).close();
});

test("entail run sends notices through the connector the global settings name", async (t) => {
  const dir = dataDirectory(t);
  saveSettings(dir, { boardPort: await freePort(), noticeConnector: "file" });
  const entail = await start(t, dir);

  const sent = await entail.notifier.notify(
    makeNotice({ kind: "health", text: "entail keeps stopping.", link: `${entail.server.info.origin}/repos` }),
  );
  assert.equal(sent, true);
  const notices = readFileSync(join(dir, NOTICES_FILE), "utf8").split("\n").filter((line) => line !== "");
  assert.equal(notices.length, 1);
  assert.equal(JSON.parse(notices[0]!).text, "entail keeps stopping.");
});

function logEvents(dir: string): string[] {
  return readFileSync(join(dir, OPERATIONAL_LOG_FILE), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => (JSON.parse(line) as { event: string }).event);
}

async function until(condition: () => boolean): Promise<void> {
  for (let n = 0; n < 200 && !condition(); n++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(condition(), "the condition was met in time");
}

test("entail starts in spec order: lock, store, the records check, settle intents, the server, then the passes", async (t) => {
  const dir = dataDirectory(t);
  saveSettings(dir, { boardPort: await freePort() });
  const store = Store.openIn(dir);
  const { repo } = store.enroll({
    repo: { forge: "github", host: "github.com", projectId: 5001, path: "acme/tally", ownerAccountId: 1001, ownerLogin: "owner" },
    settings: enrollmentSettings("owner-stated", "squash"),
    savedBy: "Ada",
    visionSha: "c0ffee",
    visionLines: ["Tally counts words in text."],
    visionOrigin: "owner-stated",
    openIssueNumbers: [],
  });
  // A label left unconfirmed by the last run.
  const ticket = store.takeIn({ repoId: repo.id, issueNumber: 3 });
  store.recordForgeWriteIntent({ repoId: repo.id, ticketId: ticket.id, kind: "label", target: "issue", number: 3, payload: { action: "add", label: "entail:cleared" } });
  store.close();

  const forge = new IntakeForge();
  forge.issues = [issue(5, { createdAt: new Date(Date.now() + 60_000).toISOString() })];
  const entail = await startRun({
    dataDirectory: dir,
    log: { echo: null },
    toolCheck: NO_TOOL_PROBLEMS,
    // No owed steps: this test is about start order, not deciding the tickets it takes in.
    passes: { forgeFor: () => forge, defaultBranchFor: async () => STILL_HEAD, planners: [] },
  });
  running.get(t)!.push(entail);
  await until(() => logEvents(dir).includes("poll"));

  const events = logEvents(dir);
  const at = (event: string) => events.indexOf(event);
  assert.ok(at("records-check-clear") >= 0 && at("records-check-clear") < at("intent-settled"), "the records check runs before intents are settled");
  assert.ok(at("intent-settled") >= 0 && at("intent-settled") < at("intents-settled"));
  assert.ok(at("intents-settled") < at("started"), "intents are settled before the server starts");
  assert.ok(at("started") < at("poll"), "the passes start after the server");
  assert.deepEqual(entail.store.unconfirmedForgeWrites(), []);
  assert.deepEqual(forge.state.labels[3], ["entail:cleared"], "the label was applied again");
  assert.ok(entail.store.latestTicketForIssue(repo.id, 5), "the pass took the owner's new issue in");
});

test("a repo whose issues carry the marker with no records gets no forge read or write at start beyond the check", async (t) => {
  const dir = dataDirectory(t);
  saveSettings(dir, { boardPort: await freePort() });
  const store = Store.openIn(dir);
  const { repo } = store.enroll({
    repo: { forge: "github", host: "github.com", projectId: 5001, path: "acme/tally", ownerAccountId: OWNER_ID, ownerLogin: "owner" },
    settings: enrollmentSettings("owner-stated", "squash"),
    savedBy: "Ada",
    visionSha: "c0ffee",
    visionLines: ["Tally counts words in text."],
    visionOrigin: "owner-stated",
    openIssueNumbers: [],
  });
  // A store restored from an older copy of the records: ticket 1 is here, but
  // entail later took in issue 4 as ticket 2, which this store never saw.
  const ticket = store.takeIn({ repoId: repo.id, issueNumber: 3 });
  store.recordForgeWriteIntent({ repoId: repo.id, ticketId: ticket.id, kind: "label", target: "issue", number: 3, payload: { action: "add", label: "entail:cleared" } });
  store.close();

  const forge = new IntakeForge();
  forge.issues = [issue(4, { createdAt: new Date(Date.now() + 60_000).toISOString() })];
  forge.commentChanges = [
    issueComment(8001, 3, actor(OWNER_ID), `Speaking from Ada's entail:\n\nTaken in.\n\n${hiddenMarker(ticket.id)}`),
    issueComment(8002, 4, actor(OWNER_ID), `Speaking from Ada's entail:\n\nTaken in.\n\n${hiddenMarker(2)}`),
  ];
  const entail = await startRun({
    dataDirectory: dir,
    log: { echo: null },
    toolCheck: NO_TOOL_PROBLEMS,
    passes: { forgeFor: () => forge, defaultBranchFor: async () => STILL_HEAD, planners: [] },
  });
  running.get(t)!.push(entail);

  const events = logEvents(dir);
  assert.ok(events.indexOf("records-missing") >= 0 && events.indexOf("records-missing") < events.indexOf("started"));
  assert.deepEqual(entail.recordsCheck.standing(repo.id).status, "missing");
  const [outcome] = await entail.passes.runPass();
  assert.equal(outcome?.outcome, "waiting-for-records");
  assert.equal(entail.store.unconfirmedForgeWrites().length, 1, "its unconfirmed intent waits too");
  assert.deepEqual(forge.reads, { changes: 1, transferred: 0, comments: 0 }, "the check is the only read");
  assert.deepEqual(forge.state.sends, { comment: 0, addLabel: 0, removeLabel: 0, close: 0, merge: 0 }, "and nothing is written");
  assert.equal(entail.store.latestTicketForIssue(repo.id, 4), null, "nothing is taken in");
});

test("stopping starts no new work, waits for in-flight forge writes up to the limit, then releases the lock", async (t) => {
  const dir = dataDirectory(t);
  saveSettings(dir, { boardPort: await freePort() });
  const entail = await startRun({ dataDirectory: dir, log: { echo: null }, toolCheck: NO_TOOL_PROBLEMS, stopWaitMs: 200 });
  let confirmed = false;
  entail.inFlight.track(new Promise<void>((resolve) => setTimeout(() => {
    confirmed = true;
    resolve();
  }, 50)));
  entail.stop("SIGTERM");
  await entail.stopped;
  assert.ok(confirmed, "the write in flight confirmed before the lock was released");
  assert.ok(!existsSync(join(dir, LOCK_FILE)));
  assert.ok(!logEvents(dir).includes("writes-unconfirmed-at-stop"));

  const again = await startRun({ dataDirectory: dir, log: { echo: null }, toolCheck: NO_TOOL_PROBLEMS, stopWaitMs: 100 });
  again.inFlight.track(new Promise<void>(() => {}));
  again.stop("SIGINT");
  await again.stopped;
  assert.ok(logEvents(dir).includes("writes-unconfirmed-at-stop"), "a write still unconfirmed at the limit is left for the next start");
  assert.ok(!existsSync(join(dir, LOCK_FILE)), "the lock is released after the limit");
  const events = logEvents(dir);
  assert.ok(events.lastIndexOf("stopping") < events.lastIndexOf("stopped"));
});

test("stopping commits the records repo and pushes it to the remote before releasing the lock", async (t) => {
  const dir = dataDirectory(t);
  const remote = join(tempDirectory(t, "remote"), "records.git");
  git(join(remote, ".."), "init", "--quiet", "--bare", `--initial-branch=${RECORDS_BRANCH}`, remote);
  const port = await freePort();
  saveSettings(dir, { boardPort: port, recordsRemote: remote });
  const entail = await start(t, dir);
  entail.store.enrollRepo({ forge: "github", host: "github.com", projectId: 1, path: "acme/tally", ownerAccountId: 1, ownerLogin: "ada" });
  assert.equal(existsSync(join(dir, RECORDS_DIRECTORY)), false, "nothing is committed before an answer, the hour or the stop");

  entail.stop("SIGTERM");
  await entail.stopped;
  const records = join(dir, RECORDS_DIRECTORY);
  assert.equal(git(records, "log", "--format=%s"), "entail records: on stop");
  assert.match(git(records, "show", "HEAD:tables/repos.jsonl"), /"path":"acme\/tally"/, "the commit holds the records as entail stopped");
  assert.equal(git(remote, "rev-parse", RECORDS_BRANCH), git(records, "rev-parse", "HEAD"), "and was pushed");
  assert.ok(readRecordsPushState(dir).lastSuccess !== null);
  const events = logEvents(dir);
  assert.ok(events.indexOf("records-pushed") < events.indexOf("stopped"), "before the lock was released");
});

test("with claude logged out, entail stays up and serves every page with the halt on the strip, reading no forge until a pass finds it fine", async (t) => {
  const dir = dataDirectory(t);
  const port = await freePort();
  saveSettings(dir, { boardPort: port });
  const store = Store.openIn(dir);
  store.enroll({
    repo: { forge: "github", host: "github.com", projectId: 5001, path: "acme/tally", ownerAccountId: OWNER_ID, ownerLogin: "owner" },
    settings: enrollmentSettings("owner-stated", "squash"),
    savedBy: "Ada",
    visionSha: "c0ffee",
    visionLines: ["Tally counts words in text."],
    visionOrigin: "owner-stated",
    openIssueNumbers: [],
  });
  store.close();
  const forge = new IntakeForge();
  let problems = [{ tool: "claude" as const, problem: "logged-out" as const, detail: "claude auth status reports no login" }];
  const entail = await startRun({
    dataDirectory: dir,
    log: { echo: null },
    toolCheck: async () => problems,
    passes: { forgeFor: () => forge, defaultBranchFor: async () => STILL_HEAD, planners: [] },
  });
  running.get(t)!.push(entail);
  await until(() => entail.passes.lastPassAt !== null);

  for (const path of ["/", CALLS_PATH, "/repos", SETTINGS_PATH, "/no-such-page"]) {
    const page = await send(port, { path });
    assert.match(page.body, /<section class="health-strip"/, `the strip is on ${path}`);
    assert.match(page.body, /Halted: claude is not logged in\.<\/strong> Nothing is read, decided or merged since/);
  }
  assert.equal(forge.reads.changes, 0, "no forge read: not the records check, not a poll");
  const notices = readFileSync(join(dir, NOTICES_FILE), "utf8").split("\n").filter((line) => line !== "");
  assert.deepEqual(notices.map((line) => JSON.parse(line).kind), ["health"], "one notice as the halt begins");

  problems = [];
  await entail.passes.runPass();
  assert.ok(forge.reads.changes > 0, "work resumes by itself");
  const page = await send(port, { path: "/" });
  assert.doesNotMatch(page.body, /<section class="health-strip"/, "no strip once all is well");
  assert.match(page.body, /<span class="last-pass muted">Last pass <time/);
});
