import { touchedPins } from "./board-item.ts";
import type { RecordedVerdict } from "./decider.ts";
import { collapseWhitespace, VISION_PATH, type VisionAtCommit } from "./vision.ts";

/**
 * The mechanical checks every settled or unopposed verdict passes before it
 * can clear a ticket (spec §6, ADR-0002, ADR-0011). entail computes them from
 * the verdict and VISION.md at the verdict's sha, with no model, so clearing
 * never rests on the decider's own confidence. A failed check makes the
 * ticket need the owner, with the failure as `why_raised`.
 */

/** Every check, by the name a board item and the Calls page show it under, in the order they run. */
export const VERDICT_CHECKS = {
  wordForWord: "every quoted line is word for word in VISION.md",
  settledCites: "a settled verdict cites passages marked matches",
  choosesOneReading: "the verdict chooses one reading",
  noContradiction: "no vision line is marked contradicts",
  noPin: "no pin is touched",
} as const;

/**
 * The check a ticket decided again from its findings fails when the decider
 * still asks for an investigation: entail investigates a ticket at most once,
 * so findings that leave the problem unknown make the ticket need the owner
 * (spec §8, ADR-0006). It is not one of the checks on a settled or unopposed
 * verdict.
 */
export const INVESTIGATED_ONCE_CHECK = "a ticket is investigated at most once";

export type VerdictCheckName = (typeof VERDICT_CHECKS)[keyof typeof VERDICT_CHECKS] | typeof INVESTIGATED_ONCE_CHECK;

/** One check's result. A failed check says how it failed, quoting what it rests on. */
export interface VerdictCheckResult {
  check: VerdictCheckName;
  passed: boolean;
  /** How it failed, in plain words; null when it passed. */
  failure: string | null;
}

/** The checks' results as recorded on the verdict call. */
export interface VerdictChecks {
  passed: boolean;
  /** The commit whose VISION.md the quoted lines were checked against: the verdict's recorded sha. */
  vision_sha: string;
  results: VerdictCheckResult[];
  /**
   * The readings a raise offers the owner: those that cited passages point
   * to when they point to different ones; empty to offer every reading.
   */
  open_readings: string[];
}

/** Quotes a line or name as a failure states it. */
function quoted(text: string): string {
  return `“${text.trim()}”`;
}

/** Words joined as “a”, “a” and “b”, or “a”, “b” and “c”. */
function joined(words: readonly string[]): string {
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

function result(check: VerdictCheckName, failures: readonly string[]): VerdictCheckResult {
  return { check, passed: failures.length === 0, failure: failures.length === 0 ? null : failures.join(" ") };
}

/**
 * Runs the mechanical checks on a settled or unopposed verdict (spec §6):
 *
 * - every citation and every quoted vision-check line appears word for word in
 *   VISION.md at the recorded sha, compared after collapsing whitespace as
 *   vision lines are identified (ADR-0003). A quote that does not is a product
 *   failure, never a machine failure;
 * - a settled verdict has a citation, and each line it cites is marked
 *   "matches" in its vision check;
 * - with several readings, the verdict chooses one: for settled, the cited
 *   passages all point to the same listed reading, and passages that point to
 *   different readings mean the vision does not settle the ticket; for
 *   unopposed, which cites nothing (ADR-0011), the reading chosen is listed;
 * - no line is marked "contradicts";
 * - no pin is touched, by the model's judgment or by entail's keyword or path
 *   matching.
 *
 * @param vision VISION.md read at the verdict's `vision_sha`.
 */
export function checkVerdict(verdict: RecordedVerdict, vision: VisionAtCommit): VerdictChecks {
  if (verdict.verdict !== "settled" && verdict.verdict !== "unopposed") {
    throw new Error(`only a settled or unopposed verdict is checked, not ${String(verdict.verdict)}`);
  }
  const marks = new Map<string, string[]>();
  for (const { line, mark } of verdict.vision_check) {
    const identity = collapseWhitespace(line);
    marks.set(identity, [...(marks.get(identity) ?? []), mark]);
  }
  const readingIds = new Set(verdict.readings.map((reading) => reading.id));
  let openReadings: string[] = [];

  // Word for word at the recorded sha.
  const wordForWord: string[] = [];
  if (vision.commit !== verdict.vision_sha) {
    wordForWord.push(`${VISION_PATH} was read at ${vision.commit}, not at the verdict's ${verdict.vision_sha}.`);
  } else if (vision.status !== "present") {
    wordForWord.push(`${VISION_PATH} is ${vision.status} at ${vision.commit}.`);
  } else {
    const identities = new Set(vision.lines.map((line) => line.identity));
    const quotes = [...verdict.citations.flatMap((citation) => citation.lines), ...verdict.vision_check.map((line) => line.line)];
    const unfound = [...new Set(quotes.filter((quote) => !identities.has(collapseWhitespace(quote))))];
    if (unfound.length > 0) {
      wordForWord.push(
        `${joined(unfound.map(quoted))} ${unfound.length === 1 ? "is" : "are"} not word for word a line of ${VISION_PATH} at ${vision.commit.slice(0, 7)}.`,
      );
    }
  }

  // A settled verdict cites, and what it cites matches.
  const settledCites: string[] = [];
  if (verdict.verdict === "settled") {
    if (verdict.citations.length === 0) settledCites.push("The settled verdict cites no passage.");
    if (verdict.citations.some((citation) => citation.lines.length === 0)) settledCites.push("A cited passage quotes no line.");
    for (const line of new Set(verdict.citations.flatMap((citation) => citation.lines))) {
      const lineMarks = marks.get(collapseWhitespace(line)) ?? [];
      if (lineMarks.length === 0) settledCites.push(`The cited line ${quoted(line)} is not in the vision check.`);
      else if (lineMarks.some((mark) => mark !== "matches")) {
        settledCites.push(`The cited line ${quoted(line)} is marked ${joined(lineMarks.filter((m) => m !== "matches").map(quoted))}, not “matches”.`);
      }
    }
  }

  // One reading chosen.
  const choosesOne: string[] = [];
  if (verdict.verdict === "settled") {
    for (const citation of verdict.citations) {
      if (!readingIds.has(citation.reading)) {
        choosesOne.push(`A cited passage points to ${quoted(citation.reading)}, which is not one of the verdict's readings.`);
      }
    }
    const chosen = [...new Set(verdict.citations.map((citation) => citation.reading))];
    if (chosen.length > 1) {
      // Several passages must together choose one reading; pointing to different ones, they settle nothing.
      const passages = chosen.map((reading) => {
        const lines = verdict.citations.filter((citation) => citation.reading === reading).flatMap((citation) => citation.lines);
        const described = verdict.readings.find((r) => r.id === reading);
        return `${joined([...new Set(lines)].map(quoted))} ${lines.length === 1 ? "points" : "point"} to ${reading}${described ? ` (${described.reading.trim()})` : ""}`;
      });
      choosesOne.push(`Cited passages point to different readings, so the vision does not settle the ticket: ${passages.join("; while ")}.`);
      openReadings = chosen.filter((reading) => readingIds.has(reading));
    }
  } else {
    if (verdict.reading_chosen === null) {
      if (verdict.readings.length > 1) choosesOne.push(`The unopposed verdict lists ${verdict.readings.length} readings and chooses none.`);
    } else if (!readingIds.has(verdict.reading_chosen)) {
      choosesOne.push(`The reading chosen, ${quoted(verdict.reading_chosen)}, is not one of the verdict's readings.`);
    }
  }

  // No contradiction.
  const contradicted = [...new Set(verdict.vision_check.filter((line) => line.mark === "contradicts").map((line) => line.line))];
  const noContradiction =
    contradicted.length === 0 ? [] : [`The vision check marks ${joined(contradicted.map(quoted))} as contradicted.`];

  // No pin touched.
  const pins = touchedPins(verdict);
  const noPin = pins.map((pin) => `It touches the pin ${quoted(pin.pin)}: ${pin.why.trim()}.`);

  const results = [
    result(VERDICT_CHECKS.wordForWord, wordForWord),
    result(VERDICT_CHECKS.settledCites, settledCites),
    result(VERDICT_CHECKS.choosesOneReading, choosesOne),
    result(VERDICT_CHECKS.noContradiction, noContradiction),
    result(VERDICT_CHECKS.noPin, noPin),
  ];
  return { passed: results.every((r) => r.passed), vision_sha: verdict.vision_sha, results, open_readings: openReadings };
}
