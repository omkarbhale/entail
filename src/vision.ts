import type { Git } from "./git.ts";

/** Where the vision of record lives on the default branch. */
export const VISION_PATH = "VISION.md";

/**
 * One vision line: one line of VISION.md that states something, as opposed to
 * a heading, a blank line or a thematic break (ADR-0003).
 */
export interface VisionLine {
  /** The line exactly as written, without its line ending. */
  text: string;
  /**
   * What identifies the line: its text with whitespace collapsed. Two lines
   * with the same identity are the same vision line, wherever they stand.
   */
  identity: string;
  /** 1-based line number in the file, used only for a permalink at a sha. */
  lineNumber: number;
  /** The text of the nearest heading above the line, or null if none. */
  heading: string | null;
}

/** VISION.md as it stands at one commit. */
export type VisionAtCommit =
  | {
      status: "present";
      /** The commit read, as a full sha. */
      commit: string;
      /** The VISION.md blob at that commit. */
      blob: string;
      lines: VisionLine[];
    }
  /** There is no VISION.md at the commit. */
  | { status: "missing"; commit: string }
  /** VISION.md exists but has no vision line, such as an empty file or only headings. */
  | { status: "empty"; commit: string; blob: string };

/**
 * A vision change: the vision lines one version of VISION.md removed and the
 * ones it added (ADR-0003). A reworded line is one removed and one added.
 */
export interface VisionChange {
  removed: VisionLine[];
  added: VisionLine[];
}

/** Collapses every run of whitespace to one space and trims both ends. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/u;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/u;
const THEMATIC_BREAK = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/u;

/**
 * Splits the text of VISION.md into its vision lines.
 *
 * Every non-blank line is a vision line except a heading (`#` style, or a line
 * underlined with `=` or `-`) and a thematic break. Each vision line keeps the
 * nearest heading above it.
 */
export function splitVisionLines(content: string): VisionLine[] {
  const raw = content.split(/\r\n|\n|\r/u);
  const lines: VisionLine[] = [];
  let heading: string | null = null;

  for (let index = 0; index < raw.length; index++) {
    const text = raw[index] ?? "";
    if (text.trim() === "") continue;

    const atx = ATX_HEADING.exec(text);
    if (atx) {
      heading = collapseWhitespace(atx[2] ?? "");
      continue;
    }
    if (THEMATIC_BREAK.test(text) && !SETEXT_UNDERLINE.test(text)) continue;

    const next = raw[index + 1];
    if (next !== undefined && SETEXT_UNDERLINE.test(next)) {
      heading = collapseWhitespace(text);
      index++;
      continue;
    }
    // A lone underline with no text above it is a thematic break.
    if (SETEXT_UNDERLINE.test(text) && /-{3,}/u.test(text)) continue;

    lines.push({ text, identity: collapseWhitespace(text), lineNumber: index + 1, heading });
  }
  return lines;
}

/**
 * Reads VISION.md at a commit of the repository.
 *
 * @param commit any revision git resolves to a commit, such as a sha.
 */
export async function readVision(git: Git, commit: string): Promise<VisionAtCommit> {
  const sha = (await git.text(["rev-parse", "--verify", "--end-of-options", `${commit}^{commit}`])).trim();
  // `<mode> <type> <object>\t<path>`; a VISION.md that is a directory, a link
  // or a submodule is not a vision.
  const entry = /^(100644|100755) blob ([0-9a-f]+)\t/u.exec(await git.text(["ls-tree", "-z", sha, "--", VISION_PATH]));
  const blob = entry?.[2];
  if (blob === undefined) return { status: "missing", commit: sha };

  const content = (await git.run(["cat-file", "blob", blob])).stdout.toString("utf8");
  const lines = splitVisionLines(content);
  if (lines.length === 0) return { status: "empty", commit: sha, blob };
  return { status: "present", commit: sha, blob, lines };
}

/** The vision lines of a VISION.md read at a commit, none if it is missing or empty. */
export function visionLinesOf(vision: VisionAtCommit): VisionLine[] {
  return vision.status === "present" ? vision.lines : [];
}

/**
 * Computes the vision change from one list of vision lines to another, by
 * identity. Moving a line or renaming its heading changes nothing; any
 * change of words removes the old line and adds the new one.
 */
export function computeVisionChange(before: VisionLine[], after: VisionLine[]): VisionChange {
  const beforeIds = new Set(before.map((line) => line.identity));
  const afterIds = new Set(after.map((line) => line.identity));
  return {
    removed: uniqueByIdentity(before.filter((line) => !afterIds.has(line.identity))),
    added: uniqueByIdentity(after.filter((line) => !beforeIds.has(line.identity))),
  };
}

/** Reads the vision change between VISION.md at two commits. */
export async function readVisionChange(git: Git, from: string, to: string): Promise<VisionChange> {
  const [before, after] = await Promise.all([readVision(git, from), readVision(git, to)]);
  return computeVisionChange(visionLinesOf(before), visionLinesOf(after));
}

/** Keeps the first line of each identity, since a repeated line is one vision line. */
function uniqueByIdentity(lines: VisionLine[]): VisionLine[] {
  const seen = new Set<string>();
  return lines.filter((line) => {
    if (seen.has(line.identity)) return false;
    seen.add(line.identity);
    return true;
  });
}
