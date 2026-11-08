import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { FILES_KEPT, OPERATIONAL_LOG_FILE, OperationalLog, ROTATE_BYTES } from "../src/operational-log.ts";

function dataDirectory(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "entail-log-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function lines(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("rotation defaults to 10 MB with five files kept", () => {
  assert.equal(ROTATE_BYTES, 10 * 1024 * 1024);
  assert.equal(FILES_KEPT, 5);
});

test("each entry is one JSON line in the data directory and the same line on the echo", (t) => {
  const dir = dataDirectory(t);
  const echoed: string[] = [];
  const now = new Date("2026-11-08T10:00:00.000Z");
  const log = new OperationalLog(dir, { echo: (line) => echoed.push(line), now: () => now });
  log.info("poll", { repo: "owner/tally" });
  log.warn("backoff", { repo: "owner/tally", minutes: 2 });

  const path = join(dir, OPERATIONAL_LOG_FILE);
  assert.deepEqual(lines(path), [
    { repo: "owner/tally", time: now.toISOString(), level: "info", event: "poll" },
    { repo: "owner/tally", minutes: 2, time: now.toISOString(), level: "warn", event: "backoff" },
  ]);
  assert.equal(echoed.join(""), readFileSync(path, "utf8"));
});

test("fields cannot overwrite an entry's time, level or event", (t) => {
  const dir = dataDirectory(t);
  const log = new OperationalLog(dir, { echo: null });
  log.info("poll", { event: "other", level: "error" });
  const [entry] = lines(join(dir, OPERATIONAL_LOG_FILE));
  assert.equal(entry?.event, "poll");
  assert.equal(entry?.level, "info");
});

test("the log is rotated before it grows past the limit, keeping the newest files", (t) => {
  const dir = dataDirectory(t);
  const log = new OperationalLog(dir, { echo: null, rotateBytes: 200, filesKept: 3 });
  for (let n = 0; n < 40; n++) log.info("poll", { n });

  const path = join(dir, OPERATIONAL_LOG_FILE);
  assert.deepEqual(readdirSync(dir).sort(), [OPERATIONAL_LOG_FILE, `${OPERATIONAL_LOG_FILE}.1`, `${OPERATIONAL_LOG_FILE}.2`]);
  for (const file of [path, `${path}.1`, `${path}.2`]) {
    assert.ok(readFileSync(file).length <= 200, `${file} stays under the limit`);
  }
  const current = lines(path).map((entry) => entry.n as number);
  const previous = lines(`${path}.1`).map((entry) => entry.n as number);
  const oldest = lines(`${path}.2`).map((entry) => entry.n as number);
  assert.equal(current.at(-1), 39, "the newest entry is in the current file");
  assert.deepEqual([...oldest, ...previous, ...current], Array.from({ length: oldest.length + previous.length + current.length }, (_, i) => (oldest[0] ?? 0) + i), "rotated files hold consecutive, ordered entries");
  assert.ok(!existsSync(`${path}.3`));
});

test("a reopened log continues counting from the existing file's size", (t) => {
  const dir = dataDirectory(t);
  const path = join(dir, OPERATIONAL_LOG_FILE);
  const first = new OperationalLog(dir, { echo: null, rotateBytes: 200 });
  first.info("poll", { padding: "x".repeat(100) });
  const second = new OperationalLog(dir, { echo: null, rotateBytes: 200 });
  second.info("poll", { padding: "y".repeat(100) });
  assert.ok(existsSync(`${path}.1`), "the second write rotated the file the first one left");
  assert.equal(lines(path).length, 1);
});
