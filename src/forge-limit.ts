import type { ForgeRequest, ForgeResponse, Transport } from "./forge/transport.ts";

/** At most this many forge subprocesses run at once, across all repos (ADR-0017). */
export const FORGE_SUBPROCESS_LIMIT = 4;

/**
 * Lets at most `limit` tasks run at once; the rest wait their turn, first come
 * first served. One limiter is shared by every repo, so it bounds the forge
 * subprocesses entail runs in total: `gh` and `glab` calls, and the `git`
 * calls that reach a forge's remote.
 */
export class Limiter {
  readonly limit: number;
  #running = 0;
  #peak = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(limit: number = FORGE_SUBPROCESS_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError(`not a limit: ${limit}`);
    this.limit = limit;
  }

  /** How many tasks are running now. */
  get running(): number {
    return this.#running;
  }

  /** The most tasks that ever ran at once. */
  get peak(): number {
    return this.#peak;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#running >= this.limit) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    } else {
      this.#running++;
    }
    this.#peak = Math.max(this.#peak, this.#running);
    try {
      return await task();
    } finally {
      // A waiting task takes this one's place, so the count stays as it is.
      const next = this.#waiting.shift();
      if (next) next();
      else this.#running--;
    }
  }
}

/** A transport whose requests, each one CLI subprocess, wait their turn at a shared {@link Limiter}. */
export class LimitedTransport implements Transport {
  readonly #inner: Transport;
  readonly #limiter: Limiter;

  constructor(inner: Transport, limiter: Limiter) {
    this.#inner = inner;
    this.#limiter = limiter;
  }

  request(request: ForgeRequest): Promise<ForgeResponse> {
    return this.#limiter.run(() => this.#inner.request(request));
  }
}
