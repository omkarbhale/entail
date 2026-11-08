import { appendFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "info" | "warn" | "error";

/** Fields of one operational log line besides its time, level and event. */
export type LogFields = Record<string, unknown>;

export const OPERATIONAL_LOG_FILE = "operational-log.jsonl";
/** A log file is rotated once it would grow past this size. */
export const ROTATE_BYTES = 10 * 1024 * 1024;
/** Files kept: the current one plus four rotated ones. */
export const FILES_KEPT = 5;

export interface OperationalLogOptions {
  /** Where each line also goes; stdout by default. Null writes only the file. */
  echo?: ((line: string) => void) | null;
  rotateBytes?: number;
  filesKept?: number;
  now?: () => Date;
}

/**
 * The operational log: what the running process did that is not a call, such
 * as polls, backoffs, retries, machine failures, usage-limit pauses and failed
 * notices (ADR-0017). It is kept apart from the records.
 *
 * Each entry is one JSON line, written to `operational-log.jsonl` in the data
 * directory and to stdout. The file is rotated at 10 MB with five files kept:
 * `operational-log.jsonl`, then `.1` (newest) to `.4` (oldest).
 */
export class OperationalLog {
  readonly path: string;
  readonly #echo: ((line: string) => void) | null;
  readonly #rotateBytes: number;
  readonly #filesKept: number;
  readonly #now: () => Date;
  #size: number;

  constructor(dataDirectory: string, options: OperationalLogOptions = {}) {
    this.path = join(dataDirectory, OPERATIONAL_LOG_FILE);
    this.#echo = options.echo === undefined ? (line) => process.stdout.write(line) : options.echo;
    this.#rotateBytes = options.rotateBytes ?? ROTATE_BYTES;
    this.#filesKept = options.filesKept ?? FILES_KEPT;
    this.#now = options.now ?? (() => new Date());
    this.#size = sizeOf(this.path);
  }

  info(event: string, fields?: LogFields): void {
    this.write("info", event, fields);
  }

  warn(event: string, fields?: LogFields): void {
    this.write("warn", event, fields);
  }

  error(event: string, fields?: LogFields): void {
    this.write("error", event, fields);
  }

  write(level: LogLevel, event: string, fields: LogFields = {}): void {
    const line = `${JSON.stringify({ ...fields, time: this.#now().toISOString(), level, event })}\n`;
    const bytes = Buffer.byteLength(line);
    if (this.#size > 0 && this.#size + bytes > this.#rotateBytes) {
      this.#rotate();
    }
    appendFileSync(this.path, line, { mode: 0o600 });
    this.#size += bytes;
    this.#echo?.(line);
  }

  #rotate(): void {
    const oldest = this.#filesKept - 1;
    if (oldest < 1) {
      rmSync(this.path, { force: true });
    } else {
      rmSync(`${this.path}.${oldest}`, { force: true });
      for (let n = oldest - 1; n >= 1; n--) {
        renameIfPresent(`${this.path}.${n}`, `${this.path}.${n + 1}`);
      }
      renameIfPresent(this.path, `${this.path}.1`);
    }
    this.#size = 0;
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function renameIfPresent(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}
