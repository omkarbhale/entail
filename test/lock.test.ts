import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { acquireLock, LOCK_FILE, LockHeldError, readLock } from "../src/lock.ts";

function dataDirectory(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "entail-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the lock records the holder's pid and start time, and release removes it", (t) => {
  const dir = dataDirectory(t);
  const now = new Date("2026-11-08T10:00:00.000Z");
  const lock = acquireLock(dir, { pid: 4242, now: () => now });
  assert.deepEqual(readLock(dir), { pid: 4242, startedAt: now.toISOString() });
  assert.equal(lock.takeover, null);
  lock.release();
  assert.equal(readLock(dir), null);
  assert.deepEqual(readdirSync(dir), [], "no staging files are left behind");
});

test("a lock held by a live process refuses a second copy, naming its pid", (t) => {
  const dir = dataDirectory(t);
  const first = acquireLock(dir, { pid: 1111, isAlive: () => true });
  assert.throws(
    () => acquireLock(dir, { pid: 2222, isAlive: () => true }),
    (error: unknown) => error instanceof LockHeldError && error.holder.pid === 1111 && /pid 1111/.test(error.message),
  );
  assert.equal(readLock(dir)?.pid, 1111, "the refused copy leaves the lock alone");
  first.release();
});

test("a lock left by a dead process is taken over and the takeover is returned", (t) => {
  const dir = dataDirectory(t);
  writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ pid: 3333, startedAt: "2026-11-08T09:00:00.000Z" }));
  const now = new Date("2026-11-08T10:00:00.000Z");
  const lock = acquireLock(dir, { pid: 4444, now: () => now, isAlive: (pid) => pid !== 3333 });
  assert.deepEqual(lock.takeover, {
    previous: { pid: 3333, startedAt: "2026-11-08T09:00:00.000Z" },
    detectedAt: now.toISOString(),
  });
  assert.equal(readLock(dir)?.pid, 4444);
  lock.release();
  assert.deepEqual(readdirSync(dir), []);
});

test("an unreadable lock is treated as left by a dead process", (t) => {
  const dir = dataDirectory(t);
  writeFileSync(join(dir, LOCK_FILE), "not json");
  const lock = acquireLock(dir, { pid: 5555 });
  assert.deepEqual(lock.takeover?.previous, null);
  assert.equal(readLock(dir)?.pid, 5555);
  lock.release();
});

test("a lock naming this process's own pid is stale, since this process has not taken it yet", (t) => {
  const dir = dataDirectory(t);
  writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ pid: process.pid, startedAt: "2026-11-08T09:00:00.000Z" }));
  const lock = acquireLock(dir);
  assert.equal(lock.takeover?.previous?.pid, process.pid);
  lock.release();
});

test("the real liveness check sees this process as alive", (t) => {
  const dir = dataDirectory(t);
  const first = acquireLock(dir, { pid: process.pid });
  assert.throws(() => acquireLock(dir, { pid: process.pid + 1 }), LockHeldError);
  first.release();
});

test("release leaves alone a lock that another copy has since taken", (t) => {
  const dir = dataDirectory(t);
  const lock = acquireLock(dir, { pid: 6666 });
  writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ pid: 7777, startedAt: "2026-11-08T09:00:00.000Z" }));
  lock.release();
  assert.ok(existsSync(join(dir, LOCK_FILE)));
  assert.equal(JSON.parse(readFileSync(join(dir, LOCK_FILE), "utf8")).pid, 7777);
});
