import { readGlobalSettings, type GlobalSettings } from "./global-settings.ts";
import { acquireLock, type HeldLock } from "./lock.ts";
import { Notifier } from "./notice.ts";
import { OperationalLog, type OperationalLogOptions } from "./operational-log.ts";
import { Enroller } from "./enrollment.ts";
import { Limiter } from "./forge-limit.ts";
import { ClaudeRunner } from "./claude-runner.ts";
import { boardPlanner } from "./board-item.ts";
import { criteriaPlanner } from "./criteria.ts";
import { deciderPlanner } from "./decider.ts";
import type { ModelRunner } from "./model-runner.ts";
import { ModelRuns } from "./model-runs.ts";
import { InFlightWrites, settleUnconfirmedWrites } from "./forge-writer.ts";
import { Passes, repoForge, type PassesOptions } from "./pass.ts";
import { landingPlanner } from "./landing.ts";
import { pullRequestFollowing } from "./pull-requests.ts";
import { boardPages } from "./board-page.ts";
import { callsPages } from "./calls-page.ts";
import { reposPages } from "./repos-page.ts";
import { startServer, type BoardPortTakenError, type LocalServer } from "./server.ts";
import { globalSettingsPage } from "./settings-page.ts";
import { RecordsRepo } from "./records-repo.ts";
import { Store, type StoreOpenError } from "./store.ts";
import { ticketPage } from "./ticket-page.ts";

/** How long stopping waits for in-flight forge writes to confirm (ADR-0017). */
export const STOP_WAIT_MS = 10_000;

export interface RunOptions {
  dataDirectory: string;
  log?: OperationalLogOptions;
  /** Replaces what the passes reach the forge and git through; the owner's own CLIs by default. */
  passes?: Pick<PassesOptions, "forgeFor" | "defaultBranchFor" | "planners" | "changeHandlers" | "limiter">;
  /** Makes every model run; `claude -p` on the owner's subscription by default. */
  modelRunner?: ModelRunner;
  /** How long stopping waits for in-flight forge writes; {@link STOP_WAIT_MS} by default. */
  stopWaitMs?: number;
}

export interface RunningEntail {
  lock: HeldLock;
  log: OperationalLog;
  store: Store;
  /** The local server every page is served from. */
  server: LocalServer;
  /**
   * The global settings in force, read from the store on every call so a
   * saved change takes effect within one pass. The board port is the
   * exception: the server keeps the port it started on until the next start.
   */
  globalSettings(): GlobalSettings;
  /** Sends notices through the connector the global settings name at each notice. */
  notifier: Notifier;
  /** The passes over every enrolled repo, started once the server is up. */
  passes: Passes;
  /** The forge writes in flight, which stopping waits for. */
  inFlight: InFlightWrites;
  /** Every model run, limited by the global "Model-run limit"; stopping interrupts them. */
  modelRuns: ModelRuns;
  /** The records repo, committed after every answer, hourly and on stop, and pushed to the global settings' remote. */
  records: RecordsRepo;
  /** Stops entail and releases the lock. Calling it again does nothing. */
  stop(reason: string): void;
  /** Settles once entail has stopped. */
  stopped: Promise<void>;
}

/**
 * Starts `entail run` in spec §1's order (ADR-0017): takes the single-copy
 * lock, opens the operational log and the store, settles unconfirmed forge
 * writes by reading the forge, starts the local server on the board port from
 * the global settings (the board page, spec §13, the Repos page with
 * enrollment and the global settings page, spec §15, and the read-only Calls
 * page and ticket pages, spec §14),
 * and then the passes and the hourly records repo commit. It stays up until
 * {@link RunningEntail.stop}, which commits and pushes the records repo
 * before releasing the lock.
 *
 * Throws {@link LockHeldError} when another copy holds the lock;
 * {@link StoreOpenError} when the store cannot be opened; and
 * {@link BoardPortTakenError} when the board port is taken. After the lock is
 * taken, a failure releases it before throwing. Later tickets add the
 * start-up checks for `git`, `claude`, each host's login and marked issues
 * with no records.
 */
export async function startRun(options: RunOptions): Promise<RunningEntail> {
  const lock = acquireLock(options.dataDirectory);
  const log = new OperationalLog(options.dataDirectory, options.log);

  if (lock.takeover) {
    // Recorded so health can warn about the unexpected stop (ADR-0019).
    log.warn("unexpected-stop", {
      previousPid: lock.takeover.previous?.pid ?? null,
      previousStartedAt: lock.takeover.previous?.startedAt ?? null,
      detectedAt: lock.takeover.detectedAt,
    });
  }

  let store: Store;
  try {
    store = Store.openIn(options.dataDirectory);
  } catch (error) {
    log.error("store-open-failed", { error: error instanceof Error ? error.message : String(error) });
    lock.release();
    throw error;
  }

  // One limiter for every repo: at most four forge subprocesses at once.
  const limiter = options.passes?.limiter ?? new Limiter();
  const forgeFor = options.passes?.forgeFor ?? ((repo) => repoForge(repo, limiter));
  const inFlight = new InFlightWrites();

  try {
    await settleIntents(store, forgeFor, log);
  } catch (error) {
    log.error("settle-failed", { error: error instanceof Error ? error.message : String(error) });
    store.close();
    lock.release();
    throw error;
  }

  // The port is read once: a running server keeps the port its links were posted with.
  const port = readGlobalSettings(store).settings.boardPort;
  const runner = options.modelRunner ?? new ClaudeRunner();
  const modelRuns = new ModelRuns({
    runner,
    log,
    limit: () => readGlobalSettings(store).settings.modelRunLimit,
  });
  const records = new RecordsRepo({
    dataDirectory: options.dataDirectory,
    storePath: store.path,
    remote: () => readGlobalSettings(store).settings.recordsRemote,
    log,
  });
  let server: LocalServer;
  let passes: Passes | undefined;
  try {
    const enroller = new Enroller({ store, dataDirectory: options.dataDirectory, runner, log });
    const pages = [
      ...boardPages({
        store,
        hostHalted: (host) => passes?.hostHalted(host) ?? false,
        afterAnswer: () => void records.save("answer"),
      }),
      ...reposPages({ store, enroller, dataDirectory: options.dataDirectory }),
      ...callsPages(store),
      ticketPage({ store, retryState: (ticketId) => modelRuns.retryState(String(ticketId)) }),
      globalSettingsPage(store, { dataDirectory: options.dataDirectory }),
    ];
    server = await startServer({ port, pages, log });
  } catch (error) {
    log.error("board-server-failed", { port, error: error instanceof Error ? error.message : String(error) });
    store.close();
    lock.release();
    throw error;
  }
  log.info("started", {
    pid: lock.holder.pid,
    dataDirectory: options.dataDirectory,
    store: store.path,
    board: `${server.info.origin}/`,
  });

  const notifier = new Notifier({
    connectorName: () => readGlobalSettings(store).settings.noticeConnector,
    dataDirectory: options.dataDirectory,
    log,
  });

  const pullRequests = pullRequestFollowing({ store, log });
  const running = new Passes({
    store,
    log,
    dataDirectory: options.dataDirectory,
    limiter,
    forgeFor,
    defaultBranchFor: options.passes?.defaultBranchFor,
    planners: options.passes?.planners ?? [
      deciderPlanner({ store, log, dataDirectory: options.dataDirectory }),
      criteriaPlanner({ store, log, dataDirectory: options.dataDirectory }),
      boardPlanner({ store, log, dataDirectory: options.dataDirectory, notifier, boardOrigin: server.info.origin }),
      pullRequests.planner,
      landingPlanner({ store, log, dataDirectory: options.dataDirectory }),
    ],
    changeHandlers: options.passes?.changeHandlers ?? [pullRequests.onChange],
    inFlight,
    modelRuns,
  });
  passes = running;
  running.start();
  records.startHourly();
  const stopWaitMs = options.stopWaitMs ?? STOP_WAIT_MS;

  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  let stopping = false;

  return {
    lock,
    log,
    store,
    server,
    stopped,
    globalSettings: () => readGlobalSettings(store).settings,
    notifier,
    passes: running,
    inFlight,
    modelRuns,
    records,
    stop(reason: string) {
      if (stopping) return;
      stopping = true;
      log.info("stopping", { reason });
      void (async () => {
        // Start no new work and interrupt model runs, then wait up to the
        // limit for the pass in progress, the interrupted runs and forge
        // writes in flight to confirm. Writes left unconfirmed are settled on
        // the next start, and interrupted runs are run again.
        await waitAtMost(stopWaitMs, Promise.all([running.stop(), inFlight.settle(stopWaitMs)]));
        if (inFlight.count > 0) log.warn("writes-unconfirmed-at-stop", { count: inFlight.count });
        // The server closes first, so no answer arrives after the last commit.
        await server.close();
        records.stopHourly();
        await records.save("stop");
        store.close();
        lock.release();
        log.info("stopped", { pid: lock.holder.pid });
        resolveStopped();
      })();
    },
  };
}

/** Settles every unconfirmed forge write before the first pass, logging each. */
async function settleIntents(store: Store, forgeFor: NonNullable<PassesOptions["forgeFor"]>, log: OperationalLog): Promise<void> {
  const settled = await settleUnconfirmedWrites(store, forgeFor);
  for (const write of settled) {
    if ("error" in write) log.warn("intent-settle-failed", { intentId: write.intentId, kind: write.kind, error: write.error.message });
    else log.info("intent-settled", { intentId: write.intentId, kind: write.kind, settled: write.settled });
  }
  if (settled.length > 0) log.info("intents-settled", { count: settled.length });
}

/** Waits for `work`, or `ms`, whichever is first. */
async function waitAtMost(ms: number, work: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  clearTimeout(timer);
}
