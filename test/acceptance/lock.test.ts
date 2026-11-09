import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { FakeForge } from "./fake-forge.ts";
import { acquireFixtureLock, FixtureLockedError, lockDirectory, lockFile, refuseInsidePipeline, type LockHolder, type LockTarget } from "./lock.ts";
import { resetFixture, setupFixture } from "./reset.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

let n = 0;
/** A fixture of its own for each test, so tests never share a lock file. */
function target(): LockTarget {
  n += 1;
  return { kind: "github", host: "github.com", path: `owner/fixture-${process.pid}-${n}` };
}

/** Writes a lock file as another process would have. */
function heldBy(t: LockTarget, holder: Partial<LockHolder>): string {
  const file = lockFile(t);
  const full: LockHolder = {
    fixture: `${t.kind} ${t.host}/${t.path}`,
    pid: 1,
    host: hostname(),
    startedAt: "2026-11-09T05:00:00.000Z",
    command: "test/acceptance/acceptance.ts --forge github",
    token: "theirs",
    ...holder,
  };
  writeFileSync(file, JSON.stringify(full));
  return file;
}

/** The pid of a process that has exited. */
function gonePid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(child.status, 0);
  return child.pid!;
}

function holder(file: string): LockHolder {
  return JSON.parse(readFileSync(file, "utf8")) as LockHolder;
}

test("the harness's own tests lock under a directory of their own, never the shared one", () => {
  assert.ok(lockDirectory().startsWith(tmpdir()), lockDirectory());
  assert.match(lockDirectory({ XDG_STATE_HOME: "/state" }), /^\/state\/entail-acceptance\/locks$/);
  assert.equal(lockDirectory({ ENTAIL_ACCEPTANCE_LOCK_DIR: "/locks", XDG_STATE_HOME: "/state" }), "/locks");
});

test("each fixture repo has its own lock file, whatever the case of its path", () => {
  const a = lockFile({ kind: "github", host: "github.com", path: "Owner/Tally" }, "/d");
  assert.equal(a, lockFile({ kind: "github", host: "github.com", path: "owner/tally" }, "/d"));
  assert.notEqual(a, lockFile({ kind: "gitlab", host: "gitlab.com", path: "owner/tally" }, "/d"));
  assert.notEqual(a, lockFile({ kind: "github", host: "github.com", path: "owner/other" }, "/d"));
});

test("a lock records its holder and is let go on release; taken twice in one process, on the second release", () => {
  const t = target();
  const first = acquireFixtureLock(t, { command: "the acceptance test" });
  const recorded = holder(first.file);
  assert.equal(recorded.pid, process.pid);
  assert.equal(recorded.host, hostname());
  assert.equal(recorded.command, "the acceptance test");
  assert.equal(recorded.fixture, `github github.com/${t.path}`);
  assert.ok(!Number.isNaN(Date.parse(recorded.startedAt)));

  const again = acquireFixtureLock(t);
  again.release();
  assert.ok(existsSync(first.file), "still held by the outer taker");
  first.release();
  assert.equal(existsSync(first.file), false);
  acquireFixtureLock(t).release();
});

test("a lock held by a live process refuses, naming its holder, even with --break-lock", () => {
  const t = target();
  const file = heldBy(t, { pid: process.ppid });
  for (const breakStale of [false, true]) {
    assert.throws(
      () => acquireFixtureLock(t, { breakStale }),
      (error: unknown) =>
        error instanceof FixtureLockedError &&
        !error.stale &&
        error.message.includes(`pid ${process.ppid} on ${hostname()}`) &&
        error.message.includes("2026-11-09T05:00:00.000Z") &&
        error.message.includes("acceptance.ts --forge github") &&
        /Wait for it to finish/.test(error.message),
    );
  }
  assert.equal(holder(file).token, "theirs", "the holder's lock is left alone");
});

test("a lock whose holder is gone refuses until it is broken with --break-lock", () => {
  const t = target();
  const file = heldBy(t, { pid: gonePid() });
  assert.throws(() => acquireFixtureLock(t), (error: unknown) => error instanceof FixtureLockedError && error.stale && /--break-lock/.test(error.message));
  assert.equal(holder(file).token, "theirs");

  const lock = acquireFixtureLock(t, { breakStale: true });
  assert.equal(holder(file).pid, process.pid);
  lock.release();
});

test("a lock taken on another host cannot be checked: it refuses, and --break-lock takes it", () => {
  const t = target();
  heldBy(t, { pid: process.pid, host: "elsewhere.example" });
  assert.throws(() => acquireFixtureLock(t), /on elsewhere\.example[\s\S]*another host[\s\S]*--break-lock/);
  acquireFixtureLock(t, { breakStale: true }).release();
});

test("an unreadable lock file names no holder and counts as stale", () => {
  const t = target();
  writeFileSync(lockFile(t), "");
  assert.throws(() => acquireFixtureLock(t), (error: unknown) => error instanceof FixtureLockedError && error.stale && error.holder === undefined);
  acquireFixtureLock(t, { breakStale: true }).release();
});

test("releasing never removes a lock another process has taken since", () => {
  const t = target();
  const lock = acquireFixtureLock(t);
  const file = heldBy(t, { pid: process.ppid });
  lock.release();
  assert.equal(holder(file).token, "theirs");
});

test("the reset and the setup refuse a fixture another run holds, and touch nothing", async (t) => {
  const forge = new FakeForge();
  t.after(() => rmSync(forge.remote, { recursive: true, force: true }));
  const file = heldBy(forge, { pid: process.ppid });
  await assert.rejects(resetFixture(forge), FixtureLockedError);
  await assert.rejects(setupFixture(forge), FixtureLockedError);
  assert.deepEqual(forge.calls, []);
  rmSync(file);

  // A run that holds the lock resets under it; a reset of its own lets it go after.
  const run = acquireFixtureLock(forge);
  await resetFixture(forge, () => {}, { delayMs: 1 });
  assert.ok(existsSync(file));
  run.release();
  await resetFixture(forge, () => {}, { delayMs: 1 });
  assert.equal(existsSync(file), false);
});

test("a live run refuses inside a review pipeline", () => {
  assert.throws(() => refuseInsidePipeline("the acceptance test", { NO_MISTAKES_GATE: "1" }), /never inside a review pipeline/);
  refuseInsidePipeline("the acceptance test", {});
});

test("the acceptance and harness commands refuse inside a review pipeline before reaching a forge", (t) => {
  // No PATH: were the guard missing, `gh` could not be found and nothing would reach a forge either.
  const home = mkdtempSync(join(tmpdir(), "entail-pipeline-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { NO_MISTAKES_GATE: "1", PATH: "", HOME: home, ENTAIL_ACCEPTANCE_LOCK_DIR: join(home, "locks") };
  const commands = [
    ["test/acceptance/acceptance.ts", "--forge", "github", "--out", join(home, "out")],
    ["test/acceptance/harness.ts", "reset", "--forge", "github"],
    ["test/acceptance/harness.ts", "play", "--forge", "github", "--once"],
  ];
  for (const args of commands) {
    const result = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: "utf8" });
    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.stderr, /never inside a review pipeline/, args.join(" "));
  }
  assert.equal(existsSync(join(home, "out")), false);
  assert.equal(existsSync(join(home, "locks")), false);
});

test("`npm test` runs only the *.test.ts files, and none of them loads the live commands", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts.test, 'node --test "test/**/*.test.ts"');
  const tests: string[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".test.ts")) tests.push(relative(ROOT, path).split(sep).join("/"));
    }
  };
  walk(join(ROOT, "test"));
  assert.ok(tests.includes("test/acceptance/lock.test.ts"));
  for (const file of tests) {
    const text = readFileSync(join(ROOT, file), "utf8");
    // Importing either command runs it; a test that starts one does so inside a pipeline, where it refuses.
    assert.doesNotMatch(text, /from ["'][^"']*\/(acceptance|harness)\.ts["']/, file);
    if (/(acceptance|harness)\.ts["']|run acceptance/.test(text)) assert.match(text, /NO_MISTAKES_GATE: "1"/, file);
  }
});
