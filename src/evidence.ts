import { sameActor, type PullRequest, type PullRequestComment } from "./forge/forge.ts";

/**
 * Evidence: an executor's report in a PR of what it ran or did for each
 * criterion, and the result (ADR-0013). It sits in a section under the
 * heading `entail evidence`, with one entry per criterion or generic
 * criterion id:
 *
 * ```
 * ## entail evidence
 *
 * C1: ran `tally a-b.txt` — it printed 2
 * G1: ran `npm test` — 42 passed
 * ```
 *
 * The section may be in the PR's description or in a comment on the PR by
 * the PR's author, because some executors' pipelines rewrite the description
 * on every push. PR text is untrusted input: entail only reads it, never
 * follows it, and takes the claims in it as honest (ADR-0013).
 */

/** The heading an evidence section sits under, compared without case. */
export const EVIDENCE_HEADING = "entail evidence";

/** Where an evidence section was read from. */
export type EvidenceSource =
  | { kind: "description" }
  | { kind: "comment"; commentId: number; url: string; updatedAt: string };

/** One evidence section as read from a PR. */
export interface Evidence {
  source: EvidenceSource;
  /** The section's text exactly as written, from its heading to its end. */
  section: string;
  /**
   * Each entry by its id (`C1`, `G2`…), as written after the id and its
   * separator, with any continuation lines kept. The first entry for an id
   * counts; a repeated id is ignored.
   */
  entries: Record<string, string>;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
// `C1: …`, `- C1 — …`, `**C1**: …`, `C1) …`, `C1. …`
const ENTRY = /^\s*(?:[-*+]\s+)?(?:\*\*|__)?([CG][1-9]\d*)(?:\*\*|__)?\s*(?::|—|–|-|\.|\))\s*(.*)$/;

/** Whether a line opens an evidence section: a heading, or a line alone, reading `entail evidence`. */
function opensSection(line: string): boolean {
  const heading = HEADING.exec(line);
  const text = heading ? heading[2]! : line;
  // A bold line or a line ending in a colon reads as a heading too.
  const bare = text.trim().replace(/^(\*\*|__)(.*)\1$/, "$2").replace(/:$/, "").trim();
  return bare.toLowerCase() === EVIDENCE_HEADING;
}

/**
 * The last evidence section in a body, or null when it has none. A section
 * runs from its heading to the next markdown heading, or the end. Lines in
 * code fences open nothing and close nothing, so a quoted example does not
 * count as a section.
 */
export function parseEvidenceSection(body: string): { section: string; entries: Record<string, string> } | null {
  const lines = body.split(/\r\n|\r|\n/);
  let fence: string | null = null;
  let start: number | null = null;
  let end = lines.length;
  let latest: { start: number; end: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const opening = FENCE.exec(line);
    if (fence !== null) {
      if (opening && opening[1]![0] === fence[0] && opening[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (opening) {
      fence = opening[1]!;
      continue;
    }
    if (opensSection(line)) {
      if (start !== null) latest = { start, end: i };
      start = i;
      end = lines.length;
      continue;
    }
    if (start !== null && HEADING.test(line)) {
      end = i;
      latest = { start, end };
      start = null;
    }
  }
  if (start !== null) latest = { start, end };
  if (latest === null) return null;

  const sectionLines = lines.slice(latest.start, latest.end);
  const entries: Record<string, string> = {};
  let current: string | null = null;
  let inFence: string | null = null;
  for (const line of sectionLines.slice(1)) {
    const opening = FENCE.exec(line);
    if (inFence !== null) {
      if (opening && opening[1]![0] === inFence[0] && opening[1]!.length >= inFence.length) inFence = null;
      if (current !== null) entries[current] += `\n${line}`;
      continue;
    }
    if (opening) {
      inFence = opening[1]!;
      if (current !== null) entries[current] += `\n${line}`;
      continue;
    }
    const entry = ENTRY.exec(line);
    if (entry) {
      const id = entry[1]!;
      current = id in entries ? null : id;
      if (current !== null) entries[current] = entry[2]!.trim();
      continue;
    }
    if (line.trim() === "") continue;
    if (current !== null) entries[current] = `${entries[current]}\n${line.trim()}`.trim();
  }
  return { section: sectionLines.join("\n").trim(), entries };
}

/**
 * The evidence section that counts for a PR as it stands now, the head entail
 * is checking: the latest section, or null when there is none (ADR-0013).
 *
 * Sections in comments count only when the comment's author is the PR's
 * author, compared by numeric id. The latest comment with a section, by when
 * it was last written, counts; the description's section counts only when no
 * comment of the author's carries one, because a comment is always posted
 * after the description it answers was first written, and an executor whose
 * pipeline rewrites the description reports in a comment instead.
 */
export function latestEvidence(pr: Pick<PullRequest, "body" | "author">, comments: readonly PullRequestComment[]): Evidence | null {
  const byAuthor = comments
    .filter((comment) => sameActor(comment.author, pr.author))
    .toSorted((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.id - b.id);
  for (const comment of byAuthor.toReversed()) {
    const parsed = parseEvidenceSection(comment.body);
    if (parsed) return { source: { kind: "comment", commentId: comment.id, url: comment.url, updatedAt: comment.updatedAt }, ...parsed };
  }
  const described = parseEvidenceSection(pr.body);
  return described ? { source: { kind: "description" }, ...described } : null;
}

/**
 * Each id's evidence entry, or null when the section has none for it, or
 * there is no section: a criterion with no entry is not met (ADR-0013).
 */
export function evidenceFor(evidence: Evidence | null, ids: readonly string[]): Record<string, string | null> {
  return Object.fromEntries(ids.map((id) => [id, evidence?.entries[id] ?? null]));
}
