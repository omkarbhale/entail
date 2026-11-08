import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Git } from "./git.ts";
import type { OperationalLog } from "./operational-log.ts";
import { exportRecords, MANIFEST_FILE, TABLES_DIRECTORY } from "./records.ts";

/** The records repo's directory in the data directory. */
export const RECORDS_DIRECTORY = "records";
/** The branch the records repo commits to and pushes. */
export const RECORDS_BRANCH = "main";
/**
 * When the records repo last pushed, kept beside it in the data directory.
 * Like the status file, it is operational state, not a record (ADR-0019).
 */
export const RECORDS_PUSH_FILE = "records-push.json";
/** entail commits at least this often while it runs (ADR-0009). */
export const RECORDS_COMMIT_INTERVAL_MS = 60 * 60 * 1000;
/** How long one push may run before it is ended, so a remote that hangs never holds up a stop for long. */
export const RECORDS_PUSH_TIMEOUT_MS = 60_000;

/** Why the records repo commits: after an answer, on the hour, or as entail stops (spec §3). */
export type RecordsCommitReason = "answer" | "hourly" | "stop";

const COMMIT_MESSAGES: Record<RecordsCommitReason, string> = {
  answer: "entail records: after an answer",
  hourly: "entail records: hourly",
  stop: "entail records: on stop",
};

/** The records repo's pushes, as entail shows them. */
export interface RecordsPushState {
  /** The last push that succeeded, or null when none has. */
  lastSuccess: { at: string; remote: string; commit: string } | null;
  /** The last push that failed, or null when none has failed since the last success. */
  lastFailure: { at: string; remote: string; error: string } | null;
}

/** What one save did. */
export interface RecordsSave {
  /** The new commit, or null when the records had not changed since the last one. */
  commit: string | null;
  push: "no-remote" | "pushed" | "failed";
}

export interface RecordsRepoOptions {
  dataDirectory: string;
  /** The store the records repo exports. */
  storePath: string;
  /** The remote the global settings name, read at every push so a saved change takes effect at the next. */
  remote: () => string | null;
  log?: OperationalLog;
  now?: () => Date;
  /** How long one push may run; {@link RECORDS_PUSH_TIMEOUT_MS} by default. */
  pushTimeoutMs?: number;
}

/**
 * The records repo (ADR-0009, spec §3): a git repository in the data
 * directory holding the store's text export. Each save writes the export,
 * commits it when it changed, and pushes to the remote the global settings
 * name. Without a remote, commits stay local.
 *
 * Saves run one at a time, in the order asked. A save never throws: a failed
 * commit or push is logged to the operational log, and a failed push is kept
 * for {@link readRecordsPushState}.
 */
export class RecordsRepo {
  readonly directory: string;
  readonly #options: RecordsRepoOptions;
  readonly #git: Git;
  #queue: Promise<unknown> = Promise.resolve();
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: RecordsRepoOptions) {
    this.#options = options;
    this.directory = join(options.dataDirectory, RECORDS_DIRECTORY);
    this.#git = new Git(join(this.directory, ".git"), [
      // The records repo's commits are entail's own, whatever the owner's git configuration holds.
      "user.name=entail",
      "user.email=entail@localhost",
      "commit.gpgSign=false",
      "core.hooksPath=/dev/null",
      "core.excludesFile=/dev/null",
      "core.autocrlf=false",
    ]);
  }

  /** Writes, commits and pushes the records, after every save already asked for. */
  save(reason: RecordsCommitReason): Promise<RecordsSave | { error: string }> {
    const saved = this.#queue.then(() => this.#save(reason));
    this.#queue = saved;
    return saved;
  }

  /** Settles once every save asked for so far is done. */
  async idle(): Promise<void> {
    await this.#queue;
  }

  /** Saves every {@link RECORDS_COMMIT_INTERVAL_MS} until {@link stopHourly}. */
  startHourly(): void {
    this.#timer ??= setInterval(() => void this.save("hourly"), RECORDS_COMMIT_INTERVAL_MS);
  }

  stopHourly(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async #save(reason: RecordsCommitReason): Promise<RecordsSave | { error: string }> {
    let commit: string | null;
    try {
      commit = await this.#commit(reason);
    } catch (error) {
      const message = errorText(error);
      this.#options.log?.error("records-commit-failed", { reason, error: message });
      return { error: message };
    }
    if (commit !== null) this.#options.log?.info("records-committed", { reason, commit });
    return { commit, push: await this.#push() };
  }

  async #commit(reason: RecordsCommitReason): Promise<string | null> {
    if (!existsSync(join(this.directory, ".git"))) {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      await this.#work(["init", "--quiet", `--initial-branch=${RECORDS_BRANCH}`]);
    }
    this.#write(exportRecords(this.#options.storePath));
    await this.#work(["add", "--all", "--", MANIFEST_FILE, TABLES_DIRECTORY]);
    const staged = await this.#work(["diff", "--cached", "--quiet"], [1]);
    if (staged.exitCode === 0) return null;
    await this.#work(["commit", "--quiet", "--no-verify", "--message", COMMIT_MESSAGES[reason]]);
    return (await this.#git.text(["rev-parse", "HEAD"])).trim();
  }

  /** Puts the export in the work tree, removing any table file it no longer has. */
  #write(files: Map<string, string>): void {
    const tables = join(this.directory, TABLES_DIRECTORY);
    mkdirSync(tables, { recursive: true });
    for (const name of readdirSync(tables)) {
      if (!files.has(`${TABLES_DIRECTORY}/${name}`)) rmSync(join(tables, name), { recursive: true, force: true });
    }
    for (const [path, text] of files) {
      const file = join(this.directory, path);
      if (!existsSync(file) || readFileSync(file, "utf8") !== text) writeFileSync(file, text);
    }
  }

  async #push(): Promise<RecordsSave["push"]> {
    const remote = this.#options.remote();
    if (remote === null) return "no-remote";
    const at = (this.#options.now?.() ?? new Date()).toISOString();
    const state = readRecordsPushState(this.#options.dataDirectory);
    let commit: string;
    try {
      commit = (await this.#git.text(["rev-parse", "--verify", "HEAD"])).trim();
      await this.#git.run(["push", "--quiet", remote, `HEAD:refs/heads/${RECORDS_BRANCH}`], {
        timeoutMs: this.#options.pushTimeoutMs ?? RECORDS_PUSH_TIMEOUT_MS,
      });
    } catch (error) {
      const message = errorText(error);
      this.#writePushState({ ...state, lastFailure: { at, remote, error: message } });
      this.#options.log?.warn("records-push-failed", { error: message });
      return "failed";
    }
    this.#writePushState({ lastSuccess: { at, remote, commit }, lastFailure: null });
    this.#options.log?.info("records-pushed", { commit });
    return "pushed";
  }

  #work(args: string[], okExitCodes: number[] = []) {
    return this.#git.run([`--work-tree=${this.directory}`, ...args], { okExitCodes });
  }

  #writePushState(state: RecordsPushState): void {
    const file = join(this.#options.dataDirectory, RECORDS_PUSH_FILE);
    try {
      writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
      renameSync(`${file}.tmp`, file);
    } catch (error) {
      this.#options.log?.warn("records-push-state-failed", { error: errorText(error) });
    }
  }
}

/** The records repo's pushes, read from the data directory whether or not entail is running. */
export function readRecordsPushState(dataDirectory: string): RecordsPushState {
  try {
    const state = JSON.parse(readFileSync(join(dataDirectory, RECORDS_PUSH_FILE), "utf8")) as Partial<RecordsPushState>;
    return { lastSuccess: state.lastSuccess ?? null, lastFailure: state.lastFailure ?? null };
  } catch {
    return { lastSuccess: null, lastFailure: null };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
