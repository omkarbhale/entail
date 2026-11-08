import { DEFAULT_GLOBAL_SETTINGS } from "./global-settings.ts";
import type { MachineFailure, ModelRunner, ModelRunRequest, RunFacts } from "./model-runner.ts";
import type { OperationalLog } from "./operational-log.ts";
import type { NewModelRun } from "./store.ts";

/**
 * Which group a waiting model run belongs to. Waiting runs start in this
 * order: landing checks first, because they finish work, then criteria after
 * an answer, then new intake (ADR-0017). Within a group the oldest goes first.
 */
export const MODEL_RUN_PRIORITIES = ["landing", "criteria-after-answer", "intake"] as const;

export type ModelRunPriority = (typeof MODEL_RUN_PRIORITIES)[number];

/** A machine failure is first retried after this long, doubling with each failure in a row. */
export const RETRY_BASE_MS = 60_000;
/** The longest a machine failure waits before its retry; there is no attempt limit (ADR-0017). */
export const RETRY_MAX_MS = 30 * 60_000;
/** How long a usage limit pauses model work when `claude` reports no reset time. */
export const USAGE_LIMIT_PAUSE_MS = 30 * 60_000;

/** How long a run that failed `failures` times in a row waits before its next attempt: 1, 2, 4… minutes, capped at 30. */
export function retryDelay(failures: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, failures - 1), RETRY_MAX_MS);
}

/** Where a run waits in line. */
export interface ScheduleOptions {
  priority: ModelRunPriority;
  /**
   * When the work became owed, such as when the ticket was taken in or the
   * answer recorded, as an ISO time. The oldest goes first within its group.
   */
  since: string;
  /** Discards the run, waiting or in flight; the promise then rejects with the signal's reason. */
  signal?: AbortSignal;
  /**
   * Checks a structured output before it is taken: returns why the output is
   * invalid, or null to take it. An invalid output, or a check that throws,
   * is the "no structured output" machine failure, retried like any other
   * (ADR-0005: invalid criteria are a machine failure).
   */
  accept?: (output: unknown) => string | null | Promise<string | null>;
}

/** A run that produced its structured output, after however many retries it took. */
export interface ScheduledRun<T> {
  output: T;
  facts: RunFacts;
  /** When the attempt that succeeded started. */
  startedAt: string;
}

/** A ticket's model step that is failing: shown on its ticket page, never on the board (ADR-0019). */
export interface RetryState {
  ticket: string;
  /** Machine failures in a row, not counting usage limits, which pause all model work instead. */
  failures: number;
  /** When the first failure in a row happened. */
  failingSince: string;
  lastFailure: MachineFailure;
  /** When the run is tried again. */
  retryAt: string;
}

/** Rejects every run waiting or in flight when entail stops; the work is still owed, so the next start runs it again. */
export class ModelRunsStoppedError extends Error {
  constructor() {
    super("entail is stopping, so the model run was interrupted and discarded");
    this.name = "ModelRunsStoppedError";
  }
}

export interface ModelRunsOptions {
  runner: ModelRunner;
  log: OperationalLog;
  /** The global "Model-run limit", read before each run starts; 2 by default. */
  limit?: () => number;
}

interface Entry {
  request: ModelRunRequest;
  rank: number;
  since: number;
  seq: number;
  signal: AbortSignal | undefined;
  accept: ScheduleOptions["accept"];
  resolve(run: ScheduledRun<unknown>): void;
  reject(error: unknown): void;
  /** The attempt in flight, if any. */
  attempt: { controller: AbortController; done: Promise<void> } | null;
  /** The timer of a retry it waits for, if any. */
  retryTimer: ReturnType<typeof setTimeout> | null;
  onAbort: () => void;
}

/**
 * How the pass hands work to the model runner (spec §1, ADR-0017, ADR-0002).
 *
 * - At most the global "Model-run limit" of runs are in flight at once,
 *   across all repos, and a ticket has at most one model run at a time: its
 *   run holds the ticket from the first attempt until it succeeds or is
 *   discarded, retries included, so a verdict and its challenge, or a grade
 *   and its challenge, run one after the other.
 * - Waiting runs start landing checks first, then criteria after an answer,
 *   then new intake, the oldest first within each group.
 * - A machine failure is retried after 1, 2, 4… minutes, capped at 30, with
 *   no attempt limit. It goes to the operational log and the ticket's
 *   {@link RetryState}, and never back to the caller, so it never reaches the
 *   board and the ticket keeps its state.
 * - A usage limit pauses every model run until the reset time `claude`
 *   reported, or for 30 minutes if it reported none. The run that hit it
 *   waits in line again; runs already in flight go on.
 * - A run `claude` refuses for want of a login holds every model run, as
 *   does an all-of-entail halt ({@link ModelRuns.hold}), until a pass's check
 *   finds `claude` logged in again (ADR-0019).
 * - {@link ModelRuns.stop} interrupts the runs in flight and discards them
 *   with every waiting run. Nothing about them is recorded, so the work is
 *   still owed and the next start runs it again.
 * - Each run's estimated cost goes to the operational log, failed attempts
 *   included, and comes back with the output to be recorded on the call. There
 *   is no budget.
 *
 * Retry state and the pause are operational, not records: a restart forgets
 * them and tries the owed work at once.
 */
export class ModelRuns {
  readonly #runner: ModelRunner;
  readonly #log: OperationalLog;
  readonly #limit: () => number;

  /** Runs waiting for a slot, in no particular order. */
  readonly #waiting = new Set<Entry>();
  /** Runs with an attempt in flight. */
  readonly #inFlight = new Set<Entry>();
  /** Runs waiting for a retry. */
  readonly #retrying = new Set<Entry>();
  /** The run holding each ticket, from its first attempt until it settles. */
  readonly #holders = new Map<string, Entry>();
  readonly #retryStates = new Map<string, RetryState>();
  #seq = 0;
  #pausedUntil: number | null = null;
  /** When the usage-limit pause in force began. */
  #pausedSince: number | null = null;
  /** Set while an all-of-entail halt holds model work (ADR-0019). */
  #held = false;
  /** When a run was refused because `claude` is not logged in, until a check finds it logged in. */
  #loggedOutSince: number | null = null;
  /** When the model runs began failing, every one of them, and the last error; null once one succeeds. */
  #failing: { since: number; lastError: string } | null = null;
  #pauseTimer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;

  constructor(options: ModelRunsOptions) {
    this.#runner = options.runner;
    this.#log = options.log;
    this.#limit = options.limit ?? (() => DEFAULT_GLOBAL_SETTINGS.modelRunLimit);
  }

  /** How many runs are in flight now. */
  get inFlight(): number {
    return this.#inFlight.size;
  }

  /** How many runs wait for a slot, the pause to end or a retry. */
  get waiting(): number {
    return this.#waiting.size + this.#retrying.size;
  }

  /** Until when a usage limit pauses model work, or null when it does not. */
  get pausedUntil(): string | null {
    return this.#pausedUntil === null ? null : new Date(this.#pausedUntil).toISOString();
  }

  /** When the usage-limit pause in force began, or null when model work is not paused. */
  get pausedSince(): string | null {
    return this.#pausedUntil === null || this.#pausedSince === null ? null : new Date(this.#pausedSince).toISOString();
  }

  /** When a run was last refused because `claude` is not logged in, or null once a check found it logged in. */
  get loggedOutSince(): string | null {
    return this.#loggedOutSince === null ? null : new Date(this.#loggedOutSince).toISOString();
  }

  /**
   * Since when every model run has failed, with the last error, or null when
   * the last run that ended succeeded. Usage limits and a logged-out `claude`
   * are halts of their own and do not count (ADR-0019).
   */
  get failing(): { since: string; lastError: string } | null {
    return this.#failing === null ? null : { since: new Date(this.#failing.since).toISOString(), lastError: this.#failing.lastError };
  }

  /**
   * Holds every model run while an all-of-entail halt lasts, or lets them go
   * again (ADR-0019). Runs in flight go on; waiting runs wait.
   */
  hold(held: boolean): void {
    if (this.#held === held) return;
    this.#held = held;
    if (!held) this.#pump();
  }

  /** A check found `claude` logged in, so runs refused for want of a login go again. */
  loginRestored(): void {
    if (this.#loggedOutSince === null) return;
    this.#loggedOutSince = null;
    this.#log.info("claude-login-restored", {});
    this.#pump();
  }

  /** The ticket's retry state while its model step is failing, or null. */
  retryState(ticket: string): RetryState | null {
    return this.#retryStates.get(ticket) ?? null;
  }

  /** Every failing ticket's retry state. */
  retryStates(): RetryState[] {
    return [...this.#retryStates.values()];
  }

  /**
   * Runs `request` once a slot is free, its ticket has no other run and model
   * work is not paused, retrying machine failures until it produces its
   * structured output. Rejects only when it is discarded: with
   * {@link ModelRunsStoppedError} when entail stops, or the signal's reason.
   */
  run<T>(request: ModelRunRequest<T>, options: ScheduleOptions): Promise<ScheduledRun<T>> {
    if (this.#stopped) return Promise.reject(new ModelRunsStoppedError());
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    const rank = MODEL_RUN_PRIORITIES.indexOf(options.priority);
    if (rank < 0) throw new Error(`unknown model run priority: ${String(options.priority)}`);
    const since = Date.parse(options.since);
    if (Number.isNaN(since)) throw new Error(`a model run's since is not a time: ${options.since}`);

    return new Promise<ScheduledRun<T>>((resolve, reject) => {
      const entry: Entry = {
        request: request as ModelRunRequest,
        rank,
        since,
        seq: this.#seq++,
        signal: options.signal,
        accept: options.accept,
        resolve: resolve as (run: ScheduledRun<unknown>) => void,
        reject,
        attempt: null,
        retryTimer: null,
        onAbort: () => this.#discard(entry, options.signal?.reason),
      };
      options.signal?.addEventListener("abort", entry.onAbort, { once: true });
      this.#waiting.add(entry);
      this.#pump();
    });
  }

  /**
   * Starts no new run, interrupts the runs in flight and discards them with
   * every waiting run. Resolves once the runs in flight have ended.
   */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    clearTimeout(this.#pauseTimer);
    const attempts = [...this.#inFlight].map((entry) => entry.attempt!.done);
    const interrupted = this.#inFlight.size;
    const discarded = this.#waiting.size + this.#retrying.size;
    for (const entry of [...this.#waiting, ...this.#retrying, ...this.#inFlight]) this.#discard(entry, new ModelRunsStoppedError());
    if (interrupted + discarded > 0) this.#log.info("model-runs-interrupted", { interrupted, discarded });
    await Promise.all(attempts);
  }

  /** Starts waiting runs, in order, while slots are free. */
  #pump(): void {
    if (this.#stopped || this.#pausedUntil !== null || this.#held || this.#loggedOutSince !== null) return;
    const limit = Math.max(1, Math.floor(this.#limit()));
    while (this.#inFlight.size < limit) {
      const next = this.#nextReady();
      if (!next) return;
      this.#start(next);
    }
  }

  /** The first waiting run whose ticket no other run holds. */
  #nextReady(): Entry | null {
    let best: Entry | null = null;
    for (const entry of this.#waiting) {
      const ticket = entry.request.ticket;
      if (ticket !== null && (this.#holders.get(ticket) ?? entry) !== entry) continue;
      if (best === null || before(entry, best)) best = entry;
    }
    return best;
  }

  #start(entry: Entry): void {
    const { request } = entry;
    this.#waiting.delete(entry);
    this.#inFlight.add(entry);
    if (request.ticket !== null) this.#holders.set(request.ticket, entry);
    const controller = new AbortController();
    const signal = entry.signal ? AbortSignal.any([controller.signal, entry.signal]) : controller.signal;
    const startedAt = new Date().toISOString();
    this.#log.info("model-run-started", { ticket: request.ticket, kind: request.kind, priority: MODEL_RUN_PRIORITIES[entry.rank] });

    const done = (async () => {
      let result: Awaited<ReturnType<ModelRunner["run"]>>;
      try {
        result = await this.#runner.run(request, { signal });
      } catch (error) {
        if (signal.aborted) return; // discarded; already settled
        // A runner classifies its failures; one that throws anyway is an error like any other.
        result = { ok: false, failure: { kind: "error", message: errorMessage(error) }, facts: null };
      }
      if (result.ok && entry.accept) {
        let invalid: string | null;
        try {
          invalid = await entry.accept(result.output);
        } catch (error) {
          invalid = `the output could not be checked: ${errorMessage(error)}`;
        }
        if (invalid !== null) result = { ok: false, failure: { kind: "no-structured-output", message: `the output is invalid: ${invalid}` }, facts: result.facts };
      }
      if (entry.attempt?.controller !== controller) return; // discarded while the runner finished
      entry.attempt = null;
      this.#inFlight.delete(entry);
      if (result.ok) this.#succeeded(entry, { output: result.output, facts: result.facts, startedAt });
      else this.#failed(entry, result.failure, result.facts);
      this.#pump();
    })();
    entry.attempt = { controller, done };
  }

  #succeeded(entry: Entry, run: ScheduledRun<unknown>): void {
    const { ticket, kind } = entry.request;
    this.#log.info("model-run-done", {
      ticket,
      kind,
      sessionId: run.facts.sessionId,
      durationMs: run.facts.durationMs,
      estimatedCostUsd: run.facts.estimatedCostUsd,
    });
    if (ticket !== null && this.#retryStates.delete(ticket)) this.#log.info("model-run-recovered", { ticket, kind });
    this.#failing = null;
    this.#settle(entry);
    entry.resolve(run);
  }

  #failed(entry: Entry, failure: MachineFailure, facts: RunFacts | null): void {
    const { ticket, kind } = entry.request;
    this.#log.warn("machine-failure", {
      ticket,
      kind,
      failure: failure.kind,
      error: failure.message,
      ...(failure.resetAt ? { resetAt: failure.resetAt.toISOString() } : {}),
      sessionId: facts?.sessionId ?? null,
      estimatedCostUsd: facts?.estimatedCostUsd ?? null,
    });

    if (failure.kind === "usage-limit") {
      // Not the ticket's failure: all model work waits for the limit to reset.
      this.#pause(failure.resetAt);
      this.#waiting.add(entry);
      return;
    }
    if (failure.kind === "logged-out") {
      // Not the ticket's failure either: all model work waits until a check finds `claude` logged in.
      this.#loggedOutSince ??= Date.now();
      this.#waiting.add(entry);
      return;
    }

    const now = Date.now();
    this.#failing = { since: this.#failing?.since ?? now, lastError: failure.message };
    const previous = ticket === null ? undefined : this.#retryStates.get(ticket);
    const failures = (previous?.failures ?? 0) + 1;
    const retryAt = now + retryDelay(failures);
    if (ticket !== null) {
      this.#retryStates.set(ticket, {
        ticket,
        failures,
        failingSince: previous?.failingSince ?? new Date(now).toISOString(),
        lastFailure: failure,
        retryAt: new Date(retryAt).toISOString(),
      });
    }
    this.#log.warn("model-run-retry", { ticket, kind, failures, retryAt: new Date(retryAt).toISOString() });
    this.#retrying.add(entry);
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      this.#retrying.delete(entry);
      this.#waiting.add(entry);
      this.#pump();
    }, retryAt - now);
  }

  #pause(resetAt: Date | undefined): void {
    const now = Date.now();
    // A reset time that is not in the future tells nothing about when the limit lifts.
    const reported = resetAt !== undefined && resetAt.getTime() > now;
    const until = reported ? resetAt.getTime() : now + USAGE_LIMIT_PAUSE_MS;
    if (this.#pausedUntil !== null && this.#pausedUntil >= until) return;
    if (this.#pausedUntil === null) this.#pausedSince = now;
    this.#pausedUntil = until;
    this.#log.warn("usage-limit-pause", { until: new Date(until).toISOString(), reported });
    clearTimeout(this.#pauseTimer);
    this.#pauseTimer = setTimeout(() => {
      this.#pausedUntil = null;
      this.#pausedSince = null;
      this.#log.info("usage-limit-pause-ended", {});
      this.#pump();
    }, until - now);
  }

  /** Discards a run wherever it is, interrupting its attempt in flight. */
  #discard(entry: Entry, reason: unknown): void {
    const attempt = entry.attempt;
    entry.attempt = null;
    if (entry.retryTimer !== null) clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
    const wasInFlight = this.#inFlight.delete(entry);
    if (!this.#waiting.delete(entry) && !this.#retrying.delete(entry) && !wasInFlight) return;
    this.#settle(entry);
    attempt?.controller.abort(reason);
    entry.reject(reason);
    this.#pump();
  }

  /** Releases what a run held once it has succeeded or been discarded. */
  #settle(entry: Entry): void {
    entry.signal?.removeEventListener("abort", entry.onAbort);
    const ticket = entry.request.ticket;
    if (ticket !== null && this.#holders.get(ticket) === entry) {
      this.#holders.delete(ticket);
      this.#retryStates.delete(ticket);
    }
  }
}

/** Whether `a` starts before `b`: by group, then oldest, then first asked. */
function before(a: Entry, b: Entry): boolean {
  if (a.rank !== b.rank) return a.rank < b.rank;
  if (a.since !== b.since) return a.since < b.since;
  return a.seq < b.seq;
}

/**
 * A scheduled run as one model run of a call, for the audit log (ADR-0009):
 * its full input and output, model, prompt version, session id, duration and
 * estimated cost. A run whose cost was not reported is recorded at 0.
 */
export function modelRunRecord<T>(request: ModelRunRequest<T>, run: ScheduledRun<T>): NewModelRun {
  return {
    purpose: request.kind,
    model: run.facts.model,
    promptVersion: request.promptVersion,
    sessionId: run.facts.sessionId,
    input: request.prompt,
    output: JSON.stringify(run.output),
    startedAt: run.startedAt,
    durationMs: run.facts.durationMs,
    estimatedCostUsd: run.facts.estimatedCostUsd ?? 0,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
