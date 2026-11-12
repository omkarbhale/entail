import type { Criterion, IssueCall } from "./judgment.ts";
import { criteriaOf, type Pending } from "./records.ts";

/**
 * What entail posts on an issue for each thing it acts on, as the text that
 * goes between the attribution line and the hidden marker (see
 * `composeComment`). The marker carries the id of the log entry the comment
 * speaks for, which is how a restart finds it again instead of posting twice.
 *
 * A question's text never goes on the issue: an ask posts only a note that a
 * question is waiting on the board, where it is asked and answered.
 */

/** One post: the issue, the entry it speaks for, its text, and whether the issue closes, or reopens if closed, with it. */
export interface Post {
  issue: number;
  /** The id of the log entry the comment speaks for; its hidden marker carries it. */
  markerFor: number;
  text: string;
  close: boolean;
  /** The owner's go: a closed issue is reopened. */
  reopen: boolean;
}

/** The post for something entail has to act on, or null for work that is not a post (a judgment still to run). */
export function postFor(pending: Pending, owner: string): Post | null {
  switch (pending.kind) {
    case "rerun":
      return null;
    case "call": {
      const { entry } = pending;
      const issue = entry.issue.number;
      if (entry.owner !== null) {
        // The judgment ran again on the owner's go: the call posted is the owner's.
        const head = entry.owner.kind === "override" ? `**Go**, by ${owner}, overriding entail's call on the board.` : `**Go**, on ${owner}'s answer on the board.`;
        const reason = entry.owner.kind === "answer" && entry.call.call === "go" ? entry.call.reason : entry.owner.words;
        const criteria = entry.call.call === "no" ? [] : entry.call.criteria;
        return { issue, markerFor: entry.id, text: join(head, escape(reason), criteriaText(criteria)), close: false, reopen: entry.owner.call === "go" };
      }
      return { issue, markerFor: entry.id, text: callText(entry.call, entry.confirm, owner), close: entry.call.call === "no" && !entry.confirm, reopen: false };
    }
    case "confirmed": {
      const { call, action } = pending;
      const called = call.call.call;
      return {
        issue: call.issue.number,
        markerFor: action.id,
        text: called === "no" ? `${owner} confirmed this call on the board: no. Closing the issue as not planned.` : `${owner} confirmed this call on the board: go.`,
        close: called === "no",
        reopen: false,
      };
    }
    case "owner-no": {
      const { call, action } = pending;
      const head = action.type === "overridden" ? `**No**, by ${owner}, overriding entail's call on the board.` : `**No**, on ${owner}'s answer on the board.`;
      const words = action.type === "overridden" ? action.reason : action.answer;
      return { issue: call.issue.number, markerFor: action.id, text: join(head, escape(words), "Closing the issue as not planned."), close: true, reopen: false };
    }
  }
}

/**
 * entail's own call as posted: the call, the reason, and for go the criteria.
 * A no also quotes the vision lines it rests on, so a ticket that goes
 * against the vision is closed quoting the line; the board and the log carry
 * what every call rests on.
 */
export function callText(call: IssueCall, confirm: boolean, owner: string): string {
  if (call.call === "ask") {
    return `A question about this issue is waiting for ${owner} on entail's board. Nothing happens here until it is answered.`;
  }
  const head = `**${call.call === "go" ? "Go" : "No"}.** ${escape(call.reason)}`;
  if (call.call === "no") {
    const tail = confirm ? `The issue closes once ${owner} confirms this call on entail's board.` : "Closing the issue as not planned.";
    return join(head, visionLinesText(call.restsOn.visionLines), tail);
  }
  const tail = confirm ? `This call waits for ${owner} to confirm it on entail's board; nothing starts until then.` : "";
  return join(head, criteriaText(criteriaOf(call)), tail);
}

function visionLinesText(lines: readonly string[]): string {
  if (lines.length === 0) return "";
  return `It rests on the vision:\n\n${lines.map((line) => `> ${line.replace(/^>\s*/u, "").trim()}`).join("\n>\n")}`;
}

function criteriaText(criteria: readonly Criterion[]): string {
  if (criteria.length === 0) return "";
  return `What the PR must do beyond solving the issue:\n\n${criteria.map((criterion) => `- ${escape(criterion.criterion).replace(/\n+/gu, " ")}`).join("\n")}`;
}

function join(...parts: string[]): string {
  return parts.filter((part) => part.trim() !== "").join("\n\n");
}

/**
 * Text from a model or the owner, made safe for a comment: a line starting
 * with `/` would break the comment rules (it could be a quick action), so its
 * slash is escaped, which Markdown renders as a plain slash.
 */
export function escape(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => line.replace(/^(\s*)\//u, "$1\\/"))
    .join("\n");
}
