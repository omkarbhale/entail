import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { addPin, normalizePin, parsePins, pinsFile, readPins, removePin } from "../src/pins.ts";

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

test("adding and removing a pin leaves the rest of a hand-edited file as it was", (t) => {
  const data = mkdtempSync(join(tmpdir(), "entail-pins-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const setting = { host: "github.com", path: "acme/tally" };
  const file = pinsFile(data, setting);
  assert.equal(addPin(data, setting, "src/billing/"), true, "a repo with no file gets one");
  assert.equal(readFileSync(file, "utf8"), "- src/billing/\n");
  assert.equal(addPin(data, setting, "src/billing/"), false, "already pinned");
  writeFileSync(file, "# Pins\n* How totals are rounded\nThe export format");
  assert.equal(addPin(data, setting, "the CLI's flags"), true);
  assert.equal(readFileSync(file, "utf8"), "# Pins\n* How totals are rounded\nThe export format\n- the CLI's flags\n");
  assert.equal(addPin(data, setting, "The export format"), false, "a hand-written line counts");
  assert.equal(removePin(data, setting, "The export format"), true);
  assert.equal(removePin(data, setting, "The export format"), false);
  assert.equal(readFileSync(file, "utf8"), "# Pins\n* How totals are rounded\n- the CLI's flags\n");
  assert.deepEqual(parsePins(readFileSync(file, "utf8")), ["How totals are rounded", "the CLI's flags"]);
  assert.equal(removePin(data, { host: "github.com", path: "acme/other" }, "x"), false, "no file, nothing to take out");
});

test("a topic is one line that reads back as itself", () => {
  assert.equal(normalizePin("  src/billing/ "), "src/billing/");
  assert.equal(normalizePin("- a list item"), "a list item");
  for (const bad of ["", "   ", "# a heading", "two\nlines"]) assert.equal(normalizePin(bad), null, JSON.stringify(bad));
});
