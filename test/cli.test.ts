import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveDataDirectory } from "../src/data-directory.ts";
import { LOCK_FILE } from "../src/lock.ts";
import { OPERATIONAL_LOG_FILE } from "../src/operational-log.ts";
import { STORE_FILE, Store } from "../src/store.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

interface Machine {
  env: NodeJS.ProcessEnv;
  dataDirectory: string;
}

/** A fresh home and data directory, as if on a machine entail never ran on. */
function machine(t: TestContext): Machine {
  const root = mkdtempSync(join(tmpdir(), "entail-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: join(root, "home"), XDG_DATA_HOME: join(root, "xdg") };
  const dataDirectory = resolveDataDirectory({ platform: process.platform, env, home: env.HOME });
  return { env, dataDirectory };
}

type Entry = Record<string, unknown>;

/** Starts `entail run` and resolves once it has logged that it started. */
async function startEntail(t: TestContext, m: Machine): Promise<{ child: ChildProcessWithoutNullStreams; entries: Entry[] }> {
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

test("entail run creates the data directory, holds the lock and stops on SIGTERM", async (t) => {
  const m = machine(t);
  assert.ok(!existsSync(m.dataDirectory));
  const { child } = await startEntail(t, m);

  const lock = JSON.parse(readFileSync(join(m.dataDirectory, LOCK_FILE), "utf8")) as { pid: number };
  assert.equal(lock.pid, child.pid);

  assert.equal(await stopWith(child, "SIGTERM"), 0);
  assert.ok(!existsSync(join(m.dataDirectory, LOCK_FILE)), "the lock is released");
  assert.deepEqual(
    logEntries(m).map((entry) => entry.event),
    ["started", "stopping", "stopped"],
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
