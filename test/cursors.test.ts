import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { CURSORS_FILE, CursorStore } from "../src/cursors.ts";

function dataDirectory(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "entail-cursors-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("cursors are kept per project in the data directory, readable by a later process", (t) => {
  const dir = dataDirectory(t);
  assert.equal(new CursorStore(dir).get("github:github.com:5001"), null, "no cursor reads everything");
  new CursorStore(dir).set("github:github.com:5001", "a");
  new CursorStore(dir).set("gitlab:gitlab.com:7", "b");
  new CursorStore(dir).set("github:github.com:5001", "c");
  const store = new CursorStore(dir);
  assert.equal(store.get("github:github.com:5001"), "c");
  assert.equal(store.get("gitlab:gitlab.com:7"), "b");
  assert.deepEqual(readdirSync(dir), [CURSORS_FILE], "no staging file is left behind");
  // Windows keeps no Unix permissions: a file there reads as 0o666, or 0o444 when read-only.
  if (process.platform !== "win32") assert.equal(statSync(join(dir, CURSORS_FILE)).mode & 0o777, 0o600);
});

test("an unreadable cursors file reads as no cursors and is replaced on the next save", (t) => {
  const dir = dataDirectory(t);
  writeFileSync(join(dir, CURSORS_FILE), "{not json");
  const store = new CursorStore(dir);
  assert.equal(store.get("github:github.com:5001"), null);
  store.set("github:github.com:5001", "a");
  assert.equal(store.get("github:github.com:5001"), "a");
});
