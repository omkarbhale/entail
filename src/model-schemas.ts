import { arrayOf, nullable, object, oneOf, string, type Infer } from "./schema.ts";

/**
 * The verdict, criteria and grade schemas, written once here, emitted as JSON
 * Schema for `claude -p --json-schema` and used to check each run's structured
 * output (spec section 1). The re-check's schema shares the verdict's fields.
 * The other run kinds (challenge, landing challenge and generic criteria
 * proposal) define their schemas with the same builder in the steps that make
 * those runs.
 *
 * A schema states only the output's shape. What it cannot state, such as a
 * citation appearing word for word in VISION.md or one to five criteria, is a
 * mechanical check of the step that reads the output (ADR-0002, ADR-0005).
 */

/** A vision line as the model quotes it: its exact text, word for word. */
const visionLine = string("A whole line of VISION.md, quoted word for word.");

/**
 * What a close at intake may rest on: the repo's own state, never the vision
 * (spec §6, ADR-0006). A duplicate is another issue in the repo; an already
 * fixed report is a commit on the default branch. A ticket decided again from
 * its investigation's findings may also close on a findings entry that shows
 * nothing is to be fixed (spec §8).
 */
export const CLOSE_EVIDENCE_KINDS = ["duplicate_issue", "fixing_commit", "findings"] as const;

/** The fields the verdict and the re-check share. */
const readings = arrayOf(
  object({
    id: string("R1, R2, … in order."),
    reading: string(),
    observed_outcome: string("The outcome a user would observe under this reading."),
  }),
);
const pinsTouched = arrayOf(object({ pin: string("The pin's topic sentence."), why: string() }));
const visionCheck = arrayOf(
  object({
    line: visionLine,
    mark: oneOf(["matches", "contradicts", "does_not_settle"]),
  }),
  "Every vision line that bears on the issue, and only those.",
);
const citations = arrayOf(
  object({
    lines: arrayOf(visionLine, "One or more whole lines, quoted word for word."),
    reading: string("The id of the reading the passage chooses."),
  }),
  "For settled: the passages that choose the reading. Empty otherwise.",
);
const whyUnopposed = nullable(string(), "For unopposed: why no vision line opposes the ticket. null otherwise.");
const readingChosen = nullable(string(), "For unopposed: the id of the more conventional reading. null otherwise.");
const whyRaised = nullable(oneOf(["contradiction", "consequential_readings", "pin"]), "For needs the owner: why it is raised. null otherwise.");
const openReadings = arrayOf(string(), "For needs the owner: the ids of the readings left open. Empty otherwise.");

/**
 * The decider's output for one ticket (spec section 6, ADR-0011, ADR-0007).
 * entail adds the model, session id, vision sha, duration, cost and usage.
 */
export const verdictSchema = object({
  size: object({
    value: oneOf(["fits", "oversized"], "oversized only when the ticket plainly holds several independent deliverables or is not reviewable as one PR; when unsure, it fits."),
    reason: string(),
  }),
  readings,
  pins_touched: pinsTouched,
  vision_check: visionCheck,
  verdict: nullable(
    oneOf(["settled", "unopposed", "needs_the_owner", "close", "investigate"]),
    "null only when the ticket is oversized, which gets no verdict. close proposes closing the issue at intake because the repo's state settles that nothing is to be done. investigate asks for an investigation when the cause or validity of the issue is unknown.",
  ),
  citations,
  why_unopposed: whyUnopposed,
  reading_chosen: readingChosen,
  why_raised: whyRaised,
  open_readings: openReadings,
  close_evidence: arrayOf(
    object({
      kind: oneOf(CLOSE_EVIDENCE_KINDS),
      ref: string("For duplicate_issue: the other issue's number. For fixing_commit: the commit's full sha. For findings: the question id of the findings entry, such as Q1."),
      why: string("How this shows that nothing is to be done, in one plain sentence."),
    }),
    "For close: the evidence from the repo's state that nothing is to be done. Empty otherwise.",
  ),
  questions: arrayOf(
    string("One question the investigation must establish, as one plain sentence."),
    "For investigate: the questions Q1, Q2, … in order. Empty otherwise.",
  ),
  reason: string("The reason for the audit log."),
});

export type VerdictOutput = Infer<typeof verdictSchema>;

/**
 * A re-check's output (spec §12, ADR-0016): whether a change alters the
 * ticket's prior call, and the call at the current vision in the verdict's
 * own fields. "stands" keeps the prior verdict and reading, "goes_ahead_differently"
 * settles another reading or is now unopposed, and "needs_the_owner" raises it.
 */
export const recheckSchema = object({
  outcome: oneOf(
    ["stands", "goes_ahead_differently", "needs_the_owner"],
    "stands when the change does not alter the call; goes_ahead_differently when the vision now settles another reading or the ticket is now unopposed (or now settled); needs_the_owner when an added line contradicts it, a pin is touched, or its readings are now consequential.",
  ),
  readings,
  pins_touched: pinsTouched,
  vision_check: visionCheck,
  verdict: oneOf(["settled", "unopposed", "needs_the_owner"], "The call at the current vision."),
  citations,
  why_unopposed: whyUnopposed,
  reading_chosen: readingChosen,
  why_raised: whyRaised,
  open_readings: openReadings,
  reason: string("The reason for the audit log: what the change does to the call."),
});

export type RecheckOutput = Infer<typeof recheckSchema>;

/** The closed list of mechanical check kinds a criterion may carry (ADR-0005). */
export const MECHANICAL_CHECK_KINDS = ["changes_path", "leaves_path", "check_passes"] as const;

/**
 * The criteria run's output: one to five criteria C1…Cn, or "needs a product
 * call" with its reason and open choices (spec section 7, ADR-0005).
 */
export const criteriaSchema = object({
  outcome: oneOf(["criteria", "needs_product_call"]),
  criteria: arrayOf(
    object({
      id: string("C1, C2, … in order."),
      sentence: string("One sentence: what is true once the issue is resolved, or a vision constraint the change must respect."),
      source: object({
        kind: oneOf(["issue", "findings", "vision_line", "answer"]),
        ref: nullable(string(), "The question id for findings, the vision line word for word for vision_line, null otherwise."),
      }),
      checks: arrayOf(
        object({
          kind: oneOf(MECHANICAL_CHECK_KINDS),
          argument: string("A path glob for changes_path and leaves_path, a check name for check_passes."),
        }),
      ),
      states_reading: nullable(string(), "The id of the reading this criterion states, when it states the reading chosen. null otherwise."),
    }),
    "For criteria: one to five. Empty for needs_product_call.",
  ),
  product_call: nullable(
    object({
      reason: string("What users could observe that no source chooses, in one or two plain sentences."),
      options: arrayOf(
        object({
          reading: string("One way to settle the open choice."),
          observed_outcome: string("The outcome a user would observe this way."),
        }),
        "The open choice, one option each.",
      ),
    }),
    "For needs_product_call: the product call. null otherwise.",
  ),
});

export type CriteriaOutput = Infer<typeof criteriaSchema>;

/**
 * The landing grader's output: met or not met for every criterion and generic
 * criterion, with evidence quoted word for word, and what users can observe
 * that the change does beyond the criteria (spec section 11, ADR-0014).
 */
export const gradeSchema = object({
  results: arrayOf(
    object({
      id: string("A criterion id (C1…) or generic criterion id (G1…)."),
      result: oneOf(["met", "not_met"]),
      evidence: arrayOf(string(), "For met: quotes from the PR at the checked head, word for word."),
      reason: string(),
    }),
    "One result for every id.",
  ),
  beyond_criteria: arrayOf(string(), "Each thing users can observe that the change does beyond the criteria and their stated reading."),
  reason: string("The reason for the audit log."),
});

export type GradeOutput = Infer<typeof gradeSchema>;
