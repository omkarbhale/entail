import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
