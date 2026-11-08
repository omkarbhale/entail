import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:net";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveDataDirectory } from "../src/data-directory.ts";
import { DEFAULT_GLOBAL_SETTINGS } from "../src/global-settings.ts";
import { LOCK_FILE } from "../src/lock.ts";
import { OPERATIONAL_LOG_FILE } from "../src/operational-log.ts";
import { STORE_FILE, Store } from "../src/store.ts";
import { RecordsRepo } from "../src/records-repo.ts";
import { freePort, send } from "./http-client.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

interface Machine {
  env: NodeJS.ProcessEnv;
  dataDirectory: string;
}

/**
 * A fresh home and data directory, as if on a machine entail never ran on,
 * with a `claude` that reports itself logged in (or not), so whether this
 * machine's own claude is logged in never decides a test.
 */
function machine(t: TestContext, { claudeLoggedIn = true } = {}): Machine {
  const root = mkdtempSync(join(tmpdir(), "entail-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho '{"loggedIn": ${claudeLoggedIn}}'\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: join(root, "home"), XDG_DATA_HOME: join(root, "xdg"), PATH: `${bin}:${process.env.PATH ?? ""}` };
  const dataDirectory = resolveDataDirectory({ platform: process.platform, env, home: env.HOME });
  return { env, dataDirectory };
}

type Entry = Record<string, unknown>;

/** Saves global settings with this board port, so tests do not need port 7419. */
function useBoardPort(m: Machine, port: number): void {
  mkdirSync(m.dataDirectory, { recursive: true });
  const store = Store.openIn(m.dataDirectory);
  if (store.latestGlobalSettings()?.settings) {
    store.close();
    return;
  }
  // Notices go to a file, so a halt never shows on this machine's desktop.
  store.saveGlobalSettings({ ...DEFAULT_GLOBAL_SETTINGS, ownerDisplayName: "Test", boardPort: port, noticeConnector: "file" }, "Test");
  store.close();
}

/** Whether a port on 127.0.0.1 can be listened on right now. */
async function portIsFree(port: number): Promise<boolean> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch {
    return false;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return true;
}

/**
 * Starts `entail run` and resolves once it has logged that it started. Unless
 * told to keep the default board port, it first saves a free one.
 */
async function startEntail(
  t: TestContext,
  m: Machine,
  { defaultPort = false } = {},
): Promise<{ child: ChildProcessWithoutNullStreams; entries: Entry[] }> {
  if (!defaultPort) useBoardPort(m, await freePort());
  const child = spawn(process.execPath, [CLI, "run"], { env: m.env });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  const entries: Entry[] = [];
  let buffered = "";
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      let newline;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        entries.push(JSON.parse(buffered.slice(0, newline)) as Entry);
        buffered = buffered.slice(newline + 1);
        if (entries.at(-1)?.event === "started") resolve();
      }
    });
    child.once("exit", (code) => reject(new Error(`entail run exited ${code} before starting: ${stderr}`)));
  });
  return { child, entries };
}

async function stopWith(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): Promise<number | null> {
  child.kill(signal);
  const [code] = (await once(child, "exit")) as [number | null];
  return code;
}

function logEntries(m: Machine): Entry[] {
  return readFileSync(join(m.dataDirectory, OPERATIONAL_LOG_FILE), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Entry);
}

test("entail run creates the data directory, serves on port 7419, holds the lock and stops on SIGTERM", async (t) => {
  if (!(await portIsFree(7419))) return t.skip("port 7419 is in use on this machine");
  const m = machine(t);
  assert.ok(!existsSync(m.dataDirectory));
  const { child, entries } = await startEntail(t, m, { defaultPort: true });
  assert.equal(entries.find((entry) => entry.event === "started")?.board, "http://127.0.0.1:7419/");
  assert.equal((await send(7419, { path: "/settings" })).status, 200);

  const lock = JSON.parse(readFileSync(join(m.dataDirectory, LOCK_FILE), "utf8")) as { pid: number };
  assert.equal(lock.pid, child.pid);

  assert.equal(await stopWith(child, "SIGTERM"), 0);
  assert.ok(!existsSync(join(m.dataDirectory, LOCK_FILE)), "the lock is released");
  assert.deepEqual(
    logEntries(m).map((entry) => entry.event),
    ["started", "stopping", "records-committed", "stopped"],
    "stopping commits the records repo before the lock is released",
  );
});

test("entail run creates the store at start and opens it again on the next start", async (t) => {
  const m = machine(t);
  const first = await startEntail(t, m);
  assert.ok(existsSync(join(m.dataDirectory, STORE_FILE)), "the store is created at start");
  assert.equal(await stopWith(first.child, "SIGTERM"), 0);

  const store = Store.openIn(m.dataDirectory);
  const repo = store.enrollRepo({ forge: "github", host: "github.com", projectId: 7, path: "o/r", ownerAccountId: 1, ownerLogin: "o" });
  store.close();

  const second = await startEntail(t, m);
  assert.equal(await stopWith(second.child, "SIGTERM"), 0);
  const reopened = Store.openIn(m.dataDirectory);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.getRepo(repo.id), repo, "records survive a restart");
});

test("entail run exits non-zero and releases the lock when the store cannot be opened", (t) => {
  const m = machine(t);
  mkdirSync(m.dataDirectory, { recursive: true });
  writeFileSync(join(m.dataDirectory, STORE_FILE), "this is not a SQLite database, just some text that is long enough\n".repeat(20));

  const result = spawnSync(process.execPath, [CLI, "run"], { env: m.env, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /entail: cannot open the store at /);
  assert.ok(!existsSync(join(m.dataDirectory, LOCK_FILE)), "the lock is released");
  assert.ok(logEntries(m).some((entry) => entry.event === "store-open-failed"));
});

test("entail run exits non-zero with a clear message when the board port is taken", async (t) => {
  const m = machine(t);
  const other = createServer();
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  t.after(() => other.close());
  const { port } = other.address() as { port: number };
  useBoardPort(m, port);

  const result = spawnSync(process.execPath, [CLI, "run"], { env: m.env, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`entail: the board port ${port} on 127\\.0\\.0\\.1 is already in use`));
  assert.ok(!existsSync(join(m.dataDirectory, LOCK_FILE)), "the lock is released");
});

test("entail run stops on SIGINT", async (t) => {
  const m = machine(t);
  const { child } = await startEntail(t, m);
  assert.equal(await stopWith(child, "SIGINT"), 0);
  assert.ok(!existsSync(join(m.dataDirectory, LOCK_FILE)));
});

test("a second entail run refuses to start, naming the running pid", async (t) => {
  const m = machine(t);
  const { child } = await startEntail(t, m);

  const second = spawnSync(process.execPath, [CLI, "run"], { env: m.env, encoding: "utf8" });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, new RegExp(`already running \\(pid ${child.pid}\\b`));
  assert.equal(JSON.parse(readFileSync(join(m.dataDirectory, LOCK_FILE), "utf8")).pid, child.pid);

  assert.equal(await stopWith(child, "SIGTERM"), 0);
});

test("a lock left by a dead process is taken over and logged as an unexpected stop", async (t) => {
  const m = machine(t);
  const first = await startEntail(t, m);
  first.child.kill("SIGKILL");
  await once(first.child, "exit");
  assert.ok(existsSync(join(m.dataDirectory, LOCK_FILE)), "a killed process leaves its lock behind");

  const { child, entries } = await startEntail(t, m);
  const warning = entries.find((entry) => entry.event === "unexpected-stop");
  assert.equal(warning?.level, "warn");
  assert.equal(warning?.previousPid, first.child.pid);
  assert.ok(logEntries(m).some((entry) => entry.event === "unexpected-stop"), "the takeover is in the log file");

  assert.equal(await stopWith(child, "SIGTERM"), 0);
});

test("an unknown command exits non-zero with usage", (t) => {
  const m = machine(t);
  const result = spawnSync(process.execPath, [CLI, "frobnicate"], { env: m.env, encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: entail <command>/);
  assert.ok(!existsSync(m.dataDirectory), "nothing is created for an unknown command");
});

test("entail --help prints usage", (t) => {
  const m = machine(t);
  const result = spawnSync(process.execPath, [CLI, "--help"], { env: m.env, encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /run\s+Run entail in the foreground/);
});

test("entail restore clones the records repo into a fresh store, and refuses to replace one without --replace", async (t) => {
  // A machine whose records were pushed to a remote.
  const old = machine(t);
  mkdirSync(old.dataDirectory, { recursive: true });
  const store = Store.openIn(old.dataDirectory);
  store.saveGlobalSettings({ ...DEFAULT_GLOBAL_SETTINGS, ownerDisplayName: "Ada" }, "Ada");
  store.close();
  const remote = join(old.dataDirectory, "..", "records.git");
  spawnSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
  const records = new RecordsRepo({ dataDirectory: old.dataDirectory, storePath: join(old.dataDirectory, STORE_FILE), remote: () => remote });
  const saved = await records.save("stop");
  assert.ok(!("error" in saved) && saved.push === "pushed");

  // A new machine restores them.
  const m = machine(t);
  const restored = spawnSync(process.execPath, [CLI, "restore", remote], { env: m.env, encoding: "utf8" });
  assert.equal(restored.status, 0, restored.stderr);
  assert.match(restored.stdout, /Restored entail's records from .* 0 repos, 0 tickets, 0 calls and 0 answers/);
  const fresh = Store.openIn(m.dataDirectory);
  assert.equal(fresh.latestGlobalSettings()?.savedBy, "Ada");
  fresh.close();

  const again = spawnSync(process.execPath, [CLI, "restore", remote], { env: m.env, encoding: "utf8" });
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already holds a store or records repo\. Restore with --replace/);
  const replaced = spawnSync(process.execPath, [CLI, "restore", remote, "--replace"], { env: m.env, encoding: "utf8" });
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.match(replaced.stdout, /set aside in .*before-restore-/);

  const usage = spawnSync(process.execPath, [CLI, "restore"], { env: m.env, encoding: "utf8" });
  assert.equal(usage.status, 2, "a remote is required");
});

function status(m: Machine, ...args: string[]): { code: number | null; stdout: string } {
  const ran = spawnSync(process.execPath, [CLI, "status", ...args], { env: m.env, encoding: "utf8" });
  return { code: ran.status, stdout: ran.stdout };
}

/** Waits until the running entail has written a status file whose last pass is set. */
async function untilPassed(m: Machine): Promise<void> {
  for (let n = 0; n < 200; n++) {
    try {
      if ((JSON.parse(readFileSync(join(m.dataDirectory, "status.json"), "utf8")) as { lastPass: unknown }).lastPass !== null) return;
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("entail never wrote a status file after a pass");
}

test("entail status works with entail stopped, exiting 2, and prints the same as JSON", (t) => {
  const m = machine(t);
  const text = status(m);
  assert.equal(text.code, 2);
  assert.match(text.stdout, /^entail is not running\.\nNo status has been written yet/);

  const json = status(m, "--json");
  assert.equal(json.code, 2);
  const report = JSON.parse(json.stdout) as Record<string, unknown>;
  assert.equal(report.running, false);
  assert.equal(report.exitCode, 2);
  assert.deepEqual(report.halts, []);
  assert.ok(!existsSync(m.dataDirectory), "status creates nothing");
});

test("entail status exits 0 while entail runs healthy, 1 while something is halted, and 2 once it stopped", async (t) => {
  const healthy = machine(t);
  const running = await startEntail(t, healthy);
  await untilPassed(healthy);
  const ok = status(healthy);
  assert.equal(ok.code, 0, ok.stdout);
  assert.match(ok.stdout, new RegExp(`^entail is running: pid ${running.child.pid}, started `));
  assert.match(ok.stdout, /No halts or warnings\./);
  assert.match(ok.stdout, /Records repo: no remote set\./);
  const report = JSON.parse(status(healthy, "--json").stdout) as { running: boolean; pid: number; lastPass: string | null };
  assert.deepEqual([report.running, report.pid, typeof report.lastPass], [true, running.child.pid, "string"]);
  assert.equal(await stopWith(running.child, "SIGTERM"), 0);
  const stopped = status(healthy);
  assert.equal(stopped.code, 2);
  assert.match(stopped.stdout, /^entail is not running\.\nWhat follows is as of /);

  const loggedOut = machine(t, { claudeLoggedIn: false });
  const halted = await startEntail(t, loggedOut);
  await untilPassed(loggedOut);
  const shown = status(loggedOut);
  assert.equal(shown.code, 1, shown.stdout);
  assert.match(shown.stdout, /Halted:\n {2}- claude is not logged in\. Nothing is read, decided or merged since /);
  assert.match(shown.stdout, /Recent warnings in the operational log:\n.*tools-halted/);
  const json = JSON.parse(status(loggedOut, "--json").stdout) as { halts: { key: string }[]; exitCode: number };
  assert.deepEqual([json.halts.map((h) => h.key), json.exitCode], [["entail:claude"], 1]);
  assert.equal((await send(portOf(halted.entries), { path: "/settings" })).status, 200, "the process stays up, serving its pages");
  assert.equal(await stopWith(halted.child, "SIGTERM"), 0);
});

function portOf(entries: Entry[]): number {
  return Number(new URL(String(entries.find((entry) => entry.event === "started")?.board)).port);
}
