import { spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CallView, StalledView } from "./api-types.ts";
import { FAILING_NOTICE_AFTER_MS, failureReason, type Failing } from "./health.ts";
import { cmdArguments } from "./windows.ts";

/**
 * How the owner learns that something is waiting: one line and a link, sent
 * by a command the owner sets (`entail settings --notice '<command>'`). The
 * line never carries the question or any text of the issue, and nothing is
 * taken back from it: the answer is given on the board.
 *
 * The command is a shell command line; entail runs it with `/bin/sh -c`
 * and the line and the link appended as its last two arguments, so a script
 * reads them as `$1` and `$2`. On Windows it runs with `cmd.exe /d /s /c`
 * and the two appended in double quotes, so a batch file reads them as `%~1`
 * and `%~2`. They are also in its environment as
 * `ENTAIL_NOTICE_LINE` and `ENTAIL_NOTICE_LINK`. entail depends on no
 * particular sink: `examples/` holds one command that appends the line to a file and one that drops it
 * into firstmate's inbox.
 */

/** Which items the owner was last told about, so each item is announced once while it waits, and which repos they were told are failing. */
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

/** The line that tells the owner a repo has stopped working: for how long, and why. */
export function failingLine(repo: string, failing: Failing, now: Date): string {
  return `entail: ${repo} has been failing for ${span(now.getTime() - Date.parse(failing.since))}: ${failureReason(failing.last)}`;
}

/** The line that tells the owner a repo they were told was failing works again. */
export function workingLine(repo: string): string {
  return `entail: ${repo} is working again`;
}

function span(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
}

export interface NoticeResult {
  ok: boolean;
  error?: string;
}

/** Runs the notice command with the line and the link appended as its last two arguments. */
export function sendNotice(command: string, line: string, link: string, timeoutMs = NOTICE_TIMEOUT_MS): Promise<NoticeResult> {
  return new Promise((resolve) => {
    let stderr = "";
    const windows = process.platform === "win32";
    const child = spawn(windows ? "cmd.exe" : "/bin/sh", windows ? cmdArguments(`${command} ${cmdQuoted(line)} ${cmdQuoted(link)}`) : ["-c", `${command} "$@"`, "entail-notice", line, link], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, ENTAIL_NOTICE_LINE: line, ENTAIL_NOTICE_LINK: link },
      timeout: timeoutMs,
      ...(windows ? { windowsVerbatimArguments: true, windowsHide: true } : {}),
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

/** A word in double quotes for cmd.exe. The line and the link carry no quotes or `%`; one that did is dropped rather than let it end the quoting. */
function cmdQuoted(value: string): string {
  return `"${value.replace(/["%]/gu, "")}"`;
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

  /**
   * Tells the owner once when a repo has been failing for
   * {@link FAILING_NOTICE_AFTER_MS}, and once when a repo they were told of
   * works again. Which repos they were told of is kept in `notices.json`, so
   * a restart does not tell them again; a notice the command did not deliver
   * is tried again at the next check.
   */
  async health(repos: readonly { repo: string; failing: Failing | null }[], now: Date): Promise<string[]> {
    const told = new Set(this.#read().failing);
    const command = this.#options.command();
    const sent: string[] = [];
    for (const { repo, failing } of repos) {
      let line: string | null = null;
      if (failing !== null && !told.has(repo) && now.getTime() - Date.parse(failing.since) >= FAILING_NOTICE_AFTER_MS) line = failingLine(repo, failing, now);
      else if (failing === null && told.has(repo)) line = workingLine(repo);
      if (line === null) continue;
      if (command !== null) {
        const result = await (this.#options.send ?? sendNotice)(command, line, this.#options.link);
        this.#options.onResult?.({ ...result, line });
        if (!result.ok) continue;
        sent.push(line);
      }
      if (failing === null) told.delete(repo);
      else told.add(repo);
    }
    this.#write({ ...this.#read(), failing: [...told].sort() });
    return sent;
  }

  /**
   * Tells the owner once for each PR head whose landing stalled. Each is
   * remembered in `notices.json` once the command delivered it, so a restart
   * does not tell it again and a head that was not told is tried again.
   */
  async stalled(items: readonly { repo: string; stalled: Pick<StalledView, "pr" | "head" | "line"> }[]): Promise<string[]> {
    const state = this.#read();
    const told = new Set(state.stalled);
    const command = this.#options.command();
    const sent: string[] = [];
    const keys = items.map(({ repo, stalled }) => `${repo}#${stalled.pr}#${stalled.head}`);
    const kept = new Set(keys.filter((key) => told.has(key)));
    for (const [index, { repo, stalled }] of items.entries()) {
      if (kept.has(keys[index]!) || command === null) continue;
      const line = `entail: ${repo} stalled: ${stalled.line}`;
      const result = await (this.#options.send ?? sendNotice)(command, line, this.#options.link);
      this.#options.onResult?.({ ...result, line });
      if (!result.ok) continue;
      sent.push(line);
      kept.add(keys[index]!);
    }
    this.#write({ ...this.#read(), stalled: [...kept].sort() });
    return sent;
  }

  async check(items: readonly (Pick<CallView, "call" | "repo" | "kind"> & { issue: { number: number } | null; pr?: { number: number } | null })[]): Promise<{ sent: boolean; line: string | null }> {
    // A PR with no cleared ticket behind it is known by its own number.
    const keys = items.map((item) => (item.issue === null ? `${item.repo}#${item.kind}#pr-${item.pr?.number ?? 0}` : `${item.repo}#${item.kind}#${item.issue.number}`));
    const told = new Set(this.#read().waiting);
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

  #remember(keys: readonly string[]): void {
    this.#write({ ...this.#read(), waiting: [...keys] });
  }

  #read(): { waiting: string[]; failing: string[]; stalled: string[] } {
    let value: unknown = null;
    try {
      value = JSON.parse(readFileSync(join(this.#options.dataDirectory, NOTICES_FILE), "utf8"));
    } catch {
      // No notice sent yet.
    }
    const strings = (key: string): string[] => {
      const list = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
      return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
    };
    return { waiting: strings("waiting"), failing: strings("failing"), stalled: strings("stalled") };
  }

  #write(told: { waiting: string[]; failing: string[]; stalled: string[] }): void {
    const path = join(this.#options.dataDirectory, NOTICES_FILE);
    const staging = `${path}.new-${process.pid}`;
    writeFileSync(staging, `${JSON.stringify(told, null, 2)}\n`, { mode: 0o600 });
    renameSync(staging, path);
  }
}
