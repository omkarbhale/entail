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
import { forgeRemote, Mirror } from "./mirror.ts";
import { ModelRuns } from "./model-runs.ts";
import type { OperationalLog } from "./operational-log.ts";
import type { RecordsCheck, RecordsStanding } from "./records-check.ts";
import type { RepoSettings } from "./repo-settings.ts";
import type { RepoRecord, SettingsVersionRecord, Store, TicketRecord } from "./store.ts";

/** A repo that failed to poll waits this long before its next poll, doubling with each failure in a row. */
export const BACKOFF_BASE_MS = 60_000;
/** The longest a failing repo waits between polls (ADR-0017). */
export const BACKOFF_MAX_MS = 15 * 60_000;

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
 *    changed on the forge, taking in the owner's new issues and handing each
 *    change to the change handlers;
 * 2. works out every non-final ticket's next owed step from its records and
 *    the latest forge state;
 * 3. starts that step unless the ticket already has one running.
 *
 * Repos are polled side by side, with at most four forge subprocesses at once
 * across all of them. A rate limit is honoured until its reset; any other
 * failure backs off that repo alone, doubling up to 15 minutes. Polls,
 * backoffs and failures go to the operational log, never the records.
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

  readonly #forges = new Map<number, Forge>();
  readonly #defaultBranches = new Map<number, Promise<DefaultBranchSource>>();
  readonly #seen = new Map<number, ChangeDeduplicator>();
  readonly #backoff = new Map<number, { failures: number; until: number }>();
  /** Per host, when its rate limit resets. */
  readonly #rateLimited = new Map<string, number>();
  /** Hosts whose CLI is logged out, until a poll of the host succeeds. */
  readonly #haltedHosts = new Set<string>();
  /** The step each ticket has running, by ticket id. */
  readonly #running = new Map<number, Promise<void>>();

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
    const store = options.store;
    this.#modelRuns =
      options.modelRuns ??
      new ModelRuns({ runner: new ClaudeRunner(), log: options.log, limit: () => readGlobalSettings(store).settings.modelRunLimit });
  }

  /** Whether the host's CLI is logged out, so its repos cannot be reached. */
  hostHalted(host: string): boolean {
    return this.#haltedHosts.has(host);
  }

  /** How many tickets have a step running now. */
  get stepsRunning(): number {
    return this.#running.size;
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

  /** One pass over every enrolled repo. */
  async runPass(): Promise<RepoPassOutcome[]> {
    return Promise.all(this.#store.listRepos().map((repo) => this.#passRepo(repo)));
  }

  async #passRepo(repo: RepoRecord): Promise<RepoPassOutcome> {
    const repoId = repo.id;
    if (this.#stopping) return { repoId, outcome: "stopping" };
    const settings = this.#store.latestSettings(repoId);
    if (!settings) return { repoId, outcome: "failed", error: "the repo has no settings" };
    if ((settings.settings as Partial<RepoSettings>).paused === true) return { repoId, outcome: "paused" };

    const now = Date.now();
    const resetAt = this.#rateLimited.get(hostKey(repo));
    if (resetAt !== undefined) {
      if (now < resetAt) return { repoId, outcome: "rate-limited", until: new Date(resetAt).toISOString() };
      this.#rateLimited.delete(hostKey(repo));
    }
    const backoff = this.#backoff.get(repoId);
    if (backoff && now < backoff.until) return { repoId, outcome: "backing-off", until: new Date(backoff.until).toISOString() };

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
    this.#haltedHosts.delete(repo.host);
    if (this.#backoff.delete(repoId)) this.#log.info("poll-recovered", { repoId });
    this.#log.info("poll", { repoId, head: head.commit, fetched: head.fetched, takenIn: takenIn.length });

    const started = this.#startOwedSteps(pass);
    return { repoId, outcome: "polled", takenIn, started };
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
      this.#haltedHosts.add(repo.host);
      this.#log.error("host-logged-out", { repoId, host: repo.host, error: error.message });
      return { repoId, outcome: "failed", error: error.message };
    }
    const failures = (this.#backoff.get(repoId)?.failures ?? 0) + 1;
    const until = Date.now() + backoffDelay(failures);
    this.#backoff.set(repoId, { failures, until });
    this.#log.warn("poll-failed", { repoId, failures, retryAt: new Date(until).toISOString(), error: message(error) });
    return { repoId, outcome: "failed", error: message(error) };
  }

  /** Starts each non-final ticket's owed step, unless it already has one running. */
  #startOwedSteps(pass: RepoPass): number[] {
    const started: number[] = [];
    for (const ticket of this.#store.ticketsInFlight(pass.repo.id)) {
      if (this.#stopping) break;
      if (this.#running.has(ticket.id)) continue;
      const step = this.#owedStep(ticket, pass);
      if (!step) continue;
      const running = step.run().then(
        () => {
          this.#log.info("step-done", { ticketId: ticket.id, step: step.name });
        },
        (error: unknown) => {
          this.#log.warn("step-failed", { ticketId: ticket.id, step: step.name, error: message(error) });
        },
      );
      this.#running.set(ticket.id, running);
      void running.then(() => this.#running.delete(ticket.id));
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

function hostKey(repo: RepoRecord): string {
  return `${repo.forge}:${repo.host}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
