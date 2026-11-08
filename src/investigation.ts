import { latestIntakeComment } from "./board-item.ts";
import { composeComment, markedTickets } from "./comment-rules.ts";
import type { RecordedVerdict } from "./decider.ts";
import type { Actor, ForgeComment } from "./forge/forge.ts";
import type { CommentPayload } from "./forge-writer.ts";
import { readGlobalSettings } from "./global-settings.ts";
import { INVESTIGATE_LABEL, intakeCommentText, investigatingNextText, type ListedQuestion, type VisionCheck } from "./intake-comment.ts";
import type { OperationalLog } from "./operational-log.ts";
import type { OwedStep, OwedStepPlanner, RepoPass } from "./pass.ts";
import { repoSettingsOf } from "./repo-settings.ts";
import type { CallRecord, JudgedInputs, NewModelRun, Store, TicketRecord } from "./store.ts";
import { collapseWhitespace } from "./vision.ts";
import { countsAsExecutor } from "./who-counts.ts";

/**
 * Investigation (spec §8, ADR-0006, ADR-0013). When the cause or validity of
 * an issue is unknown, the decider may choose investigation after the size
 * check, naming questions Q1…Qn. Choosing it is a logged call with mechanical
 * checks only and no challenge: entail adds `entail:investigate` and posts an
 * intake comment listing the questions. Any executor answers in one
 * `entail findings` comment on the issue, one entry per question id. The
 * first such comment posted after the investigate comment, by an account that
 * counts, moves the ticket back to deciding, and the decider judges it again
 * with the findings. A ticket is investigated at most once.
 */

/** Every check on a chosen investigation, by the name the Calls page shows it under, in the order they run. */
export const INVESTIGATION_CHECKS = {
  atLeastOneQuestion: "at least one question",
  noSlash: "no line starts with /",
} as const;

export type InvestigationCheckName = (typeof INVESTIGATION_CHECKS)[keyof typeof INVESTIGATION_CHECKS];

export interface InvestigationCheckResult {
  check: InvestigationCheckName;
  passed: boolean;
  /** How it failed, in plain words; null when it passed. */
  failure: string | null;
}

/** The checks' results as recorded on the investigation call. */
export interface InvestigationChecks {
  passed: boolean;
  results: InvestigationCheckResult[];
}

/** The questions of an investigate verdict, numbered Q1…Qn by position, each on one line. */
export function questionsOf(verdict: Pick<RecordedVerdict, "questions">): ListedQuestion[] {
  return (verdict.questions ?? [])
    .map((question) => collapseWhitespace(question))
    .filter((question) => question !== "")
    .map((question, index) => ({ id: `Q${index + 1}`, question }));
}

/** Whether any line of `text` starts with `/`, which a forge could read as a command once posted (spec §9). */
function startsALineWithSlash(text: string): boolean {
  return text.split(/\r\n|\r|\n/u).some((line) => line.trimStart().startsWith("/"));
}

/**
 * The mechanical checks on a chosen investigation (spec §8, ADR-0006),
 * computed with no model: at least one question, and no line of a question
 * starts with `/`. There is no challenge, because an investigation changes
 * nothing. A failed check makes the output invalid, which is a machine
 * failure, retried like invalid criteria.
 */
export function checkInvestigation(verdict: Pick<RecordedVerdict, "verdict" | "questions">): InvestigationChecks {
  if (verdict.verdict !== "investigate") throw new Error(`only an investigate verdict is checked here, not ${String(verdict.verdict)}`);
  const asked = verdict.questions ?? [];
  const atLeastOne = questionsOf(verdict).length > 0 ? [] : ["The investigation names no question."];
  const slashed = asked.flatMap((question, index) => (startsALineWithSlash(question) ? [`Q${index + 1}`] : []));
  const noSlash = slashed.length === 0 ? [] : [`A line of ${slashed.join(", ")} starts with /.`];
  const results: InvestigationCheckResult[] = [
    { check: INVESTIGATION_CHECKS.atLeastOneQuestion, passed: atLeastOne.length === 0, failure: atLeastOne[0] ?? null },
    { check: INVESTIGATION_CHECKS.noSlash, passed: noSlash.length === 0, failure: noSlash[0] ?? null },
  ];
  return { passed: results.every((r) => r.passed), results };
}

/** Why a chosen investigation is invalid, in one line, or null when every check passed. */
export function invalidInvestigation(checks: InvestigationChecks): string | null {
  if (checks.passed) return null;
  return checks.results
    .filter((r) => !r.passed)
    .map((r) => `${r.check}: ${r.failure}`)
    .join(" ");
}

/** Whether the ticket was ever investigated: some call of it moved it to investigating. */
export function wasInvestigated(calls: readonly CallRecord[]): boolean {
  return calls.some((call) => call.stateChange?.to === "investigating");
}

/**
 * Records the call that chooses investigation and carries it out (spec §8,
 * §9): one call, in the same transaction as the intents for the intake comment
 * listing the questions and for adding `entail:investigate`, that moves the
 * ticket to investigating; then the comment, then the label. A crash after the
 * call still posts both: the next start settles them.
 */
export async function investigate(
  options: { store: Store; log: OperationalLog },
  input: {
    ticket: TicketRecord;
    pass: Pick<RepoPass, "repo" | "writer">;
    verdict: RecordedVerdict;
    inputs: JudgedInputs;
    modelRuns: NewModelRun[];
    visionCheck: VisionCheck;
  },
): Promise<void> {
  const { store, log } = options;
  const { ticket, pass, verdict } = input;
  const ownerName = readGlobalSettings(store).settings.ownerDisplayName;
  if (ownerName === null) throw new Error("the owner's display name is not set, so entail cannot attribute a comment");
  const checks = checkInvestigation(verdict);
  if (!checks.passed) throw new Error(`an invalid investigation reached the call: ${invalidInvestigation(checks)}`);
  const questions = questionsOf(verdict);

  const recorded = store.transaction(() => {
    // The ticket may have moved since the verdict was asked for.
    const now = store.getTicket(ticket.id);
    if (now === null || now.state !== ticket.state || now.stateCallId !== ticket.stateCallId) return null;
    const before = store.callsForTicket(ticket.id);
    const call = store.recordCall({
      ticketId: ticket.id,
      kind: "investigation",
      reason: `To be investigated: ${collapseWhitespace(verdict.reason)}`,
      inputs: input.inputs,
      detail: verdict,
      checks,
      modelRuns: input.modelRuns,
      stateTo: "investigating",
    });
    const body = composeComment(
      ownerName,
      ticket.id,
      intakeCommentText({ visionCheck: input.visionCheck, next: investigatingNextText(questions), replaces: latestIntakeComment(before) }),
    );
    const write = { repoId: pass.repo.id, ticketId: ticket.id, callId: call.id, target: "issue" as const, number: ticket.issueNumber };
    store.recordForgeWriteIntent({ ...write, kind: "comment", payload: { body } });
    store.recordForgeWriteIntent({ ...write, kind: "label", payload: { action: "add", label: INVESTIGATE_LABEL } });
    return { call, body };
  });
  if (recorded === null) {
    log.info("verdict-discarded", { ticketId: ticket.id, state: store.getTicket(ticket.id)?.state ?? null });
    return;
  }
  log.info("ticket-investigating", { ticketId: ticket.id, callId: recorded.call.id, questions: questions.length });
  // Each resumes the intent recorded above; the comment is found by its hidden marker if it was already posted.
  const writer = pass.writer();
  const write = { ticketId: ticket.id, callId: recorded.call.id };
  await writer.comment(write, "issue", ticket.issueNumber, recorded.body);
  await writer.addLabel(write, ticket.issueNumber, INVESTIGATE_LABEL);
}

// Findings

/** The heading a findings comment carries (ADR-0013). */
export const FINDINGS_HEADING = "entail findings";

/** One entry of a findings comment: a question id and what the executor reports for it. */
export interface FindingsEntry {
  id: string;
  text: string;
}

/** A heading line's words: without `#`s, emphasis and a trailing colon, in lower case. */
function headingWords(line: string): string | null {
  const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/u.exec(line);
  const text = (heading?.[1] ?? line).trim().replace(/^[*_]+|[*_]+$/gu, "").replace(/:\s*$/u, "").trim();
  return text === "" ? null : text.toLowerCase();
}

/** Whether a line is a markdown heading. */
function isHeading(line: string): boolean {
  return /^\s{0,3}#{1,6}\s/u.test(line);
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/u;

/**
 * For each line, whether it is inside a code fence (the fence lines
 * included), so a quoted example neither opens nor closes a section.
 */
function fenced(lines: readonly string[]): boolean[] {
  let fence: string | null = null;
  return lines.map((line) => {
    const opening = FENCE.exec(line);
    if (fence !== null) {
      if (opening && opening[1]![0] === fence[0] && opening[1]!.length >= fence.length) fence = null;
      return true;
    }
    if (opening) fence = opening[1]!;
    return opening !== null;
  });
}

const ENTRY = /^[\s>*_`-]*(?:\d+[.)]\s+)?[*_`]*(Q\d+)\b[*_`]*\s*(?:[:.)—–-]\s*)?[*_]*\s*(.*)$/iu;

/**
 * The entries of a findings comment, or null when the body has no findings
 * section (ADR-0013). The section starts at a line whose words are
 * `entail findings`, as a heading, a bold line or a line alone, in any case.
 * Each entry starts a line with its question id (`Q1: …`), and runs on over
 * the lines after it until the next entry or heading. An id given twice keeps
 * its first entry, and an entry with no text is no entry. Lines in code
 * fences open nothing, close nothing and start no entry: they run on in the
 * entry they are in.
 */
export function parseFindings(body: string): FindingsEntry[] | null {
  const lines = body.split(/\r\n|\r|\n/u);
  const inFence = fenced(lines);
  const start = lines.findIndex((line, i) => !inFence[i] && headingWords(line) === FINDINGS_HEADING);
  if (start === -1) return null;
  const entries = new Map<string, string[]>();
  let current: string[] | null = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (inFence[i]) {
      current?.push(line);
      continue;
    }
    if (isHeading(line)) break;
    const entry = ENTRY.exec(line);
    if (entry) {
      const id = entry[1]!.toUpperCase();
      if (entries.has(id)) current = null;
      else {
        current = [entry[2]!.trim()];
        entries.set(id, current);
      }
    } else if (current !== null && line.trim() !== "") current.push(line.trim());
  }
  return [...entries]
    .map(([id, text]) => ({ id, text: text.join("\n").trim() }))
    .filter((entry) => entry.text !== "");
}

/**
 * What a findings call records (spec §8): the findings comment the ticket is
 * decided from, its entries by question id, and the questions they answer.
 * A question with no entry stays unknown.
 */
export interface FindingsDetail {
  /** The investigation call whose questions the findings answer. */
  investigationCallId: number;
  comment: { id: number; url: string; createdAt: string; author: Actor; body: string };
  questions: ListedQuestion[];
  /** The entries for the investigation's questions, in question order. */
  entries: FindingsEntry[];
  /** The question ids with no entry, which stay unknown. */
  unknown: string[];
}

/** The findings a ticket was decided from: its findings call's, or null when it has none. */
export function findingsOf(calls: readonly CallRecord[]): FindingsDetail | null {
  const call = calls.findLast((c) => c.kind === "findings");
  return call === undefined ? null : (call.detail as FindingsDetail);
}

/** The question ids the findings have an entry for, which criteria and a close may cite. */
export function findingsIds(findings: FindingsDetail | null): ReadonlySet<string> | null {
  return findings === null ? null : new Set(findings.entries.map((entry) => entry.id));
}

/**
 * The findings as a model run is shown them: issue text, tagged with who
 * posted it and encoded as JSON, so nothing in it can pass for a prompt's own
 * words or the owner's (ADR-0001, ADR-0006).
 */
export function findingsText(findings: FindingsDetail): string {
  const { author } = findings.comment;
  const byId = new Map(findings.entries.map((entry) => [entry.id, entry.text]));
  return JSON.stringify(
    {
      posted_by: `${author.forge} account @${author.username} (id ${author.id} on ${author.host})`,
      posted_at: findings.comment.createdAt,
      questions: findings.questions.map(({ id, question }) => ({ id, question, entry: byId.get(id) ?? null })),
    },
    null,
    2,
  );
}

/** The text of the one-time comment for findings from an account that does not count (spec §9, §10). */
export function notCountedFindingsText(): string {
  return "A findings comment on this issue is not used: this repo lands work only from its executors, and the account that posted it is not one of them. entail decides this issue again only from findings by the repo's executors.";
}

/** What the one-time comment for findings that do not count is for, recorded with its write so it is posted once per ticket. */
export const FINDINGS_NOT_COUNTED = "findings-not-counted";

/** The comments posted on the issue after the investigate comment, oldest first. */
function commentsAfter(comments: readonly ForgeComment[], investigation: CallRecord): ForgeComment[] {
  const posted = investigation.postedComments[0];
  const at = posted === undefined ? -1 : comments.findIndex((c) => String(c.id) === posted.commentId);
  if (at !== -1) return comments.slice(at + 1);
  // The investigate comment is gone from the forge: count what was posted after the call was made.
  const since = Date.parse(investigation.madeAt);
  return comments.filter((c) => Date.parse(c.createdAt) > since);
}

export interface FindingsOptions {
  store: Store;
  log: OperationalLog;
}

/**
 * The step an investigating ticket is owed on every pass: read the issue's
 * comments for the first findings comment posted after the investigate
 * comment by an account that counts (spec §8, §10). Owed work is a function
 * of the records and the forge, so a restart loses and repeats nothing
 * (ADR-0017).
 */
export function findingsPlanner(options: FindingsOptions): OwedStepPlanner {
  return (ticket, pass): OwedStep | null => {
    if (ticket.state !== "investigating") return null;
    return { name: "findings", run: () => readFindings(options, ticket, pass) };
  };
}

async function readFindings(options: FindingsOptions, ticket: TicketRecord, pass: RepoPass): Promise<void> {
  const { store, log } = options;
  const calls = store.callsForTicket(ticket.id);
  const investigation = calls.findLast((call) => call.kind === "investigation" && call.stateChange?.to === "investigating");
  if (investigation === undefined) {
    log.warn("findings-skipped", { ticketId: ticket.id, why: "no call moved the ticket to investigating" });
    return;
  }
  // Findings count only after the investigate comment; until it is posted, none can.
  if (investigation.postedComments.length === 0) return;

  const settings = repoSettingsOf(pass.settings);
  const after = commentsAfter(await pass.forge.comments("issue", ticket.issueNumber), investigation);
  for (const comment of after) {
    // entail's own comments carry its hidden marker; they are never findings.
    if (markedTickets(comment.body).length > 0) continue;
    const entries = parseFindings(comment.body);
    if (entries === null) continue;
    if (!countsAsExecutor(pass.repo, settings, comment.author)) {
      await commentNotCounted(options, ticket, pass);
      continue;
    }
    await recordFindings(options, ticket, pass, investigation, comment, entries);
    return;
  }
}

/**
 * Posts the one-time comment for findings from an account that does not
 * count, once per ticket: its write is recorded with its purpose, so a second
 * findings comment from such an account finds it there. One recorded but not
 * yet confirmed is resumed with the body it was recorded with.
 */
async function commentNotCounted(options: FindingsOptions, ticket: TicketRecord, pass: RepoPass): Promise<void> {
  const { store, log } = options;
  const writes = store
    .forgeWritesOn(pass.repo.id, "issue", ticket.issueNumber)
    .filter((write) => write.kind === "comment" && write.ticketId === ticket.id && (write.payload as Partial<CommentPayload>).purpose === FINDINGS_NOT_COUNTED);
  if (writes.some((write) => write.confirmed)) return;
  const pending = writes.at(-1);
  let body: string;
  if (pending) body = (pending.payload as CommentPayload).body;
  else {
    const ownerName = readGlobalSettings(store).settings.ownerDisplayName;
    if (ownerName === null) throw new Error("the owner's display name is not set, so entail cannot attribute a comment");
    body = composeComment(ownerName, ticket.id, notCountedFindingsText());
  }
  await pass.writer().comment({ ticketId: ticket.id, purpose: FINDINGS_NOT_COUNTED }, "issue", ticket.issueNumber, body);
  log.info("findings-not-counted", { ticketId: ticket.id });
}

/**
 * Records the findings the ticket is decided again from (spec §8): one call,
 * in the same transaction as the intent to remove `entail:investigate`, that
 * moves the ticket back to deciding. Then the label is removed.
 */
async function recordFindings(
  options: FindingsOptions,
  ticket: TicketRecord,
  pass: RepoPass,
  investigation: CallRecord,
  comment: ForgeComment,
  parsed: readonly FindingsEntry[],
): Promise<void> {
  const { store, log } = options;
  const questions = questionsOf(investigation.detail as RecordedVerdict);
  const byId = new Map(parsed.map((entry) => [entry.id, entry.text]));
  const entries = questions.flatMap(({ id }) => (byId.has(id) ? [{ id, text: byId.get(id)! }] : []));
  const unknown = questions.filter(({ id }) => !byId.has(id)).map(({ id }) => id);
  const detail: FindingsDetail = {
    investigationCallId: investigation.id,
    comment: { id: comment.id, url: comment.url, createdAt: comment.createdAt, author: comment.author, body: comment.body },
    questions,
    entries,
    unknown,
  };
  const answered = entries.length === 0 ? "no entry for any question" : `entries for ${entries.map((e) => e.id).join(", ")}`;
  const stays = entries.length === 0 || unknown.length === 0 ? "" : `; ${unknown.join(", ")} ${unknown.length === 1 ? "stays" : "stay"} unknown`;
  const reason = `Findings arrived from @${comment.author.username}, with ${answered}${stays}. The ticket is decided again.`;

  const recorded = store.transaction(() => {
    const now = store.getTicket(ticket.id);
    if (now === null || now.state !== "investigating" || now.stateCallId !== ticket.stateCallId) return null;
    const call = store.recordCall({ ticketId: ticket.id, kind: "findings", reason, detail, stateTo: "deciding" });
    store.recordForgeWriteIntent({
      repoId: pass.repo.id,
      ticketId: ticket.id,
      callId: call.id,
      kind: "label",
      target: "issue",
      number: ticket.issueNumber,
      payload: { action: "remove", label: INVESTIGATE_LABEL },
    });
    return call;
  });
  if (recorded === null) {
    log.info("findings-discarded", { ticketId: ticket.id, state: store.getTicket(ticket.id)?.state ?? null });
    return;
  }
  log.info("findings-recorded", { ticketId: ticket.id, callId: recorded.id, commentId: comment.id, entries: entries.length, unknown: unknown.length });
  await pass.writer().removeLabel({ ticketId: ticket.id, callId: recorded.id }, ticket.issueNumber, INVESTIGATE_LABEL);
}
