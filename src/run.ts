import { afterAnswerPlanner } from "./after-answer.ts";
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
import { findingsPlanner } from "./investigation.ts";
import type { ModelRunner } from "./model-runner.ts";
import { ModelRuns } from "./model-runs.ts";
import { InFlightWrites, settleUnconfirmedWrites } from "./forge-writer.ts";
import { outsideCloses } from "./outside-close.ts";
import { Passes, repoForge, type PassesOptions } from "./pass.ts";
import { landingPlanner } from "./landing.ts";
import { landingGrader } from "./landing-grade.ts";
import { landingMerger } from "./merge.ts";
import { pullRequestFollowing } from "./pull-requests.ts";
import { boardPages } from "./board-page.ts";
import { callsPages } from "./calls-page.ts";
import { reposPages } from "./repos-page.ts";
import { startServer, type BoardPortTakenError, type LocalServer } from "./server.ts";
import { globalSettingsPage } from "./settings-page.ts";
import { RecordsRepo } from "./records-repo.ts";
import { checkEveryRepo, RecordsCheck } from "./records-check.ts";
import { Store, type RepoRecord, type StoreOpenError } from "./store.ts";
import type { Forge } from "./forge/forge.ts";
import { ticketPage } from "./ticket-page.ts";
import { Health } from "./health.ts";
import { checkHostLogin, hostKey } from "./host-login.ts";
import type { HostLoginHalt } from "./pass.ts";
import { REPOS_PATH } from "./repos-page.ts";
import { checkTools, type ToolCheck, type ToolProblem } from "./tool-check.ts";

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
  /** Checks `git` and `claude` at start and on every pass; the real programs by default. */
  toolCheck?: ToolCheck;
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
  /** The check for marked issues with no records, and each repo's standing on it (spec §3). */
  recordsCheck: RecordsCheck;
  /** entail's halts and warnings, worked out on every pass, with the status file (spec §16). */
  health: Health;
  /** Stops entail and releases the lock. Calling it again does nothing. */
  stop(reason: string): void;
  /** Settles once entail has stopped. */
  stopped: Promise<void>;
}

/**
 * Starts `entail run` in spec §1's order (ADR-0017): takes the single-copy
 * lock, opens the operational log and the store, runs the check for marked
 * issues with no records on every enrolled repo (spec §3), settles
 * unconfirmed forge writes by reading the forge in the repos found clear,
 * starts the local server on the board port from
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
 * taken, a failure releases it before throwing.
 *
 * Nothing else stops it starting (ADR-0019). When `git` or `claude` is missing
 * or logged out, it reads and writes nothing on any forge and starts no model
 * run, but serves its pages with the halt shown, and the passes check again.
 * A host whose CLI is logged out or logged in as another account is left
 * alone, records check and intents included, until a pass finds it fine. A
 * repo the start could not settle is settled before its first poll.
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
  const recordsCheck = new RecordsCheck({ store, forgeFor, log });
  // Repos whose unconfirmed forge writes the start settled; any other is settled before its first poll.
  const settled = new Set<number>();
  const toolCheck = options.toolCheck ?? checkTools;
  let toolProblems: ToolProblem[] = [];
  const hostLoginHalts = new Map<string, HostLoginHalt>();

  try {
    toolProblems = await toolCheck();
    if (toolProblems.length > 0) {
      // Nothing is read or written until a pass finds `git` and `claude` fine (ADR-0019).
      log.error("tools-halted", { problems: toolProblems.map((problem) => problem.detail) });
    } else {
      await checkHostLogins(store, forgeFor, hostLoginHalts, log);
      const reachable = (repo: RepoRecord) => !hostLoginHalts.has(hostKey(repo));
      // A repo missing its records gets no forge write, settled or new, until
      // the owner restores them or confirms a fresh start (spec §3).
      await checkEveryRepo(store, recordsCheck, reachable);
      const settling = (repo: RepoRecord) => reachable(repo) && recordsCheck.mayAct(repo.id);
      await settleIntents(store, (repo) => (settling(repo) ? forgeFor(repo) : null), log);
      for (const repo of store.listEnrolledRepos()) if (settling(repo)) settled.add(repo.id);
    }
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
  let health: Health | undefined;
  try {
    const enroller = new Enroller({ store, dataDirectory: options.dataDirectory, runner, log });
    const pages = [
      ...boardPages({
        store,
        hostHalted: (host) => passes?.hostHalted(host) ?? false,
        catchingUp: (repoId) => passes?.catchingUp(repoId) ?? false,
        afterAnswer: () => void records.save("answer"),
      }),
      ...reposPages({
        store,
        enroller,
        dataDirectory: options.dataDirectory,
        recordsCheck,
        // A paused repo shows as pausing while its running steps or their writes finish (ADR-0018).
        activity: { pausing: (repo) => passes?.busy(repo.id) ?? false, lastSuccessfulPoll: (repo) => passes?.polling(repo.id).lastSuccess ?? null },
        health: () => health?.conditions() ?? [],
        forgeFor,
        inFlight,
        log,
      }),
      ...callsPages(store),
      ticketPage({ store, retryState: (ticketId) => modelRuns.retryState(String(ticketId)) }),
      globalSettingsPage(store, { dataDirectory: options.dataDirectory }),
    ];
    server = await startServer({ port, pages, log, health: () => health?.page() ?? { strip: [], lastPass: null } });
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
  const closes = outsideCloses({ store, log });
  const merger = landingMerger({ store, log, dataDirectory: options.dataDirectory });
  const running = new Passes({
    store,
    log,
    dataDirectory: options.dataDirectory,
    limiter,
    forgeFor,
    defaultBranchFor: options.passes?.defaultBranchFor,
    planners: options.passes?.planners ?? [
      afterAnswerPlanner({ store, log }),
      deciderPlanner({ store, log, dataDirectory: options.dataDirectory }),
      criteriaPlanner({ store, log, dataDirectory: options.dataDirectory }),
      boardPlanner({ store, log, dataDirectory: options.dataDirectory, notifier, boardOrigin: server.info.origin }),
      // Before following PRs, so a merge entail began is recorded as its own, not as one by someone else.
      merger.planner,
      pullRequests.planner,
      landingPlanner({
        store,
        log,
        dataDirectory: options.dataDirectory,
        afterMechanical: merger.reusingHeld(landingGrader({ store, log, dataDirectory: options.dataDirectory, afterGrade: merger.afterGrade })),
      }),
      findingsPlanner({ store, log }),
      // Last, so reading an issue live never delays a step the ticket owes.
      closes.planner,
    ],
    changeHandlers: options.passes?.changeHandlers ?? [pullRequests.onChange, closes.onChange],
    inFlight,
    modelRuns,
    recordsCheck,
    toolCheck,
    toolProblems,
    checkHostLogins: true,
    hostLoginHalts,
    beforeFirstPoll: async (repo, forge) => {
      if (settled.has(repo.id)) return;
      await settleIntents(store, (other) => (other.id === repo.id ? forge : null), log);
      settled.add(repo.id);
    },
    afterPass: async () => {
      await health?.evaluate();
    },
  });
  passes = running;
  const reposLink = `${server.info.origin}${REPOS_PATH}`;
  health = new Health({
    store,
    dataDirectory: options.dataDirectory,
    log,
    lock,
    passes: running,
    modelRuns,
    recordsCheck,
    notifier,
    reposLink: () => reposLink,
  });
  if (toolProblems.length > 0) modelRuns.hold(true);
  await health.evaluate();
  await health.noticeKeepsStopping();
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
    recordsCheck,
    health,
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

/**
 * Checks each enrolled host's CLI login once, before anything is read or
 * written there (spec §1 "Start" step 4): a host logged out or logged in as
 * another account is halted. A check that fails otherwise leaves the host to
 * its polls.
 */
async function checkHostLogins(
  store: Store,
  forgeFor: (repo: RepoRecord) => Forge,
  halts: Map<string, HostLoginHalt>,
  log: OperationalLog,
): Promise<void> {
  const hosts = new Map<string, RepoRecord[]>();
  for (const repo of store.listEnrolledRepos()) hosts.set(hostKey(repo), [...(hosts.get(hostKey(repo)) ?? []), repo]);
  await Promise.all(
    [...hosts].map(async ([key, repos]) => {
      const first = repos[0]!;
      const check = await checkHostLogin(forgeFor(first), repos);
      if (check.status === "halted") {
        halts.set(key, { forge: first.forge, host: first.host, problem: check.problem, detail: check.detail, since: new Date().toISOString() });
        log.error("host-login-halted", { host: first.host, problem: check.problem, detail: check.detail });
      } else if (check.status === "unknown") {
        log.warn("host-check-failed", { host: first.host, error: check.error });
      }
    }),
  );
}

/** Settles every unconfirmed forge write before the first pass, logging each. */
async function settleIntents(store: Store, forgeFor: (repo: RepoRecord) => Forge | null, log: OperationalLog): Promise<void> {
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
