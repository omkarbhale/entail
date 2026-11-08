import { challengePins, objectionText, type RecordedChallenge } from "./challenge.ts";
import { composeComment } from "./comment-rules.ts";
import type { CriteriaDetail } from "./criteria.ts";
import type { RecordedVerdict } from "./decider.ts";
import type { Actor } from "./forge/forge.ts";
import type { Git } from "./git.ts";
import { readGlobalSettings } from "./global-settings.ts";
import type { IntakeDetail } from "./intake.ts";
import { intakeCommentText, raisedNextText, shortSha, visionCheckOf, type VisionCheck, type VisionCheckMark } from "./intake-comment.ts";
import { forgeRemote, Mirror } from "./mirror.ts";
import { makeNotice, type Notifier } from "./notice.ts";
import type { OperationalLog } from "./operational-log.ts";
import type { OwedStep, OwedStepPlanner, RepoPass } from "./pass.ts";
import type { BoardItemRecord, CallKind, CallRecord, JudgedInputs, RepoRecord, Store, TicketRecord } from "./store.ts";
import type { VerdictChecks } from "./verdict-checks.ts";
import { readVision, VISION_PATH, visionLinesOf } from "./vision.ts";

/**
 * Raising a ticket to the board (spec §13, §9, ADR-0007, ADR-0008, ADR-0012,
 * ADR-0017): when a ticket needs the owner, entail records one board item, a
 * snapshot with live links, posts the intake comment linking the board, and
 * sends one `board-item` notice. The ticket moves to on the board.
 */

/**
 * The version of a board item as raised. The board form submits the version
 * it showed, and entail refuses an answer to an older one (ADR-0012).
 */
export const BOARD_ITEM_VERSION = 1;

/** The board page's path on the local server: its root, where the board's links point (ADR-0012). */
export const BOARD_PATH = "/";
/** The page with one ticket's whole history (spec §14). */
export const TICKET_PATH = "/ticket";

/** The live link to one board item on the board page. */
export function boardItemLink(origin: string, itemId: number): string {
  return new URL(`${BOARD_PATH}?item=${itemId}`, origin).href;
}

/** The live link to one ticket's history. */
export function ticketHistoryLink(origin: string, ticketId: number): string {
  return new URL(`${TICKET_PATH}?id=${ticketId}`, origin).href;
}

/**
 * Why a ticket was raised (spec §6, §7, §13): it contradicts a vision line, it
 * has consequential readings, it touches a pin, an automatic verdict failed a
 * mechanical check or its challenge, or writing its criteria needs a product
 * call. A touched pin is named whatever the reason, because a touched pin
 * always comes to the owner.
 */
export type WhyRaisedKind = "contradiction" | "consequential_readings" | "pin" | "failed_check" | "challenge" | "criteria_product_call";

export interface TouchedPin {
  /** The pin's topic, by which the owner named it. */
  pin: string;
  why: string;
}

export type WhyRaisedInput =
  | { kind: "contradiction" | "consequential_readings" | "pin"; pins?: TouchedPin[] }
  | { kind: "failed_check"; check: string; failure: string; pins?: TouchedPin[] }
  | { kind: "challenge"; objection: string; pins?: TouchedPin[] }
  | { kind: "criteria_product_call"; reason: string; pins?: TouchedPin[] };

/** The second part of a board item: why it was raised, in plain words, with what it rests on. */
export interface WhyRaised {
  kind: WhyRaisedKind;
  /** The list's short tag: contradicts a line, consequential readings, a pin by name, or a failed check. */
  tag: string;
  text: string;
  /** Every touched pin, by name. */
  pins: TouchedPin[];
  /** The contradicted lines, word for word at the vision's commit. */
  contradicted: string[];
  /** The failed mechanical check, by name, with how it failed. */
  failedCheck: { check: string; failure: string } | null;
  /** The challenge's objection. */
  objection: string | null;
  /** What writing the criteria found users could observe that no source chooses. */
  productCall?: string | null;
}

/** One reading of the ticket, with the outcome a user would observe. */
export interface Reading {
  id: string;
  reading: string;
  observed_outcome: string;
}

/** One way to go ahead the board form offers (spec §13 "Answer shapes"). */
export interface BoardOption {
  /** The reading's id. */
  id: string;
  /** "Go ahead as read" when there is one reading; the reading itself otherwise. */
  title: string;
  reading: string;
  /** The outcome a user would observe. */
  outcome: string;
  /** Going ahead this way goes against a vision line, for this ticket only. */
  againstVisionLine: boolean;
}

/** One call in what happened, newest first. */
export interface HappenedCall {
  ticketId: number;
  callId: number;
  kind: CallKind;
  madeAt: string;
  reason: string;
  stateChange: { from: string; to: string } | null;
}

/** An answer given on this ticket or its predecessors. The owner's private note is never part of it. */
export interface HappenedAnswer {
  ticketId: number;
  boardItemId: number;
  decision: string;
  answeredAt: string;
  answeredBy: string;
  shape: string;
  optionId: string | null;
  text: string | null;
}

/**
 * A board item as raised: a snapshot taken when it is raised, with live
 * links, holding its parts in the order spec §13 lists them, under its
 * version number.
 */
export interface BoardItemSnapshot {
  version: number;
  /** 1. The decision, one sentence, as the heading. */
  decision: string;
  /** 2. Why it was raised. */
  why: WhyRaised;
  /** 3. The vision check, quoting only bearing lines at the vision's commit. */
  visionCheck: VisionCheck;
  /** 4. What the ticket was: its issue's title and link, who filed it, and its text quoted as the reporter's request. */
  ticket: {
    repo: { forge: string; host: string; path: string };
    issue: { number: number; title: string; url: string };
    filedBy: Actor | null;
    /** The issue's text, the reporter's request: never the owner's word (ADR-0001). */
    request: string;
  };
  /** 5. What happened: the calls so far, newest first, with a link to the ticket's history. */
  happened: {
    calls: HappenedCall[];
    answers: HappenedAnswer[];
    historyLink: string;
  };
  /** 6. The answer form: the options. Answering in the owner's own words and "don't go ahead" are always offered. */
  form: { options: BoardOption[] };
}

/** The parts of a board item, in the order spec §13 lists them. */
export const BOARD_ITEM_PARTS = ["decision", "why", "visionCheck", "ticket", "happened", "form"] as const;

/** What a raise rests on: the judgment that the ticket needs the owner. */
export interface RaiseRequest {
  ticket: TicketRecord;
  why: WhyRaisedInput;
  /** The commit whose VISION.md was judged. */
  visionCommit: string;
  /** The judgment's vision check: each bearing line as quoted, with its mark. */
  marked: readonly { line: string; mark: VisionCheckMark }[];
  readings: readonly Reading[];
  /** The readings left open; all readings when none is named. */
  openReadings: readonly string[];
  /** The inputs the judgment read, recorded again on the call that raises it. */
  inputs: JudgedInputs | null;
  /** The call the raise rests on, such as the verdict. */
  basedOnCallId: number;
}

/** Where raising reads the vision: a git mirror of the repo. */
export interface BoardMirror {
  readonly git: Git;
}

export interface BoardOptions {
  store: Store;
  log: OperationalLog;
  dataDirectory: string;
  notifier: Notifier;
  /** `http://127.0.0.1:<port>`: the origin the board's links are posted with. */
  boardOrigin: string;
  /** The repo's mirror; its git mirror in the data directory by default. */
  mirrorFor?: (repo: RepoRecord) => Promise<BoardMirror>;
}

/** The call kinds whose comments are intake comments, so a later one names the one it replaces. */
const INTAKE_COMMENT_KINDS: ReadonlySet<CallKind> = new Set<CallKind>(["raise", "investigation", "criteria", "recheck"]);

/**
 * Whether a verdict call leaves the ticket needing the owner: its verdict
 * needs the owner, or an automatic verdict failed a mechanical check or its
 * challenge overturned it (spec §6).
 */
export function verdictNeedsTheOwner(call: Pick<CallRecord, "detail" | "checks" | "challenge">): boolean {
  if ((call.detail as Partial<RecordedVerdict> | null)?.verdict === "needs_the_owner") return true;
  if ((call.checks as Partial<VerdictChecks> | null)?.passed === false) return true;
  return (call.challenge as Partial<RecordedChallenge> | null)?.overturned === true;
}

/**
 * Whether a criteria call leaves the ticket needing the owner: writing the
 * criteria needs a product call, or the challenge over the verdict and the
 * criteria overturned them (spec §7).
 */
export function criteriaNeedTheOwner(call: Pick<CallRecord, "detail" | "challenge" | "stateChange">): boolean {
  if (call.stateChange !== null) return false;
  if ((call.detail as Partial<CriteriaDetail> | null)?.outcome === "needs_product_call") return true;
  return (call.challenge as Partial<RecordedChallenge> | null)?.overturned === true;
}

/**
 * The call a ticket is owed a raise for: the ticket is deciding, and the
 * latest verdict or criteria call since it last changed state needs the
 * owner, with no raise recorded after it. Null when it owes none.
 */
export function owedRaise(ticket: TicketRecord, calls: readonly CallRecord[]): CallRecord | null {
  if (ticket.state !== "deciding") return null;
  const since = ticket.stateCallId ?? 0;
  const latest = calls.findLast((call) => call.id > since && (call.kind === "verdict" || call.kind === "criteria"));
  if (latest === undefined) return null;
  if (!(latest.kind === "verdict" ? verdictNeedsTheOwner(latest) : criteriaNeedTheOwner(latest))) return null;
  if (calls.some((call) => call.id > latest.id && call.kind === "raise")) return null;
  return latest;
}

/** The raise a verdict or criteria call asks for; `calls` are the ticket's, holding the verdict a criteria call rests on. */
export function raiseFromCall(ticket: TicketRecord, call: CallRecord, calls: readonly CallRecord[]): RaiseRequest {
  return call.kind === "criteria" ? raiseFromCriteria(ticket, call, calls) : raiseFromVerdict(ticket, call);
}

/**
 * The raise a criteria call asks for (spec §7): writing the criteria needs a
 * product call, with the open choice as the options; or the challenge over
 * the verdict and the criteria overturned them, with the objection.
 *
 * Criteria written from the owner's answer raise a new item for the call the
 * answer does not cover alone (ADR-0008): it offers only that open choice,
 * never the readings the owner already chose between, and names no pin the
 * owner has seen for the ticket.
 */
export function raiseFromCriteria(ticket: TicketRecord, call: CallRecord, calls: readonly CallRecord[]): RaiseRequest {
  const detail = call.detail as CriteriaDetail;
  const verdictCall = calls.find((c) => c.id === detail.verdictCallId);
  if (verdictCall === undefined) throw new Error(`criteria call ${call.id} rests on verdict call ${detail.verdictCallId}, which is not the ticket's`);
  const verdict = verdictCall.detail as RecordedVerdict;
  const challenge = call.challenge as RecordedChallenge | null;
  const answered = detail.goAheadCallId !== undefined && detail.goAheadCallId !== null;
  const seen = new Set(detail.pinsSeen ?? []);
  const pins = touchedPins(verdict).filter((pin) => !seen.has(pin.pin.trim()));
  const raise = {
    ticket,
    visionCommit: verdict.vision_sha,
    marked: verdict.vision_check,
    inputs: call.inputs,
    basedOnCallId: call.id,
  };
  if (detail.outcome === "needs_product_call" && detail.product_call !== null) {
    return {
      ...raise,
      why: { kind: "criteria_product_call", reason: detail.product_call.reason, pins },
      readings: detail.product_call.options.map((option, i) => ({ id: `R${i + 1}`, ...option })),
      openReadings: [],
    };
  }
  return challengeRaise(raise, answered ? { ...verdict, readings: [] } : verdict, challenge!, pins);
}

/** A raise for a challenge that overturned an automatic verdict, or the verdict and its criteria. */
function challengeRaise(
  raise: Omit<RaiseRequest, "why" | "readings" | "openReadings">,
  verdict: RecordedVerdict,
  challenge: RecordedChallenge,
  pins: TouchedPin[],
): RaiseRequest {
  // A reading the decider missed is offered beside its own.
  const missed = challenge.objections.flatMap((objection) => (objection.reading === null ? [] : [objection.reading]));
  const readings = [...verdict.readings, ...missed.map((reading, i) => ({ id: `R${verdict.readings.length + i + 1}`, ...reading }))];
  const challenged = challengePins(challenge).filter((pin) => !pins.some((p) => p.pin === pin.pin));
  return {
    ...raise,
    why: { kind: "challenge", objection: objectionText(challenge), pins: [...pins, ...challenged] },
    readings,
    openReadings: [],
  };
}

/**
 * The raise a verdict call asks for: a needs-the-owner verdict with its own
 * reason; an automatic verdict that failed a mechanical check, with the
 * failure; or one its challenge overturned, with the objection.
 */
export function raiseFromVerdict(ticket: TicketRecord, call: CallRecord): RaiseRequest {
  const verdict = call.detail as RecordedVerdict;
  const checks = call.checks as VerdictChecks | null;
  const challenge = call.challenge as RecordedChallenge | null;
  const pins = touchedPins(verdict);
  const raise = {
    ticket,
    visionCommit: verdict.vision_sha,
    marked: verdict.vision_check,
    inputs: call.inputs,
    basedOnCallId: call.id,
  };
  if (verdict.verdict !== "needs_the_owner" && checks?.passed === false) {
    const failed = checks.results.filter((result) => !result.passed);
    const failure = failed.map((result) => result.failure ?? "").join(" ").trim();
    return {
      ...raise,
      why: { kind: "failed_check", check: failed[0]?.check ?? "a mechanical check", failure, pins },
      readings: verdict.readings,
      openReadings: checks.open_readings ?? [],
    };
  }
  if (verdict.verdict !== "needs_the_owner" && challenge?.overturned === true) return challengeRaise(raise, verdict, challenge, pins);
  const contradicts = verdict.vision_check.some((line) => line.mark === "contradicts");
  const kind = verdict.why_raised ?? (pins.length > 0 ? "pin" : contradicts ? "contradiction" : "consequential_readings");
  return { ...raise, why: { kind, pins }, readings: verdict.readings, openReadings: verdict.open_readings };
}

/**
 * Every pin a verdict found touched: the model's judgment, then entail's own
 * keyword and path matching, which counts whatever the model judged (spec §6).
 */
export function touchedPins(verdict: Pick<RecordedVerdict, "pins_touched" | "pin_matches">): TouchedPin[] {
  const pins = new Map<string, string[]>();
  const add = (pin: string, why: string) => {
    const whys = pins.get(pin) ?? [];
    if (!whys.includes(why)) whys.push(why);
    pins.set(pin, whys);
  };
  for (const touched of verdict.pins_touched) add(touched.pin, touched.why);
  for (const match of verdict.pin_matches ?? []) {
    add(match.pin, match.by === "keyword" ? `the issue names its keyword "${match.keyword}"` : `the issue names ${match.path}, which its path ${match.glob} matches`);
  }
  return [...pins].map(([pin, whys]) => ({ pin, why: whys.join("; ") }));
}

/** Quotes text as a board item or comment shows it. */
function quoted(text: string): string {
  return `“${text.trim()}”`;
}

/** The pins as one phrase: “a”, “a” and “b”, or “a”, “b” and “c”. */
function pinNames(pins: readonly TouchedPin[]): string {
  const names = pins.map((p) => quoted(p.pin));
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * The decision, one sentence. It names the issue by number and quotes only
 * the owner's words, vision lines and pins, never the issue's text.
 */
export function decisionSentence(issueNumber: number, why: WhyRaised): string {
  const issue = `issue #${issueNumber}`;
  switch (why.kind) {
    case "contradiction":
      return why.contradicted.length === 1
        ? `Go ahead with ${issue}, although it contradicts the vision line ${quoted(why.contradicted[0]!)}?`
        : `Go ahead with ${issue}, although it contradicts ${why.contradicted.length === 0 ? "a vision line" : "vision lines"}?`;
    case "pin":
      return `Go ahead with ${issue}, which touches the pin ${pinNames(why.pins)}?`;
    case "consequential_readings":
      return `Which reading of ${issue} should go ahead?`;
    case "failed_check":
    case "challenge":
      return `Go ahead with ${issue}, which entail could not clear on its own?`;
    case "criteria_product_call":
      return `How should ${issue} go ahead, where its criteria need a product call?`;
  }
}

/** Why a ticket was raised, in plain words, with what it rests on (spec §13 part 2). */
export function whyRaised(input: WhyRaisedInput, check: VisionCheck): WhyRaised {
  const pins = input.pins ?? [];
  const contradicted = check.lines.filter((line) => line.mark === "contradicts").map((line) => line.text);
  const unquoted = check.unquotable.filter((line) => line.mark === "contradicts").map((line) => line.line);
  const pinText = pins.map((p) => `It touches the pin ${quoted(p.pin)}: ${p.why.trim()}.`).join(" ");
  const pinsAlso = pins.length > 0 ? ` ${pinText} A touched pin always comes to the owner.` : "";
  let text: string;
  let tag: string;
  switch (input.kind) {
    case "contradiction": {
      tag = "contradicts a line";
      const lines = contradicted.map(quoted).join(" and ");
      text =
        contradicted.length > 0
          ? `The issue contradicts the vision line${contradicted.length === 1 ? "" : "s"} ${lines}. Going ahead would go against ${contradicted.length === 1 ? "it" : "them"} for this ticket only.`
          : "The decider found that the issue contradicts a vision line.";
      if (unquoted.length > 0) {
        text += ` The decider also quoted ${unquoted.map(quoted).join(" and ")}, which is not word for word in ${VISION_PATH} at ${shortSha(check.commit)}.`;
      }
      text += pinsAlso;
      break;
    }
    case "consequential_readings":
      tag = "consequential readings";
      text =
        "The issue can be read in ways whose outcomes for users differ, a vision line or pin bears on that difference, and nothing in the vision chooses between them." +
        pinsAlso;
      break;
    case "pin":
      tag = pins.length > 0 ? `pin: ${pins.map((p) => p.pin).join(", ")}` : "pin";
      text = pins.length > 0 ? `${pinText} A touched pin always comes to the owner.` : "The issue touches a pin, and a touched pin always comes to the owner.";
      break;
    case "failed_check":
      tag = "failed check";
      text = `entail could not clear the ticket on its own: the check ${quoted(input.check)} failed. ${input.failure.trim()}`.trim() + pinsAlso;
      break;
    case "challenge":
      tag = "failed check";
      text = `The challenge overturned the automatic verdict: ${input.objection.trim()}` + pinsAlso;
      break;
    case "criteria_product_call":
      tag = "criteria need a product call";
      text = `Writing the criteria needs a product call: ${input.reason.trim()}`.trim() + pinsAlso;
      break;
  }
  return {
    kind: input.kind,
    tag,
    text,
    pins,
    contradicted,
    failedCheck: input.kind === "failed_check" ? { check: input.check, failure: input.failure } : null,
    objection: input.kind === "challenge" ? input.objection : null,
    productCall: input.kind === "criteria_product_call" ? input.reason : null,
  };
}

/**
 * The options the form offers: each open reading with the outcome a user
 * would observe, or "go ahead as read" when there is one. With no reading
 * named open, every reading is offered.
 */
export function boardOptions(readings: readonly Reading[], openReadings: readonly string[], check: VisionCheck): BoardOption[] {
  const open = openReadings.length > 0 ? readings.filter((r) => openReadings.includes(r.id)) : [...readings];
  const against = check.lines.some((line) => line.mark === "contradicts");
  return open.map((r) => ({
    id: r.id,
    title: open.length === 1 ? "Go ahead as read" : r.reading,
    reading: r.reading,
    outcome: r.observed_outcome,
    againstVisionLine: against,
  }));
}

/** The calls so far on a ticket and every ticket before it, newest first, with any answers given on them (ADR-0020). */
function happened(store: Store, ticket: TicketRecord): { calls: HappenedCall[]; answers: HappenedAnswer[] } {
  const calls: HappenedCall[] = [];
  const answers: HappenedAnswer[] = [];
  for (let current: TicketRecord | null = ticket; current !== null; current = current.predecessorId === null ? null : store.getTicket(current.predecessorId)) {
    for (const call of store.callsForTicket(current.id)) {
      calls.push({ ticketId: call.ticketId, callId: call.id, kind: call.kind, madeAt: call.madeAt, reason: call.reason, stateChange: call.stateChange });
    }
    for (const { item, answer } of store.boardItemsForTicket(current.id)) {
      if (answer === null) continue;
      answers.push({
        ticketId: current.id,
        boardItemId: item.id,
        decision: item.decision,
        answeredAt: answer.answeredAt,
        answeredBy: answer.answeredBy,
        shape: answer.shape,
        optionId: answer.optionId,
        text: answer.text,
      });
    }
  }
  calls.sort((a, b) => b.callId - a.callId);
  answers.sort((a, b) => b.boardItemId - a.boardItemId);
  return { calls, answers };
}

/** What the intake call recorded about the issue: its link, and who filed it. */
function issueOf(calls: readonly CallRecord[]): { url: string; filedBy: Actor | null; title: string; body: string } | null {
  for (const call of [...calls].reverse()) {
    const detail = call.detail as Partial<IntakeDetail> | null;
    if (detail?.issue === undefined || !Array.isArray(detail.request)) continue;
    const body = detail.request?.find((part) => part.part === "body");
    return {
      url: detail.issue.url,
      filedBy: body?.author ?? null,
      title: call.inputs?.issueTitle ?? "",
      body: call.inputs?.issueBody ?? "",
    };
  }
  return null;
}

/**
 * The latest intake comment entail posted for a ticket, which a new one names
 * as the one it replaces. A ticket pulled in again that has posted none yet
 * names its predecessor's last one, recorded when it was taken in (ADR-0020).
 */
export function latestIntakeComment(calls: readonly CallRecord[]): string | null {
  return latestComment(calls, INTAKE_COMMENT_KINDS) ?? predecessorsLastComment(calls);
}

/**
 * The call kinds whose comment can be a ticket's last intake comment: its
 * intake comments, and the comment that ended it at intake or on the owner's
 * "don't go ahead" (spec §9).
 */
const LAST_COMMENT_KINDS: ReadonlySet<CallKind> = new Set<CallKind>([...INTAKE_COMMENT_KINDS, "decline", "close-at-intake", "cancel-on-answer"]);

/**
 * The last intake comment a ticket posted, which the first intake comment of
 * the ticket that pulls its issue in again names (ADR-0020): its latest intake
 * comment, or the comment that ended it, or else its own predecessor's.
 */
export function lastIntakeComment(calls: readonly CallRecord[]): string | null {
  return latestComment(calls, LAST_COMMENT_KINDS) ?? predecessorsLastComment(calls);
}

function latestComment(calls: readonly CallRecord[], kinds: ReadonlySet<CallKind>): string | null {
  for (const call of [...calls].reverse()) {
    if (!kinds.has(call.kind)) continue;
    const posted = call.postedComments.at(-1);
    if (posted) return posted.commentUrl;
  }
  return null;
}

/** The predecessor's last intake comment, as the ticket's intake call recorded it. */
function predecessorsLastComment(calls: readonly CallRecord[]): string | null {
  const intake = calls.find((call) => call.kind === "intake");
  return (intake?.detail as Partial<IntakeDetail> | null)?.predecessor?.lastIntakeComment ?? null;
}

/** The text of the notice for a raised item: no question text and no issue text (spec §13). */
export function boardNoticeText(issueNumber: number): string {
  return `Issue #${issueNumber} needs your decision on entail's board.`;
}

/**
 * Raises a ticket to the board. In one transaction it records the call that
 * moves the ticket to on the board, the board item as a snapshot, and the
 * intake comment's intent; the store refuses a second open item for the
 * ticket. Then it sends one `board-item` notice and posts the comment. A
 * failed notice is logged and blocks nothing; a comment that fails to post is
 * settled on the next start.
 *
 * @returns the board item, or null when the ticket moved before it was raised.
 */
export async function raiseToBoard(
  options: BoardOptions,
  request: RaiseRequest,
  pass: Pick<RepoPass, "repo" | "writer">,
  mirror: BoardMirror,
): Promise<BoardItemRecord | null> {
  const { store, log } = options;
  const repo = pass.repo;
  const location = { forge: repo.forge, host: repo.host, path: repo.path };
  const vision = await readVision(mirror.git, request.visionCommit);
  const check = visionCheckOf(location, request.visionCommit, visionLinesOf(vision), request.marked);
  const why = whyRaised(request.why, check);
  const decision = decisionSentence(request.ticket.issueNumber, why);
  const ownerName = readGlobalSettings(store).settings.ownerDisplayName;
  if (ownerName === null) throw new Error("the owner's display name is not set, so entail cannot attribute a comment");

  const raised = store.transaction(() => {
    const ticket = store.getTicket(request.ticket.id);
    // The ticket may have moved while the vision was read.
    if (ticket === null || ticket.state !== request.ticket.state || ticket.stateCallId !== request.ticket.stateCallId) return null;
    const before = store.callsForTicket(ticket.id);
    if (before.some((call) => call.id > request.basedOnCallId && call.kind === "raise")) return null;
    const issue = issueOf(before);
    const replaces = latestIntakeComment(before);

    const call = store.recordCall({
      ticketId: ticket.id,
      kind: "raise",
      reason: `Raised to the owner: ${why.text}`,
      inputs: request.inputs,
      detail: { basedOnCallId: request.basedOnCallId, why, unquotable: check.unquotable },
      stateTo: "on-the-board",
    });
    const snapshot: BoardItemSnapshot = {
      version: BOARD_ITEM_VERSION,
      decision,
      why,
      visionCheck: check,
      ticket: {
        repo: location,
        issue: { number: ticket.issueNumber, title: issue?.title ?? request.inputs?.issueTitle ?? "", url: issue?.url ?? "" },
        filedBy: issue?.filedBy ?? null,
        request: issue?.body ?? request.inputs?.issueBody ?? "",
      },
      happened: { ...happened(store, store.getTicket(ticket.id)!), historyLink: ticketHistoryLink(options.boardOrigin, ticket.id) },
      form: { options: boardOptions(request.readings, request.openReadings, check) },
    };
    const item = store.raiseBoardItem({ ticketId: ticket.id, callId: call.id, decision, whyRaised: why.kind, snapshot });
    const link = boardItemLink(options.boardOrigin, item.id);
    const body = composeComment(ownerName, ticket.id, intakeCommentText({ visionCheck: check, next: raisedNextText(link), replaces }));
    store.recordForgeWriteIntent({
      repoId: repo.id,
      ticketId: ticket.id,
      callId: call.id,
      kind: "comment",
      target: "issue",
      number: ticket.issueNumber,
      payload: { body },
    });
    return { item, call, body, link };
  });
  if (raised === null) {
    log.info("raise-discarded", { ticketId: request.ticket.id });
    return null;
  }
  log.info("board-item-raised", { ticketId: request.ticket.id, callId: raised.call.id, boardItemId: raised.item.id, why: why.kind });

  // One attempt; a failure is logged and sets the "last notice failed" warning.
  await options.notifier.notify(
    makeNotice({ kind: "board-item", text: boardNoticeText(request.ticket.issueNumber), repo: repo.path, link: raised.link }),
  );
  // Resumes the intent recorded above, finding the comment first if it was already posted.
  await pass.writer().comment({ ticketId: request.ticket.id, callId: raised.call.id }, "issue", request.ticket.issueNumber, raised.body);
  return raised.item;
}

/**
 * The board's owed step: a ticket whose latest verdict, or criteria written
 * after it, needs the owner is raised to the board. Owed work is a function of the records, so a ticket
 * already raised is never raised again (ADR-0017).
 */
export function boardPlanner(options: BoardOptions): OwedStepPlanner {
  const mirrors = new Map<number, Promise<BoardMirror>>();
  const mirrorFor =
    options.mirrorFor ??
    ((repo: RepoRecord) =>
      Mirror.open({
        dataDirectory: options.dataDirectory,
        key: { forge: repo.forge, host: repo.host, projectId: repo.projectId },
        remote: forgeRemote(repo.forge, repo.host, repo.path),
        log: options.log,
      }));
  const mirror = (repo: RepoRecord): Promise<BoardMirror> => {
    let found = mirrors.get(repo.id);
    if (!found) {
      found = mirrorFor(repo);
      found.catch(() => mirrors.delete(repo.id));
      mirrors.set(repo.id, found);
    }
    return found;
  };

  return (ticket, pass): OwedStep | null => {
    const calls = options.store.callsForTicket(ticket.id);
    const owed = owedRaise(ticket, calls);
    if (owed === null) return null;
    return {
      name: "raise",
      run: async () => {
        await raiseToBoard(options, raiseFromCall(ticket, owed, calls), pass, await mirror(pass.repo));
      },
    };
  };
}
