import { visionPermalink, type RepoLocation } from "./citation.ts";
import { describeCheck } from "./generic-criteria.ts";
import type { GenericCriterion, MechanicalCheck } from "./repo-settings.ts";
import { collapseWhitespace, VISION_PATH, type VisionLine } from "./vision.ts";

/**
 * The intake comment entail posts on an issue each time it decides the ticket
 * (spec §9, ADR-0007), in two sections: a vision check, then what happens
 * next. This module writes the text between the attribution line and the
 * hidden marker; {@link composeComment} adds those.
 */

/** How a vision check marks a bearing line (ADR-0007). */
export type VisionCheckMark = "matches" | "contradicts" | "does_not_settle";

/** One line of a vision check: a whole vision line at the vision's commit, with its mark. */
export interface VisionCheckLine {
  /** The line exactly as VISION.md has it at the commit. */
  text: string;
  heading: string | null;
  /** Its line number at the commit, used only for the permalink. */
  lineNumber: number;
  mark: VisionCheckMark;
  /** VISION.md at that line, at the commit. */
  permalink: string;
}

/** A vision check: the bearing lines, quoted whole at the vision's commit, and only those. */
export interface VisionCheck {
  /** The commit whose VISION.md the lines are quoted from. */
  commit: string;
  lines: VisionCheckLine[];
  /**
   * Lines the decider quoted that are not whole vision lines at the commit.
   * They cannot be quoted word for word, so they are left out of the check
   * and kept here for the record.
   */
  unquotable: { line: string; mark: VisionCheckMark }[];
}

/**
 * The vision check of a judgment: each line the decider marked, found by its
 * text among the vision lines at the commit and quoted exactly as VISION.md
 * has it, with a permalink there. A line marked twice is listed once, with its
 * first mark.
 */
export function visionCheckOf(
  repo: RepoLocation,
  commit: string,
  visionLines: readonly VisionLine[],
  marked: readonly { line: string; mark: VisionCheckMark }[],
): VisionCheck {
  const byIdentity = new Map(visionLines.map((line) => [line.identity, line]));
  const lines: VisionCheckLine[] = [];
  const unquotable: VisionCheck["unquotable"] = [];
  const seen = new Set<string>();
  for (const { line, mark } of marked) {
    const identity = collapseWhitespace(line);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const found = byIdentity.get(identity);
    if (found === undefined) {
      unquotable.push({ line, mark });
      continue;
    }
    lines.push({
      text: found.text,
      heading: found.heading,
      lineNumber: found.lineNumber,
      mark,
      permalink: visionPermalink(repo, commit, found.lineNumber),
    });
  }
  return { commit, lines, unquotable };
}

/** A mark as a comment and the board name it. */
export const MARK_WORDS: Readonly<Record<VisionCheckMark, string>> = {
  matches: "Matches",
  contradicts: "Contradicts",
  does_not_settle: "Does not settle",
};

/**
 * The one fixed line that ends the second section of every intake comment,
 * telling any executor how to report evidence or findings (ADR-0013).
 */
export const EXECUTOR_LINE =
  "Executors: report evidence in the PR under an `entail evidence` heading, one entry per criterion id " +
  "(`C1: <what was run or done> — <result>`), and investigation findings in one `entail findings` comment " +
  "on this issue, one entry per question id.";

/** The short form of a commit sha a comment shows. */
export function shortSha(commit: string): string {
  return commit.slice(0, 7);
}

/** Text quoted from VISION.md cannot open a hidden marker of its own, so the comment rules hold whatever it says. */
function quotable(text: string): string {
  return text.trim().replace(/<!--/gu, "&lt;!--");
}

/**
 * The first section, the vision check (spec §9, ADR-0007): each bearing line
 * quoted whole and word for word in a quote block, with a permalink at the
 * vision's commit, marked matches, contradicts or does not settle. It says
 * that only bearing lines are listed, or that none bears.
 */
export function visionCheckSection(check: VisionCheck): string {
  const at = `\`${shortSha(check.commit)}\``;
  const lines = ["### Vision check", ""];
  const notFound =
    check.unquotable.length === 0
      ? undefined
      : `Lines the decider quoted could not be found word for word in ${VISION_PATH} at ${at}, so they are not quoted.`;
  if (check.lines.length === 0) {
    lines.push(notFound ?? `No line of ${VISION_PATH} at ${at} bears on this issue.`);
    return lines.join("\n");
  }
  lines.push(`Only the lines of ${VISION_PATH} that bear on this issue are listed, quoted from ${VISION_PATH} at ${at}.`);
  for (const line of check.lines) {
    lines.push("", `> ${quotable(line.text)}`, "", `${MARK_WORDS[line.mark]} · [${VISION_PATH} line ${line.lineNumber} at ${at}](${line.permalink})`);
  }
  if (notFound) lines.push("", notFound);
  return lines.join("\n");
}

/**
 * What happens next for a ticket raised to the owner (spec §9, ADR-0007):
 * that it was raised, with a link to the board, and no question text. It
 * takes no answer.
 */
export function raisedNextText(boardLink: string): string {
  return `entail raised this issue to the owner, who decides it on [entail's board](${boardLink}). Nothing is taken forward until then, and no reply here counts as an answer.`;
}

/** The label a cleared or landing ticket's issue carries (ADR-0013). */
export const CLEARED_LABEL = "entail:cleared";

/** The label an investigating ticket's issue carries (ADR-0006, ADR-0013). */
export const INVESTIGATE_LABEL = "entail:investigate";

/** A question an investigation must establish, as its intake comment lists it. */
export interface ListedQuestion {
  id: string;
  question: string;
}

/**
 * What happens next for a ticket being investigated (spec §8, §9, ADR-0006,
 * ADR-0013): the questions Q1…Qn the investigation must establish, then the
 * label `entail:investigate`.
 */
export function investigatingNextText(questions: readonly ListedQuestion[]): string {
  const lines = [
    "entail cannot tell yet whether this issue describes a real problem, or what causes it, so it is to be investigated before any criteria are written. No PR is checked or merged for it until then.",
    "",
    "#### Questions",
    "",
  ];
  for (const { id, question } of questions) lines.push(`- **${id}** ${inline(question)}`);
  lines.push(
    "",
    `Label: \`${INVESTIGATE_LABEL}\`. Any executor may investigate this issue. entail decides it again from the first findings comment posted after this one.`,
  );
  return lines.join("\n");
}

/** Model-written text as one line of a comment: whitespace collapsed, and no hidden marker of its own. */
function inline(text: string): string {
  return collapseWhitespace(text).replace(/<!--/gu, "&lt;!--");
}

/** Why a ticket was cleared, as its intake comment says it (spec §9, ADR-0011). */
export type WhyCleared =
  /** The vision settles it: each cited line with its permalink at the vision's commit. */
  | { kind: "settled"; commit: string; cited: { lineNumber: number; permalink: string }[] }
  /** Unopposed: no contradiction found, why nothing opposes the ticket, and the reading chosen where there was one. */
  | { kind: "unopposed"; whyUnopposed: string; readingChosen: string | null }
  /** The owner's answer let it go ahead: the decision is quoted above the criteria, which cite it (ADR-0008). */
  | { kind: "answered" };

/** A criterion as its intake comment lists it. */
export interface ListedCriterion {
  id: string;
  sentence: string;
  checks: readonly MechanicalCheck[];
}

/** One criterion or generic criterion as a list item, with its mechanical checks under it. */
function criterionItem(id: string, sentence: string, checks: readonly MechanicalCheck[]): string[] {
  const lines = [`- **${id}** ${inline(sentence)}`];
  if (checks.length === 0) lines.push("  - No mechanical check: it is graded from the PR's evidence.");
  for (const check of checks) lines.push(`  - Mechanical check: ${describeCheck(check)}.`);
  return lines;
}

/**
 * What happens next for a ticket that goes ahead (spec §9, ADR-0007,
 * ADR-0011): the criteria C1…Cn with their mechanical checks, the generic
 * criteria in full, why the ticket was cleared (a citation permalink, "no
 * contradiction found", or the owner's decision), then the label
 * `entail:cleared`.
 */
export function clearedNextText(input: { criteria: readonly ListedCriterion[]; genericCriteria: readonly GenericCriterion[]; why: WhyCleared }): string {
  const lines = [
    "entail cleared this issue. A PR that closes it must meet every criterion below and every generic criterion of this repo.",
    "",
    "#### Criteria",
    "",
  ];
  for (const criterion of input.criteria) lines.push(...criterionItem(criterion.id, criterion.sentence, criterion.checks));
  lines.push("", "#### Generic criteria", "");
  if (input.genericCriteria.length === 0) lines.push("This repo has no generic criteria.");
  for (const criterion of input.genericCriteria) lines.push(...criterionItem(criterion.id, criterion.sentence, [criterion.check]));
  lines.push("", "#### Why cleared", "");
  if (input.why.kind === "settled") {
    const at = `\`${shortSha(input.why.commit)}\``;
    const links = input.why.cited.map((line) => `[${VISION_PATH} line ${line.lineNumber} at ${at}](${line.permalink})`);
    lines.push(`The vision settles this issue. Citation: ${links.join(", ")}.`);
  } else if (input.why.kind === "answered") {
    lines.push("The owner decided this issue on entail's board, as quoted above, and the criteria cite that decision. The verdict was not run again.");
  } else {
    lines.push(`No contradiction found. ${inline(input.why.whyUnopposed)}`.trim());
    if (input.why.readingChosen !== null) lines.push("", `Reading chosen: ${inline(input.why.readingChosen)}`);
  }
  lines.push("", `Label: \`${CLEARED_LABEL}\`. Any executor may pick this issue up.`);
  return lines.join("\n");
}

/**
 * What a re-check was made after, as a comment on the forge says it: the
 * vision change at its sha, a change to the repo's pins, or both; null when
 * neither. A pin is never named, because pins are kept out of the project's
 * repo (ADR-0018).
 */
export function afterChangeText(change: { visionChange?: string | null; pinChange?: boolean }): string | null {
  const parts: string[] = [];
  if (change.visionChange) parts.push(`the vision change at \`${shortSha(change.visionChange)}\``);
  if (change.pinChange === true) parts.push("a change to the repo's pins");
  return parts.length === 0 ? null : `after ${parts.join(" and ")}`;
}

/**
 * What a recorded re-check was made after, in its public form: the vision
 * change's sha when it covered one, and whether the repo's pins changed. A
 * re-check recorded before pin changes flagged covered vision changes only.
 */
export function recheckChangeOf(detail: unknown): { visionChange: string | null; pinChange: boolean } {
  const d = detail as { visionChangeIds?: unknown; recheck?: { toVisionSha?: unknown; pinsRemoved?: unknown[]; pinsAdded?: unknown[] } } | null;
  const recheck = d?.recheck;
  const pinChange = (recheck?.pinsRemoved?.length ?? 0) > 0 || (recheck?.pinsAdded?.length ?? 0) > 0;
  const covered = (Array.isArray(d?.visionChangeIds) && d.visionChangeIds.length > 0) || recheck?.pinsAdded === undefined;
  const visionChange = covered && typeof recheck?.toVisionSha === "string" ? recheck.toVisionSha : null;
  return { visionChange, pinChange };
}

/**
 * An intake comment's text: the vision check, then what happens next ending
 * with the fixed executor line. A comment that replaces an earlier intake
 * comment names it first, and one posted after a re-check names the vision
 * change's sha too (ADR-0016), or says the repo's pins changed (ADR-0018).
 */
export function intakeCommentText(input: { visionCheck: VisionCheck; next: string; replaces?: string | null; visionChange?: string | null; pinChange?: boolean }): string {
  const parts: string[] = [];
  const after = afterChangeText(input);
  if (input.replaces) parts.push(`This replaces [entail's earlier intake comment](${input.replaces})${after === null ? "" : `, ${after}`}.`, "");
  else if (after !== null) parts.push(`entail checked this issue again ${after}.`, "");
  parts.push(visionCheckSection(input.visionCheck), "", "### What happens next", "", input.next.trim(), "", EXECUTOR_LINE);
  return parts.join("\n");
}
