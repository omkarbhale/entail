import { createHash } from "node:crypto";
import { posix } from "node:path";
import { composeComment } from "./comment-rules.ts";
import { criteriaInForce, type CriteriaDetail } from "./criteria.ts";
import { latestEvidence, type Evidence, type EvidenceSource } from "./evidence.ts";
import { allChecksFinished, requiredChecksReported, type CheckReport, type PullRequest, type PullRequestComment } from "./forge/forge.ts";
import { readGlobalSettings } from "./global-settings.ts";
import { forgeRemote, Mirror } from "./mirror.ts";
import type { OperationalLog } from "./operational-log.ts";
import type { OwedStep, OwedStepPlanner, RepoPass } from "./pass.ts";
import { repoSettingsOf, type MechanicalCheck } from "./repo-settings.ts";
import type { CallRecord, NewModelRun, RepoRecord, Store, TicketRecord } from "./store.ts";
import { countsAsExecutor } from "./who-counts.ts";

/**
 * The landing check's trigger and its first stage, with the landing comment
 * (spec §11, ADR-0014, ADR-0016).
 *
 * - **When it runs.** Only on a PR that is open and not a draft, whose base
 *   is the default branch, that links a ticket with criteria in force, and
 *   at whose head every check has finished, the checks the frozen criteria
 *   and generic criteria name included. It runs once for each distinct head
 *   sha, latest evidence section and criteria version, so it never comments
 *   while checks are pending or on a draft, and only a new push, a new
 *   evidence section or a new criteria version checks a PR again.
 * - **Stage one** reads the forge's state at the head (every check passed and
 *   the PR does not conflict with its base) and runs every criterion's and
 *   every generic criterion's mechanical checks against the diff and the
 *   check results at that head. A failure ends the run before any model is
 *   used: entail records the landing call and posts one landing comment on
 *   the PR, never on the issue. A failed landing leaves the ticket landing.
 * - **Later stages.** A run whose first stage passes goes on to the grader
 *   and its challenge (`landing-grade.ts`), then the merge; those stages plug
 *   in through {@link LandingOptions.afterMechanical}.
 */

/** Every check a landing check runs, by the name the Calls page shows it under: stage one's, then the checks on the grade. */
export const LANDING_CHECKS = {
  checksPassed: "every check at the head passed",
  noConflicts: "the PR does not conflict with its base",
  criteria: "every criterion's mechanical checks pass",
  genericCriteria: "every generic criterion's mechanical check passes",
  everyIdGraded: "the grade has one result for every id",
  quotesWordForWord: "every quoted piece of evidence appears word for word in the PR at the head",
  metHasEntry: "every id marked met has an entry in the evidence section",
  guardOpen: "the PR is open, not a draft, and still at the checked head",
  guardMergeable: "the forge would merge the PR, with no conflicts",
  guardChecks: "every check at the head is green and every required check has reported",
} as const;

export type LandingCheckName = (typeof LANDING_CHECKS)[keyof typeof LANDING_CHECKS];

export interface LandingCheckResult {
  check: LandingCheckName;
  passed: boolean;
  /** How it failed, in plain words; null when it passed. */
  failure: string | null;
}

/** The landing check's results, as recorded on the landing call: stage one's, then the checks on the grade once it was graded, then the merge guard's. */
export interface LandingChecks {
  passed: boolean;
  results: LandingCheckResult[];
}

/** What a landing check runs once for: a PR's head, its latest evidence section and the criteria version in force. */
export interface LandingRunKey {
  pullRequest: number;
  headSha: string;
  /** A digest of the latest evidence section's text, or null when the PR has none. */
  evidence: string | null;
  criteriaVersion: number;
}

/** One mechanical check of one criterion or generic criterion, as computed at the head. */
export interface MechanicalResult {
  kind: MechanicalCheck["kind"];
  argument: string;
  passed: boolean;
  /** What was found, in plain words. */
  detail: string;
}

/** One C or G id after stage one. */
export interface IdResult {
  id: string;
  sentence: string;
  checks: MechanicalResult[];
  /** False when a mechanical check failed; null when stage one cannot say, which grading decides. */
  met: false | null;
}

/** One C or G id after grading and the challenge. */
export interface GradedId extends Omit<IdResult, "met"> {
  met: boolean;
  /** For met: the evidence quoted word for word from the PR at the head. */
  evidence: string[];
  /** For not met: why, in plain words; for met, the grader's reason. */
  reason: string;
}

/** What a landing call records as its detail. */
export interface LandingDetail {
  pullRequest: number;
  url: string;
  headSha: string;
  /** The default branch head the diff was taken against. */
  baseSha: string;
  /** The latest evidence section at the head, or null when there is none. */
  evidence: { key: string; source: EvidenceSource; section: string } | null;
  /** The ticket's criteria version the run checked against. */
  criteriaVersion: number;
  /** The settings version the generic criteria were frozen from with that criteria version (ADR-0014). */
  genericCriteriaVersion: number;
  /** The stage the run ended at: a passing run ends at the challenge, and one the live merge guard stopped at the merge guard. */
  stage: "mechanical" | "grade" | "challenge" | "merge-guard";
  outcome: "not-met" | "met";
  ids: IdResult[] | GradedId[];
  /** What users can observe that the change does beyond its criteria, by the grader or the challenge; absent before grading. */
  beyondCriteria?: string[];
  /** The checks at the head as the forge reported them. */
  checkReport: CheckReport;
  /** Every path the PR changes at the head. */
  changedPaths: string[];
}

/** A digest of an evidence section's text, which the run-once rule compares, or null when there is no section. */
export function evidenceKey(evidence: Pick<Evidence, "section"> | null): string | null {
  if (evidence === null) return null;
  return createHash("sha256").update(evidence.section.trim()).digest("hex");
}

/** The check names the frozen criteria and generic criteria name, which are pending at a head until they report. */
export function namedChecks(criteria: Pick<CriteriaDetail, "criteria" | "genericCriteria">): string[] {
  const checks = [...criteria.criteria.flatMap((c) => c.checks), ...criteria.genericCriteria.map((g) => g.check)];
  return [...new Set(checks.filter((check) => check.kind === "check_passes").map((check) => check.argument))].sort();
}

/** The keys of the landing runs already recorded on a ticket's calls, a shadow "would merge" call included. */
export function landingRuns(calls: readonly CallRecord[]): LandingRunKey[] {
  return calls.flatMap((call) => {
    if (call.kind !== "landing" && call.kind !== "would-merge") return [];
    const detail = call.detail as Partial<LandingDetail> | null;
    if (typeof detail?.pullRequest !== "number" || typeof detail.headSha !== "string" || typeof detail.criteriaVersion !== "number") return [];
    return [{ pullRequest: detail.pullRequest, headSha: detail.headSha, evidence: detail.evidence?.key ?? null, criteriaVersion: detail.criteriaVersion }];
  });
}

/** Whether two keys name the same landing run. */
export function sameRun(a: LandingRunKey, b: LandingRunKey): boolean {
  return a.pullRequest === b.pullRequest && a.headSha === b.headSha && a.evidence === b.evidence && a.criteriaVersion === b.criteriaVersion;
}

/** Why a PR is not checked at all, before its checks are read, or null when it may be. */
export function notCheckable(
  pr: Pick<PullRequest, "state" | "draft" | "baseBranch">,
  defaultBranch: string,
  criteria: Pick<CriteriaDetail, "version"> | null,
): string | null {
  if (pr.state !== "open") return `it is ${pr.state}`;
  if (pr.draft) return "it is a draft";
  if (pr.baseBranch !== defaultBranch) return `its base is ${pr.baseBranch}, not the default branch ${defaultBranch}`;
  if (criteria === null || typeof criteria.version !== "number") return "its ticket has no criteria in force";
  return null;
}

/** Whether a landing check runs on a PR now, and if so for which key. */
export type LandingTrigger = { run: true; key: LandingRunKey } | { run: false; why: string };

/**
 * The landing check's trigger (spec §11, ADR-0014, ADR-0016): it runs only
 * when the PR is open and not a draft, its base is the default branch, its
 * ticket has criteria in force, and every check at its head has finished
 * (the named checks that have not reported, and the checks the forge
 * requires, included); and only once for each distinct head sha, latest
 * evidence section and criteria version.
 */
export function landingTrigger(input: {
  pr: Pick<PullRequest, "number" | "state" | "draft" | "baseBranch" | "headSha">;
  defaultBranch: string;
  criteria: Pick<CriteriaDetail, "version"> | null;
  /** The checks at the PR's head, read with the criteria's named checks. */
  report: CheckReport;
  /** The latest evidence section's key, from {@link evidenceKey}. */
  evidence: string | null;
  /** The runs already recorded for the ticket. */
  done: readonly LandingRunKey[];
}): LandingTrigger {
  const blocked = notCheckable(input.pr, input.defaultBranch, input.criteria);
  if (blocked !== null) return { run: false, why: blocked };
  if (input.report.sha !== input.pr.headSha) return { run: false, why: `the checks were read at ${input.report.sha}, not the head ${input.pr.headSha}` };
  const pending = input.report.checks.filter((check) => check.status === "pending").map((check) => check.name);
  if (!allChecksFinished(input.report)) return { run: false, why: `checks are pending: ${pending.join(", ")}` };
  if (!requiredChecksReported(input.report)) {
    const unreported = input.report.required.filter((r) => !r.reported).map((r) => r.name);
    return { run: false, why: `required checks have not reported: ${unreported.join(", ")}` };
  }
  const key: LandingRunKey = { pullRequest: input.pr.number, headSha: input.pr.headSha, evidence: input.evidence, criteriaVersion: input.criteria!.version! };
  if (input.done.some((done) => sameRun(done, key))) return { run: false, why: "it was already checked at this head, evidence section and criteria version" };
  return { run: true, key };
}

/** Whether a path matches a glob, relative to the repository root. */
function matches(path: string, glob: string): boolean {
  return posix.matchesGlob(path, glob);
}

/**
 * Runs one mechanical check at the head against the changed paths, the check
 * results and every path in the repo at the head. A changes-path glob that
 * matches no file in the repo at the head is stale (another ticket moved the
 * code it named, ADR-0005): it does not fail, and the criterion is graded.
 */
export function runMechanicalCheck(check: MechanicalCheck, changedPaths: readonly string[], report: CheckReport, headPaths: readonly string[]): MechanicalResult {
  const { kind, argument } = check;
  switch (kind) {
    case "changes_path": {
      const hit = changedPaths.find((path) => matches(path, argument));
      if (hit !== undefined) return { kind, argument, passed: true, detail: `the PR changes ${code(hit)}` };
      if (!headPaths.some((path) => matches(path, argument))) {
        return { kind, argument, passed: true, detail: `no file in the repo at this head matches ${code(argument)}, so this check does not apply and the criterion is graded` };
      }
      return { kind, argument, passed: false, detail: `the PR changes no file matching ${code(argument)}` };
    }
    case "leaves_path": {
      const hits = changedPaths.filter((path) => matches(path, argument));
      return hits.length === 0
        ? { kind, argument, passed: true, detail: `the PR changes no file matching ${code(argument)}` }
        : { kind, argument, passed: false, detail: `the PR changes ${hits.map(code).join(", ")}, which ${hits.length === 1 ? "matches" : "match"} ${code(argument)}` };
    }
    case "check_passes": {
      const found = report.checks.find((c) => c.name === argument);
      if (found === undefined || !found.reported) return { kind, argument, passed: false, detail: `the check ${code(argument)} has not reported at this head` };
      return found.status === "passed"
        ? { kind, argument, passed: true, detail: `the check ${code(argument)} passed` }
        : { kind, argument, passed: false, detail: `the check ${code(argument)} ${found.status === "failed" ? "failed" : "is pending"} at this head` };
    }
    default:
      return { kind, argument, passed: false, detail: `${code(String(kind))} is not a known mechanical check` };
  }
}

/** Stage one's outcome: the forge's state and every id's mechanical checks at the head. */
export interface MechanicalStage {
  checks: LandingChecks;
  ids: IdResult[];
}

/**
 * Stage one of a landing check (spec §11 Order step 1, ADR-0014): the
 * forge's state at the head, and every criterion's and generic criterion's
 * mechanical checks against the diff's changed paths and the check results.
 * It uses no model. A PR whose mergeability the forge has not worked out yet
 * is not failed for it here: the merge guard reads that live before merging.
 */
export function mechanicalStage(input: {
  pr: Pick<PullRequest, "conflicts">;
  criteria: Pick<CriteriaDetail, "criteria" | "genericCriteria">;
  report: CheckReport;
  changedPaths: readonly string[];
  /** Every path in the repo at the PR's head. */
  headPaths: readonly string[];
}): MechanicalStage {
  const { report, changedPaths, headPaths } = input;
  const failedChecks = report.checks.filter((check) => check.status === "failed").map((check) => check.name);
  const checksPassed = result(LANDING_CHECKS.checksPassed, failedChecks.length === 0 ? [] : [`${failedChecks.map(code).join(", ")} failed at this head.`]);
  const noConflicts = result(LANDING_CHECKS.noConflicts, input.pr.conflicts === true ? ["The PR conflicts with its base."] : []);

  const idResult = (id: string, sentence: string, checks: readonly MechanicalCheck[]): IdResult => {
    const results = checks.map((check) => runMechanicalCheck(check, changedPaths, report, headPaths));
    return { id, sentence, checks: results, met: results.some((r) => !r.passed) ? false : null };
  };
  const criteria = input.criteria.criteria.map((c) => idResult(c.id, c.sentence, c.checks));
  const generic = input.criteria.genericCriteria.map((g) => idResult(g.id, g.sentence, [g.check]));
  const failures = (ids: IdResult[]) =>
    ids.flatMap((id) => id.checks.filter((check) => !check.passed).map((check) => `${id.id}: ${check.detail}.`));

  const results = [
    checksPassed,
    noConflicts,
    result(LANDING_CHECKS.criteria, failures(criteria)),
    result(LANDING_CHECKS.genericCriteria, failures(generic)),
  ];
  return { checks: { passed: results.every((r) => r.passed), results }, ids: [...criteria, ...generic] };
}

export function result(check: LandingCheckName, failures: readonly string[]): LandingCheckResult {
  return { check, passed: failures.length === 0, failure: failures.length === 0 ? null : failures.join(" ") };
}

/** Text as a markdown code span, fenced with more backticks than it holds. */
export function code(text: string): string {
  const oneLine = text.replace(/\s+/g, " ");
  const longest = Math.max(0, ...[...oneLine.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = oneLine.startsWith("`") || oneLine.endsWith("`") ? " " : "";
  return `${fence}${pad}${oneLine}${pad}${fence}`;
}

/** Text on one line, with runs of whitespace as single spaces. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** How a mechanical check reads in the landing comment. */
export function checkLabel(check: Pick<MechanicalResult, "kind" | "argument">): string {
  const kind = { changes_path: "changes path", leaves_path: "leaves path", check_passes: "check passes" }[check.kind] ?? String(check.kind);
  return `${kind} ${code(check.argument)}`;
}

/**
 * The text of a failing landing comment (spec §11, ADR-0014): each C and G
 * id met or not met, with mechanical results as computed and a reason for
 * each "not met", the forge's state, and the head sha. It says the PR will
 * not be merged at that head, and that a new push or a new evidence section
 * gets it checked again. An id whose mechanical checks passed, or that has
 * none, is not graded, because the run ended before any model was used.
 */
export function failingLandingText(input: {
  wording: { pullRequest: string };
  issueNumber: number;
  headSha: string;
  criteriaVersion: number;
  stage: MechanicalStage;
}): string {
  const { stage, headSha } = input;
  const pr = input.wording.pullRequest;
  const notMet = stage.ids.filter((id) => id.met === false).map((id) => id.id);
  const forgeFailures = stage.checks.results.filter(
    (r) => !r.passed && (r.check === LANDING_CHECKS.checksPassed || r.check === LANDING_CHECKS.noConflicts),
  );

  const idLine = (id: IdResult): string => {
    const head = `- **${id.id}** ${oneLine(id.sentence)}`;
    if (id.met === false) {
      const reasons = id.checks.filter((c) => !c.passed).map((c) => `${c.detail} (${checkLabel(c)})`);
      return `${head}\n  Not met: ${reasons.join("; ")}.`;
    }
    if (id.checks.length === 0) return `${head}\n  Not graded: it has no mechanical check, and this run ended before grading.`;
    return `${head}\n  Not graded: its mechanical checks passed (${id.checks.map((c) => `${checkLabel(c)}: ${c.detail}`).join("; ")}), and this run ended before grading.`;
  };
  const criteria = stage.ids.filter((id) => id.id.startsWith("C"));
  const generic = stage.ids.filter((id) => id.id.startsWith("G"));

  const sections = [
    `Landing check of this ${pr} at ${code(headSha)}: it does not pass${notMet.length > 0 ? `, and ${notMet.join(", ")} ${notMet.length === 1 ? "is" : "are"} not met` : ""}.`,
    `**Criteria for #${input.issueNumber}** (version ${input.criteriaVersion})\n\n${criteria.map(idLine).join("\n")}`,
  ];
  if (generic.length > 0) sections.push(`**Generic criteria**\n\n${generic.map(idLine).join("\n")}`);
  if (forgeFailures.length > 0) {
    sections.push(`**The forge's state at this head**\n\n${forgeFailures.map((r) => `- Not met: ${r.failure}`).join("\n")}`);
  }
  sections.push(
    `This ${pr} will not be merged at ${code(headSha)}. A new push, or a new \`entail evidence\` section, gets it checked again.`,
  );
  return sections.join("\n\n");
}

/** The parts of a repo's git mirror a landing check reads. */
export interface LandingMirror {
  fetchPullRequestHead(number: number, expectedHead?: string): Promise<{ commit: string; fetched: boolean }>;
  pullRequestChangedPaths(base: string, head: string): Promise<string[]>;
  pullRequestHeadPaths(head: string): Promise<string[]>;
}

/** Everything a passing stage one hands to the later stages. */
export interface MechanicalPass {
  ticket: TicketRecord;
  pr: PullRequest;
  pass: RepoPass;
  key: LandingRunKey;
  criteria: CriteriaDetail;
  evidence: Evidence | null;
  /** The comments on the PR as read for the run. */
  comments: PullRequestComment[];
  report: CheckReport;
  baseSha: string;
  changedPaths: string[];
  stage: MechanicalStage;
}

/** A landing run as {@link recordLanding} records it, kept while its ticket is flagged. */
export type HeldLanding = Parameters<typeof recordLanding>[1];

/**
 * Holds what a landing check would post while its ticket is flagged
 * (ADR-0016): a run in progress when a flag lands finishes, but records and
 * posts nothing until the re-check is recorded, and is kept so its result can
 * be used then if the criteria version is unchanged.
 */
export interface LandingHold {
  /** Whether the ticket is flagged now, read afresh. */
  held(ticket: TicketRecord, pass: RepoPass): Promise<boolean>;
  /** Keeps a run that was held, by its run key. */
  keep(run: HeldLanding): void;
}

export interface LandingOptions {
  store: Store;
  log: OperationalLog;
  dataDirectory: string;
  /** Holds landing runs while their ticket is flagged; with none wired in, nothing is held. */
  hold?: LandingHold;
  /** The repo's mirror; its git mirror in the data directory by default. */
  mirrorFor?: (repo: RepoRecord) => Promise<LandingMirror>;
  /**
   * Runs the stages after a passing stage one: the grader, the mechanical
   * checks on the grade, the challenge and the merge. They record the run's
   * landing call, with the same pull request, head sha, evidence key and
   * criteria version in its detail; until one is recorded, the run is handed
   * on again on the next pass. With none wired in, a run whose stage one
   * passes records nothing, and is handed on once per process.
   */
  afterMechanical?: (passed: MechanicalPass) => Promise<void>;
}

/**
 * The landing check's owed step: every landing ticket's PRs are read on each
 * pass, and each PR the trigger lets through is checked. Whether a run is
 * owed is worked out from the landing calls in the records, so a restart
 * repeats no run that was recorded.
 */
export function landingPlanner(options: LandingOptions): OwedStepPlanner {
  const mirrors = new Map<number, Promise<LandingMirror>>();
  const mirrorFor =
    options.mirrorFor ??
    ((repo: RepoRecord) =>
      Mirror.open({
        dataDirectory: options.dataDirectory,
        key: { forge: repo.forge, host: repo.host, projectId: repo.projectId },
        remote: forgeRemote(repo.forge, repo.host, repo.path),
        log: options.log,
      }));
  const mirror = (repo: RepoRecord): Promise<LandingMirror> => {
    let found = mirrors.get(repo.id);
    if (!found) {
      found = mirrorFor(repo);
      found.catch(() => mirrors.delete(repo.id));
      mirrors.set(repo.id, found);
    }
    return found;
  };
  // Runs whose stage one passed and were handed on, so that while the later
  // stages record nothing, the same run is not handed on again every pass.
  const handedOn: LandingRunKey[] = [];

  return (ticket, pass): OwedStep | null => {
    if (ticket.state !== "landing") return null;
    return {
      name: "landing-check",
      run: async () => {
        const pullRequests = await pass.forge.linkedPullRequests(ticket.issueNumber);
        for (const pr of pullRequests) {
          if (!unmoved(options.store, ticket)) return;
          await checkPullRequest(options, ticket, pr, pass, () => mirror(pass.repo), handedOn);
        }
      },
    };
  };
}

/** Whether the ticket is where it was when the step began. */
export function unmoved(store: Store, ticket: TicketRecord): boolean {
  const now = store.getTicket(ticket.id);
  return now !== null && now.state === ticket.state && now.stateCallId === ticket.stateCallId;
}

async function checkPullRequest(
  options: LandingOptions,
  ticket: TicketRecord,
  pr: PullRequest,
  pass: RepoPass,
  mirror: () => Promise<LandingMirror>,
  handedOn: LandingRunKey[],
): Promise<void> {
  const { store, log } = options;
  const calls = store.callsForTicket(ticket.id);
  const criteria = criteriaInForce(calls);
  if (notCheckable(pr, pass.head.branch, criteria) !== null || criteria === null) return;
  // A PR from an account that does not count is not checked; following the ticket's PRs comments on it once.
  if (!countsAsExecutor(pass.repo, repoSettingsOf(pass.settings), pr.author)) return;

  const report = await pass.forge.checks(pr.number, pr.headSha, namedChecks(criteria));
  const comments = await pass.forge.pullRequestComments(pr.number);
  const evidence = latestEvidence(pr, comments);
  const trigger = landingTrigger({
    pr,
    defaultBranch: pass.head.branch,
    criteria,
    report,
    evidence: evidenceKey(evidence),
    done: [...landingRuns(calls), ...handedOn],
  });
  if (!trigger.run) return;
  const { key } = trigger;

  const git = await mirror();
  const head = await git.fetchPullRequestHead(pr.number, pr.headSha);
  // The PR moved since it was read: the next pass checks the new head.
  if (head.commit !== pr.headSha) return;
  const baseSha = pass.head.commit;
  const changedPaths = await git.pullRequestChangedPaths(baseSha, pr.headSha);
  const headPaths = await git.pullRequestHeadPaths(pr.headSha);
  const stage = mechanicalStage({ pr, criteria, report, changedPaths, headPaths });

  if (stage.checks.passed) {
    log.info("landing-mechanical-passed", { ticketId: ticket.id, pullRequest: pr.number, headSha: pr.headSha, criteriaVersion: key.criteriaVersion });
    if (options.afterMechanical) {
      await options.afterMechanical({ ticket, pr, pass, key, criteria, evidence, comments, report, baseSha, changedPaths, stage });
    } else {
      handedOn.push(key);
    }
    return;
  }
  await recordFailedLanding(options, ticket, pr, pass, { key, criteria, evidence, report, baseSha, changedPaths, stage });
}

/**
 * Records a landing run that failed its first stage, and posts its landing
 * comment on the PR (spec §11, ADR-0014). It uses no model.
 */
async function recordFailedLanding(
  options: LandingOptions,
  ticket: TicketRecord,
  pr: PullRequest,
  pass: RepoPass,
  run: Omit<MechanicalPass, "ticket" | "pr" | "pass" | "comments">,
): Promise<void> {
  const { key, stage } = run;
  const notMet = stage.ids.filter((id) => id.met === false).map((id) => id.id);
  const forgeFailed = stage.checks.results.filter((r) => !r.passed && (r.check === LANDING_CHECKS.checksPassed || r.check === LANDING_CHECKS.noConflicts));
  const why = [...(notMet.length > 0 ? [`${notMet.join(", ")} not met`] : []), ...forgeFailed.map((r) => r.failure ?? r.check)];
  await recordLanding(options, {
    ticket,
    pr,
    pass,
    detail: landingDetail({ ...run, pr }, { stage: "mechanical", outcome: "not-met", ids: stage.ids }),
    reason: `Landing check of PR #${pr.number} at ${pr.headSha.slice(0, 12)} failed its mechanical checks: ${why.join("; ")}.`,
    checks: stage.checks,
    text: failingLandingText({ wording: pass.forge.wording, issueNumber: ticket.issueNumber, headSha: pr.headSha, criteriaVersion: key.criteriaVersion, stage }),
  });
}

/** A landing call's detail for a run, with how it ended. */
export function landingDetail(
  run: Pick<MechanicalPass, "pr" | "key" | "criteria" | "evidence" | "report" | "baseSha" | "changedPaths">,
  ended: Pick<LandingDetail, "stage" | "outcome" | "ids" | "beyondCriteria">,
): LandingDetail {
  const { pr, key } = run;
  return {
    pullRequest: pr.number,
    url: pr.url,
    headSha: pr.headSha,
    baseSha: run.baseSha,
    evidence: run.evidence === null ? null : { key: key.evidence!, source: run.evidence.source, section: run.evidence.section },
    criteriaVersion: key.criteriaVersion,
    genericCriteriaVersion: run.criteria.settingsVersionId,
    ...ended,
    checkReport: run.report,
    changedPaths: run.changedPaths,
  };
}

/**
 * Records a landing run and posts its landing comment on the PR, never on the
 * issue (spec §11, ADR-0014). In one transaction it records the landing call,
 * which leaves the ticket landing, with the comment's intent; then it posts
 * the comment, which a restart settles by its hidden marker. Nothing is
 * recorded when the ticket moved since the step began, or the run was already
 * recorded. A passing run in a repo in shadow is recorded as a "would merge"
 * call. While the ticket is flagged, nothing is recorded or posted, and the
 * run is kept by the hold (ADR-0016).
 *
 * @returns the call recorded, or null when nothing was.
 */
export async function recordLanding(
  options: Pick<LandingOptions, "store" | "log" | "hold">,
  run: {
    ticket: TicketRecord;
    pr: Pick<PullRequest, "number" | "headSha">;
    pass: RepoPass;
    detail: LandingDetail;
    reason: string;
    checks: LandingChecks;
    challenge?: unknown;
    modelRuns?: NewModelRun[];
    /** The landing comment's text, without the attribution line or hidden marker. */
    text: string;
    /** The call's kind: a landing call, or a shadow "would merge" call. */
    kind?: "landing" | "would-merge";
  },
): Promise<CallRecord | null> {
  const { store, log } = options;
  const { ticket, pr, pass, detail } = run;
  const ownerName = readGlobalSettings(store).settings.ownerDisplayName;
  if (ownerName === null) throw new Error("the owner's display name is not set, so entail cannot attribute a comment");
  const body = composeComment(ownerName, ticket.id, run.text);
  const key: LandingRunKey = { pullRequest: detail.pullRequest, headSha: detail.headSha, evidence: detail.evidence?.key ?? null, criteriaVersion: detail.criteriaVersion };
  if (options.hold !== undefined && (await options.hold.held(ticket, pass))) {
    options.hold.keep(run);
    log.info("landing-held-for-flag", { ticketId: ticket.id, pullRequest: pr.number, headSha: pr.headSha, criteriaVersion: key.criteriaVersion });
    return null;
  }

  const recorded = store.transaction(() => {
    if (!unmoved(store, ticket)) return null;
    if (landingRuns(store.callsForTicket(ticket.id)).some((done) => sameRun(done, key))) return null;
    const call = store.recordCall({
      ticketId: ticket.id,
      kind: run.kind ?? "landing",
      reason: run.reason,
      inputs: { prHeadSha: pr.headSha, settingsVersionId: pass.settings.id },
      checks: run.checks,
      ...(run.challenge === undefined ? {} : { challenge: run.challenge }),
      detail,
      ...(run.modelRuns === undefined ? {} : { modelRuns: run.modelRuns }),
    });
    store.recordForgeWriteIntent({ repoId: pass.repo.id, ticketId: ticket.id, callId: call.id, kind: "comment", target: "pr", number: pr.number, payload: { body } });
    return call;
  });
  if (recorded === null) return null;
  const notMet = detail.ids.filter((id) => id.met === false).map((id) => id.id);
  log.info(detail.outcome === "met" ? "landing-passed-recorded" : "landing-failed", { ticketId: ticket.id, callId: recorded.id, pullRequest: pr.number, headSha: pr.headSha, stage: detail.stage, notMet });

  // Resumes the intent recorded above; the comment is found by its hidden marker if it was already posted.
  await pass.writer().comment({ ticketId: ticket.id, callId: recorded.id }, "pr", pr.number, body);
  return recorded;
}
