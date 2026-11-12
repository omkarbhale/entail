import { spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CallView } from "./api-types.ts";

/**
 * How the owner learns that something is waiting: one line and a link, sent
 * by a command the owner sets (`entail settings --notice '<command>'`). The line never carries the question or any text of the issue,
 * and nothing is taken back from it: the answer is given on the board.
 *
 * The command is a shell command line; entail runs it with `/bin/sh -c`
 * and the line and the link appended as its last two arguments, so a script
 * reads them as `$1` and `$2`. They are also in its environment as
 * `ENTAIL_NOTICE_LINE` and `ENTAIL_NOTICE_LINK`. entail depends on no particular sink: `examples/`
 * holds one command that appends the line to a file and one that drops it
 * into firstmate's inbox.
 */

/** Which items the owner was last told about, so each item is announced once while it waits. */
export const NOTICES_FILE = "notices.json";

/** How long a notice command may run before entail stops it. */
export const NOTICE_TIMEOUT_MS = 30_000;

/** The one line: how many questions and calls wait, never what they are. */
export function noticeLine(items: readonly Pick<CallView, "call" | "repo">[]): string {
  const questions = items.filter((item) => item.call === "ask").length;
  const calls = items.length - questions;
  const parts = [];
  if (questions > 0) parts.push(`${questions} question${questions === 1 ? "" : "s"}`);
  if (calls > 0) parts.push(`${calls} call${calls === 1 ? "" : "s"} to confirm`);
  const repos = new Set(items.map((item) => item.repo)).size;
  return `entail: ${parts.join(" and ")} waiting on you${repos > 1 ? ` across ${repos} repos` : ""}`;
}

export interface NoticeResult {
  ok: boolean;
  error?: string;
}

/** Runs the notice command with the line and the link appended as its last two arguments. */
export function sendNotice(command: string, line: string, link: string, timeoutMs = NOTICE_TIMEOUT_MS): Promise<NoticeResult> {
  return new Promise((resolve) => {
    let stderr = "";
    const child = spawn("/bin/sh", ["-c", `${command} "$@"`, "entail-notice", line, link], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, ENTAIL_NOTICE_LINE: line, ENTAIL_NOTICE_LINK: link },
      timeout: timeoutMs,
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => resolve({ ok: false, error: error.message }));
    child.on("close", (code, signal) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: signal !== null ? `stopped by ${signal}` : `exited ${code}${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}` });
    });
  });
}

export interface NotifierOptions {
  dataDirectory: string;
  /** The notice command now set, or null for none. */
  command: () => string | null;
  /** The link the notice carries: the board's Waiting page. */
  link: string;
  send?: typeof sendNotice;
  onResult?: (result: NoticeResult & { line: string }) => void;
}

/**
 * Sends a notice when something new starts waiting: an item waiting now that
 * was not waiting when the owner was last told. An item is known by its repo,
 * its kind (issue or PR) and its issue, so an issue judged again after an edit is not announced twice, and a PR call and a question on the same issue are each announced. An item is remembered only once the notice reached the owner, so a failed command is tried again at the next check.
 */
export class Notifier {
  readonly #options: NotifierOptions;

  constructor(options: NotifierOptions) {
    this.#options = options;
  }

  async check(items: readonly (Pick<CallView, "call" | "repo" | "kind"> & { issue: { number: number } })[]): Promise<{ sent: boolean; line: string | null }> {
    const keys = items.map((item) => `${item.repo}#${item.kind}#${item.issue.number}`);
    const told = this.#told();
    const fresh = keys.filter((key) => !told.has(key));
    const command = this.#options.command();
    if (fresh.length === 0 || command === null) {
      this.#remember(keys);
      return { sent: false, line: null };
    }
    const line = noticeLine(items);
    const result = await (this.#options.send ?? sendNotice)(command, line, this.#options.link);
    this.#options.onResult?.({ ...result, line });
    this.#remember(result.ok ? keys : keys.filter((key) => told.has(key)));
    return { sent: result.ok, line };
  }

  #told(): Set<string> {
    try {
      const value: unknown = JSON.parse(readFileSync(join(this.#options.dataDirectory, NOTICES_FILE), "utf8"));
      const waiting = (value as { waiting?: unknown }).waiting;
      return new Set(Array.isArray(waiting) ? waiting.filter((key): key is string => typeof key === "string") : []);
    } catch {
      return new Set();
    }
  }

  #remember(keys: readonly string[]): void {
    const path = join(this.#options.dataDirectory, NOTICES_FILE);
    const staging = `${path}.new-${process.pid}`;
    writeFileSync(staging, `${JSON.stringify({ waiting: keys }, null, 2)}\n`, { mode: 0o600 });
    renameSync(staging, path);
  }
}
