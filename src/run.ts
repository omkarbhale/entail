import { acquireLock, type HeldLock } from "./lock.ts";
import { OperationalLog, type OperationalLogOptions } from "./operational-log.ts";
import { Store, type StoreOpenError } from "./store.ts";

export interface RunOptions {
  dataDirectory: string;
  log?: OperationalLogOptions;
}

export interface RunningEntail {
  lock: HeldLock;
  log: OperationalLog;
  store: Store;
  /** Stops entail and releases the lock. Calling it again does nothing. */
  stop(reason: string): void;
  /** Settles once entail has stopped. */
  stopped: Promise<void>;
}

/**
 * Starts `entail run`: takes the single-copy lock, opens the operational log
 * and the store, and stays up until {@link RunningEntail.stop} (ADR-0017).
 *
 * Throws {@link LockHeldError} when another copy holds the lock, and
 * {@link StoreOpenError}, after releasing the lock, when the store cannot be
 * opened. Later tickets add the start-up checks, the board server and the
 * passes.
 */
export function startRun(options: RunOptions): RunningEntail {
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
  log.info("started", { pid: lock.holder.pid, dataDirectory: options.dataDirectory, store: store.path });

  // Nothing else keeps the event loop alive until the passes exist.
  const keepAlive = setInterval(() => {}, 2 ** 31 - 1);
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  let stopping = false;

  return {
    lock,
    log,
    store,
    stopped,
    stop(reason: string) {
      if (stopping) return;
      stopping = true;
      log.info("stopping", { reason });
      clearInterval(keepAlive);
      store.close();
      lock.release();
      log.info("stopped", { pid: lock.holder.pid });
      resolveStopped();
    },
  };
}
