import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { DEFAULT_GLOBAL_SETTINGS, type GlobalSettings } from "../src/global-settings.ts";
import { LOCK_FILE } from "../src/lock.ts";
import { OPERATIONAL_LOG_FILE } from "../src/operational-log.ts";
import { startRun, type RunningEntail } from "../src/run.ts";
import { BoardPortTakenError } from "../src/server.ts";
import { SETTINGS_PATH } from "../src/settings-page.ts";
import { Store } from "../src/store.ts";
import { freePort, send } from "./http-client.ts";

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
