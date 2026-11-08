import { visionPermalink, type RepoLocation } from "./citation.ts";
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

/**
 * An intake comment's text: the vision check, then what happens next ending
 * with the fixed executor line. A comment that replaces an earlier intake
 * comment names it first.
 */
export function intakeCommentText(input: { visionCheck: VisionCheck; next: string; replaces?: string | null }): string {
  const parts: string[] = [];
  if (input.replaces) parts.push(`This replaces [entail's earlier intake comment](${input.replaces}).`, "");
  parts.push(visionCheckSection(input.visionCheck), "", "### What happens next", "", input.next.trim(), "", EXECUTOR_LINE);
  return parts.join("\n");
}
