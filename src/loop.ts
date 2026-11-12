import type { CheckResponse } from "./api-types.ts";
import type { EventBus } from "./events.ts";
import type { PassReport } from "./watch.ts";

/**
 * What `entail run` keeps going: a pass over every enrolled repo on an
 * interval, a pass for one repo when the owner asks to check it now, and an
 * act-only pass the moment an owner's undo window closes, so a confirmation
 * reaches GitHub ten seconds after it was given rather than at the next poll.
 * Passes never overlap: each waits for the one before it.
 */

export interface PassRequest {
  /** Only these repos; every enrolled repo when left out. */
  only?: string[];
  /** Read nothing new from GitHub: only act on what is due. */
  actOnly?: boolean;
}

export interface LoopOptions {
  /** Runs one pass; `onChecked` is called as each repo has been checked for changes. */
  pass: (request: PassRequest & { onChecked: (repo: string, outcome: { ok: boolean; judged: number; posted: number }) => void }) => Promise<PassReport>;
  intervalMs: number;
  /** When the earliest held owner's action comes due, across repos, or null when none is held. */
  nextDue?: () => Date | null;
  /** Runs after every pass, such as sending a notice for what started waiting. */
  afterPass?: () => Promise<void>;
  bus?: EventBus;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

/** How long after a window closes the act-only pass runs, so the hold has surely passed on the clock that checks it. */
const DUE_MARGIN_MS = 250;

export class Loop {
  readonly #options: LoopOptions;
  readonly #checkedAt = new Map<string, string>();
  #tail: Promise<unknown> = Promise.resolve();
  #running = 0;
  #lastPassAt: string | null = null;
  #dueTimer: NodeJS.Timeout | null = null;
  #dueAt: number | null = null;
  #wake: (() => void) | null = null;
  #wakeAsked = false;

  constructor(options: LoopOptions) {
    this.#options = options;
  }

  /** When a repo was last checked for changes in this run. */
  checkedAt(repo: string): string | null {
    return this.#checkedAt.get(repo) ?? null;
  }

  get lastPassAt(): string | null {
    return this.#lastPassAt;
  }

  get checking(): boolean {
    return this.#running > 0;
  }

  /** Queues a pass after any running one, and resolves with its report. */
  request(request: PassRequest = {}): Promise<PassReport> {
    const run = this.#tail.then(() => this.#pass(request));
    this.#tail = run.catch(() => undefined);
    return run;
  }

  /** Checks one repo now, as the board's Check now asks. */
  async check(repo: string): Promise<CheckResponse> {
    const report = await this.request({ only: [repo] });
    return { repo, at: this.checkedAt(repo) ?? this.#now().toISOString(), judged: report.judged, posted: report.posted, failed: report.failed.includes(repo) };
  }

  /** Runs an act-only pass at `at`, or earlier if one is already due sooner. */
  schedule(at: Date): void {
    const when = at.getTime() + DUE_MARGIN_MS;
    if (this.#dueAt !== null && this.#dueAt <= when) return;
    if (this.#dueTimer !== null) clearTimeout(this.#dueTimer);
    this.#dueAt = when;
    this.#dueTimer = setTimeout(() => {
      this.#dueTimer = null;
      this.#dueAt = null;
      this.request({ actOnly: true }).catch((error: unknown) => this.#options.onError?.(error));
    }, Math.max(0, when - this.#now().getTime()));
    this.#dueTimer.unref?.();
  }

  /** Ends the wait before the next full pass, as a change made on the board asks. */
  wake(): void {
    if (this.#wake !== null) this.#wake();
    else this.#wakeAsked = true;
  }

  /** Runs a full pass every interval until `signal` aborts. */
  async run(signal: AbortSignal): Promise<void> {
    this.#scheduleDue();
    while (!signal.aborted) {
      try {
        await this.request({});
      } catch (error) {
        if (signal.aborted) break;
        this.#options.onError?.(error);
      }
      if (this.#wakeAsked) {
        this.#wakeAsked = false;
        continue;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, this.#options.intervalMs);
        function done() {
          clearTimeout(timer);
          resolve();
        }
        this.#wake = () => {
          this.#wake = null;
          done();
        };
        signal.addEventListener("abort", done, { once: true });
      });
      this.#wake = null;
    }
    if (this.#dueTimer !== null) clearTimeout(this.#dueTimer);
  }

  async #pass(request: PassRequest): Promise<PassReport> {
    this.#running++;
    this.#options.bus?.emit({ type: "checking", repo: request.only?.length === 1 ? request.only[0]! : null });
    try {
      const report = await this.#options.pass({
        ...request,
        onChecked: (repo, outcome) => {
          const at = this.#now().toISOString();
          this.#checkedAt.set(repo, at);
          this.#options.bus?.emit({ type: "checked", repo, at, judged: outcome.judged, posted: outcome.posted, failed: !outcome.ok });
        },
      });
      if (request.actOnly !== true && request.only === undefined) this.#lastPassAt = this.#now().toISOString();
      try {
        await this.#options.afterPass?.();
      } catch (error) {
        this.#options.onError?.(error);
      }
      return report;
    } finally {
      this.#running--;
      this.#scheduleDue();
      this.#options.bus?.emit({ type: "changed" });
    }
  }

  #scheduleDue(): void {
    const due = this.#options.nextDue?.();
    if (due !== null && due !== undefined) this.schedule(due);
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }
}
