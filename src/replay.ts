import { precedentsFor, type Case } from "./case-book.ts";
import { judge, type JudgeOptions, type Judgment, type JudgmentInputs } from "./judgment.ts";
import type { ModelRunner } from "./model-runner.ts";

/**
 * Replaying the case book: every case goes through the judgment as if it
 * were a new issue, against the vision it was decided under, and its answer
 * is compared with the owner's call. A case never sees itself as precedent.
 */

/** One case replayed. */
export interface ReplayResult {
  case: Case;
  judgment: Judgment;
  /** Whether entail's call is the owner's; null when the run gave no call. */
  agrees: boolean | null;
}

/** A read-only checkout of a case's repo at the case's vision commit. */
export type CaseCheckout = (past: Case) => Promise<{ directory: string; commit: string }>;

export interface ReplayOptions extends JudgeOptions {
  /** How many cases are judged at once; 2 by default. */
  concurrency?: number;
}

/** The judgment's inputs for a case: its own issue and vision, and every other case as precedent. */
export function caseInputs(past: Case, book: readonly Case[], checkout: { directory: string; commit: string }): JudgmentInputs {
  const others = book.filter((other) => other.slug !== past.slug);
  return {
    repo: past.repo,
    issueNumber: past.issue,
    issueText: past.issueText,
    vision: past.vision.trim() === "" ? null : { text: past.vision, commit: past.visionCommit },
    // Cases record no pins yet: the seeded repo had none.
    pins: [],
    precedents: precedentsFor(others, past.repo, past.issueText),
    checkout: checkout.directory,
    sha: checkout.commit,
  };
}

/** Replays every case in the book, in the book's order. */
export async function replay(runner: ModelRunner, book: readonly Case[], checkoutOf: CaseCheckout, options: ReplayOptions = {}): Promise<ReplayResult[]> {
  const { concurrency = 2, ...judgeOptions } = options;
  const results: ReplayResult[] = new Array(book.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < book.length) {
      const index = next++;
      const past = book[index]!;
      const judgment = await judge(runner, caseInputs(past, book, await checkoutOf(past)), judgeOptions);
      results[index] = { case: past, judgment, agrees: judgment.ok ? judgment.call.call === past.call : null };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, book.length)) }, worker));
  return results;
}

/**
 * The replay as plain text: one line per case, disagreements and failed runs
 * first, each with entail's reason, then the agreement count.
 */
export function formatReplay(results: readonly ReplayResult[]): string {
  const rank = (result: ReplayResult): number => (result.agrees === false ? 0 : result.agrees === null ? 1 : 2);
  const ordered = [...results].sort((a, b) => rank(a) - rank(b));
  const width = Math.max(0, ...results.map((result) => result.case.slug.length));
  const lines = ordered.map((result) => {
    const slug = result.case.slug.padEnd(width);
    if (!result.judgment.ok) return `FAILED    ${slug}  owner ${result.case.call}, run failed (${result.judgment.failure.kind}): ${result.judgment.failure.message}`;
    const { call } = result.judgment;
    const head = `${result.agrees ? "agree   " : "DISAGREE"}  ${slug}  owner ${result.case.call}, entail ${call.call}`;
    return result.agrees ? head : `${head}: ${call.reason}${call.call === "ask" ? ` Question: ${call.question}` : ""}`;
  });
  const agreed = results.filter((result) => result.agrees === true).length;
  const failed = results.filter((result) => result.agrees === null).length;
  lines.push("", `agreement: ${agreed} of ${results.length}${failed > 0 ? ` (${failed} failed to run)` : ""}`);
  return lines.join("\n");
}
