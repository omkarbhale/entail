import { outcomeWords, type IssueCall, type KnownKind, type Ruling, type RulingAnswer, type RulingOutcome } from "./judgment.ts";
import { isHeld, undoneActions, type CallEntry, type Entry } from "./records.ts";

/**
 * Learned rulings. Once the same kind of question has been answered the same
 * way on the board enough times, entail settles that kind of question itself,
 * citing those answers where a call would otherwise cite a vision passage.
 *
 * A ruling only ever settles a call that would have gone to the owner as a
 * question; every other call is made, and comes out, exactly as it would
 * without rulings. Nothing here asks a model anything: the kind of a question
 * is named by the judgment that raised it, and everything below reads the
 * repo's own log.
 *
 * What a ruling never does:
 *
 * - It is never written into VISION.md, or anywhere else: it is derived from
 *   the log each time, so the answers it rests on are the whole of it.
 * - It never settles a question about a change that is large or hard to undo,
 *   or one that touches a pinned topic: those always reach the owner.
 * - It forms only from several consistent answers, and any answer to that kind
 *   of question that disagrees, before or after, stops it from being used.
 */

/** How many board answers of one kind, all the same way, earn a ruling. */
export const RULING_MIN_ANSWERS = 3;

/** The longest a kind's name is kept: a longer one is cut, so a runaway name still matches itself. */
const KIND_LENGTH = 60;

/**
 * A kind of question as the log keeps it: lowercase words joined with
 * hyphens, so the same kind named a little differently (case, spaces,
 * punctuation) is still the same kind. Empty when the name holds no word.
 */
export function normalizeKind(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, KIND_LENGTH)
    .replace(/-+$/u, "");
}

/** How a board answer settled a question; the way an answer or an override reads for a ruling. */
function outcomeOf(to: string, scope: string | undefined): RulingOutcome | null {
  if (to === "no") return "no";
  if (to === "go") return scope === "plan" ? "plan" : "go";
  return null;
}

/** An override of a call a ruling settled, to a different outcome: an answer that disagrees with the ruling. */
interface Disagreement {
  action: number;
  by: string;
  at: string;
  outcome: RulingOutcome;
}

interface KindHistory {
  /** Every call that asked this kind, so it is known even before it is answered. */
  asked: number;
  answers: RulingAnswer[];
  disagreements: Disagreement[];
}

/**
 * The repo's questions by kind, from its log: each kind the judgment has
 * asked, the board answers it has had, and the owner's overrides of calls a
 * ruling settled. An answer counts when it stands: not undone, and past its
 * undo window. An answer to a question about a change that is hard to undo
 * does not count, so it never earns a ruling a smaller change could ride on.
 */
function historyByKind(entries: readonly Entry[], now: Date): Map<string, KindHistory> {
  const undone = undoneActions(entries);
  const calls = new Map<number, CallEntry>();
  const kinds = new Map<string, KindHistory>();
  const of = (kind: string): KindHistory => {
    let history = kinds.get(kind);
    if (history === undefined) kinds.set(kind, (history = { asked: 0, answers: [], disagreements: [] }));
    return history;
  };
  for (const entry of entries) {
    if (entry.type === "call") {
      calls.set(entry.id, entry);
      if (entry.call.call === "ask" && entry.owner === null && normalizeKind(entry.call.kind ?? "") !== "") of(normalizeKind(entry.call.kind!)).asked++;
      continue;
    }
    if ((entry.type !== "answered" && entry.type !== "overridden") || undone.has(entry.id) || isHeld(entry, now)) continue;
    const call = calls.get(entry.call);
    if (call === undefined) continue;
    const outcome = outcomeOf(entry.to, entry.scope);
    if (outcome === null) continue;
    if (entry.type === "answered" && call.call.call === "ask" && !call.call.large) {
      const kind = normalizeKind(call.call.kind ?? "");
      if (kind === "") continue;
      of(kind).answers.push({
        action: entry.id,
        call: call.id,
        issue: { number: call.issue.number, title: call.issue.title, url: call.issue.url },
        by: entry.by,
        at: entry.at,
        outcome,
        words: entry.answer,
      });
    } else if (entry.type === "overridden" && (call.call.call === "go" || call.call.call === "no") && call.call.ruling !== undefined) {
      const ruled = call.call.ruling;
      if (outcome !== ruled.outcome) of(normalizeKind(ruled.kind)).disagreements.push({ action: entry.id, by: entry.by, at: entry.at, outcome });
    }
  }
  return kinds;
}

/** The outcome every answer of a kind agrees on; null when there are none or they differ. */
function agreed(history: KindHistory): RulingOutcome | null {
  const outcomes = new Set([...history.answers.map((answer) => answer.outcome), ...history.disagreements.map((one) => one.outcome)]);
  return outcomes.size === 1 ? [...outcomes][0]! : null;
}

/** The kinds of question the repo has asked, newest first and at most `limit`, for the judgment to name a new question's kind by. */
export function knownKinds(entries: readonly Entry[], now: Date, limit = 40): KnownKind[] {
  return [...historyByKind(entries, now)]
    .map(([kind, history]) => ({ kind, answers: history.answers.length, outcome: history.answers.length === 0 ? null : agreed(history) }))
    .slice(-limit)
    .reverse();
}

/** Whether a kind of question has earned a ruling, and if not, why. */
export type RulingStanding =
  | { earned: true; outcome: RulingOutcome; answers: RulingAnswer[] }
  | { earned: false; why: string };

/** Whether `kind` has earned a ruling in this log: enough answers, all the same way, and nothing that disagrees. */
export function rulingFor(entries: readonly Entry[], kind: string, now: Date): RulingStanding {
  const history = historyByKind(entries, now).get(normalizeKind(kind));
  if (history === undefined || history.answers.length === 0) return { earned: false, why: "no board answer to this kind of question yet" };
  const outcome = agreed(history);
  if (outcome === null) {
    return { earned: false, why: `answers to this kind of question disagree (${[...new Set([...history.answers, ...history.disagreements].map((one) => one.outcome))].join(", ")})` };
  }
  if (history.answers.length < RULING_MIN_ANSWERS) {
    return { earned: false, why: `${history.answers.length} of the ${RULING_MIN_ANSWERS} consistent answers a ruling needs` };
  }
  return { earned: true, outcome, answers: history.answers };
}

/** The pinned topics a text mentions, matched as words in it ignoring case: a literal match, on top of what the judgment itself weighs. */
export function pinsTouched(pins: readonly string[], ...texts: string[]): string[] {
  const text = texts.join("\n").toLowerCase();
  return pins.filter((pin) => pin.trim() !== "" && text.includes(pin.trim().toLowerCase()));
}

/** What came of trying to settle a call by a ruling. */
export interface Settlement {
  call: IssueCall;
  /** Set when a ruling settled the call. */
  ruling: Ruling | null;
  /** Why a call that would have gone to the owner was not settled by a ruling; null for a call a ruling never considered. */
  notSettled: string | null;
}

export interface SettleContext {
  entries: readonly Entry[];
  /** The issue as the judgment read it, searched with the question for pinned topics. */
  issueText: string;
  pins: readonly string[];
  now: Date;
}

/**
 * The reason a ruling-settled call carries, in words posted on the issue: the
 * kind, how many answers it rests on and how they went. The answers are cited
 * by name beside it; their words and the question stay on the board.
 */
export function rulingReason(kind: string, outcome: RulingOutcome, answers: readonly RulingAnswer[]): string {
  const people = [...new Set(answers.map((answer) => answer.by))];
  const by = people.length === 1 ? `, all by ${people[0]}` : "";
  return `This is a kind of question the board has settled before ("${kind}"): ${answers.length} answers to it, all ${outcomeWords(outcome)}${by}, and none the other way. entail settles it the same way here, as a ruling those answers earned, instead of asking again.`;
}

/**
 * Settles a call by a learned ruling when one is earned, and otherwise
 * returns it untouched. Only an ask is ever considered, and an ask about a
 * large or hard-to-undo change, or one that touches a pinned topic, is never
 * settled: it goes to the owner as it would without rulings. A go the ruling
 * settles carries the criteria the ask carried; a no closes the issue with the
 * ruling's reason. Either cites the answers, not a vision passage.
 */
export function settleByRuling(call: IssueCall, context: SettleContext): Settlement {
  if (call.call !== "ask") return { call, ruling: null, notSettled: null };
  const kind = normalizeKind(call.kind ?? "");
  if (kind === "") return { call, ruling: null, notSettled: "the question was named no kind" };
  if (call.large) return { call, ruling: null, notSettled: "the change is large or hard to undo, so the owner decides" };
  const touched = pinsTouched(context.pins, context.issueText, call.question, call.why);
  if (touched.length > 0) return { call, ruling: null, notSettled: `it touches a pinned topic (${touched.join(", ")}), so the owner decides` };
  const standing = rulingFor(context.entries, kind, context.now);
  if (!standing.earned) return { call, ruling: null, notSettled: standing.why };
  const ruling: Ruling = { kind, outcome: standing.outcome, answers: standing.answers, asked: { question: call.question, why: call.why, reason: call.reason } };
  const reason = rulingReason(kind, standing.outcome, standing.answers);
  const restsOn = { visionLines: [], cases: [] };
  if (standing.outcome === "no") return { call: { call: "no", reason, restsOn, ruling }, ruling, notSettled: null };
  return { call: { call: "go", reason, restsOn, criteria: call.criteria, scope: standing.outcome === "plan" ? "plan" : "implement", ruling }, ruling, notSettled: null };
}
