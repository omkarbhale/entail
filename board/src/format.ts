import type { ActionView, Call, CallView, CriterionView, OwnerCallName, OwnerWordView } from "./api.ts";

/** A call as the board shows it: a go for planning is shown as plan, with its own tag. */
export type ShownCall = Call | "plan";

/** The call an item shows: plan for entail's go for planning, else the call itself. */
export function shownCall(item: Pick<CallView, "call" | "scope">): ShownCall {
  return item.call === "go" && item.scope === "plan" ? "plan" : item.call;
}

/** The call an owner's action or word made: plan for a go for planning. */
export function ownerCallOf(action: Pick<ActionView, "to" | "scope"> | null | undefined, fallback: OwnerCallName = "go"): OwnerCallName {
  const to = action?.to ?? fallback;
  return to === "go" && action?.scope === "plan" ? "plan" : to;
}

/** The call an owner's word a call was run on made: plan for a go for planning. */
function wordCall(word: OwnerWordView): OwnerCallName {
  return word.call === "go" && word.scope === "plan" ? "plan" : word.call;
}

/** The forge a repo lives on, as people say it: GitLab for a `gitlab:` name, else GitHub. */
export function forgeName(repo: string): string {
  return repo.startsWith("gitlab:") ? "GitLab" : "GitHub";
}

/** A repo's web page: `owner/name` on github.com, `gitlab:group/name` on gitlab.com, `github://host/owner/name` or `gitlab://host/group/name` on that host. */
export function repoHref(repo: string): string {
  if (repo.startsWith("github://")) return `https://${repo.slice("github://".length)}`;
  if (repo.startsWith("gitlab://")) return `https://${repo.slice("gitlab://".length)}`;
  return repo.startsWith("gitlab:") ? `https://gitlab.com/${repo.slice("gitlab:".length)}` : `https://github.com/${repo}`;
}

/** How long ago a time was, in the fewest words: "40s ago", "3 min ago", "2h ago", "2d ago". */
export function ago(iso: string | null | undefined, now: number = Date.now()): string {
  if (iso === null || iso === undefined) return "";
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** The time of day, as the owner's clock shows it. */
export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** A day of the log, `YYYY-MM-DD`, as a heading: Today, Yesterday, or "10 Nov". */
export function dayLabel(day: string, now: Date = new Date()): string {
  const today = localDay(now);
  const yesterday = localDay(new Date(now.getTime() - 86_400_000));
  if (day === today) return "Today";
  if (day === yesterday) return "Yesterday";
  const [year, month, date] = day.split("-").map(Number);
  const value = new Date(year!, month! - 1, date!);
  return value.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(year === now.getFullYear() ? {} : { year: "numeric" }) });
}

export function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function timeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

/** The repo's short name, as the board names it beside an item. */
export function shortName(repo: string): string {
  return repo.split("/").at(-1) || repo;
}

/** The number an item is known by: the PR's for a call on a PR, the issue's otherwise. */
export function refNumber(item: Pick<CallView, "issue" | "pr">): number {
  // Only a PR's call can have no issue.
  return item.pr?.number ?? item.issue!.number;
}

/** An item's key across calls: an issue or a PR judged again keeps it. */
export function issueKey(item: Pick<CallView, "repo" | "issue" | "pr">): string {
  return `${item.repo}#${refNumber(item)}`;
}

/** The thing a call is on, as the owner says it: "the issue" or "the PR". */
export function subject(item: Pick<CallView, "pr">): "issue" | "PR" {
  return item.pr === null ? "issue" : "PR";
}

/** What the call does, in plain words. */
export function callLabel(item: CallView): string {
  if (item.call === "ask") return item.question?.question ?? "A question for you";
  if (item.call === "go") return item.scope === "plan" ? "Go, for planning" : "Go ahead";
  if (item.call === "merge") return "Merge it";
  if (item.call === "send-back") return "Send it back";
  return item.restsOn.visionLines.length > 0 ? "Close it, quoting the vision" : "Close it with this reason";
}

/**
 * How big the change is: a go is never hard to undo (such a change is
 * asked); a go for planning is too large for one PR; a question says when it
 * is hard to undo.
 */
export function sizeLine(item: CallView): string {
  if (item.call === "go") return item.scope === "plan" ? "Too large for one PR · cleared for planning" : "Fits one PR · easy to undo";
  if (item.call === "ask" && item.question?.large === true) return "Hard to undo";
  return "";
}

export function confirmLabel(item: CallView): string {
  if (item.call === "merge") return `Confirm · merge #${refNumber(item)}`;
  if (item.call === "send-back") return `Confirm · send back #${refNumber(item)}`;
  const n = refNumber(item);
  if (item.call === "no") return `Confirm · close #${n}`;
  return item.scope === "plan" ? `Confirm · go for planning on #${n}` : `Confirm · go on #${n}`;
}

/** Where a criterion comes from, in words. */
export function sourceLabel(criterion: CriterionView, item: CallView): string {
  switch (criterion.source) {
    case "vision": {
      const line = item.restsOn.visionLines.find((candidate) => candidate.line !== null && criterion.basis.includes(candidate.text.replace(/^>\s*/u, "").slice(0, 40)));
      return line?.line ? `VISION.md:${line.line}` : "the vision";
    }
    case "reading":
      return "reading entail chose";
    case "edge":
      return "edge entail drew";
    case "answer":
      return "the owner's answer";
    case "owner":
      return "the repo's generic criteria";
  }
}

export type OverrideChoice = { key: string; to: OwnerCallName; differently: boolean; label: string; placeholder: string };

const NO_CHOICE: OverrideChoice = { key: "no", to: "no", differently: false, label: "No, close it", placeholder: "Why not? entail closes the issue with your reason." };
const DIFFERENTLY_CHOICE: OverrideChoice = { key: "differently", to: "go", differently: true, label: "Go, but differently", placeholder: "What should be different? It becomes the criterion." };
const PLAN_CHOICE: OverrideChoice = { key: "plan", to: "plan", differently: false, label: "Go, for planning", placeholder: "Why plan it? Your workflow writes the plan and files the smaller tickets." };

/**
 * The owner's calls that override entail's: the other calls of go, go for
 * planning and no, and for a go, a go made differently. An override to go is
 * a go to implement unless the owner picks planning.
 */
export function overrideChoices(item: CallView): OverrideChoice[] {
  if (item.call === "merge") return [{ key: "send-back", to: "send-back", differently: false, label: "Send it back", placeholder: "Why send it back? entail comments your reason on the PR." }];
  if (item.call === "send-back") return [{ key: "merge", to: "merge", differently: false, label: "Merge it", placeholder: "Why merge it? entail merges at the judged head and comments your reason." }];
  const effective = item.owner === null ? shownCall(item) : wordCall(item.owner);
  const go: OverrideChoice = { key: "go", to: "go", differently: false, label: "Go instead", placeholder: "Why go? entail posts your reason on the issue." };
  if (effective === "no") return [go, { ...PLAN_CHOICE, label: "Go, for planning, instead" }];
  if (effective === "plan") return [NO_CHOICE, { ...go, label: "Go to implement instead", placeholder: "Why implement it in one PR? entail posts your reason on the issue." }, DIFFERENTLY_CHOICE];
  return [NO_CHOICE, DIFFERENTLY_CHOICE, PLAN_CHOICE];
}

export type AnswerChoice = { key: string; to: OwnerCallName; label: string; note: string; lean: boolean; parts?: true };

/** The answers to a question, and what each does: on an issue, go, go for planning, or don't. */
export function answerChoices(item: CallView): AnswerChoice[] {
  const n = refNumber(item);
  if (item.pr !== null) {
    return [
      { key: "merge", to: "merge", label: "Merge it", note: `entail merges #${item.pr.number} at the head it judged, with your answer as the reason.`, lean: false },
      { key: "send-back", to: "send-back", label: "Send it back", note: `entail comments your answer on #${item.pr.number} as what needs to change.`, lean: false },
    ];
  }
  // A question asked only because the change is large carries the criteria a go would have: entail leans to go.
  const leansGo = item.question?.large === true && item.criteria.length > 0;
  const choices: AnswerChoice[] = [
    { key: "go", to: "go", label: "Go ahead", note: `entail runs the call on #${n} again with your answer as your word, and posts the go with its criteria.`, lean: leansGo },
    { key: "plan", to: "plan", label: "Go, for planning", note: `entail runs the call on #${n} again with your answer, and posts a go for planning: your workflow writes the plan and files the smaller tickets.`, lean: false },
    { key: "no", to: "no", label: "Don’t go ahead", note: `entail closes #${n} with your answer as the reason.`, lean: false },
  ];
  // An issue that lists several suggestions can be taken in part: one new issue for each part accepted.
  if (item.parts.length > 0) {
    choices.push({ key: "parts", to: "no", label: "Take only some of the parts", note: `entail files one new issue for each part you pick, and closes #${n} with links to them and the parts you turned down.`, lean: false, parts: true });
  }
  return choices;
}

/** What a receipt says the owner did, and what entail does when the window closes. */
export function receiptText(item: CallView, action: ActionView): { head: string; text: string; quote: string | null; call: OwnerCallName | null } {
  const n = refNumber(item);
  if (item.pr !== null) {
    if (action.type === "confirmed") {
      return { head: "Confirmed.", text: item.call === "merge" ? `entail merges #${n} at the head it judged.` : `entail sends #${n} back with what needs to change.`, quote: null, call: null };
    }
    const merge = action.to === "merge";
    if (action.type === "overridden") {
      return { head: "Overridden.", text: `${merge ? "Merge it" : "Send it back"}. It goes on the PR and into the case book.`, quote: action.reason ?? null, call: action.to ?? null };
    }
    return {
      head: "Answered.",
      text: merge ? `Merge it. entail merges #${n} at the head it judged.` : `Send it back. entail comments your answer on #${n}.`,
      quote: action.answer !== undefined && !/^(Merge it|Send it back)\.$/u.test(action.answer) ? action.answer : null,
      call: action.to ?? null,
    };
  }
  if (action.type === "confirmed") {
    return { head: "Confirmed.", text: item.call === "no" ? `entail closes #${n} with its reason.` : `#${n} is go; its criteria are on the issue.`, quote: null, call: null };
  }
  if (action.type === "overridden") {
    const to = ownerCallOf(action);
    const label = action.differently === true ? "Go, but differently" : to === "plan" ? "Go, for planning" : to === "go" ? "Go instead" : "No, close it";
    return { head: "Overridden.", text: `${label}. It goes on the issue and into the case book.`, quote: action.reason ?? null, call: action.to === undefined ? null : to };
  }
  if (action.parts !== undefined) {
    const total = action.parts.accepted.length + action.parts.declined.length;
    return {
      head: "Answered.",
      text: `Took ${action.parts.accepted.length} of ${total} parts. entail files an issue for each and closes #${n}, naming the ${action.parts.declined.length === 1 ? "part" : "parts"} turned down.`,
      quote: action.answer ?? null,
      call: "no",
    };
  }
  const to = ownerCallOf(action);
  const text =
    to === "plan"
      ? `Go, for planning. entail runs the call again with your answer and posts the go for planning on #${n}.`
      : to === "go"
        ? `Go ahead. entail runs the call again with your answer and posts the go on #${n}.`
        : `Don’t go ahead. entail closes #${n} with your answer as the reason.`;
  return {
    head: "Answered.",
    text,
    quote: action.answer !== undefined && !/^(Go ahead|Go, for planning|Don’t go ahead)\.$/u.test(action.answer) ? action.answer : null,
    call: action.to === undefined ? null : to,
  };
}
