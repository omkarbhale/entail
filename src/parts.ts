/**
 * The parts of an issue that bundles several suggestions: the items of the
 * lists in its own words. The owner picks the parts they accept on the board;
 * entail files one new issue for each and closes the original. Nothing here
 * runs a model: the parts are what the issue's lists say, read the same way
 * every time, so the owner is picking among words they can see.
 */

/** One part: its first line as the title, and the rest of the item, if any, as the body. */
export interface IssuePart {
  title: string;
  body: string;
}

/** What an owner's partial answer recorded: the parts accepted, each filed as its own issue, and the titles of those turned down. */
export interface AnswerParts {
  accepted: IssuePart[];
  declined: string[];
}

const ITEM = /^(?:[-*+]|\d{1,9}[.)])[ \t]+(.*)$/u;
const FENCE = /^ {0,3}(```|~~~)/u;
const TASK_BOX = /^\[[ xX]\][ \t]+/u;

/**
 * The parts of an issue's body: each item of a list, at the first level of
 * the list, with its indented lines as its body. A body with fewer than two
 * items bundles nothing, so it has no parts. Lists inside a code fence are
 * skipped, and a checkbox mark is dropped from a title.
 */
export function issueParts(body: string): IssuePart[] {
  const parts: IssuePart[] = [];
  let fence: string | null = null;
  let current: { title: string; lines: string[] } | null = null;
  const finish = () => {
    if (current === null) return;
    const title = current.title.replace(TASK_BOX, "").trim();
    if (title !== "") parts.push({ title, body: current.lines.join("\n").trim() });
    current = null;
  };
  for (const line of body.split(/\r\n|\r|\n/u)) {
    const marker = FENCE.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      if (current !== null && /^\s/u.test(line)) current.lines.push(line.trim());
      else if (current !== null) finish();
      continue;
    }
    if (fence !== null) {
      if (current !== null) current.lines.push(line.trim());
      continue;
    }
    const item = ITEM.exec(line);
    if (item !== null) {
      finish();
      current = { title: item[1]!, lines: [] };
    } else if (current !== null) {
      // A continuation is indented; a blank line may sit inside an item; an unindented line ends it.
      if (/^\s+\S/u.test(line)) current.lines.push(line.trim());
      else if (line.trim() === "") current.lines.push("");
      else finish();
    }
  }
  finish();
  return parts.length >= 2 ? parts : [];
}

/**
 * The parts an owner accepts, picked by their position among {@link issueParts}
 * (from 0): the accepted ones in the issue's order, and the titles of the rest.
 * Throws a message for a pick that is not a whole position, is repeated, or
 * names a part the issue has not.
 */
export function pickParts(parts: readonly IssuePart[], picked: unknown): AnswerParts {
  if (parts.length === 0) throw new Error("the issue has no parts to pick from: it does not list several suggestions");
  if (!Array.isArray(picked) || picked.length === 0) throw new Error("accept lists the parts to take, by position, and takes at least one");
  const chosen = new Set<number>();
  for (const position of picked) {
    if (typeof position !== "number" || !Number.isInteger(position) || position < 0 || position >= parts.length) {
      throw new Error(`a part is picked by its position from 0 to ${parts.length - 1}`);
    }
    if (chosen.has(position)) throw new Error(`part ${position} is picked twice`);
    chosen.add(position);
  }
  return {
    accepted: parts.filter((_, index) => chosen.has(index)),
    declined: parts.filter((_, index) => !chosen.has(index)).map((part) => part.title),
  };
}
