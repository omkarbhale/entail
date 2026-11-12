import type { ActionView, CallView, CriterionView, OwnerCallName } from "./api.ts";

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
  return repo.split("/")[1] ?? repo;
}

/** The number an item is known by: the PR's for a call on a PR, the issue's otherwise. */
export function refNumber(item: Pick<CallView, "issue" | "pr">): number {
  return item.pr?.number ?? item.issue.number;
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
  if (item.call === "go") return "Go ahead";
  if (item.call === "merge") return "Merge it";
  if (item.call === "send-back") return "Send it back";
  return item.restsOn.visionLines.length > 0 ? "Close it, quoting the vision" : "Close it with this reason";
}

/** How big the change is: a go is never large (a large one is asked), a question says when it is. */
export function sizeLine(item: CallView): string {
  if (item.call === "go") return "Small · easy to undo";
  if (item.call === "ask" && item.question?.large === true) return "Large or hard to undo";
  return "";
}

export function confirmLabel(item: CallView): string {
  if (item.call === "merge") return `Confirm · merge #${refNumber(item)}`;
  if (item.call === "send-back") return `Confirm · send back #${refNumber(item)}`;
  return item.call === "no" ? `Confirm · close #${item.issue.number}` : `Confirm · go on #${item.issue.number}`;
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
  }
}

export type OverrideChoice = { key: string; to: OwnerCallName; differently: boolean; label: string; placeholder: string };

/** The owner's calls that override entail's: the opposite call, and for a go, a go made differently. */
export function overrideChoices(item: CallView): OverrideChoice[] {
  if (item.call === "merge") return [{ key: "send-back", to: "send-back", differently: false, label: "Send it back", placeholder: "Why send it back? entail comments your reason on the PR." }];
  if (item.call === "send-back") return [{ key: "merge", to: "merge", differently: false, label: "Merge it", placeholder: "Why merge it? entail merges at the judged head and comments your reason." }];
  const effective = item.owner?.call ?? item.call;
  if (effective === "no") return [{ key: "go", to: "go", differently: false, label: "Go instead", placeholder: "Why go? entail posts your reason on the issue." }];
  return [
    { key: "no", to: "no", differently: false, label: "No, close it", placeholder: "Why not? entail closes the issue with your reason." },
    { key: "differently", to: "go", differently: true, label: "Go, but differently", placeholder: "What should be different? It becomes the criterion." },
  ];
}

export type AnswerChoice = { to: OwnerCallName; label: string; note: string; lean: boolean };

/** The two answers to a question, and what each does. */
export function answerChoices(item: CallView): AnswerChoice[] {
  const n = item.issue.number;
  if (item.pr !== null) {
    return [
      { to: "merge", label: "Merge it", note: `entail merges #${item.pr.number} at the head it judged, with your answer as the reason.`, lean: false },
      { to: "send-back", label: "Send it back", note: `entail comments your answer on #${item.pr.number} as what needs to change.`, lean: false },
    ];
  }
  // A question asked only because the change is large carries the criteria a go would have: entail leans to go.
  const leansGo = item.question?.large === true && item.criteria.length > 0;
  return [
    { to: "go", label: "Go ahead", note: `entail runs the call on #${n} again with your answer as your word, and posts the go with its criteria.`, lean: leansGo },
    { to: "no", label: "Don’t go ahead", note: `entail closes #${n} with your answer as the reason.`, lean: false },
  ];
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
    const label = action.differently === true ? "Go, but differently" : action.to === "go" ? "Go instead" : "No, close it";
    return { head: "Overridden.", text: `${label}. It goes on the issue and into the case book.`, quote: action.reason ?? null, call: action.to ?? null };
  }
  const go = action.to === "go";
  return {
    head: "Answered.",
    text: go ? `Go ahead. entail runs the call again with your answer and posts the go on #${n}.` : `Don’t go ahead. entail closes #${n} with your answer as the reason.`,
    quote: action.answer !== undefined && !/^(Go ahead|Don’t go ahead)\.$/u.test(action.answer) ? action.answer : null,
    call: action.to ?? null,
  };
}
