import { execFile, spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import {
  acceptOutput,
  type MachineFailure,
  type ModelRunner,
  type ModelRunRequest,
  type ModelRunResult,
  type RunFacts,
  type RunOptions,
} from "./model-runner.ts";
import { emitJsonSchema } from "./schema.ts";

const execFileAsync = promisify(execFile);

/** A run is ended after 10 minutes (spec section 1, ADR-0017). */
export const RUN_TIMEOUT_MS = 10 * 60 * 1000;
/** How long an ended run gets after SIGINT before SIGTERM, and after SIGTERM before SIGKILL. */
export const RUN_GRACE_MS = 10 * 1000;

/** At most this much of a run's stderr is kept for a failure's message. */
const STDERR_KEPT = 64 * 1024;

export interface ClaudeRunnerOptions {
  /** The `claude` executable; `claude` on the PATH by default. */
  command?: string;
  timeoutMs?: number;
  graceMs?: number;
}

/**
 * The arguments of one run: structured JSON output against the request's
 * schema, the request's model, read-only tools, and isolation from the
 * owner's settings, MCP servers, permission prompts and saved sessions
 * (spec section 6). The prompt goes on stdin.
 */
export function claudeArguments(request: ModelRunRequest): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    emitJsonSchema(request.schema),
    "--model",
    request.model,
    "--tools",
    "Read,Grep,Glob",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
  ];
}

/**
 * The real model runner: one `claude -p` subprocess per run, on the owner's
 * subscription, in the request's read-only checkout (spec section 6). It
 * classifies every way a run can fail as a machine failure, so nothing above
 * it knows about `claude`.
 */
export class ClaudeRunner implements ModelRunner {
  readonly #command: string;
  readonly #timeoutMs: number;
  readonly #graceMs: number;

  constructor(options: ClaudeRunnerOptions = {}) {
    this.#command = options.command ?? "claude";
    this.#timeoutMs = options.timeoutMs ?? RUN_TIMEOUT_MS;
    this.#graceMs = options.graceMs ?? RUN_GRACE_MS;
  }

  async run<T>(request: ModelRunRequest<T>, options: RunOptions = {}): Promise<ModelRunResult<T>> {
    const { signal } = options;
    signal?.throwIfAborted();
    const misplaced = await checkoutProblem(request.checkout, request.sha);
    if (misplaced !== null) return { ok: false, failure: { kind: "error", message: misplaced }, facts: null };
    signal?.throwIfAborted();

    const started = performance.now();
    const exit = await this.#spawn(request, signal);
    if (exit.aborted) throw signal?.reason;
    return classify(request, exit, Math.round(performance.now() - started));
  }

  #spawn(request: ModelRunRequest, signal: AbortSignal | undefined): Promise<Exit> {
    return new Promise((resolve) => {
      const child = spawn(this.#command, claudeArguments(request), { cwd: request.checkout, stdio: ["pipe", "pipe", "pipe"] });
      const exit: Exit = { code: null, signal: null, stdout: "", stderr: "", timedOut: false, aborted: false, spawnError: null };
      let exited = false;
      const timers: NodeJS.Timeout[] = [];

      // SIGINT first, SIGTERM after a grace period, and SIGKILL only if
      // even that is ignored, so a run never holds a model slot forever.
      const end = () => {
        child.kill("SIGINT");
        timers.push(
          setTimeout(() => {
            if (exited) return;
            child.kill("SIGTERM");
            timers.push(setTimeout(() => exited || child.kill("SIGKILL"), this.#graceMs));
          }, this.#graceMs),
        );
      };
      const onAbort = () => {
        exit.aborted = true;
        end();
      };

      timers.push(
        setTimeout(() => {
          exit.timedOut = true;
          end();
        }, this.#timeoutMs),
      );
      signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        exit.stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        exit.stderr = (exit.stderr + chunk).slice(-STDERR_KEPT);
      });
      // A run that exits before reading its prompt closes stdin early.
      child.stdin.on("error", () => {});
      child.stdin.end(request.prompt);

      const finish = () => {
        if (exited) return;
        exited = true;
        for (const timer of timers) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(exit);
      };
      child.on("error", (error) => {
        exit.spawnError = error;
        finish();
      });
      child.on("close", (code, killedBy) => {
        exit.code = code;
        exit.signal = killedBy;
        finish();
      });
    });
  }
}

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError: Error | null;
}

/** Why the checkout cannot be read at the recorded sha, or null if it can. */
async function checkoutProblem(checkout: string, sha: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", checkout, "rev-parse", "--verify", "HEAD"]);
    const head = stdout.trim();
    return head === sha ? null : `the checkout ${checkout} is at ${head}, not the recorded sha ${sha}`;
  } catch (error) {
    return `the checkout ${checkout} could not be read: ${error instanceof Error ? error.message.trim() : String(error)}`;
  }
}

/** The fields of `claude -p --output-format json`'s result entail reads. */
interface ClaudeResult {
  type?: unknown;
  subtype?: unknown;
  is_error?: unknown;
  result?: unknown;
  stop_reason?: unknown;
  api_error_status?: unknown;
  session_id?: unknown;
  duration_ms?: unknown;
  total_cost_usd?: unknown;
  usage?: unknown;
  modelUsage?: unknown;
  structured_output?: unknown;
}

function classify<T>(request: ModelRunRequest<T>, exit: Exit, measuredMs: number): ModelRunResult<T> {
  const fail = (failure: MachineFailure, facts: RunFacts | null = null): ModelRunResult<T> => ({ ok: false, failure, facts });
  if (exit.spawnError !== null) {
    return fail({ kind: "error", message: `claude could not be started: ${exit.spawnError.message}` });
  }
  if (exit.timedOut) {
    return fail({ kind: "timeout", message: `the run did not finish within ${Math.round(measuredMs / 1000)} s` });
  }

  const result = parseResult(exit.stdout);
  if (result === null) {
    const text = `${exit.stdout}\n${exit.stderr}`;
    if (USAGE_LIMIT.test(text)) return fail(usageLimit(text));
    const how = exit.code !== null ? `exited with code ${exit.code}` : `was ended by ${exit.signal ?? "an unknown cause"}`;
    return fail({ kind: "error", message: `claude ${how} without a result: ${tail(exit.stderr || exit.stdout)}` });
  }

  const facts = factsOf(result, request.model, measuredMs);
  const text = typeof result.result === "string" ? result.result : "";
  if (result.stop_reason === "refusal") {
    return fail({ kind: "refusal", message: `the model refused: ${tail(text)}` }, facts);
  }
  if (result.is_error === true || result.subtype !== "success") {
    if (result.subtype === "error_max_structured_output_retries") {
      return fail({ kind: "no-structured-output", message: "the run gave up producing output that matches the schema" }, facts);
    }
    if (result.api_error_status === 429 || USAGE_LIMIT.test(text)) return fail(usageLimit(text), facts);
    return fail({ kind: "error", message: `the run failed (${String(result.subtype)}): ${tail(text || exit.stderr)}` }, facts);
  }
  return acceptOutput(request.schema, result.structured_output, facts);
}

function parseResult(stdout: string): ClaudeResult | null {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && (parsed as ClaudeResult).type === "result"
      ? (parsed as ClaudeResult)
      : null;
  } catch {
    return null;
  }
}

function factsOf(result: ClaudeResult, requested: string, measuredMs: number): RunFacts {
  const models = isRecord(result.modelUsage) ? Object.keys(result.modelUsage) : [];
  return {
    sessionId: typeof result.session_id === "string" ? result.session_id : null,
    model: models.includes(requested) ? requested : (models[0] ?? requested),
    durationMs: typeof result.duration_ms === "number" ? result.duration_ms : measuredMs,
    estimatedCostUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : null,
    usage: isRecord(result.usage) ? result.usage : null,
  };
}

/** How `claude` words the subscription's usage limit and rate limits. */
const USAGE_LIMIT = /usage limit|hit your limit|limit reached|rate limit/i;

/**
 * A usage-limit failure, with the reset time when `claude` reported one: as
 * epoch seconds after a `|` ("Claude AI usage limit reached|1794153600") or
 * as an ISO 8601 time. Without one, the scheduler pauses for 30 minutes.
 */
export function usageLimit(text: string): MachineFailure {
  const failure: MachineFailure = { kind: "usage-limit", message: `the usage limit was reached: ${tail(text)}` };
  const epoch = /\|\s*(\d{10})\b/.exec(text);
  const iso = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/.exec(text);
  const resetAt = epoch ? new Date(Number(epoch[1]) * 1000) : iso ? new Date(iso[1]!) : undefined;
  if (resetAt !== undefined && !Number.isNaN(resetAt.getTime())) failure.resetAt = resetAt;
  return failure;
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 500 ? `…${trimmed.slice(-500)}` : trimmed || "(no output)";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
