// One acceptance run or reset at a time per fixture repo. Two runs on the
// same fixture reset it under each other and invalidate both, so whatever
// writes to a fixture repo (the acceptance test, the harness's setup, reset,
// executor and play) first takes an exclusive lock on it: a file named for
// the fixture under a directory every checkout on this machine shares,
// holding who took it. A lock whose holder is gone stays until it is broken
// on purpose, with `--break-lock`.
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

/** The fixture repo a lock covers. */
export interface LockTarget {
  readonly kind: string;
  readonly host: string;
  readonly path: string;
}

/** What a lock file records about the process holding it. */
export interface LockHolder {
  fixture: string;
  pid: number;
  host: string;
  startedAt: string;
  command: string;
  /** Tells this holder's file from a later one at the same path. */
  token: string;
}

export interface LockOptions {
  /** Break a lock whose holder is gone (or cannot be checked from this host). Never breaks a live holder's lock. */
  breakStale?: boolean;
  /** Where lock files go (default: {@link lockDirectory}). */
  directory?: string;
  /** What the holder is doing, for the refusal message (default: this process's command line). */
  command?: string;
}

export class FixtureLockedError extends Error {
  readonly holder: LockHolder | undefined;
  /** Whether the holder is known to be gone, so `--break-lock` may take the lock. */
  readonly stale: boolean;

  constructor(message: string, holder: LockHolder | undefined, stale: boolean) {
    super(message);
    this.holder = holder;
    this.stale = stale;
  }
}

/**
 * The directory lock files go in: `ENTAIL_ACCEPTANCE_LOCK_DIR` when set,
 * otherwise `entail-acceptance/locks` under `XDG_STATE_HOME` (or
 * `~/.local/state`), shared by every checkout and worktree of entail.
 */
export function lockDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ENTAIL_ACCEPTANCE_LOCK_DIR) return env.ENTAIL_ACCEPTANCE_LOCK_DIR;
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "entail-acceptance", "locks");
}

/** The fixture's name in messages: `github github.com/owner/name`. */
export function fixtureName(target: LockTarget): string {
  return `${target.kind} ${target.host}/${target.path}`;
}

/** The lock file for a fixture: one per forge, host and repo path. */
export function lockFile(target: LockTarget, directory = lockDirectory()): string {
  return join(directory, `${encodeURIComponent(`${target.kind}:${target.host}/${target.path.toLowerCase()}`)}.lock`);
}

/** Whether a process with this pid exists on this host. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readHolder(file: string): LockHolder | undefined {
  try {
    const holder = JSON.parse(readFileSync(file, "utf8")) as Partial<LockHolder>;
    return typeof holder.pid === "number" && typeof holder.host === "string" ? (holder as LockHolder) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a holder is known to be gone: a process on this host that no
 * longer exists, or a lock file that records no holder at all.
 */
function holderGone(holder: LockHolder | undefined): boolean {
  if (holder === undefined) return true;
  return holder.host === hostname() && !alive(holder.pid);
}

/** Locks this process holds, by file, with how many times each was taken. */
const held = new Map<string, { holder: LockHolder; count: number }>();

process.once("exit", () => {
  for (const [file, { holder }] of held) removeIfOurs(file, holder);
});

function removeIfOurs(file: string, holder: LockHolder): void {
  if (readHolder(file)?.token !== holder.token) return;
  try {
    unlinkSync(file);
  } catch {
    // Already gone.
  }
}

/** A lock this process holds on one fixture repo. */
export class FixtureLock {
  readonly file: string;
  readonly holder: LockHolder;
  #released = false;

  constructor(file: string, holder: LockHolder) {
    this.file = file;
    this.holder = holder;
  }

  /** Lets the lock go. Taken twice in this process, it is let go on the second release. */
  release(): void {
    if (this.#released) return;
    this.#released = true;
    const entry = held.get(this.file);
    if (entry === undefined || entry.holder.token !== this.holder.token) return;
    entry.count -= 1;
    if (entry.count > 0) return;
    held.delete(this.file);
    removeIfOurs(this.file, this.holder);
  }
}

function refusal(target: LockTarget, holder: LockHolder | undefined, gone: boolean, file: string): FixtureLockedError {
  const who =
    holder === undefined
      ? `a lock file that names no holder (${file})`
      : `pid ${holder.pid} on ${holder.host}, since ${holder.startedAt} (${holder.command})`;
  const what = `${fixtureName(target)} is in use by another acceptance run or reset: ${who}.`;
  const next = gone
    ? " That process is gone: run again with --break-lock to take the lock."
    : holder !== undefined && holder.host !== hostname()
      ? ` It was taken on another host, so it cannot be checked from here: once that run is over, run again with --break-lock.`
      : " Wait for it to finish; two runs on one fixture reset it under each other.";
  return new FixtureLockedError(what + next, holder, gone);
}

/**
 * Takes the lock on a fixture repo, or throws {@link FixtureLockedError}
 * naming its holder. A process that already holds it takes it again.
 */
export function acquireFixtureLock(target: LockTarget, options: LockOptions = {}): FixtureLock {
  const directory = options.directory ?? lockDirectory();
  const file = lockFile(target, directory);
  const mine = held.get(file);
  if (mine !== undefined && readHolder(file)?.token === mine.holder.token) {
    mine.count += 1;
    return new FixtureLock(file, mine.holder);
  }
  mkdirSync(directory, { recursive: true });
  const holder: LockHolder = {
    fixture: fixtureName(target),
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    command: options.command ?? process.argv.slice(1).join(" "),
    token: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
  for (let attempt = 1; ; attempt += 1) {
    try {
      writeFileSync(file, `${JSON.stringify(holder, null, 2)}\n`, { flag: "wx" });
      held.set(file, { holder, count: 1 });
      return new FixtureLock(file, holder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const current = readHolder(file);
    const gone = holderGone(current);
    const unverifiable = current !== undefined && current.host !== hostname();
    if (attempt > 1 || !options.breakStale || !(gone || unverifiable)) throw refusal(target, current, gone, file);
    try {
      unlinkSync(file);
    } catch {
      // Someone else broke it first; the next attempt finds out who holds it now.
    }
  }
}

/** Runs `work` holding the lock on a fixture repo, and lets the lock go after. */
export async function withFixtureLock<T>(target: LockTarget, options: LockOptions, work: () => Promise<T>): Promise<T> {
  const lock = acquireFixtureLock(target, options);
  try {
    return await work();
  } finally {
    lock.release();
  }
}

/**
 * Refuses a live run inside a no-mistakes review pipeline (which sets
 * `NO_MISTAKES_GATE`): a pipeline's test step validates a change with
 * `npm test`, and a live run there would reset a fixture repo under a graded
 * run. Live runs go only through the acceptance and harness commands, run by
 * hand.
 */
export function refuseInsidePipeline(command: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!env.NO_MISTAKES_GATE) return;
  throw new Error(
    `${command} runs live against the real fixture repos, and never inside a review pipeline (NO_MISTAKES_GATE is set). Validate with \`npm test\`; run the acceptance test by hand.`,
  );
}
