import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readGlobalSettings } from "./global-settings.ts";
import { cliOf } from "./host-login.ts";
import type { HeldLock } from "./lock.ts";
import type { ModelRuns } from "./model-runs.ts";
import { makeNotice, type Notifier } from "./notice.ts";
import type { OperationalLog } from "./operational-log.ts";
import type { Passes } from "./pass.ts";
import { readRecordsPushState } from "./records-repo.ts";
import type { RecordsCheck } from "./records-check.ts";
import { readRepoSettings } from "./repo-settings.ts";
import type { Store } from "./store.ts";

/** The status file in the data directory, rewritten on every pass (ADR-0019). */
export const STATUS_FILE = "status.json";
/** The status file's shape; a reader skips a file of another version. */
export const STATUS_VERSION = 1;

/** A ticket's model step failing this long in a row is warned about (spec §16). */
export const TICKET_FAILING_WARN_MS = 60 * 60_000;
/** Every model run failing this long is warned about (spec §16). */
export const ALL_RUNS_FAILING_WARN_MS = 15 * 60_000;
/** A repo failing to poll this long is warned about; below it, it is only logged (spec §16). */
export const POLL_FAILING_WARN_MS = 15 * 60_000;
/** No records push succeeding this long while a remote is set is warned about, and notified (spec §16). */
export const RECORDS_PUSH_WARN_MS = 24 * 60 * 60_000;
/** Three unexpected stops within this long send the "entail keeps stopping" notice (spec §16). */
export const KEEPS_STOPPING_WINDOW_MS = 10 * 60_000;
export const KEEPS_STOPPING_COUNT = 3;

/** What a condition covers: all of entail, all model work, one host's repos, or one repo. */
export type HealthScope =
  | { kind: "entail" }
  | { kind: "model" }
  | { kind: "host"; forge: string; host: string }
  | { kind: "repo"; repoId: number }
  | { kind: "records" }
  | { kind: "notices" };

/**
 * One halt or warning (spec §16, ADR-0019). A halt is work entail stops on
 * its own because something outside it is wrong, and it clears by itself; a
 * warning is work that goes on but needs watching. Neither is a call, a
 * board item or a record: the operational log and the status file hold them.
 */
export interface HealthCondition {
  /** Stays the same while the condition lasts, so its onset is kept and its notice sent once. */
  key: string;
  kind: "halt" | "warning";
  scope: HealthScope;
  /** What is wrong, as one sentence with no closing full stop. */
  wrong: string;
  /** What it stops, read with "since <onset>" after it. */
  stops: string;
  /** What clears it. */
  clears: string;
  /** When it began, as ISO. */
  since: string;
  /** Whether the owner must fix it by hand, so one notice goes out when it begins. */
  notify: boolean;
}

/** What the passes know about health. */
export type PassHealth = Pick<Passes, "toolsHalted" | "hostLoginHalts" | "hostsUnanswered" | "polling" | "visionGoneSince" | "lastPassAt">;
/** What the model runs know about health. */
export type ModelHealth = Pick<ModelRuns, "pausedSince" | "pausedUntil" | "loggedOutSince" | "failing" | "retryStates">;

export interface HealthOptions {
  store: Store;
  dataDirectory: string;
  log: OperationalLog;
  /** The lock this process holds: its pid and start, and any unexpected stop it found. */
  lock: Pick<HeldLock, "holder" | "takeover">;
  passes?: PassHealth;
  modelRuns?: ModelHealth;
  recordsCheck?: Pick<RecordsCheck, "standing">;
  notifier?: Pick<Notifier, "lastFailure" | "notify">;
  /** The Repos page's link, which a health notice carries; null until the server is up, and notices wait until then. */
  reposLink?: () => string | null;
}

/** One repo as the status file shows it. */
export interface RepoStatus {
  id: number;
  forge: string;
  host: string;
  path: string;
  /** The owner's pause, a halt, backing off or active. */
  state: string;
  lastSuccessfulPoll: string | null;
}

/** The status file: what `entail status` reads, whether or not entail is running (ADR-0019). */
export interface StatusFile {
  version: typeof STATUS_VERSION;
  pid: number;
  startedAt: string;
  writtenAt: string;
  lastPass: string | null;
  conditions: HealthCondition[];
  /** Standing lines that are never on the strip, such as no records remote being set. */
  standing: string[];
  repos: RepoStatus[];
  /** Every unexpected stop found in the last day, as ISO. */
  unexpectedStops: string[];
  /** When the "entail keeps stopping" notice last went out, as ISO. */
  keepsStoppingNoticeAt: string | null;
}

/** What every page's header shows of health: the strip's lines, or when the last pass ran. */
export interface PageHealth {
  /** Every halt and warning, halts first; empty when all is well. */
  strip: readonly HealthCondition[];
  lastPass: string | null;
}

/**
 * entail's own health (spec §16, ADR-0019). On every pass it works out each
 * halt and warning from what the running process knows, then:
 *
 * - keeps each condition's onset while it lasts, and logs when one begins
 *   and when it clears;
 * - sends one health notice, through the board-item notice connector, when
 *   a halt the owner must fix by hand begins, and none when it clears;
 * - rewrites the status file `entail status` reads.
 *
 * Health stays off the forge, the board and the records: nothing here
 * writes to any of them.
 */
export class Health {
  readonly #options: HealthOptions;
  #current = new Map<string, HealthCondition>();
  /** Conditions the last process left in the status file: carried on, they keep their onset and send no second notice. */
  #inherited: Map<string, HealthCondition>;
  /** Notices whose condition began before the Repos page could be linked. */
  readonly #owed = new Set<string>();
  #unexpectedStops: string[];
  #keepsStoppingNoticeAt: string | null;

  constructor(options: HealthOptions) {
    this.#options = options;
    const previous = readStatusFile(options.dataDirectory);
    this.#inherited = new Map((previous?.conditions ?? []).map((condition) => [condition.key, condition]));
    const now = Date.now();
    this.#unexpectedStops = (previous?.unexpectedStops ?? []).filter((at) => now - Date.parse(at) < 24 * 60 * 60_000);
    this.#keepsStoppingNoticeAt = previous?.keepsStoppingNoticeAt ?? null;
    const takeover = options.lock.takeover;
    if (takeover !== null) this.#unexpectedStops.push(takeover.detectedAt);
  }

  /** Every halt and warning now, halts first, each group oldest first. */
  conditions(): HealthCondition[] {
    return [...this.#current.values()].sort(
      (a, b) => (a.kind === b.kind ? a.since.localeCompare(b.since) : a.kind === "halt" ? -1 : 1),
    );
  }

  /** What every page's header shows. */
  page(): PageHealth {
    return { strip: this.conditions(), lastPass: this.#options.passes?.lastPassAt ?? null };
  }

  /**
   * Works out every condition now, notes onsets and clears, sends the
   * notices owed, and rewrites the status file. It never throws.
   */
  async evaluate(): Promise<HealthCondition[]> {
    const { log } = this.#options;
    let observed: HealthCondition[];
    try {
      observed = this.#observe();
    } catch (error) {
      log.error("health-failed", { error: errorText(error) });
      return this.conditions();
    }
    const next = new Map<string, HealthCondition>();
    for (const condition of observed) {
      const known = this.#current.get(condition.key) ?? this.#inherited.get(condition.key);
      if (known !== undefined) {
        next.set(condition.key, { ...condition, since: earlier(known.since, condition.since) });
        continue;
      }
      next.set(condition.key, condition);
      log.write(condition.kind === "halt" ? "error" : "warn", "health-began", { key: condition.key, kind: condition.kind, wrong: condition.wrong });
      if (condition.notify) this.#owed.add(condition.key);
    }
    for (const [key, condition] of this.#current) {
      if (!next.has(key)) {
        this.#owed.delete(key);
        log.info("health-cleared", { key, kind: condition.kind });
      }
    }
    // Only the first evaluation carries on what the last process left.
    this.#inherited = new Map();
    this.#current = next;
    await this.#sendOwed();
    this.writeStatus();
    return this.conditions();
  }

  /**
   * Sends the "entail keeps stopping" notice when this start found the third
   * unexpected stop within 10 minutes, once for each run of them (spec §16).
   */
  async noticeKeepsStopping(): Promise<boolean> {
    const now = Date.now();
    const recent = this.#unexpectedStops.filter((at) => now - Date.parse(at) <= KEEPS_STOPPING_WINDOW_MS);
    if (this.#options.lock.takeover === null || recent.length < KEEPS_STOPPING_COUNT) return false;
    if (this.#keepsStoppingNoticeAt !== null && now - Date.parse(this.#keepsStoppingNoticeAt) <= KEEPS_STOPPING_WINDOW_MS) return false;
    const link = this.#options.reposLink?.() ?? null;
    if (link === null || !this.#options.notifier) return false;
    this.#keepsStoppingNoticeAt = new Date(now).toISOString();
    this.#options.log.error("keeps-stopping", { stops: recent });
    await this.#options.notifier.notify(
      makeNotice({ kind: "health", text: `entail keeps stopping: ${recent.length} unexpected stops within 10 minutes`, link }),
    );
    this.writeStatus();
    return true;
  }

  /** Rewrites the status file in one step, so a reader never sees half of it. It never throws. */
  writeStatus(): void {
    const { dataDirectory, lock, log } = this.#options;
    const status: StatusFile = {
      version: STATUS_VERSION,
      pid: lock.holder.pid,
      startedAt: lock.holder.startedAt,
      writtenAt: new Date().toISOString(),
      lastPass: this.#options.passes?.lastPassAt ?? null,
      conditions: this.conditions(),
      standing: this.#standing(),
      repos: this.#repoStatuses(),
      unexpectedStops: this.#unexpectedStops,
      keepsStoppingNoticeAt: this.#keepsStoppingNoticeAt,
    };
    const file = join(dataDirectory, STATUS_FILE);
    try {
      writeFileSync(`${file}.tmp`, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    } catch (error) {
      log.warn("status-file-failed", { error: errorText(error) });
    }
  }

  async #sendOwed(): Promise<void> {
    const { notifier } = this.#options;
    if (!notifier || this.#owed.size === 0) return;
    const link = this.#options.reposLink?.() ?? null;
    if (link === null) return;
    for (const key of [...this.#owed]) {
      this.#owed.delete(key);
      const condition = this.#current.get(key);
      if (condition === undefined) continue;
      const repo = condition.scope.kind === "repo" ? this.#options.store.getRepo(condition.scope.repoId) : null;
      await notifier.notify(makeNotice({ kind: "health", text: noticeText(condition.wrong), repo: repo?.path ?? null, link }));
    }
  }

  #standing(): string[] {
    const remote = readGlobalSettings(this.#options.store).settings.recordsRemote;
    return remote === null ? ["Records repo: no remote set. Records stay on this machine only."] : [];
  }

  #repoStatuses(): RepoStatus[] {
    const { store, passes, recordsCheck } = this.#options;
    const halted = new Map(this.conditions().filter((c) => c.kind === "halt").map((c) => [c.key, c]));
    const toolsHalted = [...halted.values()].some((c) => c.scope.kind === "entail");
    return store.listEnrolledRepos().map((repo) => {
      const polling = passes?.polling(repo.id) ?? { lastSuccess: null, failing: null };
      const records = recordsCheck?.standing(repo.id).status ?? "clear";
      const hostHalt = [...halted.values()].find((c) => c.scope.kind === "host" && c.scope.forge === repo.forge && c.scope.host === repo.host);
      let state: string;
      if (readRepoSettings(store, repo.id)?.settings.paused === true) state = "paused";
      else if (records === "missing") state = "halted: waiting for records";
      else if (toolsHalted) state = "halted: git or claude";
      else if (hostHalt !== undefined) state = `halted: ${hostHalt.wrong}`;
      else if (halted.has(`repo:${repo.id}:vision`)) state = "halted: no vision";
      else if (records === "unchecked") state = "checking records";
      else if (polling.failing !== null) state = "backing off";
      else state = "active";
      return { id: repo.id, forge: repo.forge, host: repo.host, path: repo.path, state, lastSuccessfulPoll: polling.lastSuccess };
    });
  }

  /** Every condition that holds now, from what the running process knows. */
  #observe(): HealthCondition[] {
    const { store, passes, modelRuns, recordsCheck, notifier } = this.#options;
    const now = Date.now();
    const repos = store.listEnrolledRepos();
    const conditions: HealthCondition[] = [];

    // All of entail: `git` or `claude` missing or logged out.
    const tools = passes?.toolsHalted ?? null;
    for (const problem of tools?.problems ?? []) {
      conditions.push({
        key: `entail:${problem.tool}`,
        kind: "halt",
        scope: { kind: "entail" },
        wrong: problem.problem === "logged-out" ? `${problem.tool} is not logged in` : problem.detail,
        stops: "Nothing is read, decided or merged",
        clears:
          problem.problem === "logged-out"
            ? `Log in with ${problem.tool}; entail checks again on every pass and carries on once it is logged in`
            : `entail checks again on every pass and carries on once ${problem.tool} runs`,
        since: tools!.since,
        notify: true,
      });
    }
    const loggedOutSince = modelRuns?.loggedOutSince ?? null;
    if (loggedOutSince !== null && !conditions.some((c) => c.key === "entail:claude")) {
      conditions.push({
        key: "entail:claude",
        kind: "halt",
        scope: { kind: "entail" },
        wrong: "claude is not logged in",
        stops: "No model run starts",
        clears: "Log in with claude; entail checks again on the next pass",
        since: loggedOutSince,
        notify: true,
      });
    }

    // All model work: the subscription's usage limit.
    const pausedSince = modelRuns?.pausedSince ?? null;
    const pausedUntil = modelRuns?.pausedUntil ?? null;
    if (pausedSince !== null && pausedUntil !== null) {
      conditions.push({
        key: "model:usage-limit",
        kind: "halt",
        scope: { kind: "model" },
        wrong: "The Claude subscription's usage limit is reached",
        stops: "No model run starts",
        clears: `Model work resumes at ${shownTime(pausedUntil)}`,
        since: pausedSince,
        notify: false,
      });
    }

    // One host's repos: its CLI logged out or on another account, or not answering for an hour.
    const onHost = (forge: string, host: string) => repos.filter((repo) => repo.forge === forge && repo.host === host);
    for (const halt of passes?.hostLoginHalts() ?? []) {
      const hosted = onHost(halt.forge, halt.host);
      const cli = cliOf(halt);
      conditions.push({
        key: `host:${halt.forge}:${halt.host}:${halt.problem}`,
        kind: "halt",
        scope: { kind: "host", forge: halt.forge, host: halt.host },
        wrong: halt.detail,
        stops: `${reposCount(hosted.length)} on ${halt.host} ${hosted.length === 1 ? "is" : "are"} not being read or written`,
        clears: `Log ${cli} in to ${halt.host}${hosted[0] ? ` as ${hosted[0].ownerLogin}` : ""}; entail checks again on every pass`,
        since: halt.since,
        notify: true,
      });
    }
    const unanswered = passes?.hostsUnanswered(now) ?? [];
    for (const host of unanswered) {
      const hosted = onHost(host.forge, host.host);
      conditions.push({
        key: `host:${host.forge}:${host.host}:unanswered`,
        kind: "halt",
        scope: { kind: "host", forge: host.forge, host: host.host },
        wrong: `${host.host} is not answering`,
        stops: `${reposCount(hosted.length)} ${hosted.length === 1 ? "is" : "are"} not being read`,
        clears: "entail retries every 15 minutes and carries on once a poll succeeds",
        since: host.since,
        notify: true,
      });
    }

    for (const repo of repos) {
      const named = `${repo.path} on ${repo.host}`;
      // One repo: marked issues with no records, or a vanished vision.
      const standing = recordsCheck?.standing(repo.id);
      if (standing?.status === "missing") {
        conditions.push({
          key: `repo:${repo.id}:records`,
          kind: "halt",
          scope: { kind: "repo", repoId: repo.id },
          wrong: `${named} has issues marked by entail with no records behind them`,
          stops: "Nothing is read or written in this repo",
          clears: "Restore the records with entail restore, or confirm a fresh start on the Repos page",
          since: standing.since,
          notify: true,
        });
      }
      const visionGone = passes?.visionGoneSince(repo.id) ?? null;
      if (visionGone !== null) {
        conditions.push({
          key: `repo:${repo.id}:vision`,
          kind: "halt",
          scope: { kind: "repo", repoId: repo.id },
          wrong: `VISION.md in ${named} is gone or empty`,
          stops: "Nothing new is decided or landed in this repo",
          clears: "entail carries on once VISION.md with vision lines is back on the default branch",
          since: visionGone,
          notify: true,
        });
      }
      // A repo backing off for 15 minutes or more, until its host's halt takes over at an hour.
      const failing = passes?.polling(repo.id).failing ?? null;
      const hostUnanswered = unanswered.some((host) => host.forge === repo.forge && host.host === repo.host);
      if (failing !== null && !hostUnanswered && now - Date.parse(failing.since) >= POLL_FAILING_WARN_MS) {
        conditions.push({
          key: `repo:${repo.id}:polling`,
          kind: "warning",
          scope: { kind: "repo", repoId: repo.id },
          wrong: `${named} has failed to poll: ${oneLine(failing.lastError)}`,
          stops: "Its issues are not being read",
          clears: `entail retries at ${shownTime(failing.retryAt)} and carries on once a poll succeeds`,
          since: failing.since,
          notify: false,
        });
      }
    }

    // Records push: no push succeeding for 24 hours while a remote is set.
    const remote = readGlobalSettings(store).settings.recordsRemote;
    const push = readRecordsPushState(this.#options.dataDirectory);
    const pushFailingSince = push.lastFailure?.since ?? push.lastFailure?.at ?? null;
    if (remote !== null && pushFailingSince !== null && now - Date.parse(pushFailingSince) >= RECORDS_PUSH_WARN_MS) {
      conditions.push({
        key: "records:push",
        kind: "warning",
        scope: { kind: "records" },
        wrong: "No records push has succeeded for 24 hours",
        stops: "The records repo's remote copy is falling behind",
        clears: `entail pushes again with every commit, at least hourly; the last error: ${oneLine(push.lastFailure!.error)}`,
        since: pushFailingSince,
        notify: true,
      });
    }

    // Model runs failing: a ticket's step for an hour in a row, or every run for 15 minutes.
    const failingTickets = (modelRuns?.retryStates() ?? []).filter((state) => now - Date.parse(state.failingSince) >= TICKET_FAILING_WARN_MS);
    const allFailing = modelRuns?.failing ?? null;
    const everyRun = allFailing !== null && now - Date.parse(allFailing.since) >= ALL_RUNS_FAILING_WARN_MS;
    if (failingTickets.length > 0 || everyRun) {
      const latest = failingTickets.reduce<(typeof failingTickets)[number] | null>(
        (last, state) => (last === null || state.retryAt > last.retryAt ? state : last),
        null,
      );
      const lastError = everyRun ? allFailing.lastError : latest!.lastFailure.message;
      const since = [...failingTickets.map((state) => state.failingSince), ...(everyRun ? [allFailing.since] : [])].reduce(earlier);
      const count = failingTickets.length;
      conditions.push({
        key: "model:failing",
        kind: "warning",
        scope: { kind: "model" },
        wrong: everyRun
          ? "Every model run has failed for 15 minutes or more"
          : `${count} ${count === 1 ? "ticket's model step has" : "tickets' model steps have"} failed for an hour or more`,
        stops: "Those tickets wait; each ticket page shows its retry state",
        clears: `entail keeps retrying; the last error: ${oneLine(lastError)}`,
        since,
        notify: false,
      });
    }

    // Notices failing: the last desktop notice failed.
    const noticeFailure = notifier?.lastFailure ?? null;
    if (noticeFailure !== null) {
      conditions.push({
        key: "notices:failed",
        kind: "warning",
        scope: { kind: "notices" },
        wrong: `The last ${noticeFailure.connector === null ? "" : `${noticeFailure.connector} `}notice failed: ${oneLine(noticeFailure.error)}`,
        stops: "A board item or halt may not have reached your desktop",
        clears: "The next notice that goes through clears this",
        since: noticeFailure.at.toISOString(),
        notify: false,
      });
    }

    // An unexpected stop, warned until the end of its day.
    const lastStop = this.#unexpectedStops.at(-1);
    if (lastStop !== undefined && now < endOfDay(lastStop)) {
      conditions.push({
        key: "entail:unexpected-stop",
        kind: "warning",
        scope: { kind: "entail" },
        wrong: `entail restarted after an unexpected stop at ${shownTime(lastStop)}`,
        stops: "Work in flight then was run again",
        clears: "This clears at the end of the day",
        since: lastStop,
        notify: false,
      });
    }
    return conditions;
  }
}

/** Reads the status file, or null when there is none or it cannot be read. */
export function readStatusFile(dataDirectory: string): StatusFile | null {
  try {
    const status = JSON.parse(readFileSync(join(dataDirectory, STATUS_FILE), "utf8")) as Partial<StatusFile>;
    if (status.version !== STATUS_VERSION || !Array.isArray(status.conditions) || !Array.isArray(status.repos)) return null;
    return status as StatusFile;
  } catch {
    return null;
  }
}

/** A stored ISO time, shown to the minute in UTC, as the pages show times. */
export function shownTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** The end of the local day `iso` falls on, in epoch milliseconds. */
export function endOfDay(iso: string): number {
  const at = new Date(iso);
  return new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1).getTime();
}

function reposCount(n: number): string {
  return n === 1 ? "1 repo" : `${n} repos`;
}

function earlier(a: string, b: string): string {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

/** A notice holds one short line: the condition's own sentence, cut to fit. */
function noticeText(wrong: string): string {
  const line = oneLine(wrong);
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
