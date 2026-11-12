import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parsePins, pinsFile, readPins } from "../src/pins.ts";

test("each non-blank line of a pins file is one topic, list markers and headings aside", () => {
  assert.deepEqual(parsePins("# Pins\n\n- How totals are rounded\n* The CLI's flags\nThe export format\n\n"), [
    "How totals are rounded",
    "The CLI's flags",
    "The export format",
  ]);
});

test("a repo's pins live under the data directory by host and path; a repo with no file has none", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "entail-pins-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const setting = { host: "GitHub.com", path: "acme/tally" };
  const file = pinsFile(data, setting);
  assert.equal(file, join(data, "pins", "github.com", "acme", "tally.md"));
  assert.deepEqual(await readPins(data, setting), []);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "- How totals are rounded\n");
  assert.deepEqual(await readPins(data, setting), ["How totals are rounded"]);
  assert.throws(() => pinsFile(data, { host: "github.com", path: "acme/.." }), RangeError);
});
