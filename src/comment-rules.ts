/**
 * The rules every comment entail posts follows, enforced by the one comment
 * writer (MVP-1 spec section 9, ADR-0015, ADR-0009):
 *
 * - its first line is the attribution line, naming the owner in the
 *   possessive, such as "Speaking from Omkar's entail:";
 * - it carries the hidden marker with its ticket's record id, by which entail
 *   finds its own comment again after a crash (see {@link MarkerFor} for the
 *   one comment posted where entail has no ticket);
 * - no line starts with `/`, so no line is ever a GitLab quick action.
 */

/** Thrown for a comment body that breaks the comment rules; nothing is posted. */
export class CommentRuleError extends Error {
  readonly violations: readonly string[];

  constructor(violations: readonly string[]) {
    super(`the comment breaks entail's comment rules: ${violations.join("; ")}`);
    this.name = "CommentRuleError";
    this.violations = violations;
  }
}

/**
 * The owner's display name as the attribution line carries it: one line,
 * with runs of whitespace as single spaces. Throws for a name that is empty
 * or would start a new line.
 */
function displayName(ownerName: string): string {
  if (/[\r\n]/.test(ownerName)) throw new Error("the owner's display name must be one line");
  const name = ownerName.trim().replace(/\s+/g, " ");
  if (name === "") throw new Error("the owner's display name is not set");
  return name;
}

/**
 * The owner's display name in the possessive. A name ending in "s", in any
 * case, takes the apostrophe alone ("James'", "JONAS'"); every other name
 * takes "'s" ("Omkar's", "Max's", "Li's"). A name already in the possessive
 * ("Omkar's", "James'") is kept as it is rather than doubled.
 */
export function possessive(ownerName: string): string {
  const name = displayName(ownerName);
  if (/['’](s)?$/i.test(name)) return name;
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

/** The line every comment entail posts opens with, such as "Speaking from Omkar's entail:". */
export function attributionLine(ownerName: string): string {
  return `Speaking from ${possessive(ownerName)} entail:`;
}

const MARKER = /<!-- entail ticket (\d+) -->/g;
const REPLY_MARKER = /<!-- entail reply (\d+) -->/g;

/**
 * What a comment's hidden marker carries: its ticket's record id, or, for
 * entail's one reply to an `/entail` comment on a closed issue it has no
 * ticket for, the forge id of that `/entail` comment, since there is no
 * ticket record to name (ADR-0020).
 */
export type MarkerFor = number | { reply: number };

/**
 * The hidden marker carrying a ticket's record id, or the `/entail` comment a
 * reply answers: an HTML comment, which both forges hide when they render the
 * comment. It starts with `<`, so its line never starts with `/`.
 */
export function hiddenMarker(markerFor: MarkerFor): string {
  if (typeof markerFor !== "number") {
    const { reply } = markerFor;
    if (!Number.isSafeInteger(reply) || reply <= 0) throw new Error(`a comment's forge id is a positive integer, not ${reply}`);
    return `<!-- entail reply ${reply} -->`;
  }
  if (!Number.isSafeInteger(markerFor) || markerFor <= 0) throw new Error(`a ticket's record id is a positive integer, not ${markerFor}`);
  return `<!-- entail ticket ${markerFor} -->`;
}

/** The ticket record ids of the hidden markers in a comment body, in order. */
export function markedTickets(body: string): number[] {
  return [...body.matchAll(MARKER)].map((match) => Number(match[1]));
}

/** The `/entail` comment ids of the reply markers in a comment body, in order. */
export function markedReplies(body: string): number[] {
  return [...body.matchAll(REPLY_MARKER)].map((match) => Number(match[1]));
}

/**
 * A comment body that follows the rules: the attribution line, a blank line,
 * `text`, a blank line, then the hidden marker on its own last line. The text
 * is checked like any other body, so a line of it starting with `/` is still
 * refused.
 */
export function composeComment(ownerName: string, markerFor: MarkerFor, text: string): string {
  const body = `${attributionLine(ownerName)}\n\n${text.trim()}\n\n${hiddenMarker(markerFor)}`;
  assertCommentRules(body, ownerName, markerFor);
  return body;
}

/** Every way `body` breaks the comment rules for the owner's name and the ticket (or replied comment), or none. */
export function commentRuleViolations(body: string, ownerName: string, markerFor: MarkerFor): string[] {
  const violations: string[] = [];
  const lines = body.split(/\r\n|\r|\n/);
  const first = lines.find((line) => line.trim() !== "");
  const expected = attributionLine(ownerName);
  if (first?.trim() !== expected) violations.push(`the first line is not the attribution line "${expected}"`);

  const tickets = markedTickets(body);
  const replies = markedReplies(body);
  if (typeof markerFor === "number") {
    if (!tickets.includes(markerFor)) violations.push(`it lacks the hidden marker for ticket ${markerFor}`);
    if (tickets.some((id) => id !== markerFor) || replies.length > 0) violations.push("it carries a hidden marker for another ticket");
  } else {
    if (!replies.includes(markerFor.reply)) violations.push(`it lacks the hidden marker for the comment ${markerFor.reply} it replies to`);
    if (replies.some((id) => id !== markerFor.reply) || tickets.length > 0) violations.push("it carries a hidden marker for another ticket");
  }
  if (tickets.length + replies.length > 1) violations.push("it carries more than one hidden marker");

  // Leading whitespace is ignored, so an indented `/` is refused too.
  const slashed = lines.flatMap((line, index) => (/^\s*\//.test(line) ? [index + 1] : []));
  if (slashed.length > 0) violations.push(`line ${slashed.join(", ")} starts with "/"`);
  return violations;
}

/** Throws {@link CommentRuleError} unless `body` follows the comment rules. */
export function assertCommentRules(body: string, ownerName: string, markerFor: MarkerFor): void {
  const violations = commentRuleViolations(body, ownerName, markerFor);
  if (violations.length > 0) throw new CommentRuleError(violations);
}
