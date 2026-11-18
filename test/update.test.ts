import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import type { LockHolder } from "../src/lock.ts";
import { serviceDefinition, TASK_STATE_QUERY, type CommandResult, type ServiceInputs, type ServiceSystem } from "../src/service.ts";
import { update, UpdateError, type RunningStatus, type UpdateMachine, type UpdateOptions } from "../src/update.ts";

const URL = "http://127.0.0.1:4380/";
const OLD: LockHolder = { pid: 1111, startedAt: "2026-11-18T09:00:00.000Z" };
const NEW: LockHolder = { pid: 2222, startedAt: "2026-11-18T10:00:00.000Z" };

function temp(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A checkout of entail: a .git and a package.json named entail. */
function checkoutOf(t: TestContext, name = "entail"): string {
  const dir = temp(t, "entail-update-");
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name }));
  return dir;
}

interface World {
  options: UpdateOptions;
  /** Every command run and every request to the running copy, in order. */
  calls: string[];
  printed: string[];
  state: { holder: LockHolder | null; checking: boolean; draining: boolean; status: Partial<RunningStatus> | null; drainSupported: boolean };
}

/**
 * A machine with entail's checkout at `checkout`, `git` and `npm` answering
 * from `results`, a running copy whose pass in flight ends after `passPolls`
 * reads of its status, and a systemd service manager that restarts it.
 */
function world(
  t: TestContext,
  checkout: string,
  setup: {
    results?: Record<string, CommandResult>;
    running?: LockHolder | null;
    status?: Partial<RunningStatus> | null;
    drainSupported?: boolean;
    passPolls?: number;
  /** How many status reads report a suggestion run in flight. */
  suggestPolls?: number;
    service?: "active" | "none";
    serviceCli?: string;
    commandLine?: string;
    abortAfterPolls?: number;
  } = {},
): World {
  const home = temp(t, "entail-update-home-");
  // On Windows, LOCALAPPDATA in a temp directory, so the service's script goes there.
  const inputs: ServiceInputs = WINDOWS
    ? { platform: "win32", env: { PATH: "C:\\Windows\\system32", LOCALAPPDATA: join(home, "Local"), USERNAME: "owner" }, home, uid: 0, node: process.execPath, cli: join(checkout, "dist", "cli.js") }
    : { platform: "linux", env: { PATH: "/usr/bin", XDG_CONFIG_HOME: join(home, "config") }, home, uid: 501, node: "/opt/node/bin/node", cli: join(checkout, "dist", "cli.js") };
  if ((setup.service ?? "active") === "active") {
    const definition = serviceDefinition({ ...inputs, cli: setup.serviceCli ?? join(checkout, "dist", "cli.js") });
    mkdirSync(dirname(definition.path), { recursive: true });
    writeFileSync(definition.path, WINDOWS ? Buffer.from(`\ufeff${definition.content}`, "utf16le") : definition.content);
  }
  const calls: string[] = [];
  const printed: string[] = [];
  const state: World["state"] = {
    holder: setup.running === undefined ? OLD : setup.running,
    checking: (setup.passPolls ?? 0) > 0,
    draining: false,
    status: setup.status === undefined ? {} : setup.status,
    drainSupported: setup.drainSupported ?? true,
  };
  let polls = 0;
  let suggestReads = 0;
  const abort = new AbortController();
  const system: ServiceSystem = {
    exec(file, args) {
      const call = [file, ...args].join(" ");
      calls.push(call);
      if (call === "systemctl --user is-active --quiet entail.service" || call === "systemctl --user is-enabled --quiet entail.service") return { status: setup.service === "none" ? 3 : 0, output: "" };
      if (call === `powershell.exe -NoProfile -NonInteractive -Command ${TASK_STATE_QUERY}`) return { status: 0, output: "Running\r\n" };
      if (call === "schtasks /End /TN entail" || call.startsWith("taskkill ")) {
        assert.equal(state.checking, false, "the service is stopped only once no pass runs");
        if (call.startsWith("taskkill ")) state.holder = null;
      }
      if (call === RESTART && setup.results?.[call] === undefined) {
        assert.equal(state.checking, false, "the service is restarted only once no pass runs");
        state.holder = NEW;
        state.draining = false;
      }
      return setup.results?.[call] ?? { status: 0, output: "" };
    },
    runningCopy: () => state.holder,
    sleep: async () => {},
    kernelRelease: () => "6.8.0-generic",
  };
  const machine: UpdateMachine = {
    run(file, args, cwd) {
      assert.equal(cwd, checkout);
      const call = [file, ...args].join(" ");
      calls.push(call);
      if (call === "git rev-parse --short HEAD") return setup.results?.[call] ?? { status: 0, output: calls.includes("git pull --ff-only") ? "bbbbbbb\n" : "aaaaaaa\n" };
      return setup.results?.[call] ?? { status: 0, output: "" };
    },
    api: {
      async status() {
        if (state.holder === null || state.status === null) return null;
        if (state.checking && ++polls >= (setup.passPolls ?? 0)) state.checking = false;
        if (setup.abortAfterPolls !== undefined && polls >= setup.abortAfterPolls) abort.abort();
        const suggesting = suggestReads++ < (setup.suggestPolls ?? 0) ? ["acme/tally"] : [];
        return { checking: state.checking, draining: state.draining, suggesting, pid: state.holder.pid, cli: join(checkout, "dist", "cli.js"), ...state.status };
      },
      async drain() {
        calls.push("POST /api/drain");
        if (!state.drainSupported) return "unsupported";
        state.draining = true;
        return { checking: state.checking, draining: true };
      },
      async resume() {
        calls.push("DELETE /api/drain");
        state.draining = false;
      },
    },
    commandLine: () => setup.commandLine ?? "",
    stop(pid) {
      calls.push(`stop ${pid}`);
      assert.equal(state.checking, false, "a copy run by hand is stopped only once no pass runs");
      state.holder = null;
    },
  };
  return { options: { checkout, url: URL, inputs, system, machine, print: (line) => printed.push(line), signal: abort.signal, pollMs: 1000, drainTimeoutMs: 10_000 }, calls, printed, state };
}

const BUILD = ["git pull --ff-only", "npm ci", "npm run build"];

/** The service manager these tests restart through: Task Scheduler on Windows, whose paths only it takes, systemd elsewhere. */
const WINDOWS = process.platform === "win32";
const RESTART = WINDOWS ? "schtasks /Run /TN entail" : "systemctl --user restart entail.service";

test("update refuses a directory that is not a git checkout of entail, and touches nothing", async (t) => {
  const bare = temp(t, "entail-update-bare-");
  const nothing = world(t, bare);
  await assert.rejects(update(nothing.options), (error: unknown) => error instanceof UpdateError && /is not one \(expected a \.git and a package\.json named entail\)/u.test(error.message));
  assert.deepEqual(nothing.calls, []);

  const other = world(t, checkoutOf(t, "something-else"));
  await assert.rejects(update(other.options), /expected a \.git and a package\.json named entail/u);
  assert.deepEqual(other.calls, []);
});

test("update refuses a checkout with uncommitted changes to tracked files, before pulling", async (t) => {
  const checkout = checkoutOf(t);
  const dirty = world(t, checkout, { results: { "git status --porcelain --untracked-files=no": { status: 0, output: " M src/cli.ts\n" } } });
  await assert.rejects(update(dirty.options), /uncommitted changes, so nothing was updated: commit or discard them first\.\n M src\/cli\.ts/u);
  assert.ok(!dirty.calls.includes("git pull --ff-only"));
  assert.ok(!dirty.calls.includes("POST /api/drain"));
});

test("update refuses when the running entail runs from another install, naming both, before pulling", async (t) => {
  const checkout = checkoutOf(t);
  const elsewhere = world(t, checkout, { status: { cli: "/opt/other/entail/dist/cli.js" } });
  await assert.rejects(update(elsewhere.options), (error: unknown) => {
    assert.ok(error instanceof UpdateError);
    assert.match(error.message, /entail runs from \/opt\/other\/entail\/dist\/cli\.js \(pid 1111\)/u);
    assert.ok(error.message.includes(join(checkout, "dist", "cli.js")));
    return true;
  });
  assert.ok(!elsewhere.calls.includes("git pull --ff-only"));

  // A copy from before the update reports no script: the service's definition says where it runs from.
  const legacy = world(t, checkout, { status: { cli: undefined, pid: undefined, draining: undefined }, serviceCli: "/opt/other/entail/dist/cli.js" });
  await assert.rejects(update(legacy.options), /\/opt\/other\/entail\/dist\/cli\.js/u);
  assert.ok(!legacy.calls.includes("git pull --ff-only"));

  // Run by hand with no script reported: its command line says.
  const byHand = world(t, checkout, { service: "none", status: { cli: undefined }, commandLine: "node /opt/other/entail/dist/cli.js run" });
  await assert.rejects(update(byHand.options), /node \/opt\/other\/entail\/dist\/cli\.js run/u);
  const unknown = world(t, checkout, { service: "none", status: { cli: undefined }, commandLine: "" });
  await assert.rejects(update(unknown.options), /cannot tell where the running entail \(pid 1111\) runs from/u);
});

test("with nothing running, update pulls, installs and builds, and says nothing was restarted", async (t) => {
  const checkout = checkoutOf(t);
  const quiet = world(t, checkout, { running: null });
  const result = await update(quiet.options);
  assert.deepEqual(result, { before: "aaaaaaa", after: "bbbbbbb", restarted: "not-running" });
  assert.deepEqual(quiet.calls.filter((call) => BUILD.includes(call)), BUILD);
  assert.ok(!quiet.calls.includes("POST /api/drain"));
  assert.ok(!quiet.calls.some((call) => call === RESTART));
  assert.match(quiet.printed.join("\n"), /aaaaaaa → bbbbbbb[\s\S]*entail is not running, so there is nothing to restart/u);
});

test("a failed pull or build leaves the running entail alone", async (t) => {
  const checkout = checkoutOf(t);
  const diverged = world(t, checkout, { results: { "git pull --ff-only": { status: 128, output: "fatal: Not possible to fast-forward, aborting." } } });
  await assert.rejects(update(diverged.options), /git pull --ff-only failed, so nothing was updated and the running entail was left alone: fatal: Not possible to fast-forward/u);
  assert.ok(!diverged.calls.includes("npm ci"));

  const broken = world(t, checkout, { results: { "npm run build": { status: 2, output: "src/cli.ts(1,1): error TS1005" } } });
  await assert.rejects(update(broken.options), /npm run build failed at bbbbbbb; the running entail \(pid 1111\) was left alone on the code it started with: src\/cli\.ts/u);
  assert.ok(!broken.calls.includes("POST /api/drain"));
  assert.ok(!broken.calls.some((call) => call === RESTART));
});

test("the service is drained, waits out the pass in flight, then is restarted through its service manager on the new code", async (t) => {
  const checkout = checkoutOf(t);
  const running = world(t, checkout, { passPolls: 3 });
  const result = await update(running.options);
  assert.deepEqual(result, { before: "aaaaaaa", after: "bbbbbbb", restarted: "service" });
  const order = running.calls.filter((call) => [...BUILD, "POST /api/drain", RESTART].includes(call));
  assert.deepEqual(order, [...BUILD, "POST /api/drain", RESTART]);
  assert.ok(running.printed.some((line) => /Waiting for the pass in flight to finish/u.test(line)));
  assert.match(running.printed.at(-1)!, /The entail service runs bbbbbbb now \(was aaaaaaa\); the board: http:\/\/127\.0\.0\.1:4380\//u);
});

test("a suggestion run in flight is waited out too before the restart", async (t) => {
  const checkout = checkoutOf(t);
  const running = world(t, checkout, { suggestPolls: 3 });
  assert.equal((await update(running.options)).restarted, "service");
  assert.ok(running.printed.some((line) => /Waiting for the suggestion run in flight for acme\/tally to finish/u.test(line)));
  assert.equal(running.calls.filter((call) => call === RESTART).length, 1);
});

test("entail run by hand is drained and stopped, not restarted, and the owner is told to start it again", async (t) => {
  const checkout = checkoutOf(t);
  const byHand = world(t, checkout, { service: "none", passPolls: 2 });
  const result = await update(byHand.options);
  assert.equal(result.restarted, "by-hand");
  assert.deepEqual(byHand.calls.filter((call) => call === "POST /api/drain" || call.startsWith("stop ") || call === RESTART), ["POST /api/drain", "stop 1111"]);
  assert.match(byHand.printed.at(-1)!, /running by hand \(pid 1111\): it finished the work in flight and was stopped[\s\S]*node dist\/cli\.js run/u);
});

test("a copy from before the drain is restarted as soon as no pass runs", async (t) => {
  const checkout = checkoutOf(t);
  const legacy = world(t, checkout, { drainSupported: false, passPolls: 2, status: { cli: undefined, pid: undefined, draining: undefined } });
  assert.equal((await update(legacy.options)).restarted, "service");
  assert.ok(legacy.printed.some((line) => /predates entail update/u.test(line)));
});

test("a failed restart and an interrupted wait both let entail take work again", async (t) => {
  const checkout = checkoutOf(t);
  const failing = world(t, checkout, { results: { [RESTART]: { status: 1, output: "Failed to restart entail" } } });
  if (WINDOWS) {
    // Task Scheduler stops the old copy before it runs the task again, so a failed run leaves nothing to resume.
    await assert.rejects(update(failing.options), /stopped but could not be started again on bbbbbbb, so entail is not running/u);
    assert.ok(!failing.calls.includes("DELETE /api/drain"));
  } else {
    await assert.rejects(update(failing.options), /could not be restarted, so entail still runs the code it started with and takes work again/u);
    assert.equal(failing.calls.at(-1), "DELETE /api/drain");
  }

  const interrupted = world(t, checkout, { passPolls: 100, abortAfterPolls: 2 });
  await assert.rejects(update(interrupted.options), /interrupted; entail takes work again/u);
  assert.ok(interrupted.calls.includes("DELETE /api/drain"));
  assert.ok(!interrupted.calls.some((call) => call === RESTART));

  const slow = world(t, checkout, { passPolls: 1000 });
  await assert.rejects(update(slow.options), /did not finish within 0 minutes, so entail was not restarted and takes work again/u);
  assert.ok(slow.calls.includes("DELETE /api/drain"));
});

test("update refuses when the board at the port is not the copy holding the lock", async (t) => {
  const checkout = checkoutOf(t);
  const another = world(t, checkout, { status: { pid: 9999 } });
  await assert.rejects(update(another.options), /served by pid 9999, not by the entail holding the lock \(pid 1111\)/u);
  const silent = world(t, checkout, { status: null });
  await assert.rejects(update(silent.options), /does not answer at http:\/\/127\.0\.0\.1:4380\/: if it serves another port, pass it with --port/u);
  assert.ok(!silent.calls.includes("git pull --ff-only"));
});

test("a checkout reached through a symlink is the same checkout as the path the running entail reports", { skip: WINDOWS && "a symlink needs privileges on Windows" }, async (t) => {
  const real = realpathSync(checkoutOf(t));
  const link = join(temp(t, "entail-update-link-"), "entail");
  symlinkSync(real, link);
  // Before dist/ is built, so the script's path cannot be resolved: as macOS's /var, a link to /private/var.
  const throughLink = world(t, link, { status: { cli: join(link, "dist", "cli.js") } });
  assert.equal((await update(throughLink.options)).restarted, "service");
  const byRealPath = world(t, link, { status: { cli: join(real, "dist", "cli.js") } });
  assert.equal((await update(byRealPath.options)).restarted, "service");
});
