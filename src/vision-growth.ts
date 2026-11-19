import { DEFAULT_MODEL, type Effort, type MachineFailure, type ModelRunner, type RunFacts, type RunOptions } from "./model-runner.ts";
import { boolean, nullable, object, string, type Infer } from "./schema.ts";
import { collapseWhitespace, splitVisionLines } from "./vision.ts";

/**
 * Growing the vision from a board answer. After an answer settles its own
 * ticket, one model run reads the question, the answer and the vision and
 * says whether the answer makes sense as a general statement of what the
 * product is or should be. Most answers are rulings on one ticket and add
 * nothing. When one does add a line, entail writes it into VISION.md itself
 * and tells the owner; it records where the line came from in its own log,
 * and VISION.md carries no mark of it. The prompt below is the whole of how
 * entail decides; the code here builds it, checks the answer and places the
 * line.
 */

/** What a run of this judgment is called, for the runner and its records. */
export const VISION_GROWTH_KIND = "vision-growth";

/** Changes whenever the prompt or the answer's shape changes, so a decision records what made it. */
export const VISION_GROWTH_PROMPT_VERSION = "vision-growth-1";

/** The longest line entail adds: a vision line states one thing, in a sentence or two. */
export const MAX_LINE_LENGTH = 400;

export const VISION_GROWTH_SCHEMA = object({
  general: boolean(
    "Whether the answer, taken out of this ticket, states something that holds for the product in general and that the vision does not already say. False for a ruling on this ticket, a preference about this change, a scheduling or priority call, and anything the vision already says or that the vision contradicts.",
  ),
  line: string("When general: the one vision line to add, one sentence or two on one line, in the vision's own voice and tense, with no ticket numbers, names, dates or reference to this answer. Empty when not general."),
  heading: nullable(string(), "When general: the exact text of the existing heading of the vision whose section the line belongs under; null when none fits, and the line goes at the end of the vision."),
  reason: string("In one to three sentences for the owner to read: why this answer is a general statement that belongs in the vision, or why it only settles its own ticket."),
});

export type VisionGrowthAnswer = Infer<typeof VISION_GROWTH_SCHEMA>;

/** Everything the decision reads about one answer. */
export interface VisionGrowthInputs {
  /** The repo, as `owner/name`. */
  repo: string;
  /** What the answer was given on, such as `acme/tally#12` or a PR. */
  about: string;
  /** The ticket or PR as entail read it when it asked, in full. */
  context: string;
  /** What entail asked. */
  question: string;
  /** Who answered, as the board recorded them. */
  by: string;
  /** What they chose: go, no, merge or send back. */
  chose: string;
  /** Their words. */
  answer: string;
  /** VISION.md as it stands, or null when the repo has none. */
  vision: { text: string; commit: string } | null;
  /** A read-only checkout of the repo, and its commit. */
  checkout: string;
  sha: string;
}

/** The prompt: what makes an answer a vision line, the vision as it stands, and the answer. */
export function visionGrowthPrompt(inputs: VisionGrowthInputs): string {
  const vision =
    inputs.vision === null
      ? "This repo has no VISION.md. Add nothing: a vision is first written by the owner."
      : `VISION.md at ${inputs.vision.commit}:\n\n<vision>\n${inputs.vision.text.trim()}\n</vision>`;
  return `You are deciding whether a board answer belongs in the vision of ${inputs.repo}.

The vision is the owner's word on what the product is and what better means for it. entail asked the owner a question on the board about ${inputs.about}, and the answer below settled that one ticket. Your question is different: does what the answer says also hold for the product in general, so that it belongs in the vision as a line of its own?

## How to decide

Most answers add nothing. An answer settles its own ticket and stops there. Add a line only when all of these hold:

1. The answer states, or plainly implies, something about the product that is true beyond this ticket: what it is, what it is for, a rule it follows or something it never does.
2. A thoughtful owner would want the next ticket that touches the same ground settled by it without being asked again.
3. The vision does not already say it, in other words or in part, and does not contradict it. When the answer contradicts a line of the vision, add nothing: the owner changes the vision by hand.
4. It can be said as one line in the vision's own voice, with no ticket numbers, names, dates or mention of this answer.

Never add a ruling on one change ("yes, add the flag", "not this release"), a preference about how one thing is built, a scheduling or priority call, an answer of go or no that only approves or declines this ticket, or anything the owner said only because the ticket's wording prompted it. When in doubt, add nothing: a vision that is padded and cut back later has already done its harm, and an answer that is not added still stays on record and settles its ticket.

The vision stays proportionate to the real complexity of the project: months of daily answers should grow it very little. Do not restate the answer; state what follows from it for the product. Never state something the owner did not say.

Choose the heading of the section the line belongs under from the vision's existing headings, exactly as written. The text of the line is written into VISION.md as it is.

## The repo

You are in a read-only checkout of ${inputs.repo} at ${inputs.sha}. Read it only if what the answer means for the product is unclear.

## The vision

${vision}

## The question and the answer

<ticket>
${inputs.context.trim()}
</ticket>

entail asked the owner: ${inputs.question}

${inputs.by} answered ${inputs.chose}:

<answer>
${inputs.answer.trim()}
</answer>

Now decide: does this answer belong in the vision, and if it does, as which line?`;
}

/** What entail decided about one answer. */
export type GrowthDecision = { add: false; reason: string } | { add: true; line: string; heading: string | null; reason: string };

/**
 * Checks the model's answer against the vision it was given. A line that is
 * empty, spans more than one line, is a heading or a list item of nothing,
 * runs past {@link MAX_LINE_LENGTH}, or says what a vision line already says
 * is no addition, and the decision becomes "nothing added" with that reason.
 */
export function checkGrowth(answer: VisionGrowthAnswer, vision: { text: string } | null): GrowthDecision {
  if (vision === null) return { add: false, reason: answer.reason };
  if (!answer.general) return { add: false, reason: answer.reason };
  const line = answer.line.trim();
  const refuse = (why: string): GrowthDecision => ({ add: false, reason: `${answer.reason} Nothing was added: ${why}.` });
  if (line === "") return refuse("the line was empty");
  if (/[\r\n]/u.test(line)) return refuse("the line was more than one line");
  if (line.length > MAX_LINE_LENGTH) return refuse("the line was too long to be one vision line");
  if (/^(?:#|---|\*\*\*|___|```|~~~|>|<)/u.test(line) || /^[-*+]\s*$/u.test(line)) return refuse("the line was not a statement");
  const identity = collapseWhitespace(line);
  if (splitVisionLines(vision.text).some((existing) => existing.identity === identity)) return refuse("the vision already says it");
  const heading = answer.heading === null ? null : collapseWhitespace(answer.heading);
  return { add: true, line, heading: heading === "" ? null : heading, reason: answer.reason };
}

/**
 * VISION.md with `line` added at the end of the section under `heading`, or
 * at the end of the file when no heading of that text is there. The text
 * keeps its line endings and is touched nowhere else. Null when the text
 * already has the line, so a retried write never adds it twice.
 */
export function addVisionLine(text: string, line: string, heading: string | null): string | null {
  const identity = collapseWhitespace(line);
  if (splitVisionLines(text).some((existing) => existing.identity === identity)) return null;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r\n|\n|\r/u);
  const wanted = heading === null ? null : collapseWhitespace(heading);
  // The vision lines of a section are the ones under its heading: find where the section ends.
  const sectionLines = splitVisionLines(text);
  let after = -1;
  if (wanted !== null) {
    for (const existing of sectionLines) if (existing.heading === wanted) after = existing.lineNumber - 1;
    if (after === -1) after = headingLine(lines, wanted);
  }
  if (after === -1) after = lastContentLine(lines);
  if (after === -1) return `${line}${eol}`;
  lines.splice(after + 1, 0, line);
  const joined = lines.join(eol);
  return joined.endsWith(eol) || joined.endsWith("\n") ? joined : `${joined}${eol}`;
}

/** The index of the ATX heading whose text is `wanted`, or -1. */
function headingLine(lines: readonly string[], wanted: string): number {
  return lines.findIndex((text) => {
    const match = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/u.exec(text);
    return match !== null && collapseWhitespace(match[1] ?? "") === wanted;
  });
}

function lastContentLine(lines: readonly string[]): number {
  for (let index = lines.length - 1; index >= 0; index--) if ((lines[index] ?? "").trim() !== "") return index;
  return -1;
}

export type GrowthJudgment =
  | { ok: true; decision: GrowthDecision; facts: RunFacts }
  | { ok: false; failure: MachineFailure; facts: RunFacts | null };

export interface GrowthOptions extends RunOptions {
  model?: string;
  effort?: Effort;
}

/** Decides what one answer adds to the vision, if anything: one model run, parsed and checked. */
export async function decideGrowth(runner: ModelRunner, inputs: VisionGrowthInputs, options: GrowthOptions = {}): Promise<GrowthJudgment> {
  const { model = DEFAULT_MODEL, effort, ...runOptions } = options;
  const result = await runner.run(
    {
      kind: VISION_GROWTH_KIND,
      ticket: inputs.about,
      prompt: visionGrowthPrompt(inputs),
      promptVersion: VISION_GROWTH_PROMPT_VERSION,
      schema: VISION_GROWTH_SCHEMA,
      checkout: inputs.checkout,
      sha: inputs.sha,
      model,
      ...(effort === undefined ? {} : { effort }),
    },
    runOptions,
  );
  if (!result.ok) return result;
  return { ok: true, decision: checkGrowth(result.output, inputs.vision), facts: result.facts };
}
