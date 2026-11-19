import { outcomeWords, scopeOf, type Criterion, type GoScope, type IssueCall, type Ruling } from "./judgment.ts";
import type { LandingCall } from "./landing.ts";
import { refsText } from "./blockers.ts";
import type { AnswerParts } from "./parts.ts";
import {
  criteriaOf,
  goScope,
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

/** The labels entail puts on an issue, one at a time: the call that acted on it, `entail:plan` for a go for planning. */
export type EntailLabel = "entail:go" | "entail:plan" | "entail:no" | "entail:ask" | "entail:blocked";

/** The label a go carries: `entail:plan` when it clears the ticket for planning, else `entail:go`. */
export function goLabel(scope: GoScope): EntailLabel {
  return scope === "plan" ? "entail:plan" : "entail:go";
}

/** What a go for planning says it hands to the owner's workflow, after its heading. */
export const PLANNING_LINE = "The owner's workflow writes the plan and files the smaller tickets, each judged on its own, and closes this issue with links to them. entail closes nothing here.";

/** The label a held issue carries while it waits on its blockers; the call's own label replaces it. */
export const BLOCKED_LABEL = "entail:blocked";

/**
 * The post for something entail has to act on, or null for work that is not
 * a post (a judgment still to run). `repo` is the issue's repo, `owner/name`,
 * so a blocker there is named by its number alone.
 */
export function postFor(pending: Pending, owner: string, repo: string, baseBranch: string | null = null, filed: readonly FiledPart[] = []): Post | null {
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
        const scope = goScope(entry) ?? "implement";
        const go = scope === "plan" ? "**Go, for planning**" : "**Go**";
        const head = entry.owner.kind === "override" ? `${go}, by ${owner}, overriding entail's call on the board.` : `${go}, on ${owner}'s answer on the board.`;
        const reason = entry.owner.kind === "answer" && entry.call.call === "go" ? entry.call.reason : entry.owner.words;
        const criteria = entry.owner.call === "go" ? criteriaText(criteriaOf(entry.call), issue, scope, baseBranch) : "";
        const label = entry.owner.call === "go" ? goLabel(scope) : "entail:no";
        return { issue, markerFor: entry.id, text: join(head, escape(reason), scope === "plan" ? PLANNING_LINE : "", criteria), close: false, reopen: entry.owner.call === "go", label };
      }
      const waits = entry.confirm && entry.call.call !== "ask";
      const label = entry.call.call === "go" ? goLabel(scopeOf(entry.call)) : (`entail:${entry.call.call}` as const);
      const text = callText(entry.call, entry.confirm, owner, issue, baseBranch);
      return { issue, markerFor: entry.id, text: entry.recheck === undefined ? text : join(recheckText(entry.recheck, entry.call.call, owner), text), close: entry.call.call === "no" && !entry.confirm, reopen: false, label: waits ? null : label };
    }
    case "confirmed": {
      const { call, action } = pending;
      const called = call.call.call;
      const scope = goScope(call) ?? "implement";
      return {
        issue: call.issue.number,
        markerFor: action.id,
        text: called === "no" ? `${owner} confirmed this call on the board: no. Closing the issue as not planned.` : `${owner} confirmed this call on the board: ${scope === "plan" ? "go, for planning" : "go"}.`,
        close: called === "no",
        reopen: false,
        label: called === "no" ? "entail:no" : goLabel(scope),
      };
    }
    case "owner-no": {
      const { call, action } = pending;
      if (action.type === "answered" && action.parts !== undefined) {
        return { issue: call.issue.number, markerFor: action.id, text: partsText(owner, action.answer, action.parts, filed), close: true, reopen: false, label: "entail:no" };
      }
      const head = action.type === "overridden" ? `**No**, by ${owner}, overriding entail's call on the board.` : `**No**, on ${owner}'s answer on the board.`;
      const words = action.type === "overridden" ? action.reason : action.answer;
      return { issue: call.issue.number, markerFor: action.id, text: join(head, escape(words), "Closing the issue as not planned."), close: true, reopen: false, label: "entail:no" };
    }
    case "owner-go": {
      // Go, but differently: the owner's line is the criterion, word for word, in place of entail's.
      const { call, action } = pending;
      const scope = goScope(call) ?? "implement";
      const head = `${scope === "plan" ? "**Go, for planning**" : "**Go**"}, by ${owner}, keeping entail's go but not its criteria.`;
      const what = scope === "plan" ? "What the plan must do beyond solving the issue" : "What the PR must do beyond solving the issue";
      return {
        issue: call.issue.number,
        markerFor: action.id,
        text: join(head, scope === "plan" ? PLANNING_LINE : "", `${what}, in ${owner}'s words:\n\n- ${escape(action.reason).replace(/\n+/gu, " ")}\n- ${escape(linkCriterion(call.issue.number, baseBranch).criterion)}`),
        close: false,
        reopen: true,
        label: goLabel(scope),
      };
    }
  }
}

/** An issue filed for a part the owner accepted: its position among the accepted parts, and its number (null in a dry run, where none is filed). */
export interface FiledPart {
  index: number;
  number: number | null;
}

/**
 * What entail posts when the owner took only some of an issue's parts: that
 * the answer is theirs, the issue each accepted part was filed as, and the
 * parts turned down by name, then that the issue closes. The new issues are
 * named by number, which both forges turn into a link.
 */
export function partsText(owner: string, answer: string, parts: AnswerParts, filed: readonly FiledPart[]): string {
  const head = `**Some of it**, on ${owner}'s answer on the board: ${owner} took ${parts.accepted.length} of the ${parts.accepted.length + parts.declined.length} parts of this issue and turned down the rest.`;
  const taken = parts.accepted.map((part, index) => {
    const number = filed.find((one) => one.index === index)?.number ?? null;
    return `- ${number === null ? "(to be filed)" : `#${number}`} ${escape(part.title).replace(/\n+/gu, " ")}`;
  });
  const turned = parts.declined.map((title) => `- ${escape(title).replace(/\n+/gu, " ")}`);
  return join(
    head,
    escape(answer),
    `Taken, each filed as an issue of its own that entail judges like any other:\n\n${taken.join("\n")}`,
    turned.length === 0 ? "" : `Turned down:\n\n${turned.join("\n")}`,
    "Closing this issue: what was taken lives on in the issues above.",
  );
}

const PART_MARKER = /<!-- entail part (\d+)\.(\d+) -->/gu;

/** The hidden marker an issue filed for an accepted part ends with: the owner's answer (a log entry) and the part's position among the accepted. */
export function partMarker(action: number, index: number): string {
  return `<!-- entail part ${action}.${index} -->`;
}

/** The positions of the parts of the owner's answer `action` that an issue body marks as filed. */
export function markedParts(body: string, action: number): number[] {
  return [...body.matchAll(PART_MARKER)].filter((match) => Number(match[1]) === action).map((match) => Number(match[2]));
}

/**
 * The body an accepted part is filed with: a line saying where it came from
 * and whose answer took it, so its words never read as the owner's; the part
 * as the original issue wrote it; and the hidden marker. No line starts with
 * `/`, so none is an `/entail` mention or a quick action.
 */
export function partBody(owner: string, from: number, action: number, index: number, part: { title: string; body: string }): string {
  return join(`Filed by entail from #${from}, which lists several suggestions: ${owner} took this one on entail's board. It goes through entail's usual call like any issue.`, part.body, partMarker(action, index))
    .split("\n")
    .map((line) => line.replace(/^([ \t]*)\//u, "$1\\/"))
    .join("\n");
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
export function callText(call: IssueCall, confirm: boolean, owner: string, issue: number, baseBranch: string | null = null): string {
  if (call.call === "ask") {
    return `A question about this issue is waiting for ${owner} on entail's board. Nothing happens here until it is answered.`;
  }
  if (call.call === "no") {
    const tail = confirm ? `The issue closes once ${owner} confirms this call on entail's board.` : "Closing the issue as not planned.";
    return join(`**No.** ${escape(call.reason)}`, visionLinesText(call.restsOn.visionLines), call.ruling === undefined ? "" : rulingText(call.ruling), tail);
  }
  const scope = scopeOf(call);
  const head = `**${scope === "plan" ? "Go, for planning" : "Go"}.** ${escape(call.reason)}`;
  const tail = confirm ? `This call waits for ${owner} to confirm it on entail's board; nothing starts until then.` : "";
  return join(head, call.ruling === undefined ? "" : rulingText(call.ruling), scope === "plan" ? PLANNING_LINE : "", criteriaText(criteriaOf(call), issue, scope, baseBranch), tail);
}

/**
 * The board answers a ruling-settled call rests on, each under the name of
 * whoever gave it, with the ticket it settled and when. Only what each answer
 * decided is posted: the question and the owner's words stay on the board.
 */
export function rulingText(ruling: Ruling): string {
  const lines = ruling.answers.map((answer) => `- ${escape(answer.by)} answered ${outcomeWords(answer.outcome)} on #${answer.issue.number} (${answer.at.slice(0, 10)})`);
  return `It rests on these answers given on entail's board, not on a vision passage:\n\n${lines.join("\n")}\n\nA later answer that disagrees stops entail settling this kind of question itself.`;
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

/**
 * A go's criteria as posted: the model's, then the line on linking the PR,
 * which every go carries. A go for planning names them as what the plan must
 * do; a PR that closes the issue still has to be linked to it. In a repo with
 * a base branch set, the line also says to open the PR into it from a branch
 * named for the issue.
 */
function criteriaText(criteria: readonly Criterion[], issue: number, scope: GoScope = "implement", baseBranch: string | null = null): string {
  const lines = [...criteria, linkCriterion(issue, baseBranch)].map((criterion) => `- ${escape(criterion.criterion).replace(/\n+/gu, " ")}`);
  return `${scope === "plan" ? "What the plan must do beyond solving the issue" : "What the PR must do beyond solving the issue"}:\n\n${lines.join("\n")}`;
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
      // A PR with no cleared ticket behind it says so after its opening line, with the vision lines the call rests on.
      const ticketless = entry.issue === null;
      const behind = ticketless ? join(noTicketText(pullRequest), visionLinesText(call.restsOn.visionLines)) : "";
      const checklist = checklistText(call, ticketless);
      if (call.call === "merge") {
        if (entry.confirm) {
          return { ...base, merge: false, close: false, sentBack: false, text: () => join(`**Merge.** ${escape(call.reason)}`, behind, checklist, `This call waits for ${owner} to confirm it on entail's board; nothing is merged until then.`) };
        }
        return { ...base, merge: true, close: false, sentBack: false, text: (merge) => join(`**Merge.** ${escape(call.reason)}`, behind, checklist, mergeText(merge, entry.head)) };
      }
      if (call.call === "send-back") {
        const cancelling = entry.cancel
          ? entry.confirm
            ? `entail has sent this ${pullRequest} back ${entry.sendBacks} times before. It closes unmerged once ${owner} confirms this call on entail's board.`
            : `entail has sent this ${pullRequest} back ${entry.sendBacks} times before. Closing it unmerged.`
          : "entail judges it again on its next push.";
        return { ...base, merge: false, close: entry.cancel && !entry.confirm, sentBack: true, text: () => join(`**Send back.** ${escape(call.reason)}`, behind, needsText(call.needsToChange), checklist, cancelling) };
      }
      const asked = `A question about this ${pullRequest} is waiting for ${owner} on entail's board. Nothing is merged until it is answered.`;
      return { ...base, merge: false, close: false, sentBack: false, text: () => (ticketless ? join(asked, noTicketText(pullRequest)) : asked) };
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

/** The line a call on a PR with no cleared ticket behind it carries. */
function noTicketText(pullRequest: string): string {
  return `No cleared ticket is behind this ${pullRequest}, so entail judged it on the vision alone.`;
}

/** The criteria marked met or unmet, and what the PR does beyond them (or, with no ticket, what it does), as the comment shows them. */
function checklistText(call: LandingCall, ticketless = false): string {
  const parts: string[] = [];
  if (call.criteria.length > 0) {
    parts.push(`Criteria:\n\n${call.criteria.map((check) => `- ${check.met ? "Met" : "**Not met**"}: ${escape(check.criterion).replace(/\n+/gu, " ")}`).join("\n")}`);
  }
  if (call.beyond.length > 0) {
    const label = { needed: "Needed", harmless: "Harmless", unwanted: "**Unwanted**" } as const;
    parts.push(`${ticketless ? "What it does" : "Beyond the criteria"}:\n\n${call.beyond.map((item) => `- ${label[item.sort]}: ${escape(item.change).replace(/\n+/gu, " ")}`).join("\n")}`);
  }
  return parts.join("\n\n");
}
