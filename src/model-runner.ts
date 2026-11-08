import { checkAgainst, type Schema } from "./schema.ts";

/**
 * The model every run uses unless the global "Model" setting names another:
 * Opus 5.5 (spec section 15, ADR-0018).
 */
export const DEFAULT_MODEL = "claude-opus-5-5";

/** The kinds of model run entail makes. */
export const RUN_KINDS = [
  "verdict",
  "challenge",
  "criteria",
  "re-check",
  "grade",
  "landing-challenge",
  "generic-criteria-proposal",
] as const;

export type RunKind = (typeof RUN_KINDS)[number];

/** One model run, as the step that needs it asks for it. */
export interface ModelRunRequest<T = unknown> {
  kind: RunKind;
  /**
   * The ticket's record id, or null for a run that belongs to no ticket (the
   * generic criteria proposal at enrollment).
   */
  ticket: string | null;
  prompt: string;
  promptVersion: string;
  /** The output's schema, emitted as JSON Schema for the run. */
  schema: Schema<T>;
  /** A read-only checkout made by the git mirror, which the run reads: of the default branch, or of a PR's head for a landing check's runs. */
  checkout: string;
  /** The commit the checkout is at, as recorded on the call. */
  sha: string;
  /** From the global "Model" setting, {@link DEFAULT_MODEL} by default. */
  model: string;
}

/** What entail records about a run besides its output (ADR-0009). */
export interface RunFacts {
  sessionId: string | null;
  model: string;
  durationMs: number;
  /** The run's estimated cost in US dollars. There is no budget (ADR-0017). */
  estimatedCostUsd: number | null;
  /** Token usage as reported for the run. */
  usage: Record<string, unknown> | null;
}

export const MACHINE_FAILURE_KINDS = ["no-structured-output", "error", "timeout", "refusal", "usage-limit", "logged-out"] as const;

export type MachineFailureKind = (typeof MACHINE_FAILURE_KINDS)[number];

/**
 * A run that produced no usable output. A machine failure is retried, logged
 * to the operational log and never reaches the board (ADR-0002, ADR-0017).
 * `logged-out` is `claude` refusing the run for want of a login: that is the
 * all-of-entail halt, checked again on every pass, not a failure retried on
 * its own (ADR-0019).
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
 * The one path to a model (ADR-0017). Every step that needs a model run calls
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
