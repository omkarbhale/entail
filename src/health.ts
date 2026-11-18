import type { FailingView } from "./api-types.ts";

/**
 * Whether each repo's passes are working, as the running process saw them:
 * the last failure of a pass on a repo (when, at which step, why, and for a
 * rate or usage limit when it resets) and when a check on it last finished
 * with nothing failed. It is kept in memory only: the operational log holds
 * every failure as it happened, and this is what `entail status` and the
 * board read from the running copy.
 *
 * A failure never changes a call or stops polling; it is only told.
 */

/** One step of a pass on a repo that failed. */
export interface RepoFailure {
  at: string;
  /** Which step failed, in words: "reading the forge", "judging #12", "acting on PR #7". */
  step: string;
  /** The error, on one line. */
  message: string;
  /** For a usage or rate limit: when it resets, if known. */
  resetAt?: string;
}

/** A repo whose last check failed and that has not had one succeed since. */
export interface Failing {
  /** The first failed check of this run of failures. */
  since: string;
  last: RepoFailure;
  /** Checks failed in a row. */
  checks: number;
}

/** How long a repo has to have been failing before the owner is told, so one failed poll followed by a good one says nothing. */
export const FAILING_NOTICE_AFTER_MS = 10 * 60_000;

/** The longest message kept from an error. */
const MESSAGE_LIMIT = 300;

/** The error's message on one line, kept short. */
export function oneLine(message: string): string {
  const line = message.replace(/\s+/gu, " ").trim();
  return line.length > MESSAGE_LIMIT ? `${line.slice(0, MESSAGE_LIMIT - 1)}…` : line;
}

/** A failure for the owner to read: the step, the error, and the reset time when there is one. */
export function failureReason(failure: RepoFailure): string {
  const reset = failure.resetAt === undefined ? "" : `; it resets at ${failure.resetAt.slice(0, 16).replace("T", " ")} UTC`;
  return `${failure.step}: ${failure.message}${reset}`;
}

export function failingView(failing: Failing): FailingView {
  const { last } = failing;
  return { since: failing.since, at: last.at, step: last.step, message: last.message, resetAt: last.resetAt ?? null, reason: failureReason(last) };
}

export class Health {
  readonly #failing = new Map<string, Failing>();
  readonly #okAt = new Map<string, string>();

  /** Notes how a check on a repo went: failed when it carries a failure. */
  checked(repo: string, failure: RepoFailure | undefined, at: string): void {
    if (failure === undefined) {
      this.#failing.delete(repo);
      this.#okAt.set(repo, at);
      return;
    }
    const before = this.#failing.get(repo);
    this.#failing.set(repo, { since: before?.since ?? failure.at, last: failure, checks: (before?.checks ?? 0) + 1 });
  }

  /** The repo's failing run, or null while it works or was not checked yet. */
  failing(repo: string): Failing | null {
    return this.#failing.get(repo) ?? null;
  }

  /** When a check on the repo last finished with nothing failed in this run, or null. */
  okAt(repo: string): string | null {
    return this.#okAt.get(repo) ?? null;
  }

  /** Every repo checked in this run: failing, or working since its last good check. */
  repos(): { repo: string; failing: Failing | null }[] {
    const repos = new Set([...this.#failing.keys(), ...this.#okAt.keys()]);
    return [...repos].sort().map((repo) => ({ repo, failing: this.failing(repo) }));
  }
}
