import { checkAgainst, type Schema } from "./schema.ts";

/** The model every run uses unless the caller names another: Opus 5.5. */
export const DEFAULT_MODEL = "claude-opus-5-5";

/** The effort levels `claude --effort` takes. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type Effort = (typeof EFFORTS)[number];

/** The effort a real judgment uses unless the settings or caller name another: high, since a wrong call costs the owner's attention and a judgment costs cents either way. */
export const DEFAULT_EFFORT: Effort = "high";

/** The effort `entail replay` uses unless --effort names another: low, so the case book stays cheap to replay. */
export const REPLAY_EFFORT: Effort = "low";

/** One model run, as the judgment that needs it asks for it. */
export interface ModelRunRequest<T = unknown> {
  /** What the run is for, named by the judgment that asks for it, such as the call on an issue or on a PR. */
  kind: string;
  /** The ticket the run is about, or null for a run that belongs to no ticket. */
  ticket: string | null;
  prompt: string;
  promptVersion: string;
  /** The output's schema, emitted as JSON Schema for the run. */
  schema: Schema<T>;
  /** A read-only checkout made by the git mirror, which the run reads: of the default branch, or of a PR's head. */
  checkout: string;
  /** The commit the checkout is at, as recorded on the call. */
  sha: string;
  /** The model to run, {@link DEFAULT_MODEL} by default. */
  model: string;
  /** How hard the model works on the run; the model's own default when left out. */
  effort?: Effort;
}

/** What entail records about a run besides its output. */
export interface RunFacts {
  sessionId: string | null;
  model: string;
  durationMs: number;
  /** The run's estimated cost in US dollars. */
  estimatedCostUsd: number | null;
  /** Token usage as reported for the run. */
  usage: Record<string, unknown> | null;
}

export const MACHINE_FAILURE_KINDS = ["no-structured-output", "error", "timeout", "refusal", "usage-limit", "logged-out"] as const;

export type MachineFailureKind = (typeof MACHINE_FAILURE_KINDS)[number];

/**
 * A run that produced no usable output. A machine failure is never a call:
 * it is retried or logged, and no judgment is made from it. `logged-out` is
 * `claude` refusing the run for want of a login, which no retry fixes until
 * the owner logs in again.
 */
export interface MachineFailure {
  kind: MachineFailureKind;
  message: string;
  /** For a usage limit: when the limit resets, if one was reported. */
  resetAt?: Date;
}

export type ModelRunResult<T = unknown> =
  | { ok: true; output: T; facts: RunFacts }
  | { ok: false; failure: MachineFailure; facts: RunFacts | null };

export interface RunOptions {
  /** Interrupts the run; the promise then rejects with the signal's reason. */
  signal?: AbortSignal;
}

/**
 * The one path to a model. Every judgment that needs a model run calls
 * `run`, and nothing above this interface knows how the run is made.
 */
export interface ModelRunner {
  run<T>(request: ModelRunRequest<T>, options?: RunOptions): Promise<ModelRunResult<T>>;
}

/**
 * Accepts a run's structured output only when it conforms to the request's
 * schema; anything else is the "no structured output" machine failure.
 */
export function acceptOutput<T>(schema: Schema<T>, output: unknown, facts: RunFacts): ModelRunResult<T> {
  if (output === undefined || output === null) {
    return { ok: false, failure: { kind: "no-structured-output", message: "the run returned no structured output" }, facts };
  }
  const problems = checkAgainst(schema, output);
  if (problems.length > 0) {
    return {
      ok: false,
      failure: { kind: "no-structured-output", message: `the structured output does not match the schema: ${problems.slice(0, 5).join("; ")}` },
      facts,
    };
  }
  return { ok: true, output: output as T, facts };
}
