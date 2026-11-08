// Reading what entail posts, and writing what an executor posts back, in the
// formats ADR-0013 fixes: an `entail evidence` section with one entry per
// criterion id, and an `entail findings` comment with one entry per question id.
import type { Comment } from "./forge.ts";
import type { PreparedChange } from "./prepared.ts";
import type { TestRun } from "./tree.ts";

/**
 * Whether a comment is entail's: its first line is the attribution line,
 * which names the owner in the possessive (for example "Speaking from Omkar's
 * entail:", MVP-1 spec section 9).
 */
export function isEntailComment(body: string): boolean {
  const first = body.split("\n").find((line) => line.trim() !== "") ?? "";
  return /^\s*Speaking from .+\bentail:/.test(first);
}

export interface ListedId {
  id: string;
  /** The rest of the line, without markdown emphasis and separators. */
  text: string;
}

/**
 * The ids with a prefix (`C`, `G` or `Q`) that start a line of a comment, in
 * order and each once: entail lists criteria C1…Cn, generic criteria G1…Gn and
 * questions Q1…Qn one per line, whatever markdown surrounds them.
 */
export function listedIds(body: string, prefix: "C" | "G" | "Q"): ListedId[] {
  const seen = new Map<string, string>();
  const pattern = new RegExp(`^[\\s>|*_\`#-]*(?:\\d+\\.\\s+)?[*_\`]*(${prefix}\\d+)\\b[*_\`]*[\\s:.|—–-]*(.*)$`);
  for (const line of body.split("\n")) {
    const match = pattern.exec(line);
    if (!match?.[1] || seen.has(match[1])) continue;
    const text = (match[2] ?? "").replace(/[*_`|]/g, "").trim();
    seen.set(match[1], text);
  }
  return [...seen].map(([id, text]) => ({ id, text }));
}

/** entail's latest comment listing criteria: the intake comment the executor works from. */
export function latestCriteriaComment(comments: readonly Comment[]): Comment | undefined {
  return comments.findLast((c) => isEntailComment(c.body) && listedIds(c.body, "C").length > 0);
}

/** entail's latest comment listing investigation questions. */
export function latestQuestionsComment(comments: readonly Comment[]): Comment | undefined {
  return comments.findLast((c) => isEntailComment(c.body) && listedIds(c.body, "Q").length > 0);
}

/**
 * entail's failing landing comment on a PR at a head: it names the head sha
 * and does not end in "merging at" (MVP-1 spec section 11).
 */
export function failingLandingComment(comments: readonly Comment[], headSha: string): Comment | undefined {
  const short = headSha.slice(0, 7);
  return comments.find((c) => isEntailComment(c.body) && c.body.includes(short) && !/\bmerging at\b/i.test(c.body));
}

export const EVIDENCE_HEADING = "## entail evidence";
export const FINDINGS_HEADING = "## entail findings";

/** A hidden line naming what an evidence section was written from, so the executor knows when it is stale. */
const BASIS = /<!-- entail test executor: criteria comment (\d+), head ([0-9a-f]+) -->/;

export interface EvidenceBasis {
  criteriaCommentId: number;
  headSha: string;
}

export function evidenceBasis(body: string): EvidenceBasis | undefined {
  const match = BASIS.exec(body);
  return match ? { criteriaCommentId: Number(match[1]), headSha: match[2]! } : undefined;
}

function factsFor(change: PreparedChange, criterion: string): string[] {
  const lower = criterion.toLowerCase();
  const matching = change.facts.filter((fact) => fact.keywords.some((word) => lower.includes(word.toLowerCase())));
  return (matching.length > 0 ? matching : change.facts).map((fact) => fact.text);
}

function result(run: TestRun): string {
  const total = run.pass + run.fail;
  return run.passed ? `all ${total} tests pass` : `${run.fail} of ${total} tests fail`;
}

/**
 * The `entail evidence` section for a prepared PR at a head: one entry per
 * criterion and generic criterion id listed in entail's criteria comment,
 * each `<id>: <what was run or done> — <result>`, with the result of running
 * tally's tests at that head.
 */
export function renderEvidence(
  change: PreparedChange,
  criteria: Comment,
  headSha: string,
  run: TestRun,
): string {
  const short = headSha.slice(0, 7);
  const lines = [EVIDENCE_HEADING, ""];
  for (const { id, text } of listedIds(criteria.body, "C")) {
    lines.push(`${id}: ${factsFor(change, text).join("; ")}; ran \`npm test\` at ${short} — ${result(run)}`);
  }
  for (const { id } of listedIds(criteria.body, "G")) {
    lines.push(`${id}: ran \`npm test\`, the command the CI job \`test\` runs, at ${short} — ${result(run)}`);
  }
  lines.push("", `<!-- entail test executor: criteria comment ${criteria.id}, head ${headSha} -->`);
  return lines.join("\n");
}

/** The `entail findings` comment: the prepared finding under every question id. */
export function renderFindings(questions: Comment, finding: string): string {
  const lines = [FINDINGS_HEADING, ""];
  for (const { id } of listedIds(questions.body, "Q")) lines.push(`${id}: ${finding}`);
  return lines.join("\n");
}

export function isFindings(body: string): boolean {
  return body.trimStart().startsWith(FINDINGS_HEADING);
}
