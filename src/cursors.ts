import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChangeCursor } from "./forge/forge.ts";

export const CURSORS_FILE = "cursors.json";

/**
 * Where each enrolled repo's change detection got to on its forge, kept as
 * operational state in the data directory and never in the records: losing a
 * cursor costs only a re-scan (ADR-0015). A missing or unreadable file reads
 * as no cursors.
 *
 * Cursors are kept under a project's key (see `projectKey`), so a renamed or
 * transferred repo keeps its cursor.
 */
export class CursorStore {
  readonly path: string;

  constructor(dataDirectory: string) {
    this.path = join(dataDirectory, CURSORS_FILE);
  }

  /** The cursor kept for a project, or null to read everything. */
  get(key: string): ChangeCursor | null {
    return this.#read()[key] ?? null;
  }

  /** Keeps a project's cursor, replacing the file whole so a crash never leaves half of it. */
  set(key: string, cursor: ChangeCursor): void {
    const cursors = { ...this.#read(), [key]: cursor };
    const staging = `${this.path}.new-${process.pid}`;
    writeFileSync(staging, `${JSON.stringify(cursors, null, 2)}\n`, { mode: 0o600 });
    renameSync(staging, this.path);
  }

  #read(): Record<string, ChangeCursor> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      return {};
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const cursors: Record<string, ChangeCursor> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") cursors[key] = value;
    }
    return cursors;
  }
}
