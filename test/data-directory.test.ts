import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureDataDirectory, resolveDataDirectory, UnsupportedPlatformError } from "../src/data-directory.ts";

test("Linux and WSL use $XDG_DATA_HOME/entail when it is set", () => {
  const dir = resolveDataDirectory({ platform: "linux", env: { XDG_DATA_HOME: "/data/xdg" }, home: "/home/owner" });
  assert.equal(dir, "/data/xdg/entail");
});

test("Linux and WSL default to ~/.local/share/entail", () => {
  assert.equal(resolveDataDirectory({ platform: "linux", env: {}, home: "/home/owner" }), "/home/owner/.local/share/entail");
  assert.equal(
    resolveDataDirectory({ platform: "linux", env: { XDG_DATA_HOME: "" }, home: "/home/owner" }),
    "/home/owner/.local/share/entail",
  );
});

test("a relative $XDG_DATA_HOME is ignored", () => {
  const dir = resolveDataDirectory({ platform: "linux", env: { XDG_DATA_HOME: "relative/data" }, home: "/home/owner" });
  assert.equal(dir, "/home/owner/.local/share/entail");
});

test("macOS uses ~/Library/Application Support/entail, whatever $XDG_DATA_HOME says", () => {
  const dir = resolveDataDirectory({ platform: "darwin", env: { XDG_DATA_HOME: "/data/xdg" }, home: "/Users/owner" });
  assert.equal(dir, "/Users/owner/Library/Application Support/entail");
});

test("Windows uses %LOCALAPPDATA%\\entail, by default ~\\AppData\\Local\\entail", () => {
  const home = "C:\\Users\\owner";
  assert.equal(resolveDataDirectory({ platform: "win32", env: { LOCALAPPDATA: "D:\\Local" }, home }), "D:\\Local\\entail");
  assert.equal(resolveDataDirectory({ platform: "win32", env: {}, home }), "C:\\Users\\owner\\AppData\\Local\\entail");
  assert.equal(resolveDataDirectory({ platform: "win32", env: { LOCALAPPDATA: "relative" }, home }), "C:\\Users\\owner\\AppData\\Local\\entail");
  assert.equal(resolveDataDirectory({ platform: "win32", env: { XDG_DATA_HOME: "D:\\xdg" }, home }), "C:\\Users\\owner\\AppData\\Local\\entail");
});

test("any other platform is not supported", () => {
  assert.throws(() => resolveDataDirectory({ platform: "freebsd", env: {}, home: "/home/owner" }), UnsupportedPlatformError);
});

test("the data directory is created on first run", (t) => {
  const home = mkdtempSync(join(tmpdir(), "entail-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const machine = { platform: process.platform, env: {}, home };
  const dir = ensureDataDirectory(machine);
  assert.equal(dir, resolveDataDirectory(machine));
  assert.ok(dir.startsWith(home));
  assert.ok(existsSync(dir));
  assert.equal(ensureDataDirectory(machine), dir, "an existing directory is reused");
});
