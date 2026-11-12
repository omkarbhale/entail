import {
  acceptOutput,
  type MachineFailure,
  type ModelRunner,
  type ModelRunRequest,
  type ModelRunResult,
  type RunFacts,
  type RunOptions,
} from "./model-runner.ts";

/**
 * One recorded result: an output, or a machine failure. With `until`, the run
 * stays in flight until that promise settles, or rejects with the signal's
 * reason if it is interrupted first.
 */
export type ScriptedOutcome = ({ output: unknown; facts?: Partial<RunFacts> } | { failure: MachineFailure; facts?: Partial<RunFacts> | null }) & {
  until?: Promise<unknown>;
};

/**
 * The model runner unit tests use in place of `claude`. Each kind and
 * ticket gets a list of recorded outcomes, returned
 * one per run in order. A run with nothing left to return rejects, so a test
 * never gets a result it did not script.
 *
 * Outputs go through the same schema check as the real runner's, so a
 * recorded output that does not match the request's schema comes back as the
 * "no structured output" machine failure.
 */
export class ScriptedRunner implements ModelRunner {
  /** Every request made, in order. */
  readonly requests: ModelRunRequest[] = [];
  readonly #outcomes = new Map<string, ScriptedOutcome[]>();

  /** Adds outcomes for runs of this kind for this ticket (null for none). */
  script(kind: string, ticket: string | null, ...outcomes: ScriptedOutcome[]): this {
    const key = keyOf(kind, ticket);
    this.#outcomes.set(key, [...(this.#outcomes.get(key) ?? []), ...outcomes]);
    return this;
  }

  /** Outcomes scripted but not yet returned, by kind and ticket. */
  remaining(kind: string, ticket: string | null): number {
    return this.#outcomes.get(keyOf(kind, ticket))?.length ?? 0;
  }

  async run<T>(request: ModelRunRequest<T>, options: RunOptions = {}): Promise<ModelRunResult<T>> {
    options.signal?.throwIfAborted();
    this.requests.push(request as ModelRunRequest);
    const outcome = this.#outcomes.get(keyOf(request.kind, request.ticket))?.shift();
    if (outcome === undefined) {
      throw new Error(`no scripted outcome for kind ${request.kind} on ticket ${request.ticket ?? "(none)"}`);
    }
    if (outcome.until) await held(outcome.until, options.signal);
    const facts = (overrides: Partial<RunFacts> | null | undefined): RunFacts => ({
      sessionId: `scripted-${this.requests.length}`,
      model: request.model,
      durationMs: 0,
      estimatedCostUsd: 0,
      usage: null,
      ...overrides,
    });
    if ("failure" in outcome) {
      return { ok: false, failure: outcome.failure, facts: outcome.facts === null ? null : facts(outcome.facts) };
    }
    return acceptOutput(request.schema, outcome.output, facts(outcome.facts));
  }
}

/** Waits for `until`, unless `signal` interrupts first. */
async function held(until: Promise<unknown>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) {
    await until;
    return;
  }
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([until, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function keyOf(kind: string, ticket: string | null): string {
  return JSON.stringify([kind, ticket]);
}
