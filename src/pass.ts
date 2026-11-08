import { existsSync } from "node:fs";
import { join } from "node:path";
import { ChangeDeduplicator } from "./changes.ts";
import { ClaudeRunner } from "./claude-runner.ts";
import { CursorStore } from "./cursors.ts";
import { createForge } from "./forge/create-forge.ts";
import { ForgeLoggedOutError, projectKey, RateLimitedError, type Change, type Forge, type ForgeKind } from "./forge/forge.ts";
import { CliTransport } from "./forge/transport.ts";
import { Limiter, LimitedTransport } from "./forge-limit.ts";
import { ForgeWriter, InFlightWrites } from "./forge-writer.ts";
import { readGlobalSettings } from "./global-settings.ts";
import { takeInIfNew } from "./intake.ts";
import { forgeRemote, Mirror, mirrorPaths } from "./mirror.ts";
import { Git } from "./git.ts";
import { checkHostLogin, hostKey, type HostLoginProblem } from "./host-login.ts";
import type { ToolCheck, ToolProblem } from "./tool-check.ts";
import { readVision } from "./vision.ts";
import { ModelRuns } from "./model-runs.ts";
import type { OperationalLog } from "./operational-log.ts";
import { pullInOnComment } from "./pull-in.ts";
import type { RecordsCheck, RecordsStanding } from "./records-check.ts";
import type { RepoSettings } from "./repo-settings.ts";
import { latestResume } from "./repo-switches.ts";
import type { RepoRecord, SettingsVersionRecord, Store, TicketRecord } from "./store.ts";

/** A repo that failed to poll waits this long before its next poll, doubling with each failure in a row. */
export const BACKOFF_BASE_MS = 60_000;
/** The longest a failing repo waits between polls (ADR-0017). */
export const BACKOFF_MAX_MS = 15 * 60_000;
/**
 * The steps a repo whose VISION.md is gone or empty does not start: nothing
 * new is decided and nothing lands there until a vision is back (spec §4).
 */
export const VISION_HALTED_STEPS: ReadonlySet<string> = new Set(["verdict", "findings", "criteria", "landing-check", "merge"]);

/** A host none of whose repos has polled for this long is the host-not-answering halt (spec §16). */
export const HOST_UNANSWERED_HALT_MS = 60 * 60_000;

/** How long a repo that failed `failures` polls in a row waits before its next one. */
export function backoffDelay(failures: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);
}

/** The default branch head a pass checks with `git ls-remote`, fetching only when it moved. */
export interface DefaultBranchSource {
  updateDefaultBranch(): Promise<{ branch: string; commit: string; fetched: boolean }>;
}

/** What a pass knows about one repo when it works out a ticket's owed step. */
export interface RepoPass {
  repo: RepoRecord;
  forge: Forge;
  /** The repo's settings in force on this pass, re-read on every pass. */
  settings: SettingsVersionRecord;
  /** The default branch head this pass saw. */
  head: { branch: string; commit: string };
  /** A forge writer whose writes stopping waits for. */
  writer(): ForgeWriter;
  /** Where a step makes its model runs, so the limit, order, retries and pause hold across all repos. */
  modelRuns: ModelRuns;
  /** What this pass read as changed on the forge that no earlier pass of this process had seen. */
  changes: readonly Change[];
}

/**
 * Handles one change the pass read from the forge, before the pass saves its
 * cursor: a handler that throws fails the pass, which reads the change again
 * next time, so a handler must be safe to run twice for one change.
 */
export type ChangeHandler = (change: Change, pass: RepoPass) => Promise<void>;

/** One step a ticket is owed, started by the pass unless the ticket already has a step running. */
export interface OwedStep {
  /** What the step is, for the operational log. */
  name: string;
  run(): Promise<void>;
}

/**
 * Works out a non-final ticket's next owed step from its records and the
 * latest forge state, or null when it owes none now. There is no job queue:
 * owed work is a function of the records, so a restart loses and repeats
 * nothing (ADR-0017).
 */
export type OwedStepPlanner = (ticket: TicketRecord, pass: RepoPass) => OwedStep | null;

/** What one pass did with one repo. */
export type RepoPassOutcome =
  | { repoId: number; outcome: "polled"; takenIn: number[]; started: number[] }
  | { repoId: number; outcome: "paused" | "stopping" }
  | { repoId: number; outcome: "halted"; why: "tools" | "host" }
  | { repoId: number; outcome: "waiting-for-records"; since: string; markedIssues: number[] }
  | { repoId: number; outcome: "rate-limited" | "backing-off"; until: string }
  | { repoId: number; outcome: "failed"; error: string };

export interface PassesOptions {
  store: Store;
  log: OperationalLog;
  dataDirectory: string;
  /** Shared by every repo; at most four forge subprocesses at once by default. */
  limiter?: Limiter;
  /** The forge adapter for a repo; the owner's own CLI, through {@link PassesOptions.limiter}, by default. */
  forgeFor?: (repo: RepoRecord) => Forge;
  /** Where a repo's default branch head is checked; its git mirror by default. */
  defaultBranchFor?: (repo: RepoRecord) => Promise<DefaultBranchSource>;
  /** Works out each non-final ticket's next owed step; none by default. */
  planners?: readonly OwedStepPlanner[];
  /** Handle each change read from the forge, after taking in the owner's new issues; none by default. */
  changeHandlers?: readonly ChangeHandler[];
  /** Counts forge writes in flight, so stopping can wait for them. */
  inFlight?: InFlightWrites;
  /**
   * Where steps make their model runs; by default `claude -p` runs limited by
   * the global "Model-run limit". Stopping the passes interrupts them.
   */
  modelRuns?: ModelRuns;
  /**
   * The check for marked issues with no records (spec §3). When given, a repo
   * is polled only once the check found its records: a repo not yet checked
   * is checked first, and a repo missing records is left alone. None by default.
   */
  recordsCheck?: RecordsCheck;
  /**
   * Checks `git` and `claude` before every pass (spec §16). While either
   * fails, the pass reads and writes nothing and model work is held, until a
   * later check passes. None by default: the tools count as present.
   */
  toolCheck?: ToolCheck;
  /** Problems the start found with `git` or `claude`, in force until the first pass checks again. */
  toolProblems?: readonly ToolProblem[];
  /**
   * Checks each host's CLI login once a pass, before any of its repos is
   * polled: a CLI logged out or logged in as another account halts the
   * host's repos until a later check passes (spec §16). Off by default.
   */
  checkHostLogins?: boolean;
  /** Host halts the start found, by {@link hostKey}, in force until a pass checks the host again. */
  hostLoginHalts?: ReadonlyMap<string, HostLoginHalt>;
  /**
   * Whether VISION.md holds vision lines at the default branch head a pass
   * saw, or null when that cannot be read; the repo's git mirror by default.
   */
  visionPresent?: (repo: RepoRecord, commit: string) => Promise<boolean | null>;
  /**
   * Runs once before a repo's first poll in this process, after its records
   * were found, such as settling forge writes the start could not settle. A
   * failure fails the poll, and it runs again before the next.
   */
  beforeFirstPoll?: (repo: RepoRecord, forge: Forge) => Promise<void>;
  /** Runs after every pass, with what it did with each repo. */
  afterPass?: (outcomes: readonly RepoPassOutcome[]) => void | Promise<void>;
}

/** A host whose CLI cannot act as the owner, and since when (spec §16). */
export interface HostLoginHalt extends HostLoginProblem {
  forge: ForgeKind;
  host: string;
  since: string;
}

/** A host none of whose repos has polled for an hour or more, and since when it stopped answering. */
export interface HostUnanswered {
  forge: ForgeKind;
  host: string;
  since: string;
  lastError: string;
}

/** What the passes know of a repo's polling, for health and the Repos page. */
export interface RepoPolling {
  /** The last poll that succeeded in this process, as ISO, or null. */
  lastSuccess: string | null;
  /** Since when every poll of the repo has failed, and the last error, or null. */
  failing: { since: string; failures: number; lastError: string; retryAt: string } | null;
}

/** Whether the repo's mirror holds a VISION.md with vision lines at `commit`; null when it cannot be read. */
export async function mirrorVisionAt(dataDirectory: string, repo: RepoRecord, commit: string): Promise<boolean | null> {
  try {
    const { mirror } = mirrorPaths(dataDirectory, { forge: repo.forge, host: repo.host, projectId: repo.projectId });
    if (!existsSync(join(mirror, "HEAD"))) return null;
    return (await readVision(new Git(mirror), commit)).status === "present";
  } catch {
    return null;
  }
}

/** The forge adapter for an enrolled repo, through the owner's CLI, its subprocesses limited by `limiter`. */
export function repoForge(repo: RepoRecord, limiter: Limiter): Forge {
  const cli: Record<ForgeKind, "gh" | "glab"> = { github: "gh", gitlab: "glab" };
  return createForge(
    { forge: repo.forge, host: repo.host, path: repo.path },
    new LimitedTransport(new CliTransport(cli[repo.forge]), limiter),
  );
}

/**
 * entail's passes (spec §1, ADR-0017). Every poll interval, for each enrolled
 * repo that is not paused or missing its records (spec §3), a pass:
 *
 * 1. checks the default branch head with `git ls-remote` and reads what
 *    changed on the forge, taking in the owner's new issues and the issues
 *    the owner pulls in with `/entail`, and handing each change to the change
 *    handlers;
 * 2. works out every non-final ticket's next owed step from its records and
 *    the latest forge state;
 * 3. starts that step unless the ticket already has one running.
 *
 * Before anything else, a pass checks `git` and `claude`, and does nothing
 * while either fails; and before a host's repos are polled, it checks once
 * that the host's CLI is logged in as the account they were enrolled with.
 * It keeps what health shows (spec §16): each repo's last successful poll
 * and how long its polls have failed, the hosts that have not answered for an
 * hour, and the repos whose VISION.md is gone.
 *
 * Repos are polled side by side, with at most four forge subprocesses at once
 * across all of them. A rate limit is honoured until its reset; any other
 * failure backs off that repo alone, doubling up to 15 minutes. Polls,
 * backoffs and failures go to the operational log, never the records.
 *
 * A paused repo is not polled and no new step starts there; it is "pausing"
 * while steps already running there, or their forge writes, finish. The first
 * pass after it is resumed catches up from the saved cursors, and its board
 * items stay locked until that pass has polled and the steps owed by the
 * tickets on the board have finished (ADR-0018). An unenrolled repo is never
 * passed over at all.
 *
 * Everything kept in memory here (the deduplicator, backoffs, steps running)
 * is lost on a restart at no cost: a change's cursor is saved only once the
 * change was handled, and taking an issue in is one transaction, so a restart
 * re-reads what it had not finished and takes nothing in twice.
 */
export class Passes {
  readonly #store: Store;
  readonly #log: OperationalLog;
  readonly #cursors: CursorStore;
  readonly #limiter: Limiter;
  readonly #forgeFor: (repo: RepoRecord) => Forge;
  readonly #defaultBranchFor: (repo: RepoRecord) => Promise<DefaultBranchSource>;
  readonly #planners: readonly OwedStepPlanner[];
  readonly #changeHandlers: readonly ChangeHandler[];
  readonly #inFlight: InFlightWrites;
  readonly #modelRuns: ModelRuns;
  readonly #recordsCheck: RecordsCheck | undefined;
  readonly #toolCheck: ToolCheck | undefined;
  readonly #checkHostLogins: boolean;
  readonly #visionPresent: (repo: RepoRecord, commit: string) => Promise<boolean | null>;
  readonly #beforeFirstPoll: ((repo: RepoRecord, forge: Forge) => Promise<void>) | undefined;
  readonly #afterPass: ((outcomes: readonly RepoPassOutcome[]) => void | Promise<void>) | undefined;

  readonly #forges = new Map<number, Forge>();
  readonly #defaultBranches = new Map<number, Promise<DefaultBranchSource>>();
  readonly #seen = new Map<number, ChangeDeduplicator>();
  readonly #backoff = new Map<number, { failures: number; until: number }>();
  /** Per host, when its rate limit resets. */
  readonly #rateLimited = new Map<string, number>();
  /** Hosts whose CLI is logged out or logged in as another account, by host key, until a check passes and a poll catches up. */
  readonly #hostLogins = new Map<string, HostLoginHalt>();
  /** Halted hosts whose check passed again: polled, and freed once a poll of theirs has caught up. */
  readonly #hostLoginsPassing = new Set<string>();
  /** Per host key, since when none of its repos has polled, and the last error. */
  readonly #hostUnanswered = new Map<string, { since: number; lastError: string }>();
  /** Each host's login check on the pass in progress, so a host is checked once a pass. */
  #hostChecks = new Map<string, Promise<void>>();
  /** Per repo, since when every poll has failed. */
  readonly #pollFailingSince = new Map<number, { since: number; lastError: string }>();
  /** Per repo, the last poll that succeeded. */
  readonly #lastSuccess = new Map<number, string>();
  /** Per repo, whether VISION.md held vision lines at the head the last poll saw, and since when it has not. */
  readonly #visionGone = new Map<number, string>();
  /** Per repo, the head whose VISION.md was last read, so an unmoved head is not read again. */
  readonly #visionRead = new Map<number, string>();
  /** Repos whose first poll in this process has been prepared for. */
  readonly #prepared = new Set<number>();
  /** What the last tool check found; empty while `git` and `claude` are fine. */
  #toolProblems: readonly ToolProblem[] = [];
  /** Since when the tools have failed their check. */
  #toolsHaltedSince: string | null = null;
  #lastPassAt: string | null = null;
  /** The step each ticket has running, by ticket id. */
  readonly #running = new Map<number, Promise<void>>();
  /** The repo of each ticket with a step running, by ticket id. */
  readonly #runningIn = new Map<number, number>();
  /** Per repo, the settings version id of the latest resume this process has caught up with. */
  readonly #caughtUp = new Map<number, number>();

  #stopping = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #current: Promise<unknown> | undefined;

  constructor(options: PassesOptions) {
    this.#store = options.store;
    this.#log = options.log;
    this.#cursors = new CursorStore(options.dataDirectory);
    this.#limiter = options.limiter ?? new Limiter();
    const limiter = this.#limiter;
    this.#forgeFor = options.forgeFor ?? ((repo) => repoForge(repo, limiter));
    this.#defaultBranchFor =
      options.defaultBranchFor ??
      ((repo) =>
        Mirror.open({
          dataDirectory: options.dataDirectory,
          key: { forge: repo.forge, host: repo.host, projectId: repo.projectId },
          remote: forgeRemote(repo.forge, repo.host, repo.path),
          log: options.log,
        }));
    this.#planners = options.planners ?? [];
    this.#changeHandlers = options.changeHandlers ?? [];
    this.#inFlight = options.inFlight ?? new InFlightWrites();
    this.#recordsCheck = options.recordsCheck;
    this.#toolCheck = options.toolCheck;
    this.#checkHostLogins = options.checkHostLogins ?? false;
    for (const [key, halt] of options.hostLoginHalts ?? []) this.#hostLogins.set(key, halt);
    if (options.toolProblems !== undefined && options.toolProblems.length > 0) {
      this.#toolProblems = options.toolProblems;
      this.#toolsHaltedSince = new Date().toISOString();
    }
    const dataDirectory = options.dataDirectory;
    this.#visionPresent = options.visionPresent ?? ((repo, commit) => mirrorVisionAt(dataDirectory, repo, commit));
    this.#beforeFirstPoll = options.beforeFirstPoll;
    this.#afterPass = options.afterPass;
    const store = options.store;
    this.#modelRuns =
      options.modelRuns ??
      new ModelRuns({ runner: new ClaudeRunner(), log: options.log, limit: () => readGlobalSettings(store).settings.modelRunLimit });
  }

  /**
   * Whether entail cannot reach the host: its CLI is logged out or logged in
   * as another account, or it has not answered for an hour (spec §16).
   */
  hostHalted(host: string): boolean {
    for (const halt of this.#hostLogins.values()) if (halt.host === host) return true;
    for (const unanswered of this.hostsUnanswered()) if (unanswered.host === host) return true;
    return false;
  }

  /** Hosts whose CLI cannot act as the owner. */
  hostLoginHalts(): HostLoginHalt[] {
    return [...this.#hostLogins.values()];
  }

  /** Hosts none of whose repos has polled for an hour or more: the host-not-answering halt. */
  hostsUnanswered(now = Date.now()): HostUnanswered[] {
    const halts: HostUnanswered[] = [];
    for (const [key, { since, lastError }] of this.#hostUnanswered) {
      if (now - since < HOST_UNANSWERED_HALT_MS) continue;
      const [forge, ...host] = key.split(":");
      halts.push({ forge: forge as ForgeKind, host: host.join(":"), since: new Date(since).toISOString(), lastError });
    }
    return halts;
  }

  /** What `git` and `claude` lacked at the last check, and since when; null while both are fine. */
  get toolsHalted(): { since: string; problems: readonly ToolProblem[] } | null {
    return this.#toolsHaltedSince === null ? null : { since: this.#toolsHaltedSince, problems: this.#toolProblems };
  }

  /** When the last pass ended, as ISO, or null before the first. */
  get lastPassAt(): string | null {
    return this.#lastPassAt;
  }

  /** What the passes know of the repo's polling. */
  polling(repoId: number): RepoPolling {
    const failing = this.#pollFailingSince.get(repoId);
    const backoff = this.#backoff.get(repoId);
    return {
      lastSuccess: this.#lastSuccess.get(repoId) ?? null,
      failing:
        failing === undefined
          ? null
          : {
              since: new Date(failing.since).toISOString(),
              failures: backoff?.failures ?? 0,
              lastError: failing.lastError,
              retryAt: new Date(backoff?.until ?? failing.since).toISOString(),
            },
    };
  }

  /** Since when the repo's VISION.md has been gone or empty at the head its polls saw, or null. */
  visionGoneSince(repoId: number): string | null {
    return this.#visionGone.get(repoId) ?? null;
  }

  /** How many tickets have a step running now. */
  get stepsRunning(): number {
    return this.#running.size;
  }

  /**
   * Whether the repo still has steps running or forge writes in flight. A
   * paused repo that is busy shows as "pausing" (ADR-0018).
   */
  busy(repoId: number): boolean {
    if (this.#inFlight.countFor(repoId) > 0) return true;
    for (const repo of this.#runningIn.values()) if (repo === repoId) return true;
    return false;
  }

  /**
   * Whether the repo was resumed and this process has not yet caught up with
   * the changes made during its pause, so its board items stay locked
   * (ADR-0018). A repo that is paused now is locked as paused, not as
   * catching up.
   */
  catchingUp(repoId: number): boolean {
    const resume = latestResume(this.#store, repoId);
    return resume !== null && (this.#caughtUp.get(repoId) ?? 0) < resume.id;
  }

  /** Runs one pass now, then one every poll interval, read from the global settings before each wait. */
  start(): void {
    if (this.#stopping || this.#timer !== undefined || this.#current !== undefined) return;
    this.#next(0);
  }

  /**
   * Starts no new pass and no new step, and interrupts model runs, which stay
   * owed and run again on the next start. Resolves once the pass in progress,
   * if any, and the interrupted runs have ended.
   */
  async stop(): Promise<void> {
    this.#stopping = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    await Promise.all([this.#current, this.#modelRuns.stop()]);
  }

  #next(delayMs: number): void {
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const pass = this.runPass().catch((error: unknown) => {
        this.#log.error("pass-failed", { error: message(error) });
      });
      this.#current = pass;
      void pass.then(() => {
        this.#current = undefined;
        if (!this.#stopping) this.#next(readGlobalSettings(this.#store).settings.pollIntervalSeconds * 1000);
      });
    }, delayMs);
  }

  /**
   * One pass over every enrolled repo; an unenrolled one is neither read nor
   * written. It first checks `git` and `claude`: while either fails, it does
   * nothing else (spec §16).
   */
  async runPass(): Promise<RepoPassOutcome[]> {
    const repos = this.#store.listEnrolledRepos();
    let outcomes: RepoPassOutcome[];
    if (!(await this.#checkTools())) {
      outcomes = repos.map((repo) => ({ repoId: repo.id, outcome: "halted", why: "tools" }));
    } else {
      this.#hostChecks = new Map();
      this.#forgetUnpolled(repos);
      outcomes = await Promise.all(repos.map((repo) => this.#passRepo(repo)));
    }
    this.#lastPassAt = new Date().toISOString();
    if (this.#afterPass) {
      try {
        await this.#afterPass(outcomes);
      } catch (error) {
        this.#log.error("after-pass-failed", { error: message(error) });
      }
    }
    return outcomes;
  }

  /** Checks `git` and `claude`, holding model work while either fails; resolves whether entail may work. */
  async #checkTools(): Promise<boolean> {
    if (!this.#toolCheck) return true;
    let problems: ToolProblem[];
    try {
      problems = await this.#toolCheck();
    } catch (error) {
      problems = [{ tool: "git", problem: "missing", detail: `the check could not run: ${message(error)}` }];
    }
    // A run `claude` refused for want of a login holds model work until a check finds it logged in.
    if (!problems.some((problem) => problem.tool === "claude")) this.#modelRuns.loginRestored();
    if (problems.length > 0) {
      if (this.#toolsHaltedSince === null) {
        this.#toolsHaltedSince = new Date().toISOString();
        this.#log.error("tools-halted", { problems: problems.map((problem) => problem.detail) });
      }
      this.#toolProblems = problems;
      this.#modelRuns.hold(true);
      return false;
    }
    if (this.#toolsHaltedSince !== null) this.#log.info("tools-restored", {});
    this.#toolsHaltedSince = null;
    this.#toolProblems = [];
    this.#modelRuns.hold(false);
    return true;
  }

  /** Checks the repo's host login once this pass, then resolves whether the host is halted for it. */
  async #hostLoginHalted(repo: RepoRecord): Promise<boolean> {
    // Without the login check, a halted host is polled again, and a poll that succeeds clears the halt.
    if (!this.#checkHostLogins) return false;
    const key = hostKey(repo);
    let check = this.#hostChecks.get(key);
    if (!check) {
      check = this.#checkHost(repo);
      this.#hostChecks.set(key, check);
    }
    await check;
    return this.#hostLogins.has(key) && !this.#hostLoginsPassing.has(key);
  }

  async #checkHost(repo: RepoRecord): Promise<void> {
    const key = hostKey(repo);
    const repos = this.#store.listEnrolledRepos().filter((other) => hostKey(other) === key);
    const check = await checkHostLogin(this.#forge(repo), repos);
    if (check.status === "unknown") {
      // Says nothing about the login; the polls show whether the host answers.
      this.#log.warn("host-check-failed", { host: repo.host, error: check.error });
      return;
    }
    if (check.status === "ok") {
      // The halt lasts until a poll has caught up, so the board unlocks only once entail has seen what changed.
      if (this.#hostLogins.has(key)) this.#hostLoginsPassing.add(key);
      return;
    }
    this.#hostLoginsPassing.delete(key);
    this.#haltHostLogin(repo, { problem: check.problem, detail: check.detail });
  }

  #haltHostLogin(repo: RepoRecord, problem: HostLoginProblem): void {
    const key = hostKey(repo);
    this.#hostLoginsPassing.delete(key);
    const existing = this.#hostLogins.get(key);
    if (existing?.problem === problem.problem) return;
    this.#hostLogins.set(key, { forge: repo.forge, host: repo.host, ...problem, since: new Date().toISOString() });
    this.#log.error("host-login-halted", { host: repo.host, problem: problem.problem, detail: problem.detail });
  }

  /** Drops poll failures of repos no longer polled (paused or unenrolled), and of hosts left with none. */
  #forgetUnpolled(repos: RepoRecord[]): void {
    const polled = repos.filter((repo) => (this.#store.latestSettings(repo.id)?.settings as Partial<RepoSettings> | undefined)?.paused !== true);
    const ids = new Set(polled.map((repo) => repo.id));
    const hosts = new Set(polled.map((repo) => hostKey(repo)));
    for (const id of [...this.#pollFailingSince.keys()]) if (!ids.has(id)) this.#pollFailingSince.delete(id);
    for (const key of [...this.#hostUnanswered.keys()]) if (!hosts.has(key)) this.#hostUnanswered.delete(key);
  }

  async #passRepo(repo: RepoRecord): Promise<RepoPassOutcome> {
    const repoId = repo.id;
    if (this.#stopping) return { repoId, outcome: "stopping" };
    const settings = this.#store.latestSettings(repoId);
    if (!settings) return { repoId, outcome: "failed", error: "the repo has no settings" };
    if ((settings.settings as Partial<RepoSettings>).paused === true) return { repoId, outcome: "paused" };
    // Read before polling: a pass that started after the resume catches up with it.
    const resume = this.catchingUp(repoId) ? latestResume(this.#store, repoId) : null;

    const now = Date.now();
    const resetAt = this.#rateLimited.get(hostKey(repo));
    if (resetAt !== undefined) {
      if (now < resetAt) return { repoId, outcome: "rate-limited", until: new Date(resetAt).toISOString() };
      this.#rateLimited.delete(hostKey(repo));
    }
    const backoff = this.#backoff.get(repoId);
    if (backoff && now < backoff.until) return { repoId, outcome: "backing-off", until: new Date(backoff.until).toISOString() };
    if (await this.#hostLoginHalted(repo)) return { repoId, outcome: "halted", why: "host" };

    if (this.#recordsCheck) {
      // A repo is read and written only once its records are found (spec §3).
      let standing: RecordsStanding;
      try {
        standing = await this.#recordsCheck.check(repo);
      } catch (error) {
        return this.#failed(repo, error);
      }
      if (standing.status === "missing") {
        return { repoId, outcome: "waiting-for-records", since: standing.since, markedIssues: standing.markedIssues };
      }
    }

    const forge = this.#forge(repo);
    const key = projectKey({ forge: repo.forge, host: repo.host, id: repo.projectId });
    let head: { branch: string; commit: string; fetched: boolean };
    let pass: RepoPass;
    const takenIn: number[] = [];
    try {
      if (this.#beforeFirstPoll && !this.#prepared.has(repoId)) {
        await this.#beforeFirstPoll(repo, forge);
        this.#prepared.add(repoId);
      }
      const source = await this.#defaultBranch(repo);
      head = await this.#limiter.run(() => source.updateDefaultBranch());
      const batch = await forge.changesSince(this.#cursors.get(key));
      const fresh = this.#deduplicator(repoId).fresh(batch.changes);
      pass = {
        repo,
        forge,
        settings,
        head: { branch: head.branch, commit: head.commit },
        writer: () => this.#writer(repo, forge),
        modelRuns: this.#modelRuns,
        changes: fresh,
      };
      for (const change of fresh) {
        if (change.kind === "issue") {
          const outcome = await takeInIfNew(this.#store, forge, repo, change.issue, settings.id);
          if ("takenIn" in outcome) {
            takenIn.push(outcome.takenIn.id);
            this.#log.info("taken-in", { repoId, issue: change.issue.number, ticketId: outcome.takenIn.id });
          }
        } else if (change.kind === "issue-comment") {
          const context = { store: this.#store, forge, repo, settingsVersionId: settings.id, writer: pass.writer, log: this.#log };
          const outcome = await pullInOnComment(context, change.comment);
          if ("takenIn" in outcome) takenIn.push(outcome.takenIn.id);
        }
        for (const handle of this.#changeHandlers) await handle(change, pass);
      }
      // Saved only once every change was handled, so a restart before this
      // reads them again rather than losing them.
      this.#cursors.set(key, batch.cursor);
    } catch (error) {
      // What this pass marked as seen was not all handled; read it all again next time.
      this.#seen.delete(repoId);
      return this.#failed(repo, error);
    }
    this.#hostUnanswered.delete(hostKey(repo));
    if (!this.#checkHostLogins || this.#hostLoginsPassing.delete(hostKey(repo))) {
      if (this.#hostLogins.delete(hostKey(repo))) this.#log.info("host-login-restored", { host: repo.host });
    }
    this.#pollFailingSince.delete(repoId);
    this.#lastSuccess.set(repoId, new Date().toISOString());
    if (this.#backoff.delete(repoId)) this.#log.info("poll-recovered", { repoId });
    await this.#noteVision(repo, head.commit);
    this.#log.info("poll", { repoId, head: head.commit, fetched: head.fetched, takenIn: takenIn.length });

    const started = this.#startOwedSteps(pass);
    if (resume !== null) this.#catchUp(repoId, resume.id);
    return { repoId, outcome: "polled", takenIn, started };
  }

  /**
   * Marks the repo caught up with the resume `resumeId` once the steps running
   * for its tickets on the board have finished: those are what withdraw an
   * item whose basis changed during the pause (ADR-0008, ADR-0018).
   */
  #catchUp(repoId: number, resumeId: number): void {
    const owed = this.#store
      .ticketsInFlight(repoId)
      .filter((ticket) => ticket.state === "on-the-board")
      .map((ticket) => this.#running.get(ticket.id))
      .filter((running) => running !== undefined);
    void Promise.all(owed).then(() => {
      if ((this.#caughtUp.get(repoId) ?? 0) < resumeId) this.#caughtUp.set(repoId, resumeId);
      this.#log.info("caught-up", { repoId, resumeSettingsVersionId: resumeId });
    });
  }

  #failed(repo: RepoRecord, error: unknown): RepoPassOutcome {
    const repoId = repo.id;
    if (error instanceof RateLimitedError) {
      this.#rateLimited.set(hostKey(repo), error.resetAt.getTime());
      this.#log.warn("rate-limited", { repoId, host: repo.host, until: error.resetAt.toISOString() });
      return { repoId, outcome: "rate-limited", until: error.resetAt.toISOString() };
    }
    if (error instanceof ForgeLoggedOutError) {
      // A logged-out CLI is the host's halt, not a backoff: it is checked again on the next pass.
      this.#haltHostLogin(repo, { problem: "logged-out", detail: `${repo.forge === "github" ? "gh" : "glab"} is not logged in to ${repo.host}` });
      this.#log.error("host-logged-out", { repoId, host: repo.host, error: error.message });
      return { repoId, outcome: "failed", error: error.message };
    }
    const now = Date.now();
    const failing = this.#pollFailingSince.get(repoId);
    this.#pollFailingSince.set(repoId, { since: failing?.since ?? now, lastError: message(error) });
    const unanswered = this.#hostUnanswered.get(hostKey(repo));
    this.#hostUnanswered.set(hostKey(repo), { since: unanswered?.since ?? now, lastError: message(error) });
    const failures = (this.#backoff.get(repoId)?.failures ?? 0) + 1;
    const until = now + backoffDelay(failures);
    this.#backoff.set(repoId, { failures, until });
    this.#log.warn("poll-failed", { repoId, failures, retryAt: new Date(until).toISOString(), error: message(error) });
    return { repoId, outcome: "failed", error: message(error) };
  }

  /** Notes whether VISION.md is gone or empty at the head the poll saw: the repo's vision halt (spec §4, §16). */
  async #noteVision(repo: RepoRecord, commit: string): Promise<void> {
    if (this.#visionRead.get(repo.id) === commit) return;
    const present = await this.#visionPresent(repo, commit);
    if (present === null) return; // nothing to read; what was known stands
    this.#visionRead.set(repo.id, commit);
    if (present) {
      if (this.#visionGone.delete(repo.id)) this.#log.info("vision-back", { repoId: repo.id, commit });
    } else if (!this.#visionGone.has(repo.id)) {
      this.#visionGone.set(repo.id, new Date().toISOString());
      this.#log.error("vision-gone", { repoId: repo.id, commit });
    }
  }

  /** Starts each non-final ticket's owed step, unless it already has one running. */
  #startOwedSteps(pass: RepoPass): number[] {
    const started: number[] = [];
    for (const ticket of this.#store.ticketsInFlight(pass.repo.id)) {
      if (this.#stopping) break;
      if (this.#running.has(ticket.id)) continue;
      const step = this.#owedStep(ticket, pass);
      if (!step) continue;
      if (VISION_HALTED_STEPS.has(step.name) && this.#visionGone.has(pass.repo.id)) continue;
      const running = step.run().then(
        () => {
          this.#log.info("step-done", { ticketId: ticket.id, step: step.name });
        },
        (error: unknown) => {
          this.#log.warn("step-failed", { ticketId: ticket.id, step: step.name, error: message(error) });
        },
      );
      this.#running.set(ticket.id, running);
      this.#runningIn.set(ticket.id, ticket.repoId);
      void running.then(() => {
        this.#running.delete(ticket.id);
        this.#runningIn.delete(ticket.id);
      });
      this.#log.info("step-started", { ticketId: ticket.id, step: step.name });
      started.push(ticket.id);
    }
    return started;
  }

  #owedStep(ticket: TicketRecord, pass: RepoPass): OwedStep | null {
    for (const planner of this.#planners) {
      const step = planner(ticket, pass);
      if (step) return step;
    }
    return null;
  }

  #forge(repo: RepoRecord): Forge {
    let forge = this.#forges.get(repo.id);
    if (!forge) {
      forge = this.#forgeFor(repo);
      this.#forges.set(repo.id, forge);
    }
    return forge;
  }

  #defaultBranch(repo: RepoRecord): Promise<DefaultBranchSource> {
    let source = this.#defaultBranches.get(repo.id);
    if (!source) {
      source = this.#defaultBranchFor(repo);
      // A mirror that failed to open is opened afresh next time.
      source.catch(() => this.#defaultBranches.delete(repo.id));
      this.#defaultBranches.set(repo.id, source);
    }
    return source;
  }

  #deduplicator(repoId: number): ChangeDeduplicator {
    let seen = this.#seen.get(repoId);
    if (!seen) {
      seen = new ChangeDeduplicator();
      this.#seen.set(repoId, seen);
    }
    return seen;
  }

  #writer(repo: RepoRecord, forge: Forge): ForgeWriter {
    const name = readGlobalSettings(this.#store).settings.ownerDisplayName;
    if (name === null) throw new Error("the owner's display name is not set, so entail cannot attribute a comment");
    return new ForgeWriter(this.#store, forge, repo, name, this.#inFlight);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
