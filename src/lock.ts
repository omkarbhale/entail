import { linkSync, openSync, readFileSync, renameSync, unlinkSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";

/** What the lock file says about the copy of entail holding it. */
export interface LockHolder {
  pid: number;
  /** ISO time the holder started. */
  startedAt: string;
}

/** A lock found on start whose holder no longer exists: an unexpected stop. */
export interface LockTakeover {
  /** The dead holder, or null when the lock file could not be read. */
  previous: LockHolder | null;
  /** ISO time the stale lock was found and taken over. */
  detectedAt: string;
}

export interface HeldLock {
  path: string;
  holder: LockHolder;
  /** Set when this start took over a lock left by a dead process. */
  takeover: LockTakeover | null;
  /** Removes the lock file, if it is still this process's lock. */
  release(): void;
}

export const LOCK_FILE = "entail.lock";

/** Another copy of entail is running and holds the lock. */
export class LockHeldError extends Error {
  readonly holder: LockHolder;
  constructor(path: string, holder: LockHolder) {
    super(`already running (pid ${holder.pid}, started ${holder.startedAt}); lock: ${path}`);
    this.name = "LockHeldError";
    this.holder = holder;
  }
}

export interface AcquireOptions {
  pid?: number;
  now?: () => Date;
  /** Whether a process with this pid exists. Replaceable in tests. */
  isAlive?: (pid: number) => boolean;
}

/**
 * Takes the single-copy lock in the data directory, so one copy of entail
 * runs per machine (ADR-0017).
 *
 * - A lock held by a live process throws {@link LockHeldError}.
 * - A lock left by a process that no longer exists is taken over, and the
 *   takeover is returned so it can be logged as an unexpected stop (ADR-0019).
 */
export function acquireLock(dataDirectory: string, options: AcquireOptions = {}): HeldLock {
  const pid = options.pid ?? process.pid;
  const now = options.now ?? (() => new Date());
  const isAlive = options.isAlive ?? processExists;
  const path = join(dataDirectory, LOCK_FILE);
  const holder: LockHolder = { pid, startedAt: now().toISOString() };
  const content = `${JSON.stringify(holder)}\n`;

  let takeover: LockTakeover | null = null;
  // A few rounds cover a race with another copy starting at the same moment.
  for (let attempt = 0; attempt < 5; attempt++) {
    if (tryCreate(path, content)) {
      return heldLock(path, holder, takeover, pid);
    }
    const existingText = readIfPresent(path);
    if (existingText === null) continue; // removed between our create and read
    const existing = parseHolder(existingText);
    if (existing && existing.pid !== pid && isAlive(existing.pid)) {
      throw new LockHeldError(path, existing);
    }
    // Stale: its holder is gone (or the file is unreadable). Move it aside
    // atomically, and check we moved the lock we judged and not a fresh one.
    const aside = `${path}.stale-${pid}`;
    try {
      renameSync(path, aside);
    } catch (error) {
      if (isCode(error, "ENOENT")) continue;
      throw error;
    }
    const movedText = readIfPresent(aside);
    if (movedText !== existingText) {
      // Another copy replaced the stale lock first; put its lock back.
      try {
        linkSync(aside, path);
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
      }
      unlinkSync(aside);
      continue;
    }
    unlinkSync(aside);
    takeover = { previous: existing, detectedAt: now().toISOString() };
  }
  throw new Error(`could not take the lock at ${path}`);
}

/** Reads the lock without taking it; null when no lock file exists. */
export function readLock(dataDirectory: string): LockHolder | null {
  const text = readIfPresent(join(dataDirectory, LOCK_FILE));
  return text === null ? null : parseHolder(text);
}

/** Whether a process with this pid exists on this machine. */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to another user.
    return isCode(error, "EPERM");
  }
}

function heldLock(path: string, holder: LockHolder, takeover: LockTakeover | null, pid: number): HeldLock {
  let released = false;
  return {
    path,
    holder,
    takeover,
    release() {
      if (released) return;
      released = true;
      const current = readIfPresent(path);
      if (current !== null && parseHolder(current)?.pid === pid) {
        try {
          unlinkSync(path);
        } catch (error) {
          if (!isCode(error, "ENOENT")) throw error;
        }
      }
    },
  };
}

/**
 * Writes the lock in full to a private file, then links it into place, so the
 * lock never exists half-written and the link fails if a lock already exists.
 */
function tryCreate(path: string, content: string): boolean {
  const staging = `${path}.new-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const fd = openSync(staging, "wx", 0o600);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(staging, path);
    return true;
  } catch (error) {
    if (isCode(error, "EEXIST")) return false;
    throw error;
  } finally {
    unlinkSync(staging);
  }
}

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (isCode(error, "ENOENT")) return null;
    throw error;
  }
}

function parseHolder(text: string): LockHolder | null {
  try {
    const value: unknown = JSON.parse(text);
    if (
      typeof value === "object" &&
      value !== null &&
      "pid" in value &&
      "startedAt" in value &&
      Number.isInteger(value.pid) &&
      (value.pid as number) > 0 &&
      typeof value.startedAt === "string"
    ) {
      return { pid: value.pid as number, startedAt: value.startedAt };
    }
  } catch {
    // fall through: unreadable lock
  }
  return null;
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
