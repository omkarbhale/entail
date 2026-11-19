import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ForgeSetting } from "./forge/forge.ts";

/** Where pins are kept inside the data directory. */
export const PINS_DIRECTORY = "pins";

/**
 * The file holding a repo's pins: `pins/<host>/<owner>/<name>.md` in the data
 * directory. Pins are the owner's, kept on their machine, never in the repo.
 */
export function pinsFile(dataDirectory: string, setting: Pick<ForgeSetting, "host" | "path">): string {
  const parts = setting.path.split("/").map((part) => encodeURIComponent(part));
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new RangeError(`not a repo path: ${setting.path}`);
  const name = parts.pop()!;
  return join(dataDirectory, PINS_DIRECTORY, encodeURIComponent(setting.host.toLowerCase()), ...parts, `${name}.md`);
}

/**
 * Parses a pins file: each non-blank line is one topic the owner pinned, with
 * a leading list marker (`-` or `*`) dropped. Lines starting with `#` are
 * headings or notes, not pins.
 */
export function parsePins(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim().replace(/^[-*]\s+/u, "").trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/** The topics the owner pinned for a repo; none when there is no pins file. */
export async function readPins(dataDirectory: string, setting: Pick<ForgeSetting, "host" | "path">): Promise<string[]> {
  try {
    return parsePins(await readFile(pinsFile(dataDirectory, setting), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * A topic as the pins file holds it: one line, trimmed, with no list marker or
 * leading `#`, so that reading the file back gives exactly this topic. Null
 * when the text cannot be one pin.
 */
export function normalizePin(text: string): string | null {
  if (/[\r\n]/u.test(text)) return null;
  const pins = parsePins(text);
  return pins.length === 1 && pins[0] === text.trim().replace(/^[-*]\s+/u, "").trim() ? pins[0]! : null;
}

function readPinsText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/**
 * Adds a topic to a repo's pins file, creating it when there is none, and
 * leaves everything already in it as it is: headings, notes and the owner's
 * own list markers. False when the topic was already pinned.
 */
export function addPin(dataDirectory: string, setting: Pick<ForgeSetting, "host" | "path">, topic: string): boolean {
  const file = pinsFile(dataDirectory, setting);
  const text = readPinsText(file);
  if (parsePins(text).includes(topic)) return false;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${text === "" || text.endsWith("\n") ? text : `${text}\n`}- ${topic}\n`);
  return true;
}

/**
 * Takes a topic out of a repo's pins file: the lines that pin it, and nothing
 * else. False when it was not pinned.
 */
export function removePin(dataDirectory: string, setting: Pick<ForgeSetting, "host" | "path">, topic: string): boolean {
  const file = pinsFile(dataDirectory, setting);
  const text = readPinsText(file);
  const lines = text.split(/(?<=\n)/u);
  const kept = lines.filter((line) => parsePins(line)[0] !== topic);
  if (kept.length === lines.length) return false;
  writeFileSync(file, kept.join(""));
  return true;
}
