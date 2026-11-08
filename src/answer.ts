import { BOARD_ITEM_VERSION, type BoardItemSnapshot, type BoardOption } from "./board-item.ts";
import { composeComment } from "./comment-rules.ts";
import { EXECUTOR_LINE, visionCheckSection } from "./intake-comment.ts";
import type { AnswerRecord, AnswerShape, BoardItemHistory, Store } from "./store.ts";
import type { TicketState } from "./ticket-states.ts";

/**
 * The owner's answer to a board item (spec §13 "One answer path", "Answer
 * shapes", "Answering"; ADR-0008, ADR-0012). The board form is the one path an
 * answer enters entail: no forge comment, chat or command line records one.
 *
 * "Review answer" records nothing: it shows the answer, whether the note is
 * private or shown, what happens next and the exact comment entail will post.
 * "Record answer as <owner> (final)" records it under the owner's display
 * name, with the time and the item version the form showed. What the answer
 * then does to the ticket is a call citing it, made after it is recorded; the
 * answer itself is not a call.
 */

/** The answer form's fields. The per-start token travels beside them in the server's own field. */
export const ANSWER_FIELDS = {
  item: "item",
  version: "version",
  answer: "answer",
  text: "text",
  note: "note",
  showNote: "show_note",
  step: "step",
} as const;

/** The form's steps: review the answer, record it as final, or go back to the form. */
export type AnswerStep = "review" | "record" | "back";

/** The warning an option carries when going ahead goes against a vision line (ADR-0012). It links nowhere. */
export const AGAINST_VISION_WARNING =
  "This goes against a vision line for this ticket only. The line stays as it is; to change the rule, edit VISION.md.";

/** What the owner filled in, exactly as the form sent it, so nothing they typed is lost on the way back. */
export interface AnswerDraft {
  /** `option:<id>`, `own-words` or `dont-go-ahead`; empty when nothing was chosen. */
  answer: string;
  text: string;
  note: string;
  showNote: boolean;
}

/** An answer as it would be recorded. */
export interface ChosenAnswer {
  shape: AnswerShape;
  optionId: string | null;
  text: string | null;
  note: string | null;
  showNoteOnIssue: boolean;
}

/** Reads the owner's draft from a posted form. */
export function draftFrom(form: URLSearchParams): AnswerDraft {
  return {
    answer: form.get(ANSWER_FIELDS.answer) ?? "",
    text: form.get(ANSWER_FIELDS.text) ?? "",
    note: form.get(ANSWER_FIELDS.note) ?? "",
    showNote: form.get(ANSWER_FIELDS.showNote) !== null,
  };
}

/** The step a posted form asks for; anything else is no step at all. */
export function stepFrom(form: URLSearchParams): AnswerStep | null {
  const step = form.get(ANSWER_FIELDS.step);
  return step === "review" || step === "record" || step === "back" ? step : null;
}

/** The item version a posted form showed, or null when it names none. */
export function versionFrom(form: URLSearchParams): number | null {
  const version = form.get(ANSWER_FIELDS.version);
  return version !== null && /^[1-9]\d{0,8}$/.test(version) ? Number(version) : null;
}

/** An item's current version: the one its snapshot carries. */
export function itemVersion(snapshot: Partial<BoardItemSnapshot>): number {
  return typeof snapshot.version === "number" ? snapshot.version : BOARD_ITEM_VERSION;
}

/**
 * The answer a draft gives, or what is missing from it. A note is kept only
 * when it has text, and is shown on the issue only when the owner ticked it.
 */
export function answerOf(draft: AnswerDraft, options: readonly BoardOption[]): { answer: ChosenAnswer } | { error: string } {
  const note = draft.note.trim() === "" ? null : draft.note.trim();
  const rest = { note, showNoteOnIssue: note !== null && draft.showNote };
  if (draft.answer.startsWith("option:")) {
    const id = draft.answer.slice("option:".length);
    if (!options.some((o) => o.id === id)) return { error: "That option is not one this item offers. Choose one of its options." };
    return { answer: { shape: "option", optionId: id, text: null, ...rest } };
  }
  if (draft.answer === "own-words") {
    const text = draft.text.trim();
    if (text === "") return { error: "Write your answer in your own words, or choose another way to answer." };
    return { answer: { shape: "own-words", optionId: null, text, ...rest } };
  }
  if (draft.answer === "dont-go-ahead") return { answer: { shape: "dont-go-ahead", optionId: null, text: null, ...rest } };
  return { error: "Choose how to answer: one of the options, your own words, or \"Don't go ahead\"." };
}

/** The option an answer chose, if it chose one. */
function chosenOption(answer: Pick<ChosenAnswer, "shape" | "optionId">, snapshot: Partial<BoardItemSnapshot>): BoardOption | null {
  if (answer.shape !== "option") return null;
  return snapshot.form?.options.find((o) => o.id === answer.optionId) ?? null;
}

/** Whether going ahead this way goes against a vision line, so it carries the warning. */
export function goesAgainstVisionLine(answer: Pick<ChosenAnswer, "shape" | "optionId">, snapshot: Partial<BoardItemSnapshot>): boolean {
  return chosenOption(answer, snapshot)?.againstVisionLine === true;
}

/** The answer in the owner's terms, as the review and receipt show it. */
export function answerWords(answer: Pick<ChosenAnswer, "shape" | "optionId" | "text">, snapshot: Partial<BoardItemSnapshot>): string {
  switch (answer.shape) {
    case "option": {
      const option = chosenOption(answer, snapshot);
      if (option === null) return `Option ${answer.optionId ?? ""}`;
      return option.title === option.reading ? option.reading : `${option.title}: ${option.reading}`;
    }
    case "own-words":
      return answer.text ?? "";
    case "dont-go-ahead":
      return "Don't go ahead.";
  }
}

/** What an answer does to its ticket: the state it moves to, and what happens next. */
export interface AnswerOutcome {
  state: TicketState;
  /** The ticket's new state in a few words. */
  stateWords: string;
  next: string[];
}

/**
 * What an answer does (spec §13 "After an answer", ADR-0008): going ahead
 * returns the ticket to deciding only to write criteria; "don't go ahead"
 * cancels it and closes the issue, as not planned on GitHub.
 */
export function answerOutcome(answer: Pick<ChosenAnswer, "shape" | "note" | "showNoteOnIssue">, forge: string | undefined): AnswerOutcome {
  const note =
    answer.note === null
      ? []
      : [answer.showNoteOnIssue ? "Your note is shown on the issue, in the comment below." : "Your note stays in entail's records, not on the issue."];
  if (answer.shape === "dont-go-ahead") {
    return {
      state: "cancelled",
      stateWords: "cancelled",
      next: [`entail cancels the ticket, comments on the issue and closes it${notPlanned(forge)}.`, "Nothing is taken forward.", ...note],
    };
  }
  return {
    state: "deciding",
    stateWords: "deciding, to write criteria",
    next: [
      "entail writes the criteria from your answer, without running the verdict again. They cite your answer, and the usual checks and challenge run.",
      "It then posts a new intake comment quoting your decision, with the criteria in place of the line marked below, and labels the issue entail:cleared.",
      "A product call your answer does not cover comes back as a new item for that call alone.",
      ...note,
    ],
  };
}

function notPlanned(forge: string | undefined): string {
  return forge === "github" ? " as not planned" : "";
}

/** Quotes the owner's text in a quote block, so no line of it starts with `/` or opens a hidden marker. */
function quoteBlock(text: string): string {
  return text
    .trim()
    .replace(/<!--/gu, "&lt;!--")
    .split(/\r\n|\r|\n/)
    .map((line) => (line.trim() === "" ? ">" : `> ${line}`))
    .join("\n");
}

/** The line in a going-ahead comment where the criteria go once they are written. */
export const CRITERIA_TO_COME =
  "The criteria C1…Cn follow here once entail has written them from this decision, each citing it, then the label `entail:cleared`.";

/** An answer as the issue quotes it, with whoever gave it once it is recorded. */
export type QuotedAnswer = Pick<ChosenAnswer, "shape" | "optionId" | "text" | "note" | "showNoteOnIssue"> & { answeredBy?: string };

/** An answer given on a ticket, with the board item it answered. */
export interface GivenAnswer {
  answer: AnswerRecord;
  snapshot: Partial<BoardItemSnapshot>;
}

/** Whether an answer lets its ticket go ahead: any answer but "don't go ahead" (ADR-0008). */
export function goesAhead(answer: Pick<ChosenAnswer, "shape">): boolean {
  return answer.shape !== "dont-go-ahead";
}

/**
 * The decision an answer quotes on the issue, attributed to the owner (spec
 * §9 "After an answer"): the chosen option or the owner's own words, and the
 * note only when the owner ticked "Show my note on the issue". A recorded
 * answer is attributed to whoever gave it; one under review, to `owner`.
 */
export function answerDecisionText(owner: string, answer: QuotedAnswer, snapshot: Partial<BoardItemSnapshot>, forge: string | undefined): string {
  const by = answer.answeredBy ?? owner;
  const parts: string[] = [];
  if (answer.shape === "dont-go-ahead") {
    parts.push(`${by} decided not to go ahead with this issue, so entail closes it${notPlanned(forge)} and nothing is taken forward.`);
  } else {
    parts.push(`${by} decided:`, "", quoteBlock(answerWords(answer, snapshot)));
    const option = chosenOption(answer, snapshot);
    if (option !== null) parts.push("", `What a user would observe: ${option.outcome.trim()}`);
  }
  if (answer.note !== null && answer.showNoteOnIssue) parts.push("", `A note from ${by}:`, "", quoteBlock(answer.note));
  return parts.join("\n");
}

/** What else a going-ahead comment carries once the criteria are written. */
export interface AnswerCommentParts {
  /** Earlier answers on the ticket that still go ahead, quoted before this one, oldest first. */
  earlier?: readonly GivenAnswer[];
  /** What follows the decision: the criteria once written; {@link CRITERIA_TO_COME} until then. */
  next?: string;
  /** The intake comment this one replaces, named first. */
  replaces?: string | null;
}

/**
 * The exact comment entail posts on the issue for an answer, attribution
 * line and hidden marker included. Going ahead, it is the next intake
 * comment: the item's vision check, then the decision (after any earlier
 * decision still in force on the ticket), then the criteria, which stand as
 * {@link CRITERIA_TO_COME} until they are written. "Don't go ahead" says the
 * issue is closed. A private note never appears in it.
 */
export function answerComment(
  owner: string,
  ticketId: number,
  answer: QuotedAnswer,
  snapshot: Partial<BoardItemSnapshot>,
  forge: string | undefined,
  more: AnswerCommentParts = {},
): string {
  const decision = answerDecisionText(owner, answer, snapshot, forge);
  if (answer.shape === "dont-go-ahead") return composeComment(owner, ticketId, decision);
  const decisions = [...(more.earlier ?? []).map((given) => answerDecisionText(owner, given.answer, given.snapshot, forge)), decision];
  const parts: string[] = [];
  if (more.replaces) parts.push(`This replaces [entail's earlier intake comment](${more.replaces}).`, "");
  if (snapshot.visionCheck !== undefined) parts.push(visionCheckSection(snapshot.visionCheck), "");
  parts.push("### What happens next", "", decisions.join("\n\n"), "", (more.next ?? CRITERIA_TO_COME).trim(), "", EXECUTOR_LINE);
  return composeComment(owner, ticketId, parts.join("\n"));
}

/** Why the form would not record an answer to an item, in words the page shows. */
export type AnswerRefusal =
  | { kind: "unknown" }
  | { kind: "withdrawn"; reason: string }
  | { kind: "answered"; answer: AnswerRecord }
  | { kind: "outdated"; shown: number | null; current: number }
  | { kind: "locked"; why: string }
  | { kind: "no-owner" };

/** The page's message for a refusal. */
export function refusalText(refusal: AnswerRefusal): string {
  switch (refusal.kind) {
    case "unknown":
      return "entail has no board item with this id, so nothing was recorded.";
    case "withdrawn":
      return `This item was withdrawn, so it takes no answer and yours was not recorded. ${refusal.reason}`.trim();
    case "answered":
      return `This item was already answered by ${refusal.answer.answeredBy}. Answers are final, so yours was not recorded.`;
    case "outdated":
      return refusal.shown === null
        ? "The form did not say which version of this item it showed, so nothing was recorded. Read the item again and answer it."
        : `This item changed since the page showed it: you answered version ${refusal.shown}, and it is now version ${refusal.current}. Nothing was recorded. Read the item again and answer it.`;
    case "locked":
      return `This item is locked, so nothing was recorded: ${refusal.why}`;
    case "no-owner":
      return "Your display name is not set, so entail cannot record whose answer this is. Set it on the settings page, then answer.";
  }
}

/**
 * Why an item takes no answer from a form that showed `shown`: it is unknown,
 * withdrawn, already answered, at a newer version than the form showed, or
 * locked. Null when it takes one.
 */
export function refusalFor(history: BoardItemHistory | null, shown: number | null, locked: string | null): AnswerRefusal | null {
  if (history === null) return { kind: "unknown" };
  if (history.answer !== null) return { kind: "answered", answer: history.answer };
  if (history.withdrawal !== null) return { kind: "withdrawn", reason: history.withdrawal.reason };
  const current = itemVersion((history.item.snapshot ?? {}) as Partial<BoardItemSnapshot>);
  if (shown !== current) return { kind: "outdated", shown, current };
  if (locked !== null) return { kind: "locked", why: locked };
  return null;
}

/**
 * Records the owner's answer to one board item, as the final step of the
 * board form. In one transaction it reads the item again and refuses an
 * answer to an item that is withdrawn, already answered or at another version
 * than the one the form showed; the store refuses a second answer too.
 */
export function recordBoardAnswer(
  store: Store,
  input: { itemId: number; shownVersion: number | null; answeredBy: string; answer: ChosenAnswer; locked: string | null },
): { recorded: AnswerRecord } | { refused: AnswerRefusal } {
  return store.transaction(() => {
    const refusal = refusalFor(store.boardItem(input.itemId), input.shownVersion, input.locked);
    if (refusal !== null) return { refused: refusal };
    const recorded = store.recordAnswer({
      boardItemId: input.itemId,
      itemVersion: input.shownVersion!,
      answeredBy: input.answeredBy,
      shape: input.answer.shape,
      optionId: input.answer.optionId,
      text: input.answer.text,
      note: input.answer.note,
      showNoteOnIssue: input.answer.showNoteOnIssue,
    });
    return { recorded };
  });
}
