import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CURSORS_FILE } from "./cursors.ts";
import { Git } from "./git.ts";
import { acquireLock } from "./lock.ts";
import { importRecords, type RecordsManifest } from "./records.ts";
import { RECORDS_BRANCH, RECORDS_DIRECTORY, RECORDS_PUSH_FILE } from "./records-repo.ts";
import { STORE_FILE } from "./store.ts";

/** How long fetching the records repo may run before it is ended. */
export const RESTORE_FETCH_TIMEOUT_MS = 10 * 60_000;

/** The files of SQLite's store beside the store itself. */
const STORE_SIDE_FILES = ["-wal", "-shm", "-journal"];

/** The records could not be restored; the data directory is as it was. */
export class RestoreError extends Error {
  constructor(why: string, options?: ErrorOptions) {
    super(`cannot restore the records: ${why}`, options);
    this.name = "RestoreError";
  }
}

export interface RestoreOptions {
  dataDirectory: string;
  /** The records repo to restore from: any remote git can fetch, such as a URL or a path on this machine. */
  remote: string;
  /**
   * Whether to set aside a store or records repo already in the data
   * directory. Without it, restoring refuses to replace them.
   */
  replace?: boolean;
  now?: () => Date;
  /** How long the fetch may run; {@link RESTORE_FETCH_TIMEOUT_MS} by default. */
  fetchTimeoutMs?: number;
}

export interface RestoreResult {
  /** The restored store. */
  storePath: string;
  /** The records repo, now a copy of the remote's, which later commits carry on from. */
  recordsDirectory: string;
  /** The records repo commit the store was restored from. */
  commit: string;
  manifest: RecordsManifest;
  /** Where what the data directory held before was set aside, or null when it held nothing to set aside. */
  setAside: string | null;
}

/**
 * Restores entail's records (spec §3, ADR-0009): clones the records repo from
 * `remote` and imports it into a fresh store in the data directory.
 *
 * entail must not be running: restoring takes the single-copy lock, so it
 * refuses while entail holds it, and the next start runs the check for marked
 * issues against the restored store.
 *
 * The records repo is cloned into the data directory's records repo, so
 * later commits carry on from its history and push to the remote as before.
 * A store or records repo already there is refused unless `replace` is set;
 * then it is set aside, never deleted, in a `before-restore-<time>` directory
 * with the change cursors and the last push state, which belong to it. The
 * clone and import are done before anything is set aside, so a failed restore
 * leaves the data directory as it was.
 *
 * @throws {RestoreError}, or {@link LockHeldError} while entail is running.
 */
export async function restoreRecords(options: RestoreOptions): Promise<RestoreResult> {
  const { dataDirectory, remote } = options;
  if (remote.trim() === "") throw new RestoreError("name the records repo to restore from");
  if (remote.startsWith("-")) throw new RestoreError(`${JSON.stringify(remote)} is not a remote git can fetch from`);
  const lock = acquireLock(dataDirectory);
  const staging = join(dataDirectory, `restoring-${process.pid}`);
  try {
    const storePath = join(dataDirectory, STORE_FILE);
    const recordsDirectory = join(dataDirectory, RECORDS_DIRECTORY);
    const held = [STORE_FILE, ...STORE_SIDE_FILES.map((suffix) => `${STORE_FILE}${suffix}`), RECORDS_DIRECTORY].filter((name) =>
      existsSync(join(dataDirectory, name)),
    );
    if (held.length > 0 && options.replace !== true) {
      throw new RestoreError(
        `${dataDirectory} already holds a store or records repo. Restore with --replace to set them aside, or move them away first`,
      );
    }

    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    const stagedRecords = join(staging, RECORDS_DIRECTORY);
    const commit = await cloneRecords(remote, stagedRecords, options.fetchTimeoutMs ?? RESTORE_FETCH_TIMEOUT_MS);
    const stagedStore = join(staging, STORE_FILE);
    let manifest: RecordsManifest;
    try {
      manifest = importRecords(stagedRecords, stagedStore);
    } catch (error) {
      throw new RestoreError(error instanceof Error ? error.message : String(error), { cause: error });
    }

    // Everything the old store kept beside it goes with it: its cursors would
    // skip changes the restored store never saw, and its push state is its own.
    const asideNames = [...held, CURSORS_FILE, RECORDS_PUSH_FILE].filter((name) => existsSync(join(dataDirectory, name)));
    let setAside: string | null = null;
    if (asideNames.length > 0) {
      const stamp = (options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
      setAside = join(dataDirectory, `before-restore-${stamp}`);
      mkdirSync(setAside, { mode: 0o700 });
      for (const name of asideNames) renameSync(join(dataDirectory, name), join(setAside, name));
    }
    for (const suffix of ["", ...STORE_SIDE_FILES]) {
      if (existsSync(`${stagedStore}${suffix}`)) renameSync(`${stagedStore}${suffix}`, `${storePath}${suffix}`);
    }
    renameSync(stagedRecords, recordsDirectory);
    return { storePath, recordsDirectory, commit, manifest, setAside };
  } finally {
    rmSync(staging, { recursive: true, force: true });
    lock.release();
  }
}

/**
 * Clones the records repo's branch into `directory`, as a repository whose
 * branch is the remote's, so the records repo's later commits follow it.
 */
async function cloneRecords(remote: string, directory: string, timeoutMs: number): Promise<string> {
  const git = new Git(join(directory, ".git"), [
    // Like the records repo itself, the clone runs nothing of the owner's git configuration.
    "core.hooksPath=/dev/null",
    "core.excludesFile=/dev/null",
    "core.autocrlf=false",
  ]);
  const work = (args: string[]) => git.run([`--work-tree=${directory}`, ...args]);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    await work(["init", "--quiet", `--initial-branch=${RECORDS_BRANCH}`]);
    await git.run(["fetch", "--quiet", "--no-tags", remote, `+refs/heads/${RECORDS_BRANCH}:refs/remotes/restored/${RECORDS_BRANCH}`], {
      timeoutMs,
    });
    await work(["reset", "--quiet", "--hard", `refs/remotes/restored/${RECORDS_BRANCH}`]);
    return (await git.text(["rev-parse", "HEAD"])).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RestoreError(`its branch ${RECORDS_BRANCH} could not be fetched from ${remote}: ${message}`, { cause: error });
  }
}
