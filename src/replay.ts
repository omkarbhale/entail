import { landingPrecedentsFor, precedentsFor, type Case, type LandingCase } from "./case-book.ts";
import { judge, type JudgeOptions, type Judgment, type JudgmentInputs } from "./judgment.ts";
import { judgeLanding, type LandingInputs, type LandingJudgment } from "./landing.ts";
import type { ModelRunner } from "./model-runner.ts";

/**
 * Replaying the case book: every case goes through the judgment as if it
 * were a new issue, against the vision it was decided under, and its answer
 * is compared with the owner's call. A case never sees itself as precedent.
 *
 * Landing cases replay the same way through the landing judgment: each PR at
 * its judged head, diffed against its base, against the criteria and vision it
 * was judged under and the forge's facts recorded with it.
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

/** One landing case replayed. */
export interface LandingReplayResult {
  case: LandingCase;
  judgment: LandingJudgment;
  /** Whether entail's call is the owner's; null when the run gave no call. */
  agrees: boolean | null;
}

/** A landing case's PR read from git: a read-only checkout of its head and its diff against its base. */
export type LandingCaseReading = (past: LandingCase) => Promise<{ checkout: string; diff: string }>;

/** The landing judgment's inputs for a case: its own PR, issue, criteria and vision, and every other landing case as precedent. */
export function landingCaseInputs(past: LandingCase, book: readonly LandingCase[], reading: { checkout: string; diff: string }): LandingInputs {
  const others = book.filter((other) => other.slug !== past.slug);
  return {
    repo: past.repo,
    pr: { number: past.pr, text: past.prText },
    head: past.head,
    base: past.base,
    issue: { number: past.issue, text: past.issueText },
    criteria: past.criteria,
    vision: past.vision.trim() === "" ? null : { text: past.vision, commit: past.visionCommit },
    // Cases record no pins yet: the seeded repo had none.
    pins: [],
    facts: past.facts,
    diff: reading.diff,
    precedents: landingPrecedentsFor(others, past.repo, past.issueText),
    sendBacks: [],
    checkout: reading.checkout,
  };
}

/** Replays every landing case in the book, in the book's order. */
export async function replayLandings(runner: ModelRunner, book: readonly LandingCase[], readingOf: LandingCaseReading, options: ReplayOptions = {}): Promise<LandingReplayResult[]> {
  const { concurrency = 2, ...judgeOptions } = options;
  const results: LandingReplayResult[] = new Array(book.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < book.length) {
      const index = next++;
      const past = book[index]!;
      const judgment = await judgeLanding(runner, landingCaseInputs(past, book, await readingOf(past)), judgeOptions);
      results[index] = { case: past, judgment, agrees: judgment.ok ? judgment.call.call === past.call : null };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, book.length)) }, worker));
  return results;
}

/** One replayed case of either kind, as the report lists it. */
interface Row {
  kind: "issue" | "landing";
  slug: string;
  owner: string;
  agrees: boolean | null;
  line: string;
}

/**
 * The replay as plain text: one line per case, naming its kind, with
 * disagreements and failed runs first, each with entail's reason, then the
 * agreement count.
 */
export function formatReplay(results: readonly ReplayResult[], landings: readonly LandingReplayResult[] = []): string {
  const rows: Row[] = [
    ...results.map((result): Row => {
      const { judgment } = result;
      if (!judgment.ok) return { kind: "issue", slug: result.case.slug, owner: result.case.call, agrees: null, line: `run failed (${judgment.failure.kind}): ${judgment.failure.message}` };
      const { call } = judgment;
      return { kind: "issue", slug: result.case.slug, owner: result.case.call, agrees: result.agrees, line: `entail ${call.call}${result.agrees ? "" : `: ${call.reason}${call.call === "ask" ? ` Question: ${call.question}` : ""}`}` };
    }),
    ...landings.map((result): Row => {
      const { judgment } = result;
      if (!judgment.ok) return { kind: "landing", slug: result.case.slug, owner: result.case.call, agrees: null, line: `run failed (${judgment.failure.kind}): ${judgment.failure.message}` };
      const { call } = judgment;
      const detail = [
        call.reason,
        ...call.needsToChange.map((item) => `Needs to change: ${item}`),
        ...call.beyond.filter((item) => item.sort === "unwanted").map((item) => `Unwanted: ${item.change}`),
        ...(call.question === null ? [] : [`Question: ${call.question.question}`]),
      ].join(" ");
      return { kind: "landing", slug: result.case.slug, owner: result.case.call, agrees: result.agrees, line: `entail ${call.call}${result.agrees ? "" : `: ${detail}`}` };
    }),
  ];
  const rank = (row: Row): number => (row.agrees === false ? 0 : row.agrees === null ? 1 : 2);
  const ordered = [...rows].sort((a, b) => rank(a) - rank(b));
  const width = Math.max(0, ...rows.map((row) => row.slug.length));
  const lines = ordered.map((row) => {
    const verdict = row.agrees === null ? "FAILED  " : row.agrees ? "agree   " : "DISAGREE";
    return `${verdict}  ${row.kind.padEnd(7)}  ${row.slug.padEnd(width)}  owner ${row.owner}, ${row.line}`;
  });
  const agreed = rows.filter((row) => row.agrees === true).length;
  const failed = rows.filter((row) => row.agrees === null).length;
  lines.push("", `agreement: ${agreed} of ${rows.length}${failed > 0 ? ` (${failed} failed to run)` : ""}`);
  return lines.join("\n");
}
