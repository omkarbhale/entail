import { readGlobalSettings, type GlobalSettings } from "./global-settings.ts";
import { acquireLock, type HeldLock } from "./lock.ts";
import { Notifier } from "./notice.ts";
import { OperationalLog, type OperationalLogOptions } from "./operational-log.ts";
import { startServer, type BoardPortTakenError, type LocalServer } from "./server.ts";
import { globalSettingsPage } from "./settings-page.ts";
import { Store, type StoreOpenError } from "./store.ts";

export interface RunOptions {
  dataDirectory: string;
  log?: OperationalLogOptions;
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
  /** Stops entail and releases the lock. Calling it again does nothing. */
  stop(reason: string): void;
  /** Settles once entail has stopped. */
  stopped: Promise<void>;
}

/**
 * Starts `entail run`: takes the single-copy lock, opens the operational log
 * and the store, and stays up until {@link RunningEntail.stop} (ADR-0017).
 *
 * Then it starts the local server on the board port from the global settings
 * (spec §15).
 *
 * Throws {@link LockHeldError} when another copy holds the lock;
 * {@link StoreOpenError} when the store cannot be opened; and
 * {@link BoardPortTakenError} when the board port is taken. After the lock is
 * taken, a failure releases it before throwing. Later tickets add the
 * start-up checks and the passes.
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

  // The port is read once: a running server keeps the port its links were posted with.
  const port = readGlobalSettings(store).settings.boardPort;
  let server: LocalServer;
  try {
    server = await startServer({ port, pages: [globalSettingsPage(store)], log });
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
    stop(reason: string) {
      if (stopping) return;
      stopping = true;
      log.info("stopping", { reason });
      void server.close().then(() => {
        store.close();
        lock.release();
        log.info("stopped", { pid: lock.holder.pid });
        resolveStopped();
      });
    },
  };
}
