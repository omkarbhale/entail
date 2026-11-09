// The acceptance test's pass checks 1–9 after each run, and the passing rule
// across runs (MVP-1 spec, Testing Decisions; ADR-0010, ADR-0011). They read
// only what a run leaves on the forge and in entail's store ({@link RunEvidence}).
import type { AuditedIssue, AuditedPullRequest } from "./audit.ts";
import { evidenceBasis, FINDINGS_HEADING } from "./comments.ts";
import { FIXTURE_ISSUES, type ExpectedEnd, type TicketId } from "./fixture.ts";
import type { Comment } from "./forge.ts";
import { EXPECTED_ANSWERS } from "./prepared.ts";
import type { RunEvidence, StoreBoardItem, StoreCall, StoreTicket } from "./evidence.ts";

/** The vision lines the outcomes table expects a settled clear to cite. */
export const EXPECTED_CITED_LINE: Partial<Record<TicketId, string>> = {
  T1: "tally reads plain text from the files it is given, or from standard input when it is given none.",
  T2: "Errors go to standard error, and tally then exits with a non-zero status.",
  T11: "A word is a run of characters between whitespace.",
};

/** Tickets expected to be cleared by entail on its own (settled or unopposed). */
export const EXPECTED_CLEARS: readonly TicketId[] = ["T1", "T2", "T3", "T5", "T6", "T11"];

/** Tickets expected to need the owner, or to be declined: clearing one without an answer is a wrong clear. */
export const NEVER_CLEARED_WITHOUT_ANSWER: readonly TicketId[] = ["T7", "T8", "T9", "T10", "T13"];

/** Tickets whose automatic clear must be settled, not unopposed: the outcomes table names the line they cite. */
const MUST_SETTLE: readonly TicketId[] = ["T1", "T11"];

/** The executor's own comments: its findings, and evidence carrying the line naming what it was written from. */
export function isExecutorComment(body: string): boolean {
  return body.trimStart().startsWith(FINDINGS_HEADING) || evidenceBasis(body) !== undefined;
}

/** The attribution line for an owner's display name, in the possessive (spec §9). */
export function attributionFor(ownerName: string): string {
  const name = ownerName.trim().replace(/\s+/g, " ");
  const possessive = /['’](s)?$/i.test(name) ? name : /s$/i.test(name) ? `${name}'` : `${name}'s`;
  return `Speaking from ${possessive} entail:`;
}

const MARKER = /<!-- entail (?:ticket|reply) \d+ -->/;
const PERMALINK = /https:\/\/[^\s)"'<>]+?\/(?:-\/)?blob\/([0-9a-f]{40})\/VISION\.md#L(\d+)(?:-L?(\d+))?/g;

export interface CheckResult {
  id: number;
  name: string;
  passed: boolean;
  failures: string[];
}

export interface TicketReport {
  id: TicketId;
  issue: number | null;
  expectedEnd: ExpectedEnd;
  endState: string;
  /** The states the ticket passed through, and the verdicts behind them. */
  path: string;
  /** Cleared by entail with no answer behind it. */
  clearedAutomatically: boolean;
  /** How entail cleared it on its own: settled or unopposed. */
  clearedAs: string | null;
  /** Cleared without an answer although the outcomes table expects the owner or a decline. */
  wrongClear: boolean;
  /** Board items beyond what the outcomes table expects. */
  extraItems: number;
  /** Check 1 for this ticket: it ended as expected, or differs only by an extra question. */
  endsAsExpected: boolean;
  why: string[];
  modelRuns: number;
  costUsd: number;
}

export interface ExtraBoardItem {
  ticket: TicketId | null;
  issue: number;
  item: number;
  whyRaised: string;
  decision: string;
  answered: string | null;
}

export interface RunReport {
  forge: string;
  repo: string;
  run: number;
  startedAt: string;
  finishedAt: string;
  /** Whether the run settled, or ended at its time limit or after stalling. */
  settled: boolean;
  tickets: TicketReport[];
  checks: CheckResult[];
  extraBoardItems: ExtraBoardItem[];
  modelRuns: number;
  costUsd: number;
  /** Every pass check held. */
  passed: boolean;
}

/** Everything about one fixture ticket in a run, gathered once for every check. */
interface TicketView {
  id: TicketId;
  expectedEnd: ExpectedEnd;
  issueNumber: number | undefined;
  issue: AuditedIssue | undefined;
  tickets: StoreTicket[];
  ticket: StoreTicket | undefined;
  calls: StoreCall[];
  items: StoreBoardItem[];
  prs: AuditedPullRequest[];
}

function pullRequestsFor(prs: readonly AuditedPullRequest[], id: TicketId, issue: number): AuditedPullRequest[] {
  const branch = `executor/${id.toLowerCase()}-issue-${issue}`;
  return prs.filter((pr) => pr.branch === branch || new RegExp(`\\b(?:closes|fixes|resolves) #${issue}\\b`, "i").test(pr.body));
}

function viewOf(evidence: RunEvidence): TicketView[] {
  return FIXTURE_ISSUES.map((fixture) => {
    const issueNumber = evidence.issueNumbers[fixture.id];
    const tickets = issueNumber === undefined ? [] : evidence.store.tickets.filter((t) => t.issueNumber === issueNumber);
    const ids = new Set(tickets.map((t) => t.id));
    return {
      id: fixture.id,
      expectedEnd: fixture.expectedEnd,
      issueNumber,
      issue: evidence.issues.find((i) => i.number === issueNumber),
      tickets,
      ticket: tickets.at(-1),
      calls: evidence.store.calls.filter((c) => ids.has(c.ticketId)),
      items: evidence.store.boardItems.filter((b) => ids.has(b.ticketId)),
      prs: issueNumber === undefined ? [] : pullRequestsFor(evidence.pullRequests, fixture.id, issueNumber),
    };
  });
}

const automaticClear = (calls: readonly StoreCall[]) =>
  calls.find((c) => c.stateFrom === "deciding" && c.stateTo === "cleared" && c.answerId === null);

/** The board items the outcomes table expects for a ticket: one for T7, T8, T9 and T13, none otherwise. */
function expectedItems(id: TicketId): number {
  return ["T7", "T8", "T9", "T13"].includes(id) ? 1 : 0;
}

function pathOf(view: TicketView): string {
  const steps: string[] = [];
  for (const call of view.calls) {
    if (call.stateTo === null) continue;
    const verdict = call.kind === "verdict" || call.kind === "criteria" ? call.detail?.verdict : undefined;
    const why = call.stateTo === "on-the-board" ? view.items.find((i) => i.callId === call.id)?.whyRaised : undefined;
    const tag = verdict ? ` (${verdict})` : why ? ` (${why})` : call.answerId !== null ? " (on the answer)" : "";
    steps.push(`${call.stateTo}${tag}`);
  }
  return ["deciding", ...steps].join(" → ");
}

// Check 1 ---------------------------------------------------------------

function endCheck(view: TicketView, evidence: RunEvidence): string[] {
  const why: string[] = [];
  const { ticket, issue } = view;
  if (!ticket) return [`${view.id} was never taken in`];
  if (!issue) return [`${view.id}'s issue #${view.issueNumber} is gone`];
  const merged = view.prs.filter((pr) => pr.state === "merged");
  const answers = view.items.map((i) => i.answer).filter((a) => a !== null);
  switch (view.expectedEnd) {
    case "merged": {
      if (ticket.state !== "merged") why.push(`${view.id} ended ${ticket.state}, not merged`);
      if (merged.length === 0) why.push(`${view.id} has no merged PR`);
      if (issue.state !== "closed") why.push(`${view.id}'s issue is still open`);
      const expected = EXPECTED_ANSWERS.get(view.id);
      if (expected?.shape === "own words") {
        if (!answers.some((a) => a.shape === "own-words" && a.text === expected.text)) why.push(`${view.id} was not answered "${expected.text}"`);
        const cleared = view.calls.find((c) => c.stateFrom === "deciding" && c.stateTo === "cleared" && c.answerId !== null);
        if (!cleared) why.push(`${view.id} was not cleared on the owner's answer`);
        else if (!(cleared.detail?.criteria ?? []).some((c: any) => c.source?.kind === "answer")) {
          why.push(`${view.id}'s criteria do not cite the owner's answer`);
        }
      }
      break;
    }
    case "cancelled":
      if (ticket.state !== "cancelled") why.push(`${view.id} ended ${ticket.state}, not cancelled`);
      if (!answers.some((a) => a.shape === "dont-go-ahead")) why.push(`${view.id} was not cancelled on "Don't go ahead"`);
      if (issue.state !== "closed") why.push(`${view.id}'s issue is still open`);
      else if (evidence.forge === "github" && issue.stateReason !== "not_planned") {
        why.push(`${view.id}'s issue was closed as ${issue.stateReason}, not as not planned`);
      }
      if (merged.length > 0) why.push(`${view.id} has a merged PR`);
      break;
    case "on the board": {
      if (ticket.state !== "on-the-board") why.push(`${view.id} ended ${ticket.state}, not on the board`);
      const open = view.items.filter((i) => i.answer === null && i.withdrawn === null);
      if (open.length !== 1) why.push(`${view.id} has ${open.length} open board items, not 1`);
      if (issue.state !== "open") why.push(`${view.id}'s issue was closed`);
      if (issue.labels.includes("entail:cleared")) why.push(`${view.id}'s issue is labelled entail:cleared`);
      break;
    }
    case "declined": {
      if (ticket.state !== "declined") why.push(`${view.id} ended ${ticket.state}, not declined`);
      if (issue.state !== "open") why.push(`${view.id}'s issue was closed; a declined issue stays open`);
      if (view.items.length > 0) why.push(`${view.id} had ${view.items.length} board items; a declined ticket has none`);
      const decline = view.calls.find((c) => c.kind === "decline");
      if (!decline) why.push(`${view.id} has no decline call`);
      else if (!evidence.store.forgeWrites.some((w) => w.callId === decline.id && w.kind === "comment" && w.confirmed)) {
        why.push(`${view.id}'s decline posted no issue comment`);
      }
      break;
    }
  }
  return why;
}

// Check 2 ---------------------------------------------------------------

const JUDGING_KINDS = new Set(["verdict", "criteria", "decline", "investigation", "close-at-intake"]);
const LANDING_KINDS = new Set(["landing", "would-merge", "merge", "new-push", "merged-by-others"]);
const MODEL_KINDS = new Set(["verdict", "criteria", "investigation"]);

function auditCheck(evidence: RunEvidence): string[] {
  const failures: string[] = [];
  const { calls, tickets, forgeWrites } = evidence.store;
  for (const call of calls) {
    const where = `call ${call.id} (${call.kind}, ticket ${call.ticketId})`;
    if (call.reason.trim() === "") failures.push(`${where} has no reason`);
    const missing: string[] = [];
    const inputs = call.inputs;
    if (JUDGING_KINDS.has(call.kind) || (call.kind === "raise" && call.stateFrom === "deciding") || call.kind === "recheck") {
      if (inputs.issueTitle === null) missing.push("issue title");
      if (inputs.issueBody === null) missing.push("issue body");
      if (inputs.visionSha === null) missing.push("vision sha");
      if (inputs.pins === null || inputs.pins === undefined) missing.push("pins");
      if (inputs.settingsVersionId === null) missing.push("settings version");
    }
    if (LANDING_KINDS.has(call.kind)) {
      if (inputs.prHeadSha === null) missing.push("PR head sha");
      if (inputs.settingsVersionId === null) missing.push("settings version");
    }
    if (call.kind === "intake" && (inputs.issueTitle === null || inputs.settingsVersionId === null)) missing.push("issue text or settings version");
    if ((call.kind === "go-ahead" || call.kind === "cancel-on-answer") && call.answerId === null) missing.push("the answer");
    if (missing.length > 0) failures.push(`${where} does not record its ${missing.join(", ")}`);
    if (MODEL_KINDS.has(call.kind) && call.modelRuns.length === 0) failures.push(`${where} has no model runs`);
  }
  // Exactly one record per call: no call recorded twice.
  const seen = new Map<string, number>();
  for (const call of calls) {
    const key = JSON.stringify([call.ticketId, call.kind, call.reason, call.stateFrom, call.stateTo, call.inputs, call.detail, call.answerId]);
    const earlier = seen.get(key);
    if (earlier !== undefined) failures.push(`call ${call.id} repeats call ${earlier}`);
    else seen.set(key, call.id);
  }
  // Every state change has a call: replaying the calls reaches each ticket's state.
  for (const ticket of tickets) {
    let state = "deciding";
    for (const call of calls.filter((c) => c.ticketId === ticket.id && c.stateTo !== null)) {
      if (call.stateFrom !== state) failures.push(`ticket ${ticket.id}: call ${call.id} moves it from ${call.stateFrom}, but it was ${state}`);
      state = call.stateTo!;
    }
    if (state !== ticket.state) failures.push(`ticket ${ticket.id} is ${ticket.state}, but its calls take it to ${state}`);
  }
  // And on the forge: every label change and close entail made comes from a call.
  for (const write of forgeWrites) {
    if ((write.kind === "label" || write.kind === "close" || write.kind === "merge") && write.callId === null && write.ticketId !== null) {
      failures.push(`forge write ${write.id} (${write.kind} on ${write.target} #${write.number}) has no call`);
    }
  }
  for (const issue of evidence.issues) {
    for (const event of issue.labelEvents.filter((e) => e.label.startsWith("entail:"))) {
      const writes = forgeWrites.filter(
        (w) => w.kind === "label" && w.target === "issue" && w.number === issue.number && w.payload?.label === event.label && w.payload?.action === event.action,
      );
      if (writes.length === 0) failures.push(`issue #${issue.number}: ${event.label} was ${event.action === "add" ? "added" : "removed"} on the forge with no call behind it`);
    }
  }
  return failures;
}

// Check 3 ---------------------------------------------------------------

function linesOf(text: string): string[] {
  return text.split("\n").map((line) => line.trim().replace(/\s+/g, " "));
}

function isWholeLine(vision: string | undefined, line: string): boolean {
  if (vision === undefined) return false;
  const wanted = line.trim().replace(/\s+/g, " ");
  return wanted !== "" && linesOf(vision).includes(wanted);
}

function citationCheck(evidence: RunEvidence, views: readonly TicketView[], entailComments: readonly ForgeComment[]): string[] {
  const failures: string[] = [];
  for (const call of evidence.store.calls) {
    if (!call.citation) continue;
    const vision = evidence.visionAt[call.citation.visionSha];
    if (vision === undefined) failures.push(`call ${call.id} cites VISION.md at ${call.citation.visionSha}, which cannot be read there`);
    for (const line of call.citation.lines) {
      if (!isWholeLine(vision, line)) failures.push(`call ${call.id} quotes "${line}", not a whole line of VISION.md at ${call.citation.visionSha.slice(0, 7)}`);
    }
  }
  for (const { body, where } of entailComments) {
    for (const match of body.matchAll(PERMALINK)) {
      const [link, sha, first] = match;
      const vision = evidence.visionAt[sha!];
      const count = vision === undefined ? 0 : vision.split("\n").length;
      if (vision === undefined || Number(first) < 1 || Number(first) > count) failures.push(`${where}: the permalink ${link} does not resolve to a line of VISION.md`);
    }
  }
  for (const view of views) {
    const clear = automaticClear(view.calls);
    const expected = EXPECTED_CITED_LINE[view.id];
    if (!clear || !expected) continue;
    const verdict = clear.detail?.verdict;
    if (verdict !== "settled") {
      if (MUST_SETTLE.includes(view.id)) failures.push(`${view.id} was cleared ${verdict}, not settled citing "${expected}"`);
      continue;
    }
    if (!(clear.citation?.lines ?? []).some((line) => line.trim() === expected)) {
      failures.push(`${view.id} was settled citing ${JSON.stringify(clear.citation?.lines ?? [])}, without "${expected}"`);
    }
  }
  return failures;
}

// Check 4 ---------------------------------------------------------------

const SOURCES = new Set(["issue", "findings", "vision_line", "answer"]);

function inventedCheck(evidence: RunEvidence, views: readonly TicketView[]): string[] {
  const failures: string[] = [];
  for (const view of views) {
    const findings = view.calls.filter((c) => c.kind === "findings").map((c) => c.detail);
    const findingIds = new Set(findings.flatMap((f) => (f?.entries ?? []).map((e: { id: string }) => e.id)));
    const answered = view.items.some((i) => i.answer !== null && i.answer.shape !== "dont-go-ahead");
    for (const call of view.calls.filter((c) => c.kind === "criteria" || c.kind === "recheck")) {
      for (const criterion of call.detail?.criteria ?? []) {
        const where = `${view.id} call ${call.id} ${criterion.id}`;
        const source = criterion.source ?? {};
        if (!SOURCES.has(source.kind)) {
          failures.push(`${where} has the unknown source ${JSON.stringify(source)}`);
          continue;
        }
        if (source.kind === "vision_line") {
          const sha = call.inputs.visionSha ?? call.citation?.visionSha ?? "";
          if (!isWholeLine(evidence.visionAt[sha], source.ref ?? "")) failures.push(`${where} is traced to "${source.ref}", not a vision line`);
        }
        if (source.kind === "findings" && !findingIds.has(source.ref)) failures.push(`${where} is traced to findings entry ${source.ref}, which the findings do not have`);
        if (source.kind === "answer" && !answered) failures.push(`${where} is traced to an answer, but no answer let ${view.id} go ahead`);
      }
    }
  }
  if (evidence.finalVision !== evidence.startingVision) failures.push("VISION.md on the default branch is not the fixture's VISION.md");
  if (evidence.store.visionChanges.length > 0) failures.push(`entail recorded ${evidence.store.visionChanges.length} vision changes`);
  for (const origin of evidence.store.visionLineOrigins) {
    if (origin.source !== "enrollment") failures.push(`the vision line "${origin.line}" was recorded from ${origin.source}, not at enrollment`);
    if (!isWholeLine(evidence.startingVision, origin.line)) failures.push(`"${origin.line}" is not a line of the fixture's vision`);
  }
  return failures;
}

// Check 5 ---------------------------------------------------------------

interface ForgeComment {
  body: string;
  id: number;
  createdAt: string;
  where: string;
  target: "issue" | "pr";
  number: number;
}

function forgeComments(evidence: RunEvidence): ForgeComment[] {
  const of = (target: "issue" | "pr", number: number, comments: readonly Comment[]) =>
    comments.map((c) => ({ body: c.body, id: c.id, createdAt: c.createdAt, where: `${target === "issue" ? "issue" : "PR"} #${number} comment ${c.id}`, target, number }));
  return [
    ...evidence.issues.flatMap((i) => of("issue", i.number, i.comments)),
    ...evidence.pullRequests.flatMap((p) => of("pr", p.number, p.comments)),
  ];
}

const DECISION_STATES = new Set(["cleared", "on-the-board", "investigating"]);

function commentRulesCheck(evidence: RunEvidence, entailComments: readonly ForgeComment[]): string[] {
  const failures: string[] = [];
  const attribution = attributionFor(evidence.ownerName);
  for (const { body, where } of entailComments) {
    const first = body.split("\n").find((line) => line.trim() !== "") ?? "";
    if (first.trim() !== attribution) failures.push(`${where} opens with "${first.slice(0, 80)}", not "${attribution}"`);
    if (!MARKER.test(body)) failures.push(`${where} carries no hidden marker`);
    const slash = body.split("\n").find((line) => line.trimStart().startsWith("/"));
    if (slash !== undefined) failures.push(`${where} has a line starting with "/": ${slash.slice(0, 80)}`);
  }
  const byId = new Map(entailComments.map((c) => [String(c.id), c]));
  const postedFor = (callId: number) =>
    evidence.store.forgeWrites
      .filter((w) => w.callId === callId && w.kind === "comment" && w.confirmed?.commentId)
      .map((w) => byId.get(w.confirmed!.commentId!))
      .filter((c) => c !== undefined);
  for (const call of evidence.store.calls) {
    if (call.stateFrom !== "deciding" || call.stateTo === null || !DECISION_STATES.has(call.stateTo)) continue;
    const comments = postedFor(call.id);
    const intake = comments.find((c) => {
      const check = c.body.indexOf("### Vision check");
      const next = c.body.indexOf("### What happens next");
      return check >= 0 && next > check;
    });
    if (!intake) failures.push(`call ${call.id} (${call.kind} → ${call.stateTo}, ticket ${call.ticketId}) posted no intake comment with a vision check and then what happens next`);
  }
  for (const item of evidence.store.boardItems) {
    const questions = [item.decision, ...((item.snapshot?.form?.options ?? []) as { reading?: string; title?: string }[]).flatMap((o) => [o.reading ?? ""])]
      .map((q) => q.trim())
      .filter((q) => q.length > 12);
    for (const comment of postedFor(item.callId)) {
      const asked = questions.find((q) => comment.body.includes(q));
      if (asked !== undefined) failures.push(`${comment.where}, raising board item ${item.id}, carries its question text: "${asked.slice(0, 80)}"`);
    }
  }
  return failures;
}

// Check 6 ---------------------------------------------------------------

function boardItemLink(origin: string, item: number): string {
  return new URL(`/?item=${item}`, origin).href;
}

function noticeCheck(evidence: RunEvidence, entailComments: readonly ForgeComment[]): string[] {
  const failures: string[] = [];
  for (const item of evidence.store.boardItems) {
    const link = boardItemLink(evidence.boardOrigin, item.id);
    const notices = evidence.notices.filter((n) => n.kind === "board-item" && n.link === link);
    if (notices.length !== 1) failures.push(`board item ${item.id} produced ${notices.length} notices, not 1`);
    const linking = entailComments.filter((c) => c.body.includes(`(${link})`) || c.body.includes(`${link}"`));
    if (linking.length !== 1) failures.push(`board item ${item.id} has ${linking.length} comments linking the board, not 1`);
  }
  const unexpected = evidence.notices.filter(
    (n) => n.kind === "board-item" && !evidence.store.boardItems.some((i) => boardItemLink(evidence.boardOrigin, i.id) === n.link),
  );
  for (const notice of unexpected) failures.push(`a board-item notice links ${notice.link}, which is no board item`);
  return failures;
}

// Check 7 ---------------------------------------------------------------

function mergeCheck(evidence: RunEvidence, views: readonly TicketView[], entailComments: readonly ForgeComment[]): string[] {
  const failures: string[] = [];
  const calls = evidence.store.calls;
  for (const pr of evidence.pullRequests.filter((p) => p.state === "merged")) {
    const where = `PR #${pr.number}`;
    const merge = calls.find((c) => c.kind === "merge" && c.stateTo === "merged" && c.inputs.prHeadSha === pr.headSha);
    if (!merge) {
      failures.push(`${where} merged at ${pr.headSha.slice(0, 7)} with no merge call by entail at that head`);
      continue;
    }
    const landing = calls.find((c) => c.kind === "landing" && c.ticketId === merge.ticketId && c.inputs.prHeadSha === pr.headSha && c.id < merge.id);
    if (!landing) failures.push(`${where} merged at ${pr.headSha.slice(0, 7)}, which no landing check verified`);
    const test = pr.checks.find((c) => c.name === "test");
    if (!test || test.conclusion !== "success") failures.push(`${where}: the check \`test\` did not pass at the merged head (${test?.conclusion ?? "not reported"})`);
    else if (test.completedAt && pr.mergedAt && test.completedAt > pr.mergedAt) failures.push(`${where} merged before \`test\` passed at its head`);
  }
  const t1 = views.find((v) => v.id === "T1")!;
  const failing = evidence.events.filter((e) => e.event === "fix-pushed" && e.ticket === "T1").map((e) => String(e.failedHead));
  if (t1.prs.length === 0) failures.push("T1 never had a PR, so its failing PR was not seen");
  else if (failing.length === 0) failures.push("T1's first PR was never commented on as failing, so its fix was never pushed");
  for (const head of failing) {
    const pr = t1.prs.find((p) => p.comments.length > 0) ?? t1.prs[0]!;
    if (pr.state === "merged" && pr.headSha === head) failures.push(`T1's failing head ${head.slice(0, 7)} was merged`);
    const named = entailComments.some((c) => c.target === "pr" && t1.prs.some((p) => p.number === c.number) && c.body.includes(head.slice(0, 7)) && /`?test`?/.test(c.body));
    if (!named) failures.push(`T1's failing head ${head.slice(0, 7)} got no comment naming the unmet check \`test\``);
  }
  for (const view of views) {
    const ended = view.ticket?.state;
    if (view.expectedEnd === "merged" && ended === "merged") continue;
    if (view.prs.some((p) => p.state === "merged") && ended !== "merged") failures.push(`${view.id} (${ended}) has a merged PR`);
    if (["T7", "T8", "T10"].includes(view.id) && view.prs.some((p) => p.state === "merged")) failures.push(`${view.id} has a merged PR`);
  }
  return failures;
}

// Check 8 ---------------------------------------------------------------

function callsPageCheck(evidence: RunEvidence): string[] {
  const failures: string[] = [];
  if (evidence.callsPageIds === null) failures.push("the Calls page could not be read");
  else {
    const listed = new Set(evidence.callsPageIds);
    const missing = evidence.store.calls.filter((c) => !listed.has(c.id)).map((c) => c.id);
    if (missing.length > 0) failures.push(`the Calls page does not list calls ${missing.join(", ")}`);
  }
  const answers = evidence.store.boardItems.map((i) => i.answer).filter((a) => a !== null);
  const last = answers.sort((a, b) => a.answeredAt.localeCompare(b.answeredAt)).at(-1);
  if (last) {
    const after = evidence.records.find((c) => c.committedAt >= last.answeredAt.slice(0, 19) && c.answerIds.includes(last.id));
    if (!after) failures.push(`the records repo has no commit holding the last answer (${last.id}, ${last.answeredAt})`);
  }
  return failures;
}

// Check 9 ---------------------------------------------------------------

function restartCheck(evidence: RunEvidence, views: readonly TicketView[], entailComments: readonly ForgeComment[]): string[] {
  const failures: string[] = [];
  const { restart, store } = evidence;
  if (!restart) failures.push("entail was not restarted during the run");
  else {
    for (const before of restart.ticketsBefore) {
      if (!store.tickets.some((t) => t.id === before.id && t.issueNumber === before.issueNumber)) failures.push(`ticket ${before.id} (issue #${before.issueNumber}) was lost across the restart`);
    }
  }
  for (const view of views) {
    if (view.issueNumber === undefined) failures.push(`${view.id} was never filed`);
    else if (view.tickets.length !== 1) failures.push(`${view.id} (issue #${view.issueNumber}) has ${view.tickets.length} tickets, not 1`);
  }
  // Comments: each entail comment on the forge is one confirmed write, and each confirmed write is one comment.
  const confirmed = store.forgeWrites.filter((w) => w.kind === "comment" && w.confirmed?.commentId);
  const confirmedIds = new Map<string, number>();
  for (const write of confirmed) {
    const id = write.confirmed!.commentId!;
    if (confirmedIds.has(id)) failures.push(`forge writes ${confirmedIds.get(id)} and ${write.id} name the same comment ${id}`);
    confirmedIds.set(id, write.id);
  }
  for (const comment of entailComments) {
    if (!confirmedIds.has(String(comment.id))) failures.push(`${comment.where} is entail's but no forge write records it: a duplicate`);
    const same = entailComments.filter((c) => c.target === comment.target && c.number === comment.number && c.body === comment.body);
    if (same.length > 1 && same[0] === comment) failures.push(`${comment.where} is posted ${same.length} times`);
  }
  for (const write of confirmed) {
    const posted = entailComments.filter((c) => String(c.id) === write.confirmed!.commentId);
    if (posted.length === 0) failures.push(`forge write ${write.id}'s comment ${write.confirmed!.commentId} is not on the forge`);
  }
  // Labels: no more label changes on the forge than entail's writes asked for.
  for (const issue of evidence.issues) {
    const counts = new Map<string, number>();
    for (const event of issue.labelEvents.filter((e) => e.label.startsWith("entail:"))) {
      const key = `${event.action} ${event.label}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of counts) {
      const [action, label] = key.split(" ");
      const writes = store.forgeWrites.filter(
        (w) => w.kind === "label" && w.target === "issue" && w.number === issue.number && w.payload?.action === action && w.payload?.label === label,
      ).length;
      if (count > writes) failures.push(`issue #${issue.number}: ${label} was ${action === "add" ? "added" : "removed"} ${count} times for ${writes} writes`);
    }
  }
  // Merges: one per PR, and one merge call per ticket.
  const merges = store.calls.filter((c) => c.kind === "merge" && c.stateTo === "merged");
  const perTicket = new Map<number, number>();
  for (const call of merges) perTicket.set(call.ticketId, (perTicket.get(call.ticketId) ?? 0) + 1);
  for (const [ticket, count] of perTicket) if (count > 1) failures.push(`ticket ${ticket} was merged by ${count} calls`);
  const mergeWrites = new Map<number, number>();
  for (const write of store.forgeWrites.filter((w) => w.kind === "merge")) mergeWrites.set(write.number, (mergeWrites.get(write.number) ?? 0) + 1);
  for (const [pr, count] of mergeWrites) if (count > 1) failures.push(`PR #${pr} has ${count} merge writes`);
  return failures;
}

// The run -----------------------------------------------------------------

const CHECK_NAMES = [
  "every ticket ends in its expected state",
  "every call has one audit record with its reason, inputs and model runs",
  "citations quote whole vision lines at the recorded sha",
  "nothing was invented",
  "every comment follows the comment rules",
  "each board item produced one notice and one comment linking the board",
  "entail merged only at the verified head after `test` passed",
  "the Calls page lists every call, and the records repo has a commit after the last answer",
  "after the restart nothing is lost or duplicated",
] as const;

/** Runs pass checks 1–9 on one run and reports each ticket. */
export function checkRun(evidence: RunEvidence, meta: { run: number; startedAt: string; finishedAt: string; settled: boolean }): RunReport {
  const views = viewOf(evidence);
  const comments = forgeComments(evidence);
  const entailComments = comments.filter((c) => !isExecutorComment(c.body));

  const tickets: TicketReport[] = views.map((view) => {
    const clear = automaticClear(view.calls);
    const why = endCheck(view, evidence);
    const runs = view.calls.flatMap((c) => c.modelRuns);
    const extra = Math.max(0, view.items.length - expectedItems(view.id));
    return {
      id: view.id,
      issue: view.issueNumber ?? null,
      expectedEnd: view.expectedEnd,
      endState: view.ticket?.state ?? "not taken in",
      path: pathOf(view),
      clearedAutomatically: clear !== undefined,
      clearedAs: clear?.detail?.verdict ?? null,
      wrongClear: clear !== undefined && NEVER_CLEARED_WITHOUT_ANSWER.includes(view.id),
      extraItems: extra,
      endsAsExpected: why.length === 0,
      why,
      modelRuns: runs.length,
      costUsd: runs.reduce((sum, r) => sum + r.estimatedCostUsd, 0),
    };
  });

  const extraBoardItems: ExtraBoardItem[] = [];
  for (const view of views) {
    const expected = expectedItems(view.id);
    view.items.slice(expected).forEach((item) =>
      extraBoardItems.push({
        ticket: view.id,
        issue: view.issueNumber!,
        item: item.id,
        whyRaised: item.whyRaised,
        decision: item.decision,
        answered: item.answer ? (item.answer.text ?? item.answer.optionId ?? item.answer.shape) : null,
      }),
    );
  }

  const failures: string[][] = [
    [...tickets.flatMap((t) => t.why), ...tickets.filter((t) => t.wrongClear).map((t) => `${t.id} was cleared without an answer: a wrong clear`)],
    auditCheck(evidence),
    citationCheck(evidence, views, entailComments),
    inventedCheck(evidence, views),
    commentRulesCheck(evidence, entailComments),
    noticeCheck(evidence, entailComments),
    mergeCheck(evidence, views, entailComments),
    callsPageCheck(evidence),
    restartCheck(evidence, views, entailComments),
  ];
  const checks = failures.map((f, i) => ({ id: i + 1, name: CHECK_NAMES[i]!, passed: f.length === 0, failures: f }));
  const enrollmentCost = evidence.store.enrollmentModelRuns.reduce((sum, r) => sum + (r.estimatedCostUsd ?? 0), 0);
  const allRuns = evidence.store.calls.flatMap((c) => c.modelRuns);
  return {
    forge: evidence.forge,
    repo: evidence.repo,
    run: meta.run,
    startedAt: meta.startedAt,
    finishedAt: meta.finishedAt,
    settled: meta.settled,
    tickets,
    checks,
    extraBoardItems,
    modelRuns: allRuns.length + evidence.store.enrollmentModelRuns.length,
    costUsd: allRuns.reduce((sum, r) => sum + r.estimatedCostUsd, 0) + enrollmentCost,
    passed: checks.every((c) => c.passed),
  };
}

// Passing, across runs ----------------------------------------------------

export interface Verdict {
  /** "passed", "failed", or "incomplete" when a forge's runs are not all in. */
  github: "passed" | "failed" | "incomplete";
  gitlab: "passed" | "failed" | "incomplete" | "pending";
  /** Every run on both forges passed. */
  passed: boolean;
  /** One line for the whole test: passed, failed, incomplete, or passed on GitHub with gitlab.com pending. */
  status: string;
  reasons: string[];
  /** For each ticket expected to be cleared: in how many GitHub runs it was. */
  clears: Record<string, { cleared: number; runs: number }>;
  wrongClears: { forge: string; run: number; ticket: TicketId }[];
}

export interface Plan {
  githubRuns: number;
  gitlabRuns: number;
  /** Why the gitlab.com runs did not run, when they are pending. */
  gitlabPending?: string;
}

/**
 * The passing rule (MVP-1 spec, Testing Decisions: Passing): no wrong clear in
 * any run, each expected clear in at least 2 of the 3 GitHub runs (a miss of
 * one counts only there, not as a failure of check 1), every other pass check
 * in every run, and on gitlab.com every ticket at its expected outcome
 * or differing only by an extra question (check 1).
 */
export function judge(reports: readonly RunReport[], plan: Plan): Verdict {
  const reasons: string[] = [];
  const wrongClears = reports.flatMap((r) => r.tickets.filter((t) => t.wrongClear).map((t) => ({ forge: r.forge, run: r.run, ticket: t.id })));
  for (const wrong of wrongClears) reasons.push(`${wrong.forge} run ${wrong.run}: ${wrong.ticket} was cleared without an answer`);

  const github = reports.filter((r) => r.forge === "github");
  const clears: Verdict["clears"] = {};
  for (const id of EXPECTED_CLEARS) {
    const cleared = github.filter((r) => r.tickets.find((t) => t.id === id)?.clearedAutomatically).length;
    clears[id] = { cleared, runs: github.length };
  }
  const needed = Math.ceil((2 / 3) * plan.githubRuns);
  let githubVerdict: Verdict["github"] = github.length < plan.githubRuns ? "incomplete" : "passed";
  if (github.length < plan.githubRuns) reasons.push(`${github.length} of ${plan.githubRuns} GitHub runs finished`);
  for (const [id, { cleared }] of Object.entries(clears)) {
    const stillPossible = cleared + (plan.githubRuns - github.length) >= needed;
    if (!stillPossible) {
      githubVerdict = "failed";
      reasons.push(`${id} was cleared in ${cleared} of ${plan.githubRuns} GitHub runs, fewer than ${needed}`);
    }
  }
  for (const report of github) {
    const onlyMissedClears = report.tickets.every((t) => t.endsAsExpected || (EXPECTED_CLEARS.includes(t.id) && !t.wrongClear));
    for (const check of report.checks.filter((c) => !c.passed)) {
      if (check.id === 1 && onlyMissedClears) continue;
      githubVerdict = "failed";
      reasons.push(`github run ${report.run}: pass check ${check.id} failed`);
    }
  }
  if (wrongClears.some((w) => w.forge === "github")) githubVerdict = "failed";

  const gitlab = reports.filter((r) => r.forge === "gitlab");
  let gitlabVerdict: Verdict["gitlab"];
  if (plan.gitlabPending !== undefined && gitlab.length === 0) {
    gitlabVerdict = "pending";
    reasons.push(`gitlab.com: pending (${plan.gitlabPending})`);
  } else {
    gitlabVerdict = gitlab.length < plan.gitlabRuns ? "incomplete" : "passed";
    if (gitlab.length < plan.gitlabRuns) reasons.push(`${gitlab.length} of ${plan.gitlabRuns} gitlab.com runs finished`);
    for (const report of gitlab) {
      for (const check of report.checks.filter((c) => !c.passed)) {
        gitlabVerdict = "failed";
        reasons.push(`gitlab run ${report.run}: pass check ${check.id} failed`);
      }
    }
    if (wrongClears.some((w) => w.forge === "gitlab")) gitlabVerdict = "failed";
  }
  const passed = wrongClears.length === 0 && githubVerdict === "passed" && gitlabVerdict === "passed";
  const failed = wrongClears.length > 0 || githubVerdict === "failed" || gitlabVerdict === "failed";
  const status = passed
    ? "passed"
    : failed
      ? "failed"
      : githubVerdict === "passed" && gitlabVerdict === "pending"
        ? "passed on GitHub; gitlab.com pending"
        : "incomplete";
  return { github: githubVerdict, gitlab: gitlabVerdict, passed, status, reasons, clears, wrongClears };
}
