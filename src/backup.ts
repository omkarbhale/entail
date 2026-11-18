import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER_CASE_BOOK } from "./case-book.ts";
import { Git, GitError, runGitCommand } from "./git.ts";
import type { OperationalLog } from "./operational-log.ts";
import { PINS_DIRECTORY } from "./pins.ts";
import { LOG_DIRECTORY, loggedRepos, readLog, SETTINGS_FILE } from "./records.ts";

/**
 * The backup of entail's records to a git remote the owner names.
 *
 * The data directory itself is the work tree of a git repository, its
 * metadata in `.git` there, so nothing about where entail keeps its files
 * changes. A `.gitignore` entail writes lets in only the records: each repo's
 * log, the owner's case book, the settings and the pins. The lock, the
 * mirrors and their checkouts, the cursors, the notices told and the
 * operational log are this machine's own and are never committed.
 *
 * With no remote set nothing happens at all: no repository is made and
 * nothing is pushed. Once one is set, after each pass entail commits whatever
 * changed with a one-line message and pushes to the remote's `main`, with the
 * owner's own `git` and whatever credentials the remote URL and git's own
 * configuration carry; entail holds no token.
 *
 * One machine writes and any other only restores. A push the remote refuses
 * because it has moved on since entail last pushed, as when a second machine
 * pushed to it, is never merged or forced: entail keeps committing here,
 * stops trying to make the remote take it, and records why. The owner sorts
 * the remote out by hand, and backup resumes on the first push that
 * fast-forwards it.
 */

/** The branch on the remote that holds the records. */
export const BACKUP_BRANCH = "main";

/** What the backup holds: the records, and the `.gitignore` that says so. Anything else in the data directory stays on this machine. */
export const BACKUP_IGNORE = `# Written by entail: its backup holds only the records listed here.
# Everything else in this directory belongs to this machine alone.
/*
!/.gitignore
!/${SETTINGS_FILE}
!/${LOG_DIRECTORY}/
!/${OWNER_CASE_BOOK}/
!/${PINS_DIRECTORY}/
# A case being replaced is staged in a hidden directory first.
/${OWNER_CASE_BOOK}/.*
`;

/** Where the backup's own state is kept: inside `.git`, so the data directory's layout stays as it was. */
const STATE_FILE = "entail-backup.json";

/** How long a push may wait on the network before it counts as failed. */
const PUSH_TIMEOUT_MS = 120_000;
/** How long a restore's clone may take. */
const CLONE_TIMEOUT_MS = 600_000;

/** Why the last push did not reach the remote. */
export interface BackupProblem {
  /**
   * `stuck`: the remote has moved on since entail last pushed, so entail stops
   * pushing until a push fast-forwards it again. `failed`: the push did not
   * get through (the network, credentials, a missing remote) and is tried
   * again after the next pass.
   */
  kind: "stuck" | "failed";
  /** ISO time the problem began. */
  since: string;
  reason: string;
}

/** What the backup last did, for `entail backup status`, `entail status` and the board. */
export interface BackupState {
  /** The remote the rest of this state is about. */
  remote: string | null;
  /** The commit the remote last took, or null before the first push. */
  pushed: string | null;
  /** ISO time of the last push the remote took. */
  pushedAt: string | null;
  problem: BackupProblem | null;
}

const NO_STATE: BackupState = { remote: null, pushed: null, pushedAt: null, problem: null };

/** What one backup did. */
export type BackupOutcome =
  /** No remote is set: nothing was done. */
  | { kind: "off" }
  /** Nothing changed since the last push. */
  | { kind: "unchanged" }
  | { kind: "pushed"; commit: string }
  | { kind: "stuck"; reason: string }
  | { kind: "failed"; reason: string };

export interface BackupOptions {
  /** Where pushes and problems are recorded; nowhere when left out. */
  log?: OperationalLog | null;
  now?: () => Date;
}

/** The backup's state as last written, or nothing done yet. */
export function readBackupState(dataDirectory: string): BackupState {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDirectory, ".git", STATE_FILE), "utf8")) as Partial<BackupState>;
    return {
      remote: typeof parsed.remote === "string" ? parsed.remote : null,
      pushed: typeof parsed.pushed === "string" ? parsed.pushed : null,
      pushedAt: typeof parsed.pushedAt === "string" ? parsed.pushedAt : null,
      problem: isProblem(parsed.problem) ? parsed.problem : null,
    };
  } catch {
    return NO_STATE;
  }
}

function isProblem(value: unknown): value is BackupProblem {
  if (typeof value !== "object" || value === null) return false;
  const problem = value as Record<string, unknown>;
  return (problem.kind === "stuck" || problem.kind === "failed") && typeof problem.since === "string" && typeof problem.reason === "string";
}

function writeBackupState(dataDirectory: string, state: BackupState): void {
  const path = join(dataDirectory, ".git", STATE_FILE);
  const staging = `${path}.new-${process.pid}`;
  writeFileSync(staging, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(staging, path);
}

/** The repository whose work tree is the data directory, run with an identity, signing and hooks that do not depend on the owner's git configuration. */
function repository(dataDirectory: string): { git: Git; run: (args: string[], okExitCodes?: number[], timeoutMs?: number) => Promise<{ stdout: string; exitCode: number }> } {
  const git = new Git(join(dataDirectory, ".git"), ["user.name=entail", "user.email=entail@localhost", "commit.gpgSign=false", "core.autocrlf=false"]);
  return {
    git,
    run: async (args, okExitCodes = [], timeoutMs) => {
      const result = await git.run([`--work-tree=${dataDirectory}`, ...args], { okExitCodes, cwd: dataDirectory, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
      return { stdout: result.stdout.toString("utf8"), exitCode: result.exitCode };
    },
  };
}

/**
 * Commits the records that changed and pushes them to `remote`; does nothing
 * when `remote` is null. A failure is recorded and returned, never thrown:
 * a backup that cannot run never stops a pass.
 */
export async function backUp(dataDirectory: string, remote: string | null, options: BackupOptions = {}): Promise<BackupOutcome> {
  if (remote === null) return { kind: "off" };
  const now = options.now ?? (() => new Date());
  const log = options.log ?? null;
  let state = readBackupState(dataDirectory);
  // A new remote starts afresh: what an old one took or refused says nothing about it.
  if (state.remote !== remote) state = { ...NO_STATE, remote };
  const shown = shownRemote(remote);

  let head: string;
  const { run } = repository(dataDirectory);
  try {
    await prepare(dataDirectory, remote);
    await run(["add", "--all"]);
    const staged = (await run(["diff", "--cached", "--quiet"], [1])).exitCode === 1;
    if (staged) await run(["commit", "--quiet", "--no-verify", "-m", `Back up entail's records at ${now().toISOString()}`]);
    head = (await run(["rev-parse", "HEAD"])).stdout.trim();
  } catch (error) {
    return failed(dataDirectory, state, `entail could not commit its records: ${message(error)}`, now(), log, shown);
  }
  if (head === state.pushed) return { kind: "unchanged" };

  let push: { stdout: string; exitCode: number };
  try {
    push = await run(["push", "--porcelain", "--no-verify", "origin", `HEAD:refs/heads/${BACKUP_BRANCH}`], [1], PUSH_TIMEOUT_MS);
  } catch (error) {
    return failed(dataDirectory, state, `the push to ${shown} failed: ${message(error)}`, now(), log, shown);
  }
  const refused = push.stdout.split("\n").find((line) => line.startsWith("!\t"));
  if (push.exitCode !== 0) {
    if (refused !== undefined && /\[rejected\]|non-fast-forward|fetch first/u.test(refused)) {
      const why = /\(([^)]+)\)\s*$/u.exec(refused)?.[1];
      const reason = `${shown} has moved on since entail last pushed${why === undefined ? "" : ` (${why})`}: entail does not merge or overwrite it, so it keeps committing here and stops pushing until a push fast-forwards the remote again`;
      if (state.problem?.kind !== "stuck") {
        log?.warn("backup-stuck", { remote: shown, reason });
        state = { ...state, problem: { kind: "stuck", since: now().toISOString(), reason } };
      }
      writeBackupState(dataDirectory, state);
      return { kind: "stuck", reason: state.problem!.reason };
    }
    return failed(dataDirectory, state, `the push to ${shown} failed: ${(refused ?? push.stdout).trim() || `exit code ${push.exitCode}`}`, now(), log, shown);
  }
  if (state.problem !== null) log?.info("backup-resumed", { remote: shown, was: state.problem.kind });
  log?.info("backup-pushed", { remote: shown, commit: head });
  writeBackupState(dataDirectory, { remote, pushed: head, pushedAt: now().toISOString(), problem: null });
  return { kind: "pushed", commit: head };
}

function failed(dataDirectory: string, state: BackupState, reason: string, at: Date, log: OperationalLog | null, shown: string): BackupOutcome {
  log?.warn("backup-failed", { remote: shown, reason });
  const problem: BackupProblem = state.problem?.kind === "failed" ? { ...state.problem, reason } : { kind: "failed", since: at.toISOString(), reason };
  if (existsSync(join(dataDirectory, ".git"))) writeBackupState(dataDirectory, { ...state, problem });
  return { kind: "failed", reason };
}

/** Makes the data directory a repository if it is not one yet, writes the `.gitignore` and points `origin` at the remote. */
async function prepare(dataDirectory: string, remote: string): Promise<void> {
  if (!existsSync(join(dataDirectory, ".git"))) {
    await runGitCommand(["init", "--quiet", `--initial-branch=${BACKUP_BRANCH}`, dataDirectory]);
  }
  const ignore = join(dataDirectory, ".gitignore");
  if (readIfPresent(ignore) !== BACKUP_IGNORE) writeFileSync(ignore, BACKUP_IGNORE, { mode: 0o600 });
  const { run } = repository(dataDirectory);
  const current = await run(["remote", "get-url", "origin"], [2]);
  if (current.exitCode === 2) await run(["remote", "add", "origin", remote]);
  else if (current.stdout.trim() !== remote) await run(["remote", "set-url", "origin", remote]);
}

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function message(error: unknown): string {
  if (error instanceof GitError) return error.stderr.trim().split("\n").filter((line) => line.trim() !== "").pop() ?? error.message;
  return error instanceof Error ? error.message : String(error);
}

/** A remote as entail shows it: a password or token written into the URL is hidden. */
export function shownRemote(remote: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(remote) || !URL.canParse(remote)) return remote;
  const url = new URL(remote);
  if (url.password === "") return remote;
  url.password = "***";
  return url.toString();
}

/** A remote as `entail settings --backup` takes it: one line, not starting with `-` so git never reads it as an option. */
export function checkRemote(remote: string): string | null {
  const trimmed = remote.trim();
  if (trimmed === "" || /[\r\n]/u.test(trimmed) || trimmed.startsWith("-")) return null;
  return trimmed;
}

/** What a restore brought back. */
export interface RestoreReport {
  /** The repos with a log, each with how many entries it holds. */
  repos: { repo: string; entries: number }[];
  /** The cases in the owner's case book. */
  cases: number;
  /** The repos with pins. */
  pins: number;
  settings: boolean;
  /** The last commit restored, and when it was made. */
  commit: string;
  committedAt: string;
}

/** Refused: the data directory already holds something, and a restore never mixes into or replaces it. */
export class RestoreRefusedError extends Error {
  constructor(dataDirectory: string, found: string[]) {
    const shown = found.slice(0, 5).join(", ") + (found.length > 5 ? ", …" : "");
    super(`${dataDirectory} is not empty (${shown}): entail restores only into an empty data directory, on a machine where it has not run yet`);
    this.name = "RestoreRefusedError";
  }
}

/**
 * Restores the records from a backup remote into an empty data directory:
 * clones the remote's `main` there, so the log, case book, settings and pins
 * come back where entail reads them, and the clone is the backup repository
 * from then on. Refuses a data directory that holds anything.
 */
export async function restore(dataDirectory: string, remote: string, now: () => Date = () => new Date()): Promise<RestoreReport> {
  const found = existsSync(dataDirectory) ? readdirSync(dataDirectory) : [];
  if (found.length > 0) throw new RestoreRefusedError(dataDirectory, found);
  await runGitCommand(["clone", "--quiet", "--branch", BACKUP_BRANCH, "--", remote, dataDirectory], { timeoutMs: CLONE_TIMEOUT_MS });
  const { run } = repository(dataDirectory);
  const [commit, committedAt] = (await run(["log", "-1", "--format=%H%n%cI"])).stdout.trim().split("\n");
  // The remote already holds what was cloned, so the first backup after this pushes only what changes.
  writeBackupState(dataDirectory, { remote, pushed: commit!, pushedAt: now().toISOString(), problem: null });
  return {
    repos: loggedRepos(dataDirectory).map((repo) => ({ repo, entries: readLog(dataDirectory, repo).length })),
    cases: countDirectories(join(dataDirectory, OWNER_CASE_BOOK)),
    pins: countFiles(join(dataDirectory, PINS_DIRECTORY)),
    settings: existsSync(join(dataDirectory, SETTINGS_FILE)),
    commit: commit!,
    committedAt: committedAt!,
  };
}

function countDirectories(directory: string): number {
  try {
    return readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).length;
  } catch {
    return 0;
  }
}

function countFiles(directory: string): number {
  try {
    return readdirSync(directory, { recursive: true }).filter((name) => statSync(join(directory, String(name))).isFile()).length;
  } catch {
    return 0;
  }
}
