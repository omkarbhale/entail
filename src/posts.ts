import type { Criterion, IssueCall } from "./judgment.ts";
import type { LandingCall } from "./landing.ts";
import { refsText } from "./blockers.ts";
import {
  criteriaOf,
  linkCriterion,
  type BlockedEntry,
  type LandingPending,
  type Pending,
  type VisionRecheck,
} from "./records.ts";

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
  /**
   * The `entail:` label the issue carries once this acts: the call that acted,
   * or the question waiting on the board. Null for a call that still waits to
   * be confirmed: its label comes with the confirmation.
   */
  label: EntailLabel | null;
}

/** The labels entail puts on an issue, one at a time: the call that acted on it. */
export type EntailLabel = "entail:go" | "entail:no" | "entail:ask" | "entail:blocked";

/** The label a held issue carries while it waits on its blockers; the call's own label replaces it. */
export const BLOCKED_LABEL = "entail:blocked";

/**
 * The post for something entail has to act on, or null for work that is not
 * a post (a judgment still to run). `repo` is the issue's repo, `owner/name`,
 * so a blocker there is named by its number alone.
 */
export function postFor(pending: Pending, owner: string, repo: string): Post | null {
  switch (pending.kind) {
    case "rerun":
      return null;
    case "blocked": {
      const { entry } = pending;
      return { issue: entry.issue.number, markerFor: entry.id, text: blockedText(entry, repo), close: false, reopen: false, label: BLOCKED_LABEL };
    }
    case "call": {
      const { entry } = pending;
      const issue = entry.issue.number;
      if (entry.owner !== null) {
        // The judgment ran again on the owner's go: the call posted is the owner's.
        const head = entry.owner.kind === "override" ? `**Go**, by ${owner}, overriding entail's call on the board.` : `**Go**, on ${owner}'s answer on the board.`;
        const reason = entry.owner.kind === "answer" && entry.call.call === "go" ? entry.call.reason : entry.owner.words;
        const criteria = entry.owner.call === "go" ? criteriaText(criteriaOf(entry.call), issue) : "";
        return { issue, markerFor: entry.id, text: join(head, escape(reason), criteria), close: false, reopen: entry.owner.call === "go", label: `entail:${entry.owner.call}` };
      }
      const waits = entry.confirm && entry.call.call !== "ask";
      const text = callText(entry.call, entry.confirm, owner, issue);
      return { issue, markerFor: entry.id, text: entry.recheck === undefined ? text : join(recheckText(entry.recheck, entry.call.call, owner), text), close: entry.call.call === "no" && !entry.confirm, reopen: false, label: waits ? null : `entail:${entry.call.call}` };
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
        label: called === "no" ? "entail:no" : "entail:go",
      };
    }
    case "owner-no": {
      const { call, action } = pending;
      const head = action.type === "overridden" ? `**No**, by ${owner}, overriding entail's call on the board.` : `**No**, on ${owner}'s answer on the board.`;
      const words = action.type === "overridden" ? action.reason : action.answer;
      return { issue: call.issue.number, markerFor: action.id, text: join(head, escape(words), "Closing the issue as not planned."), close: true, reopen: false, label: "entail:no" };
    }
    case "owner-go": {
      // Go, but differently: the owner's line is the criterion, word for word, in place of entail's.
      const { call, action } = pending;
      const head = `**Go**, by ${owner}, keeping entail's go but not its criteria.`;
      return {
        issue: call.issue.number,
        markerFor: action.id,
        text: join(head, `What the PR must do beyond solving the issue, in ${owner}'s words:\n\n- ${escape(action.reason).replace(/\n+/gu, " ")}\n- ${escape(linkCriterion(call.issue.number).criterion)}`),
        close: false,
        reopen: true,
        label: "entail:go",
      };
    }
  }
}

/** The note on a held issue: what it waits on, and what makes entail pick it up again. */
export function blockedText(entry: Pick<BlockedEntry, "blockers" | "forgeLinks">, repo: string): string {
  const one = entry.blockers.length === 1;
  const head = `This issue is blocked by ${refsText(entry.blockers, repo)}, which ${one ? "is" : "are"} still open. entail is waiting on ${one ? "it" : "them"} and makes no call here until then: no criteria, and no work starts.`;
  const again = `entail picks this issue up again when it is edited (for example to remove a blocker), on an \`/entail\` comment, or when ${one ? "the blocker closes" : "the blockers close"}.`;
  const text = entry.forgeLinks ? "" : "The forge's own blocked-by links could not be read for this repo, so only this issue's text was checked for blockers.";
  return join(head, again, text);
}

/**
 * entail's own call as posted: the call, the reason, and for go the criteria.
 * A no also quotes the vision lines it rests on, so a ticket that goes
 * against the vision is closed quoting the line; the board and the log carry
 * what every call rests on.
 */
export function callText(call: IssueCall, confirm: boolean, owner: string, issue: number): string {
  if (call.call === "ask") {
    return `A question about this issue is waiting for ${owner} on entail's board. Nothing happens here until it is answered.`;
  }
  const head = `**${call.call === "go" ? "Go" : "No"}.** ${escape(call.reason)}`;
  if (call.call === "no") {
    const tail = confirm ? `The issue closes once ${owner} confirms this call on entail's board.` : "Closing the issue as not planned.";
    return join(head, visionLinesText(call.restsOn.visionLines), tail);
  }
  const tail = confirm ? `This call waits for ${owner} to confirm it on entail's board; nothing starts until then.` : "";
  return join(head, criteriaText(criteriaOf(call), issue), tail);
}

/**
 * What a call a vision change moved says first: that VISION.md changed, the
 * call before and after, the line that moved it, and the open PRs that relied
 * on the old text.
 */
export function recheckText(recheck: VisionRecheck, call: IssueCall["call"], owner: string): string {
  const name = (kind: string) => kind.charAt(0).toUpperCase() + kind.slice(1);
  const whose = recheck.previousCall === "ask" ? `A question to ${owner} was waiting on this issue` : `The call on this issue was **${name(recheck.previousCall)}**`;
  const head = `**VISION.md changed, and the call changes with it: ${name(recheck.previousCall)} → ${name(call)}.** ${whose} under the earlier vision; entail judged it again under the new one.`;
  const what = recheck.passageKind === "added" ? "The line the change added that moves the call:" : recheck.passageKind === "removed" ? "The line the change removed that moves the call:" : "What changed in the vision:";
  const passage = `${what}\n\n${recheck.passage.split("\n").map((line) => `> ${escape(line).replace(/^>\s*/u, "")}`).join("\n")}`;
  const prs = recheck.pullRequests.length === 0 ? "" : `In-flight work relied on the old text: ${recheck.pullRequests.map((pr) => pr.url).join(", ")}. It is told of this change.`;
  return join(head, passage, prs);
}

function visionLinesText(lines: readonly string[]): string {
  if (lines.length === 0) return "";
  return `It rests on the vision:\n\n${lines.map((line) => `> ${line.replace(/^>\s*/u, "").trim()}`).join("\n>\n")}`;
}

/** A go's criteria as posted: the model's, then the line on linking the PR, which every go carries. */
function criteriaText(criteria: readonly Criterion[], issue: number): string {
  const lines = [...criteria, linkCriterion(issue)].map((criterion) => `- ${escape(criterion.criterion).replace(/\n+/gu, " ")}`);
  return `What the PR must do beyond solving the issue:\n\n${lines.join("\n")}`;
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

// Posts on PRs.

/** What entail does on a PR for one landing call or owner's action, and the comment that says so. */
export interface PullRequestPost {
  pr: number;
  /** The id of the log entry the comment speaks for; its hidden marker carries it. */
  markerFor: number;
  /** Whether to merge at the judged head before posting. */
  merge: boolean;
  /** Whether to close the PR unmerged after posting: it is cancelled. */
  close: boolean;
  /** Whether this post sends the PR back, which counts toward cancelling it. */
  sentBack: boolean;
  /** The comment's text, given what came of the merge when there was one. */
  text: (merge: MergeResult | null) => string;
}

/** What came of a merge entail tried: merged at the judged head, or why not. */
export type MergeResult = { merged: true; sha: string; commit: string | null } | { merged: false; refusal: string };

/**
 * The post for a landing call or the owner's action on one. `pullRequest` is what the
 * forge calls a PR: "pull request" on GitHub, "merge request" on GitLab.
 */
export function pullRequestPostFor(pending: LandingPending, owner: string, pullRequest = "pull request"): PullRequestPost {
  switch (pending.kind) {
    case "landing": {
      const { entry } = pending;
      const { call } = entry;
      const base = { pr: entry.pr.number, markerFor: entry.id };
      if (call.call === "merge") {
        if (entry.confirm) {
          return { ...base, merge: false, close: false, sentBack: false, text: () => join(`**Merge.** ${escape(call.reason)}`, checklistText(call), `This call waits for ${owner} to confirm it on entail's board; nothing is merged until then.`) };
        }
        return { ...base, merge: true, close: false, sentBack: false, text: (merge) => join(`**Merge.** ${escape(call.reason)}`, checklistText(call), mergeText(merge, entry.head)) };
      }
      if (call.call === "send-back") {
        const cancelling = entry.cancel
          ? entry.confirm
            ? `entail has sent this ${pullRequest} back ${entry.sendBacks} times before. It closes unmerged once ${owner} confirms this call on entail's board.`
            : `entail has sent this ${pullRequest} back ${entry.sendBacks} times before. Closing it unmerged.`
          : "entail judges it again on its next push.";
        return { ...base, merge: false, close: entry.cancel && !entry.confirm, sentBack: true, text: () => join(`**Send back.** ${escape(call.reason)}`, needsText(call.needsToChange), checklistText(call), cancelling) };
      }
      return { ...base, merge: false, close: false, sentBack: false, text: () => `A question about this ${pullRequest} is waiting for ${owner} on entail's board. Nothing is merged until it is answered.` };
    }
    case "landing-confirmed": {
      const { landing, action } = pending;
      const base = { pr: landing.pr.number, markerFor: action.id, sentBack: false };
      if (landing.call.call === "merge") {
        return { ...base, merge: true, close: false, text: (merge) => join(`${owner} confirmed this call on the board: merge.`, mergeText(merge, landing.head)) };
      }
      return {
        ...base,
        merge: false,
        close: landing.cancel,
        text: () => (landing.cancel ? `${owner} confirmed this call on the board: send back, and close the ${pullRequest} unmerged. Closing it.` : `${owner} confirmed this call on the board: send back.`),
      };
    }
    case "landing-owner": {
      const { landing, action, to } = pending;
      const words = action.type === "overridden" ? action.reason : action.answer;
      const how = action.type === "overridden" ? `by ${owner}, overriding entail's call on the board.` : `on ${owner}'s answer on the board.`;
      const base = { pr: landing.pr.number, markerFor: action.id, close: false };
      if (to === "merge") return { ...base, merge: true, sentBack: false, text: (merge) => join(`**Merge**, ${how}`, escape(words), mergeText(merge, landing.head)) };
      return { ...base, merge: false, sentBack: true, text: () => join(`**Send back**, ${how}`, escape(words), "entail judges it again on its next push.") };
    }
  }
}

function mergeText(merge: MergeResult | null, head: string): string {
  if (merge === null) return `Merging at \`${head}\`.`;
  if (merge.merged) return `Merged at \`${merge.sha}\`.`;
  return `entail did not merge it at \`${head}\`: ${escape(merge.refusal)}. A new push gets it judged again.`;
}

function needsText(items: readonly string[]): string {
  if (items.length === 0) return "";
  return `What needs to change:\n\n${items.map((item) => `- ${escape(item).replace(/\n+/gu, " ")}`).join("\n")}`;
}

/** The criteria marked met or unmet, and what the PR does beyond them, as the comment shows them. */
function checklistText(call: LandingCall): string {
  const parts: string[] = [];
  if (call.criteria.length > 0) {
    parts.push(`Criteria:\n\n${call.criteria.map((check) => `- ${check.met ? "Met" : "**Not met**"}: ${escape(check.criterion).replace(/\n+/gu, " ")}`).join("\n")}`);
  }
  if (call.beyond.length > 0) {
    const label = { needed: "Needed", harmless: "Harmless", unwanted: "**Unwanted**" } as const;
    parts.push(`Beyond the criteria:\n\n${call.beyond.map((item) => `- ${label[item.sort]}: ${escape(item.change).replace(/\n+/gu, " ")}`).join("\n")}`);
  }
  return parts.join("\n\n");
}
