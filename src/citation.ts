import type { Git } from "./git.ts";
import { collapseWhitespace, readVision, VISION_PATH, visionLinesOf, type VisionAtCommit } from "./vision.ts";
import type { ForgeName } from "./mirror.ts";

/** One whole vision line a citation quotes (ADR-0003). */
export interface CitedLine {
  /** The heading above the line, or null if none. */
  heading: string | null;
  /** The line's exact text. */
  text: string;
  /** Its line number at the citation's commit, used only for a permalink. */
  lineNumber: number;
}

/**
 * The vision passage a call relies on: one or more whole vision lines, quoted
 * word for word, at the vision's commit.
 */
export interface Citation {
  commit: string;
  lines: CitedLine[];
}

export type CitationCheck = { verified: true } | { verified: false; unmatched: CitedLine[]; reason: string };

/** A quoted line that is not a whole vision line at the vision's commit. */
export class NotAVisionLineError extends Error {
  readonly quote: string;

  constructor(quote: string, commit: string) {
    super(`"${quote}" is not a whole line of ${VISION_PATH} at ${commit}`);
    this.name = "NotAVisionLineError";
    this.quote = quote;
  }
}

/**
 * Builds a citation of whole vision lines, each found by its text in VISION.md
 * as read at a commit. Throws {@link NotAVisionLineError} for a quote that is
 * not a whole line there.
 */
export function cite(vision: VisionAtCommit, quotes: string[]): Citation {
  const lines = visionLinesOf(vision);
  return {
    commit: vision.commit,
    lines: quotes.map((quote) => {
      const identity = collapseWhitespace(quote);
      const line = lines.find((candidate) => candidate.identity === identity);
      if (line === undefined) throw new NotAVisionLineError(quote, vision.commit);
      return { heading: line.heading, text: line.text, lineNumber: line.lineNumber };
    }),
  };
}

/**
 * Checks that every line a citation quotes appears word for word as a whole
 * vision line in VISION.md at the citation's commit. Lines are compared after
 * collapsing whitespace, as vision lines are identified (ADR-0003).
 */
export async function verifyCitation(git: Git, citation: Citation): Promise<CitationCheck> {
  if (citation.lines.length === 0) return { verified: false, unmatched: [], reason: "the citation quotes no line" };
  const vision = await readVision(git, citation.commit);
  if (vision.status !== "present") {
    return { verified: false, unmatched: citation.lines, reason: `${VISION_PATH} is ${vision.status} at ${vision.commit}` };
  }
  const identities = new Set(vision.lines.map((line) => line.identity));
  const unmatched = citation.lines.filter((line) => !identities.has(collapseWhitespace(line.text)));
  if (unmatched.length > 0) {
    return {
      verified: false,
      unmatched,
      reason: `${unmatched.length} quoted line(s) not word for word in ${VISION_PATH} at ${vision.commit}`,
    };
  }
  return { verified: true };
}

/** Where an enrolled repo lives on its forge. */
export interface RepoLocation {
  forge: ForgeName;
  host: string;
  /** The project path, such as `owner/repo` or `group/subgroup/project`. */
  path: string;
}

/**
 * A permalink to lines of VISION.md at a commit, which resolves on GitHub and
 * GitLab after any later edit (ADR-0003).
 *
 * @param lastLine the end of a range of lines; omit it for one line.
 */
export function visionPermalink(repo: RepoLocation, commit: string, firstLine: number, lastLine = firstLine): string {
  const base = `https://${repo.host}/${repo.path}`;
  const range = lastLine === firstLine ? "" : repo.forge === "github" ? `-L${lastLine}` : `-${lastLine}`;
  const blob = repo.forge === "github" ? "blob" : "-/blob";
  return `${base}/${blob}/${commit}/${VISION_PATH}#L${firstLine}${range}`;
}

/** The permalink of each line a citation quotes. */
export function citationPermalinks(repo: RepoLocation, citation: Citation): string[] {
  return citation.lines.map((line) => visionPermalink(repo, citation.commit, line.lineNumber));
}
