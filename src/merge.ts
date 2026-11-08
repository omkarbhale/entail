import { owedAnswer } from "./after-answer.ts";
import type { BoardItemSnapshot, PinnedPathTouched } from "./board-item.ts";
import { criteriaInForce, type CriteriaDetail } from "./criteria.ts";
import { composeComment } from "./comment-rules.ts";
import { MergePendingError, type CheckReport, type Issue, type MergeMethod, type MergeOutcome, type PullRequest } from "./forge/forge.ts";
import { readGlobalSettings } from "./global-settings.ts";
import { CLEARED_LABEL } from "./intake-comment.ts";
import {
  code,
  LANDING_CHECKS,
  namedChecks,
  oneLine,
  recordLanding,
  result,
  unmoved,
  type LandingCheckResult,
  type LandingRunKey,
  type MechanicalPass,
} from "./landing.ts";
import { failingClosing, gradedLandingText, type GradedLandingDetail, type GradedPass } from "./landing-grade.ts";
import { isLandingMergeAnswer, ownerClosing, pinnedPathsAtLanding } from "./landing-pin.ts";
import { forgeRemote, Mirror } from "./mirror.ts";
import type { OperationalLog } from "./operational-log.ts";
import type { OwedStep, OwedStepPlanner, RepoPass } from "./pass.ts";
import { alreadyMergedText, commentOnce, ONE_TIME_COMMENTS, type PullRequestDetail } from "./pull-requests.ts";
import { repoSettingsOf } from "./repo-settings.ts";
import type { AnswerRecord, BoardItemRecord, CallRecord, RepoRecord, Store, TicketRecord } from "./store.ts";
import { readVision } from "./vision.ts";

/**
 * What happens after a passing landing check (spec §11, ADR-0014, ADR-0016,
 * ADR-0018, ADR-0020).
 *
 * - **The merge guard**, read live at the pinned head: the PR is open, not a
 *   draft, mergeable and conflict-free, every check at that head is green and
 *   every check the forge requires has reported. A guard that cannot say yet
 *   (a draft, pending checks, mergeability not worked out) holds the run with
 *   nothing posted, and the next pass tries again with the same grade. A PR
 *   that moved or closed is left to the run for its new head, or to following
 *   its PRs. A guard that says no fails the landing check with its comment.
 * - **Just before merging** entail re-reads VISION.md's blob on the default
 *   branch and each linked issue's title and body. If either changed, the
 *   change is processed first ({@link MergeOptions.processChanges}, where
 *   flagging plugs in) and the PR merges only if no ticket was flagged; a
 *   flagged run is held, its result reused once the re-check is recorded.
 * - **One PR linking several tickets** merges only when it passed the
 *   criteria in force of every ticket it links. A run for one of them that
 *   passes first records its landing call and waits for the others; one
 *   whose other issue has no criteria in force does not merge.
 * - **A pinned path touched.** A passing PR that would merge, or waits only
 *   for the other tickets it links, but changes a pinned path the owner has
 *   not seen for a ticket whose criteria do not fence it off the pins, is not
 *   merged: its landing call raises the ticket to the owner
 *   ({@link MergeOptions.raiseForPins}, in `landing-pin.ts`). Answered "Merge
 *   this PR as it is", entail verifies the same head again through the merge
 *   guard and merges it; a merge that does not go through then takes the
 *   ticket back to landing.
 * - **Shadow.** A passing PR in a repo in shadow gets the landing comment
 *   ending "would merge at `<sha>`", recorded as a "would merge" call, with
 *   no merge, no board item and no notice. The run-once rule keeps switching
 *   shadow off from merging a PR that already got it.
 * - **The merge** goes through the forge's API pinned to the checked sha with
 *   the repo's merge method, never an admin override or auto-merge. A merge
 *   records a merge call that ends every linked ticket as merged, closes each
 *   issue the forge left open and removes `entail:cleared`, then comments
 *   once on each other open PR for the ticket that it is already merged. A
 *   refusal leaves the ticket landing and gets one comment saying why.
 */

/** What a passing landing check decided about the merge, recorded on its landing call. */
export type MergeDecision =
  | { decision: "merging" }
  | { decision: "shadow" }
  /** Linked tickets whose criteria this PR has not passed yet at this head. */
  | { decision: "waiting"; issues: number[] }
  /** Linked issues with no criteria in force. */
  | { decision: "no-criteria"; issues: number[] }
  /** The PR changes pinned paths the owner has not seen for the ticket, so it goes to the owner (spec §11). */
  | { decision: "owner"; paths: PinnedPathTouched[] };

/** A passing landing call's detail: the graded run, and what it decided about the merge. */
export type PassingLandingDetail = GradedLandingDetail & { merge: MergeDecision };

/** What a merge call records as its detail. */
export interface MergeDetail extends PullRequestDetail {
  url: string;
  /** The head the landing check verified and the merge was pinned to. */
  headSha: string;
  /** The passing landing call the merge carries out. */
  landingCallId: number;
  outcome: "merged" | "refused";
  /** The merge method asked for, or null for the project's own (GitLab). */
  method: string | null;
  mergeCommitSha?: string | null;
  /** Why the forge refused, or why entail did not merge after all. */
  refusal?: Refusal;
  /** The board item answered "Merge this PR as it is", when the owner's answer asked for the merge. */
  boardItemId?: number;
}

/** Why a passing PR was not merged: the forge refused the merge, or entail found, reading afresh, that it may no longer merge it. */
export interface Refusal {
  by: "forge" | "entail";
  why: string;
}

/** What the live merge guard says about merging a PR at the pinned head. */
export type MergeGuard =
  | { verdict: "merge"; results: LandingCheckResult[] }
  /** Not yet: try again on a later pass, with nothing posted. */
  | { verdict: "hold"; why: string }
  /** The PR is no longer the one checked: it moved, closed or merged. */
  | { verdict: "stale"; why: string }
  /** The forge's state at the head stops the merge. */
  | { verdict: "refuse"; results: LandingCheckResult[]; failures: string[] };

/**
 * The merge guard (spec §11, ADR-0013, ADR-0014), read live at the pinned
 * head: the PR is open, not a draft and still at `pinnedSha`; the forge says
 * it would merge it, with no conflicts; every check at that head is green;
 * and every check the forge requires has reported.
 *
 * @param pr the PR as read live, with its mergeability.
 * @param report the checks read live at `pinnedSha`.
 */
export function mergeGuard(input: { pinnedSha: string; pr: Pick<PullRequest, "state" | "draft" | "headSha" | "mergeable" | "conflicts">; report: CheckReport }): MergeGuard {
  const { pinnedSha, pr, report } = input;
  if (pr.state !== "open") return { verdict: "stale", why: `it is ${pr.state}` };
  if (pr.headSha !== pinnedSha) return { verdict: "stale", why: `its head moved from ${pinnedSha} to ${pr.headSha}` };
  if (pr.draft) return { verdict: "hold", why: "it is a draft" };
  if (report.sha !== pinnedSha) return { verdict: "hold", why: `the checks were read at ${report.sha}, not ${pinnedSha}` };

  const failed = report.checks.filter((check) => check.status === "failed").map((check) => check.name);
  const pending = report.checks.filter((check) => check.status === "pending").map((check) => check.name);
  const unreported = report.required.filter((required) => !required.reported).map((required) => required.name);
  if (failed.length === 0 && pending.length > 0) return { verdict: "hold", why: `checks are pending: ${pending.join(", ")}` };
  if (failed.length === 0 && unreported.length > 0) return { verdict: "hold", why: `required checks have not reported: ${unreported.join(", ")}` };
  if (pr.conflicts !== true && (pr.mergeable === null || pr.conflicts === null)) {
    return { verdict: "hold", why: "the forge has not worked out yet whether it would merge the PR" };
  }

  const checks = failed.length === 0 ? [] : [`${failed.map(code).join(", ")} failed at this head.`];
  const mergeable =
    pr.conflicts === true ? ["The PR conflicts with its base."] : pr.mergeable === false ? ["The forge would not merge the PR at this head."] : [];
  const results = [result(LANDING_CHECKS.guardOpen, []), result(LANDING_CHECKS.guardMergeable, mergeable), result(LANDING_CHECKS.guardChecks, checks)];
  const failures = [...mergeable, ...checks];
  return failures.length === 0 ? { verdict: "merge", results } : { verdict: "refuse", results, failures };
}

/** An issue's title and body as a call recorded them. */
export interface IssueText {
  title: string;
  body: string;
}

/** The issue text the ticket's latest call to record one judged, or null when none did. */
export function recordedIssueText(calls: readonly CallRecord[]): IssueText | null {
  for (const call of [...calls].reverse()) {
    const title = call.inputs?.issueTitle;
    const body = call.inputs?.issueBody;
    if (typeof title === "string" && typeof body === "string") return { title, body };
  }
  return null;
}

/** Whether an issue's title or body differs from the text recorded. Whether such a change is an edit that flags is for flagging to say. */
export function issueTextChanged(recorded: IssueText, current: Pick<Issue, "title" | "body">): boolean {
  return recorded.title !== current.title || recorded.body !== current.body;
}

/** What changed just before a merge, read live, since the pass that checked the PR. */
export interface ChangesBeforeMerge {
  /** VISION.md's blob changed on the default branch since the pass's head; null when it did not. */
  vision: { fromCommit: string; toCommit: string; fromBlob: string | null; toBlob: string | null } | null;
  /** Each linked ticket whose issue title or body differs from the text its records judged. */
  issues: { ticket: TicketRecord; recorded: IssueText; current: Issue }[];
}

/** Processes the changes read just before a merge and says whether any linked ticket is flagged, so nothing merges. */
export type ProcessChanges = (input: { tickets: readonly TicketRecord[]; pass: RepoPass; changes: ChangesBeforeMerge }) => Promise<{ flagged: boolean }>;

/** The parts of a repo's git mirror the merge guard's VISION.md re-read uses. */
export interface MergeMirror {
  updateDefaultBranch(): Promise<{ branch: string; commit: string }>;
  /** VISION.md's blob at a commit, or null when it has none. */
  visionBlob(commit: string): Promise<string | null>;
}

export interface MergeOptions {
  store: Store;
  log: OperationalLog;
  dataDirectory: string;
  /** The repo's mirror; its git mirror in the data directory by default. */
  mirrorFor?: (repo: RepoRecord) => Promise<MergeMirror>;
  /**
   * Processes a VISION.md or issue change found just before merging, and says
   * whether it flagged a linked ticket (ADR-0016, ADR-0020). Flagging plugs in
   * here, and is also asked when nothing changed, so a ticket already flagged
   * holds its merge. With none wired in, nothing flags a ticket, and a change
   * is only logged.
   */
  processChanges?: ProcessChanges;
  /**
   * Raises the ticket of a passing run whose PR touches a pinned path the
   * owner has not seen, once its landing call is recorded (spec §11). With
   * none wired in, the raise is left to its owed step on a later pass.
   */
  raiseForPins?: (ticket: TicketRecord, landing: CallRecord, pass: RepoPass) => Promise<void>;
}

/** The merge, as the landing check's last stage and as the step a passing run that has not merged yet is owed. */
export interface LandingMerger {
  /** Takes a passing landing check to the merge guard, then the merge. */
  afterGrade(passed: GradedPass): Promise<void>;
  /**
   * Wraps the grader so a run held at the merge guard, or flagged, is taken to
   * the merge again with the grade it already has, with no extra model runs
   * (ADR-0016).
   */
  reusingHeld(grade: (run: MechanicalPass) => Promise<void>): (run: MechanicalPass) => Promise<void>;
  /**
   * The step a landing ticket owes when its passing landing call has no merge
   * recorded after it, as after a restart; and the merge an on-the-board
   * ticket owes when the owner answered its landing pin item "Merge this PR as
   * it is".
   */
  planner: OwedStepPlanner;
}

function runKey(key: LandingRunKey): string {
  return JSON.stringify([key.pullRequest, key.headSha, key.evidence, key.criteriaVersion]);
}

export function landingMerger(options: MergeOptions): LandingMerger {
  const { store, log } = options;
  const mirrors = new Map<number, Promise<MergeMirror>>();
  const mirrorFor =
    options.mirrorFor ??
    (async (repo: RepoRecord): Promise<MergeMirror> => {
      const mirror = await Mirror.open({
        dataDirectory: options.dataDirectory,
        key: { forge: repo.forge, host: repo.host, projectId: repo.projectId },
        remote: forgeRemote(repo.forge, repo.host, repo.path),
        log: options.log,
      });
      return {
        updateDefaultBranch: () => mirror.updateDefaultBranch(),
        visionBlob: async (commit) => {
          const vision = await readVision(mirror.git, commit);
          return vision.status === "missing" ? null : vision.blob;
        },
      };
    });
  const mirror = (repo: RepoRecord): Promise<MergeMirror> => {
    let found = mirrors.get(repo.id);
    if (!found) {
      found = mirrorFor(repo);
      found.catch(() => mirrors.delete(repo.id));
      mirrors.set(repo.id, found);
    }
    return found;
  };
  // Passing runs held at the merge guard or by a flag, by run key, so the next pass reuses their grade.
  const held = new Map<string, GradedPass>();
  const context: MergeContext = { options, mirror };

  const afterGrade = async (passed: GradedPass): Promise<void> => {
    const key = runKey(passed.key);
    held.delete(key);
    const outcome = await takeToMerge(context, passed);
    if (outcome === "held") held.set(key, passed);
  };

  const reusingHeld =
    (grade: (run: MechanicalPass) => Promise<void>) =>
    async (run: MechanicalPass): Promise<void> => {
      const found = held.get(runKey(run.key));
      if (found === undefined) return grade(run);
      log.info("landing-grade-reused", { ticketId: run.ticket.id, pullRequest: run.pr.number, headSha: run.pr.headSha });
      return afterGrade({ ...found, ticket: run.ticket, pr: run.pr, pass: run.pass, report: run.report, comments: run.comments });
    };

  const planner: OwedStepPlanner = (ticket, pass): OwedStep | null => {
    if (ticket.state === "on-the-board") {
      const answered = owedLandingMerge(store, ticket);
      return answered === null ? null : { name: "merge-on-answer", run: () => mergeOnAnswer(context, ticket, answered, pass) };
    }
    if (ticket.state !== "landing") return null;
    const owed = owedMerge(store.callsForTicket(ticket.id));
    if (owed === null) return null;
    return { name: "merge", run: () => resumeMerge(context, ticket, owed, pass) };
  };

  return { afterGrade, reusingHeld, planner };
}

interface MergeContext {
  options: MergeOptions;
  mirror(repo: RepoRecord): Promise<MergeMirror>;
}

/** A landing call whose run decided to merge, as recorded. */
function isMerging(call: CallRecord): boolean {
  return call.kind === "landing" && (call.detail as Partial<PassingLandingDetail> | null)?.merge?.decision === "merging";
}

/** The ticket's latest passing landing call that decided to merge and has no merge call after it, or null. */
export function owedMerge(calls: readonly CallRecord[]): CallRecord | null {
  const merging = calls.findLast(isMerging);
  if (merging === undefined) return null;
  const settled = calls.some((call) => call.kind === "merge" && (call.detail as Partial<MergeDetail> | null)?.landingCallId === merging.id);
  return settled ? null : merging;
}

/** A passing landing call on a ticket for a PR at a head, at the criteria version now in force. */
function passedAt(calls: readonly CallRecord[], pullRequest: number, headSha: string, criteria: CriteriaDetail): CallRecord | null {
  return (
    calls.findLast((call) => {
      const detail = call.detail as Partial<PassingLandingDetail> | null;
      return (
        (call.kind === "landing" || call.kind === "would-merge") &&
        detail?.outcome === "met" &&
        detail.merge !== undefined &&
        detail.pullRequest === pullRequest &&
        detail.headSha === headSha &&
        detail.criteriaVersion === criteria.version
      );
    }) ?? null
  );
}

/** Each other ticket a PR links, and where it stands for this PR at this head. */
interface OtherTicket {
  issueNumber: number;
  /** The ticket, when it has criteria in force. */
  ticket: TicketRecord | null;
  /** Its passing landing call for this PR at this head, when it has one. */
  passed: CallRecord | null;
}

/**
 * Where each other issue a PR links stands, read from the records alone. It
 * reads nothing from the forge, so a run that decides on it and records its
 * landing call with no wait in between sees every landing call recorded
 * before, and two tickets of one PR passing side by side cannot both wait for
 * the other.
 */
function otherTickets(store: Store, ticket: TicketRecord, linkedIssues: readonly number[], pr: Pick<PullRequest, "number" | "headSha">): OtherTicket[] {
  return linkedIssues
    .filter((issueNumber) => issueNumber !== ticket.issueNumber)
    .sort((a, b) => a - b)
    .map((issueNumber) => {
      const other = store.latestTicketForIssue(ticket.repoId, issueNumber);
      if (other === null || (other.state !== "cleared" && other.state !== "landing")) return { issueNumber, ticket: null, passed: null };
      const calls = store.callsForTicket(other.id);
      const criteria = criteriaInForce(calls);
      if (criteria === null) return { issueNumber, ticket: null, passed: null };
      return { issueNumber, ticket: other, passed: passedAt(calls, pr.number, pr.headSha, criteria) };
    });
}

/** The tickets among them with criteria in force. */
function withCriteria(others: readonly OtherTicket[]): TicketRecord[] {
  return others.flatMap((o) => (o.ticket === null ? [] : [o.ticket]));
}

/** Issue numbers as people read them: "#3", "#3 and #4", "#3, #4 and #5". */
function issueList(numbers: readonly number[]): string {
  const named = numbers.map((n) => `#${n}`);
  return named.length <= 1 ? (named[0] ?? "") : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
}

/** The closing line of a passing landing comment, by what it decided about the merge (spec §11). */
export function passingClosing(wording: { pullRequest: string }, headSha: string, decision: MergeDecision): string {
  const pr = wording.pullRequest;
  switch (decision.decision) {
    case "merging":
      return `Merging at ${code(headSha)}.`;
    case "shadow":
      return `Would merge at ${code(headSha)}; this repo is in shadow, so the merge is left to the owner.`;
    case "waiting": {
      const many = decision.issues.length > 1;
      return `This ${pr} also links ${issueList(decision.issues)}, so it merges only once it passes ${many ? "their" : "its"} criteria at ${code(headSha)} too.`;
    }
    case "no-criteria": {
      const many = decision.issues.length > 1;
      return `This ${pr} also links ${issueList(decision.issues)}, which ${many ? "have" : "has"} no criteria in force, so entail does not merge it at ${code(headSha)}.`;
    }
    case "owner":
      return ownerClosing(wording, headSha, decision.paths);
  }
}

/**
 * Takes a passing run through the merge guard, the re-read of VISION.md and
 * the issue, and the decision for a PR linking several tickets, then records
 * its landing call and merges. Returns "held" when the run is to be taken to
 * the merge again on a later pass with the same grade.
 */
async function takeToMerge(context: MergeContext, passed: GradedPass): Promise<"held" | "done"> {
  const { store, log } = context.options;
  const { ticket, pass, key, criteria } = passed;
  const pinned = key.headSha;

  const live = await pass.forge.pullRequest(passed.pr.number);
  const report = await pass.forge.checks(live.number, pinned, namedChecks(criteria));
  const guard = mergeGuard({ pinnedSha: pinned, pr: live, report });
  const at = { ticketId: ticket.id, pullRequest: live.number, headSha: pinned };
  if (guard.verdict === "stale") {
    log.info("merge-guard-stale", { ...at, why: guard.why });
    return "done";
  }
  if (guard.verdict === "hold") {
    log.info("merge-guard-hold", { ...at, why: guard.why });
    return "held";
  }
  if (guard.verdict === "refuse") {
    await recordLanding(context.options, {
      ticket,
      pr: passed.pr,
      pass,
      detail: { ...passed.detail, stage: "merge-guard", outcome: "not-met", checkReport: report },
      reason: `Landing check of PR #${live.number} at ${pinned.slice(0, 12)} passed its criteria, but the merge guard stops the merge: ${guard.failures.join(" ")}`,
      checks: { passed: false, results: [...passed.checks.results, ...guard.results] },
      challenge: passed.challenge,
      modelRuns: passed.modelRuns,
      text: gradedLandingText({
        wording: pass.forge.wording,
        issueNumber: ticket.issueNumber,
        headSha: pinned,
        criteriaVersion: key.criteriaVersion,
        ids: passed.ids,
        beyondCriteria: [],
        forgeFailures: guard.failures,
        closing: failingClosing(pass.forge.wording, pinned),
      }),
    });
    return "done";
  }

  const linkedIssues = await pass.forge.linkedIssues(live.number);
  const linked = [ticket, ...withCriteria(otherTickets(store, ticket, linkedIssues, live))];
  if (await flaggedBeforeMerge(context, linked, pass)) {
    log.info("merge-held-for-flag", at);
    return "held";
  }

  // From here to recording the landing call nothing waits, so the decision stands on the records as they are when it is recorded.
  const others = otherTickets(store, ticket, linkedIssues, live);
  const noCriteria = others.filter((o) => o.ticket === null).map((o) => o.issueNumber);
  const waiting = others.filter((o) => o.ticket !== null && o.passed === null).map((o) => o.issueNumber);
  const shadow = repoSettingsOf(pass.settings).shadow;
  let decision: MergeDecision =
    noCriteria.length > 0
      ? { decision: "no-criteria", issues: noCriteria }
      : waiting.length > 0
        ? { decision: "waiting", issues: waiting }
        : shadow
          ? { decision: "shadow" }
          : { decision: "merging" };
  // Only a PR that passed everything else goes to the owner for a touched pin, with the pins as they are now (spec §11).
  if (decision.decision === "merging" || decision.decision === "waiting") {
    const paths = pinnedPathsAtLanding(store, ticket, criteria, passed.changedPaths);
    if (paths.length > 0) decision = { decision: "owner", paths };
  }

  const short = pinned.slice(0, 12);
  const reasons: Record<MergeDecision["decision"], string> = {
    merging: `Landing check of PR #${live.number} at ${short} passed: merging at ${short}.`,
    shadow: `Landing check of PR #${live.number} at ${short} passed: would merge at ${short}; the repo is in shadow, so the merge is left to the owner.`,
    waiting: `Landing check of PR #${live.number} at ${short} passed #${ticket.issueNumber}'s criteria; it merges once it also passes ${issueList(waiting)}'s.`,
    "no-criteria": `Landing check of PR #${live.number} at ${short} passed, but it does not merge: ${issueList(noCriteria)} ${noCriteria.length === 1 ? "has" : "have"} no criteria in force.`,
    owner: `Landing check of PR #${live.number} at ${short} passed, but it changes pinned paths the owner has not seen for this ticket (${
      decision.decision === "owner" ? decision.paths.map((p) => `${p.path}, pin “${p.pin.trim()}”`).join("; ") : ""
    }), so it goes to the owner and is not merged.`,
  };
  const detail: PassingLandingDetail = { ...passed.detail, checkReport: report, merge: decision };
  const call = await recordLanding(context.options, {
    ticket,
    pr: passed.pr,
    pass,
    kind: decision.decision === "shadow" ? "would-merge" : "landing",
    detail,
    reason: reasons[decision.decision],
    checks: { passed: true, results: [...passed.checks.results, ...guard.results] },
    challenge: passed.challenge,
    modelRuns: passed.modelRuns,
    text: gradedLandingText({
      wording: pass.forge.wording,
      issueNumber: ticket.issueNumber,
      headSha: pinned,
      criteriaVersion: key.criteriaVersion,
      ids: passed.ids,
      beyondCriteria: [],
      closing: passingClosing(pass.forge.wording, pinned, decision),
    }),
  });
  if (call === null) return "done";
  if (decision.decision === "owner") {
    await context.options.raiseForPins?.(ticket, call, pass);
    return "done";
  }
  if (decision.decision !== "merging") return "done";
  await mergeFor(context, ticket, call, live, pass);
  return "done";
}

/**
 * Re-reads VISION.md's blob on the default branch and each linked issue's
 * title and body just before merging (ADR-0016, ADR-0020), processes what
 * changed, and says whether a linked ticket is flagged. A linked issue that is
 * closed or gone holds the merge too: following outside closes cancels its
 * ticket.
 */
async function flaggedBeforeMerge(context: MergeContext, tickets: readonly TicketRecord[], pass: RepoPass): Promise<boolean> {
  const { store, log, processChanges } = context.options;
  const changes: ChangesBeforeMerge = { vision: null, issues: [] };

  const git = await context.mirror(pass.repo);
  const head = await git.updateDefaultBranch();
  if (head.commit !== pass.head.commit) {
    const [fromBlob, toBlob] = [await git.visionBlob(pass.head.commit), await git.visionBlob(head.commit)];
    if (fromBlob !== toBlob) changes.vision = { fromCommit: pass.head.commit, toCommit: head.commit, fromBlob, toBlob };
  }
  for (const ticket of tickets) {
    const current = await pass.forge.issue(ticket.issueNumber);
    if (current === null || current.state !== "open") {
      log.info("merge-held-issue-closed", { ticketId: ticket.id, issueNumber: ticket.issueNumber });
      return true;
    }
    const recorded = recordedIssueText(store.callsForTicket(ticket.id));
    if (recorded !== null && issueTextChanged(recorded, current)) changes.issues.push({ ticket, recorded, current });
  }

  if (changes.vision !== null || changes.issues.length > 0) {
    log.info("merge-guard-changes", {
      ticketIds: tickets.map((t) => t.id),
      vision: changes.vision,
      issues: changes.issues.map((i) => i.ticket.issueNumber),
      processed: processChanges !== undefined,
    });
  }
  if (processChanges === undefined) return false;
  return (await processChanges({ tickets, pass, changes })).flagged;
}

/** The merge method entail asks for: the one set for a GitHub repo, or null where the project's own applies (GitLab). */
function mergeMethodFor(pass: RepoPass): MergeMethod | null {
  return pass.forge.setting.forge === "github" ? repoSettingsOf(pass.settings).mergeMethod : null;
}

/**
 * Merges a PR pinned to the head its landing call checked, with the repo's
 * merge method, and records the outcome. A merge still running on the forge
 * when the wait ends has no outcome yet: the owed step settles it on a later
 * pass by the PR's state.
 */
async function mergeFor(
  context: MergeContext,
  ticket: TicketRecord,
  landing: CallRecord,
  pr: Pick<PullRequest, "number" | "url">,
  pass: RepoPass,
  answer: AnsweredMerge | null = null,
): Promise<void> {
  const { log } = context.options;
  const detail = landing.detail as PassingLandingDetail;
  const method = mergeMethodFor(pass);
  let outcome: MergeOutcome;
  try {
    outcome = await pass.writer().merge({ ticketId: ticket.id, callId: landing.id }, pr.number, detail.headSha, method ?? undefined);
  } catch (error) {
    if (!(error instanceof MergePendingError)) throw error;
    log.info("merge-pending", { ticketId: ticket.id, pullRequest: pr.number, headSha: detail.headSha });
    return;
  }
  if (outcome.merged) await recordMerged(context, ticket, landing, pr, pass, method, outcome.mergeCommitSha, answer);
  else await recordRefused(context, ticket, landing, pr, pass, method, { by: "forge", why: outcome.refusal }, true, answer);
}

/**
 * The owed merge of a passing landing call with no merge call after it, as
 * after a restart or a merge the forge was still running: a PR already
 * merged is recorded as merged; otherwise the merge guard is read afresh
 * before merging, since the forge may have changed meanwhile.
 */
async function resumeMerge(context: MergeContext, ticket: TicketRecord, landing: CallRecord, pass: RepoPass): Promise<void> {
  const { store, log } = context.options;
  const detail = landing.detail as PassingLandingDetail;
  const state = await pass.forge.pullRequestState(detail.pullRequest);
  if (!unmoved(store, ticket)) return;
  const pr = { number: detail.pullRequest, url: detail.url };
  const method = mergeMethodFor(pass);
  if (state.state === "merged") {
    await recordMerged(context, ticket, landing, pr, pass, method, state.mergeCommitSha);
    return;
  }
  const criteria = criteriaInForce(store.callsForTicket(ticket.id));
  const live = await pass.forge.pullRequest(detail.pullRequest);
  const report = await pass.forge.checks(live.number, detail.headSha, criteria === null ? [] : namedChecks(criteria));
  const guard = mergeGuard({ pinnedSha: detail.headSha, pr: live, report });
  const at = { ticketId: ticket.id, pullRequest: live.number, headSha: detail.headSha };
  if (guard.verdict === "hold") {
    log.info("merge-guard-hold", { ...at, why: guard.why });
    return;
  }
  if (criteria?.version !== detail.criteriaVersion) {
    await recordRefused(context, ticket, landing, pr, pass, method, { by: "entail", why: "the criteria in force changed since the landing check" }, live.state === "open");
    return;
  }
  if (guard.verdict !== "merge") {
    const why = guard.verdict === "stale" ? `the ${pass.forge.wording.pullRequest} ${guard.why}` : guard.failures.join(" ");
    await recordRefused(context, ticket, landing, pr, pass, method, { by: "entail", why }, live.state === "open");
    return;
  }
  const others = otherTickets(store, ticket, await pass.forge.linkedIssues(live.number), live);
  if (await flaggedBeforeMerge(context, [ticket, ...withCriteria(others)], pass)) {
    log.info("merge-held-for-flag", at);
    return;
  }
  await mergeFor(context, ticket, landing, pr, pass);
}

/** Every ticket a merge of the PR ends as merged: the ticket that merged it, and each other linked ticket that passed at the same head. */
async function mergedTickets(store: Store, ticket: TicketRecord, landing: CallRecord, pass: RepoPass): Promise<{ ticket: TicketRecord; landingCallId: number }[]> {
  const detail = landing.detail as PassingLandingDetail;
  const others = otherTickets(store, ticket, await pass.forge.linkedIssues(detail.pullRequest), { number: detail.pullRequest, headSha: detail.headSha });
  return [
    { ticket, landingCallId: landing.id },
    ...others.flatMap((o) => (o.ticket !== null && o.passed !== null ? [{ ticket: o.ticket, landingCallId: o.passed.id }] : [])),
  ];
}

/**
 * Records a merge (spec §11, ADR-0014): for each ticket it ends, in one
 * transaction, a merge call to merged with the intents to close an issue the
 * forge left open and to remove `entail:cleared`; then sends them. Each other
 * open PR for a merged ticket then gets one "already merged" comment, and is
 * neither checked again nor closed.
 */
async function recordMerged(
  context: MergeContext,
  ticket: TicketRecord,
  landing: CallRecord,
  pr: Pick<PullRequest, "number" | "url">,
  pass: RepoPass,
  method: string | null,
  mergeCommitSha: string | null,
  answer: AnsweredMerge | null = null,
): Promise<void> {
  const { store, log } = context.options;
  const detail = landing.detail as PassingLandingDetail;
  const ending = await mergedTickets(store, ticket, landing, pass);
  const open = new Map<number, boolean>();
  for (const { ticket: t } of ending) open.set(t.id, (await pass.forge.issue(t.issueNumber))?.state === "open");

  const recorded = store.transaction(() =>
    ending.flatMap(({ ticket: t, landingCallId }) => {
      if (!unmoved(store, t)) return [];
      const onAnswer = answer !== null && t.id === ticket.id ? answer : null;
      const mergeDetail: MergeDetail = {
        pullRequests: [pr.number],
        url: pr.url,
        headSha: detail.headSha,
        landingCallId,
        outcome: "merged",
        method,
        mergeCommitSha,
        ...(onAnswer === null ? {} : { boardItemId: onAnswer.item.id }),
      };
      const call = store.recordCall({
        ticketId: t.id,
        kind: "merge",
        reason:
          onAnswer === null
            ? `Merged: entail merged PR #${pr.number} at ${detail.headSha.slice(0, 12)}, the head its landing check verified.`
            : `Merged on the owner's answer "Merge this PR as it is": entail verified PR #${pr.number} at ${detail.headSha.slice(0, 12)} again and merged it.`,
        ...(onAnswer === null ? {} : { answerId: onAnswer.answer.id }),
        inputs: { prHeadSha: detail.headSha, settingsVersionId: pass.settings.id },
        detail: mergeDetail,
        stateTo: "merged",
      });
      const write = { repoId: pass.repo.id, ticketId: t.id, callId: call.id, target: "issue" as const, number: t.issueNumber };
      if (open.get(t.id)) store.recordForgeWriteIntent({ ...write, kind: "close", payload: { reason: "completed" } });
      store.recordForgeWriteIntent({ ...write, kind: "label", payload: { action: "remove", label: CLEARED_LABEL } });
      return [{ ticket: t, call }];
    }),
  );

  const writer = pass.writer();
  for (const { ticket: t, call } of recorded) {
    log.info("ticket-merged", { ticketId: t.id, callId: call.id, pullRequest: pr.number, headSha: detail.headSha });
    // Each resumes the intent recorded above.
    const write = { ticketId: t.id, callId: call.id };
    if (open.get(t.id)) await writer.closeIssue(write, t.issueNumber, "completed");
    await writer.removeLabel(write, t.issueNumber, CLEARED_LABEL);
  }
  for (const { ticket: t } of recorded) {
    const merged = store.getTicket(t.id)!;
    for (const other of await pass.forge.linkedPullRequests(t.issueNumber)) {
      if (other.number === pr.number || other.state !== "open") continue;
      await commentOnce(context.options, pass, merged, other, ONE_TIME_COMMENTS.alreadyMerged, alreadyMergedText(store, pass, merged));
    }
  }
}

/** Text as one sentence: on one line, ending with a full stop unless it already ends a sentence. */
function sentence(text: string): string {
  const line = oneLine(text);
  return /[.!?]$/u.test(line) ? line : `${line}.`;
}

/** The comment on a PR that passed its landing check but was not merged: the forge refused the merge, or entail no longer could (ADR-0014). */
export function refusalText(wording: { pullRequest: string }, headSha: string, refusal: Refusal): string {
  const pr = wording.pullRequest;
  const first =
    refusal.by === "forge"
      ? `The forge refused to merge this ${pr} at ${code(headSha)}: ${sentence(refusal.why)}`
      : `entail did not merge this ${pr} at ${code(headSha)}: ${sentence(refusal.why)}`;
  return [first, "It passed its landing check, but it is not merged. A new push, or a new `entail evidence` section, gets it checked again."].join("\n\n");
}

/**
 * Records a merge that did not happen: the forge refused it, or the guard
 * read afresh no longer allows it. The ticket stays landing, and the PR, if
 * open, gets one comment saying why.
 */
async function recordRefused(
  context: MergeContext,
  ticket: TicketRecord,
  landing: CallRecord,
  pr: Pick<PullRequest, "number" | "url">,
  pass: RepoPass,
  method: string | null,
  refusal: Refusal,
  comment = true,
  answer: AnsweredMerge | null = null,
): Promise<void> {
  const { store, log } = context.options;
  const detail = landing.detail as PassingLandingDetail;
  const ownerName = readGlobalSettings(store).settings.ownerDisplayName;
  if (ownerName === null) throw new Error("the owner's display name is not set, so entail cannot attribute a comment");
  const body = composeComment(ownerName, ticket.id, refusalText(pass.forge.wording, detail.headSha, refusal));
  const recorded = store.transaction(() => {
    if (!unmoved(store, ticket)) return null;
    const mergeDetail: MergeDetail = {
      pullRequests: [pr.number],
      url: pr.url,
      headSha: detail.headSha,
      landingCallId: landing.id,
      outcome: "refused",
      method,
      refusal,
      ...(answer === null ? {} : { boardItemId: answer.item.id }),
    };
    const call = store.recordCall({
      ticketId: ticket.id,
      kind: "merge",
      reason: `Not merged: PR #${pr.number} at ${detail.headSha.slice(0, 12)} passed its landing check, but ${refusal.by === "forge" ? "the forge refused the merge" : "entail did not merge it"}: ${sentence(refusal.why)}${
        answer === null ? "" : " The owner had answered “Merge this PR as it is”, so the ticket goes back to landing."
      }`,
      inputs: { prHeadSha: detail.headSha, settingsVersionId: pass.settings.id },
      detail: mergeDetail,
      // A merge the owner asked for that does not go through takes the ticket off the board, back to landing.
      ...(answer === null ? {} : { answerId: answer.answer.id, stateTo: "landing" as const }),
    });
    const write = { repoId: pass.repo.id, ticketId: ticket.id, callId: call.id };
    if (comment) store.recordForgeWriteIntent({ ...write, kind: "comment", target: "pr", number: pr.number, payload: { body } });
    if (answer !== null) {
      store.recordForgeWriteIntent({ ...write, kind: "label", target: "issue", number: ticket.issueNumber, payload: { action: "add", label: CLEARED_LABEL } });
    }
    return call;
  });
  if (recorded === null) return;
  log.info("merge-refused", { ticketId: ticket.id, callId: recorded.id, pullRequest: pr.number, headSha: detail.headSha, by: refusal.by, why: refusal.why });
  const write = { ticketId: ticket.id, callId: recorded.id };
  if (comment) await pass.writer().comment(write, "pr", pr.number, body);
  if (answer !== null) await pass.writer().addLabel(write, ticket.issueNumber, CLEARED_LABEL);
}

/** A landing pin item the owner answered "Merge this PR as it is", with that answer. */
export interface AnsweredMerge {
  item: BoardItemRecord;
  answer: AnswerRecord;
}

/** The answer "Merge this PR as it is" an on-the-board ticket owes its merge for: no call cites it yet. Null when none is owed. */
export function owedLandingMerge(store: Store, ticket: TicketRecord): AnsweredMerge | null {
  const owed = owedAnswer(store, ticket, store.callsForTicket(ticket.id));
  if (owed === null || !isLandingMergeAnswer(owed.answer, owed.item.snapshot as Partial<BoardItemSnapshot> | null)) return null;
  return owed;
}

/**
 * The merge the owner asked for by answering a landing pin item "Merge this
 * PR as it is" (spec §11, ADR-0014): entail verifies the same head again
 * through the merge guard, read live, with the criteria version it passed,
 * every other linked ticket having passed too, and the re-read of VISION.md
 * and the issue; then merges pinned to that head. A guard that cannot say yet
 * holds the merge for a later pass. Anything else that stops it records a
 * refused merge citing the answer, which takes the ticket back to landing with
 * one comment on the PR, if open, saying why.
 */
async function mergeOnAnswer(context: MergeContext, ticket: TicketRecord, answered: AnsweredMerge, pass: RepoPass): Promise<void> {
  const { store, log } = context.options;
  const landingItem = (answered.item.snapshot as Partial<BoardItemSnapshot>).landing!;
  const landing = store.getCall(landingItem.landingCallId);
  if (landing === null) throw new Error(`board item ${answered.item.id} names landing call ${landingItem.landingCallId}, which is not recorded`);
  const detail = landing.detail as PassingLandingDetail;
  const pr = { number: landingItem.pullRequest, url: landingItem.url };
  const method = mergeMethodFor(pass);
  const state = await pass.forge.pullRequestState(pr.number);
  if (!unmoved(store, ticket)) return;
  if (state.state === "merged") {
    // A merge entail began on this answer that the forge finished after it was asked.
    await recordMerged(context, ticket, landing, pr, pass, method, state.mergeCommitSha, answered);
    return;
  }

  const criteria = criteriaInForce(store.callsForTicket(ticket.id));
  const live = await pass.forge.pullRequest(pr.number);
  const report = await pass.forge.checks(live.number, detail.headSha, criteria === null ? [] : namedChecks(criteria));
  const guard = mergeGuard({ pinnedSha: detail.headSha, pr: live, report });
  const at = { ticketId: ticket.id, pullRequest: live.number, headSha: detail.headSha, answerId: answered.answer.id };
  if (guard.verdict === "hold") {
    log.info("merge-guard-hold", { ...at, why: guard.why });
    return;
  }
  const refuse = (why: string) => recordRefused(context, ticket, landing, pr, pass, method, { by: "entail", why }, live.state === "open", answered);
  if (criteria?.version !== detail.criteriaVersion) return refuse("the criteria in force changed since the landing check");
  if (guard.verdict !== "merge") return refuse(guard.verdict === "stale" ? `the ${pass.forge.wording.pullRequest} ${guard.why}` : guard.failures.join(" "));
  const others = otherTickets(store, ticket, await pass.forge.linkedIssues(live.number), live);
  const notPassed = others.filter((o) => o.ticket === null || o.passed === null).map((o) => o.issueNumber);
  if (notPassed.length > 0) {
    return refuse(`it also links ${issueList(notPassed)}, whose criteria it has not passed at ${detail.headSha.slice(0, 12)}`);
  }
  if (await flaggedBeforeMerge(context, [ticket, ...withCriteria(others)], pass)) {
    log.info("merge-held-for-flag", at);
    return;
  }
  log.info("merge-on-answer", at);
  await mergeFor(context, ticket, landing, pr, pass, answered);
}
