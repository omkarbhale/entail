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
import { SETTINGS_PATH } from "../src/settings-page.ts";
import { Store } from "../src/store.ts";
import { enrollmentSettings } from "../src/repo-settings.ts";
import { freePort, send } from "./http-client.ts";
import { IntakeForge, issue, STILL_HEAD } from "./pass-fixture.ts";

const running = new WeakMap<TestContext, RunningEntail[]>();

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
  store.saveGlobalSettings({ ...DEFAULT_GLOBAL_SETTINGS, ownerDisplayName: "Ada", ...changes }, "Ada");
  store.close();
}

async function start(t: TestContext, dir: string): Promise<RunningEntail> {
  const run = await startRun({ dataDirectory: dir, log: { echo: null } });
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

  await assert.rejects(startRun({ dataDirectory: dir, log: { echo: null } }), (error: unknown) => {
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

test("entail starts in spec order: lock, store, settle intents, the server, then the passes", async (t) => {
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
    passes: { forgeFor: () => forge, defaultBranchFor: async () => STILL_HEAD },
  });
  running.get(t)!.push(entail);
  await until(() => logEvents(dir).includes("poll"));

  const events = logEvents(dir);
  const at = (event: string) => events.indexOf(event);
  assert.ok(at("intent-settled") >= 0 && at("intent-settled") < at("intents-settled"));
  assert.ok(at("intents-settled") < at("started"), "intents are settled before the server starts");
  assert.ok(at("started") < at("poll"), "the passes start after the server");
  assert.deepEqual(entail.store.unconfirmedForgeWrites(), []);
  assert.deepEqual(forge.state.labels[3], ["entail:cleared"], "the label was applied again");
  assert.ok(entail.store.latestTicketForIssue(repo.id, 5), "the pass took the owner's new issue in");
});

test("stopping starts no new work, waits for in-flight forge writes up to the limit, then releases the lock", async (t) => {
  const dir = dataDirectory(t);
  saveSettings(dir, { boardPort: await freePort() });
  const entail = await startRun({ dataDirectory: dir, log: { echo: null }, stopWaitMs: 200 });
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

  const again = await startRun({ dataDirectory: dir, log: { echo: null }, stopWaitMs: 100 });
  again.inFlight.track(new Promise<void>(() => {}));
  again.stop("SIGINT");
  await again.stopped;
  assert.ok(logEvents(dir).includes("writes-unconfirmed-at-stop"), "a write still unconfirmed at the limit is left for the next start");
  assert.ok(!existsSync(join(dir, LOCK_FILE)), "the lock is released after the limit");
  const events = logEvents(dir);
  assert.ok(events.lastIndexOf("stopping") < events.lastIndexOf("stopped"));
});
