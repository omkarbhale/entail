import { execFile } from "node:child_process";

/** The local tools all of entail needs (ADR-0019). */
export const TOOLS = ["git", "claude"] as const;
export type Tool = (typeof TOOLS)[number];

/** What is wrong with one tool: it does not run, or `claude` is not logged in. */
export interface ToolProblem {
  tool: Tool;
  problem: "missing" | "logged-out";
  /** What the check saw, for the strip and the operational log. */
  detail: string;
}

/**
 * Checks that `git` and `claude` are present and `claude` is logged in,
 * resolving every problem found; none means entail may work. It runs at
 * start and on every pass (spec §1 "Start" step 3, §16), and never throws.
 */
export type ToolCheck = () => Promise<ToolProblem[]>;

/** How long one check command may run. */
const CHECK_TIMEOUT_MS = 30_000;

interface Ran {
  ok: boolean;
  /** Set when the program could not be started at all. */
  spawnError: NodeJS.ErrnoException | null;
  stdout: string;
  stderr: string;
}

function run(file: string, args: string[]): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: CHECK_TIMEOUT_MS, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      const spawnError = error !== null && typeof (error as NodeJS.ErrnoException).code === "string" ? (error as NodeJS.ErrnoException) : null;
      resolve({ ok: error === null, spawnError, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/**
 * The real check: `git --version` runs, and `claude auth status --json`
 * reports `"loggedIn": true`. git has no login of its own; a forge's login
 * is its host's check (spec §16).
 */
export const checkTools: ToolCheck = async () => {
  const [git, claude] = await Promise.all([run("git", ["--version"]), run("claude", ["auth", "status", "--json"])]);
  const problems: ToolProblem[] = [];
  if (!git.ok) problems.push({ tool: "git", problem: "missing", detail: failureText("git", git) });
  if (claude.spawnError !== null) {
    problems.push({ tool: "claude", problem: "missing", detail: failureText("claude", claude) });
  } else if (!loggedIn(claude.stdout)) {
    problems.push({ tool: "claude", problem: "logged-out", detail: "claude auth status reports no login" });
  }
  return problems;
};

/** Whether `claude auth status --json` printed a status that is logged in. */
export function loggedIn(stdout: string): boolean {
  try {
    const status: unknown = JSON.parse(stdout.trim());
    return typeof status === "object" && status !== null && (status as { loggedIn?: unknown }).loggedIn === true;
  } catch {
    return false;
  }
}

function failureText(name: string, ran: Ran): string {
  if (ran.spawnError?.code === "ENOENT") return `${name} is not installed or not on the PATH`;
  if (ran.spawnError !== null) return `${name} could not be started: ${ran.spawnError.message}`;
  const output = (ran.stderr || ran.stdout).trim().split("\n").at(-1) ?? "";
  return output === "" ? `${name} failed` : `${name} failed: ${output.slice(0, 200)}`;
}
