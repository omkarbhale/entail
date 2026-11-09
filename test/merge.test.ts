import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import { assertCommentRules } from "../src/comment-rules.ts";
import type { CriteriaDetail, Criterion } from "../src/criteria.ts";
import type { Actor, ChangeBatch, Check, CheckReport, Issue, MergeMethod, MergeOutcome, PullRequest, PullRequestComment } from "../src/forge/forge.ts";
import { LANDING_CHECKS, landingPlanner, type LandingChecks, type LandingMirror } from "../src/landing.ts";
import { landingGrader, type GradeMirror, type LandingChallengeOutput } from "../src/landing-grade.ts";
import { isIssueEdit, recordedIssueText } from "../src/issue-edit.ts";
import {
  landingMerger,
  mergeGuard,
  passingClosing,
  refusalText,
  type ChangesBeforeMerge,
  type MergeDetail,
  type MergeMirror,
  type PassingLandingDetail,
  type ProcessChanges,
} from "../src/merge.ts";
import { ModelRuns } from "../src/model-runs.ts";
import type { GradeOutput } from "../src/model-schemas.ts";
import { Passes } from "../src/pass.ts";
import { pullRequestFollowing } from "../src/pull-requests.ts";
import { repoSettingsOf, type GenericCriterion } from "../src/repo-settings.ts";
import { ScriptedRunner } from "../src/scripted-runner.ts";
import type { CallRecord, RepoRecord, TicketRecord } from "../src/store.ts";
import { actor, IntakeForge, issue, passSetup, type PassSetup } from "./pass-fixture.ts";

const EXECUTOR = actor(2001, "executor");
const REPORTER = actor(3001, "reporter");

const C1: Criterion = {
  id: "C1",
  sentence: "Running tally with no file reads standard input.",
  source: { kind: "issue", ref: null },
  checks: [{ kind: "changes_path", argument: "src/**" }],
  states_reading: null,
};
const G1: GenericCriterion = { id: "G1", sentence: "The check `test` passes.", check: { kind: "check_passes", argument: "test" }, source: ".github/workflows/ci.yml" };

function criteriaDetail(settingsVersionId: number): CriteriaDetail {
  return {
    outcome: "criteria",
    verdictCallId: 1,
    version: 1,
    criteria: [C1],
    genericCriteria: [G1],
    settingsVersionId,
    product_call: null,
    verdict: "unopposed",
    why_unopposed: "Nothing in the vision speaks to it.",
    reading_chosen: { id: "R1", reading: "Read standard input when no file is given.", observed_outcome: "`echo a b | tally` prints 2." },
    fences: [],
  };
}

const EVIDENCE = ["Reads standard input.", "", "## entail evidence", "", "C1: ran `echo a b | tally` — it printed 2", "G1: ran `npm test` — 14 passed"].join("\n");

const GOOD_GRADE: GradeOutput = {
  results: [
    { id: "C1", result: "met", evidence: ["C1: ran `echo a b | tally` — it printed 2"], reason: "C1 holds." },
    { id: "G1", result: "met", evidence: ["test: passed"], reason: "G1 holds." },
  ],
  beyond_criteria: [],
  reason: "Every criterion is met.",
};
const UPHELD: LandingChallengeOutput = { outcome: "upheld", objections: [], reason: "Nothing to object to." };

function check(name: string, status: Check["status"], reported = true): Check {
  return { name, status, reported, url: null };
}

function headOf(number: number): string {
  return String(number).padStart(4, "0").padEnd(40, "f");
}

const LIVE_PR: Pick<PullRequest, "state" | "draft" | "headSha" | "mergeable" | "conflicts"> = {
  state: "open",
  draft: false,
  headSha: headOf(12),
  mergeable: true,
  conflicts: false,
};
const GREEN: CheckReport = { sha: headOf(12), checks: [check("test", "passed")], required: [{ name: "test", reported: true }] };

// The merge guard, read live at the pinned head.

test("the merge guard lets a merge through only for an open, ready, mergeable PR at the pinned head with every check green and every required check reported", () => {
  const go = mergeGuard({ pinnedSha: headOf(12), pr: LIVE_PR, report: GREEN });
  assert.equal(go.verdict, "merge");
  assert.ok(go.verdict === "merge" && go.results.every((r) => r.passed));
  assert.deepEqual(
    go.verdict === "merge" ? go.results.map((r) => r.check) : [],
    [LANDING_CHECKS.guardOpen, LANDING_CHECKS.guardMergeable, LANDING_CHECKS.guardChecks],
  );
});

test("the merge guard drops a run whose PR closed, merged or moved since it was checked", () => {
  assert.deepEqual(mergeGuard({ pinnedSha: headOf(12), pr: { ...LIVE_PR, state: "closed" }, report: GREEN }), { verdict: "stale", why: "it is closed" });
  assert.equal(mergeGuard({ pinnedSha: headOf(12), pr: { ...LIVE_PR, state: "merged" }, report: GREEN }).verdict, "stale");
  const moved = mergeGuard({ pinnedSha: headOf(12), pr: { ...LIVE_PR, headSha: headOf(99) }, report: GREEN });
  assert.equal(moved.verdict, "stale");
  assert.match(moved.verdict === "stale" ? moved.why : "", /its head moved/);
});

test("the merge guard holds, with nothing posted, while the PR is a draft, a check is pending, a required check has not reported or mergeability is unknown", () => {
  const hold = (pr: Partial<typeof LIVE_PR>, report: CheckReport = GREEN) => mergeGuard({ pinnedSha: headOf(12), pr: { ...LIVE_PR, ...pr }, report });
  assert.deepEqual(hold({ draft: true }), { verdict: "hold", why: "it is a draft" });
  assert.match(JSON.stringify(hold({}, { ...GREEN, checks: [check("test", "passed"), check("lint", "pending")] })), /checks are pending: lint/);
  assert.match(JSON.stringify(hold({}, { ...GREEN, required: [{ name: "build", reported: false }] })), /required checks have not reported: build/);
  assert.equal(hold({ mergeable: null, conflicts: null }).verdict, "hold");
  assert.equal(hold({}, { ...GREEN, sha: headOf(99) }).verdict, "hold", "checks read at another sha say nothing about the pinned head");
});

test("the merge guard refuses a PR that conflicts, that the forge would not merge, or with a check that failed at the head", () => {
  const refuse = (pr: Partial<typeof LIVE_PR>, report: CheckReport = GREEN) => mergeGuard({ pinnedSha: headOf(12), pr: { ...LIVE_PR, ...pr }, report });
  const conflicts = refuse({ mergeable: false, conflicts: true });
  assert.equal(conflicts.verdict, "refuse");
  assert.deepEqual(conflicts.verdict === "refuse" ? conflicts.failures : [], ["The PR conflicts with its base."]);
  const blocked = refuse({ mergeable: false });
  assert.deepEqual(blocked.verdict === "refuse" ? blocked.failures : [], ["The forge would not merge the PR at this head."]);
  const red = refuse({}, { ...GREEN, checks: [check("test", "failed"), check("lint", "pending")] });
  assert.deepEqual(red.verdict === "refuse" ? red.failures : [], ["`test` failed at this head."], "a failed check refuses even with another still pending");
  assert.equal(red.verdict === "refuse" && red.results.find((r) => r.check === LANDING_CHECKS.guardChecks)?.passed, false);
});

test("the issue re-read compares the live title and body with the text the ticket's latest call judged", () => {
  const call = (inputs: CallRecord["inputs"]) => ({ inputs }) as CallRecord;
  assert.equal(recordedIssueText([]), null);
  const recorded = recordedIssueText([call({ issueTitle: "Old", issueBody: "Old body" }), call({ prHeadSha: "abc" }), call({ issueTitle: "Read stdin", issueBody: "Body" })]);
  assert.deepEqual(recorded, { title: "Read stdin", body: "Body" });
  assert.equal(isIssueEdit(recorded!, { title: "Read stdin", body: "Body" }), false);
  assert.equal(isIssueEdit(recorded!, { title: "Read stdin ", body: "Body\n" }), false, "whitespace alone is no edit");
  assert.equal(isIssueEdit(recorded!, { title: "Read stdin", body: "Body, edited" }), true);
  assert.equal(isIssueEdit(recorded!, { title: "Read standard input", body: "Body" }), true);
});

test("a passing landing comment ends by saying what entail does about the merge", () => {
  const wording = { pullRequest: "merge request" };
  const sha = headOf(12);
  assert.equal(passingClosing(wording, sha, { decision: "merging" }), `Merging at \`${sha}\`.`);
  assert.equal(passingClosing(wording, sha, { decision: "shadow" }), `Would merge at \`${sha}\`; this repo is in shadow, so the merge is left to the owner.`);
  assert.equal(
    passingClosing(wording, sha, { decision: "waiting", issues: [2, 3] }),
    `This merge request also links #2 and #3, so it merges only once it passes their criteria at \`${sha}\` too.`,
  );
  assert.equal(passingClosing(wording, sha, { decision: "no-criteria", issues: [4] }), `This merge request also links #4, which has no criteria in force, so entail does not merge it at \`${sha}\`.`);
  assert.match(refusalText(wording, sha, { by: "forge", why: "At least 1 approving review is required\n/merge" }), /^The forge refused to merge this merge request at `[0-9a-f]+`: At least 1 approving review is required \/merge\./);
});

// The merge on the pass.

class MergeForge extends IntakeForge {
  prs: PullRequest[] = [];
  readonly links = new Map<number, number[]>();
  readonly checksAt = new Map<string, Check[]>();
  readonly merges: { number: number; sha: string; method: MergeMethod | undefined }[] = [];
  /** What the next merges answer instead of merging. */
  refusal: string | null = null;
  /** Whether the forge closes the PR's issues when it merges, as GitHub does by default. */
  closesOnMerge = false;
  /** The live mergeability the next reads report. */
  live: Pick<PullRequest, "mergeable" | "conflicts"> = { mergeable: true, conflicts: false };

  override async changesSince(): Promise<ChangeBatch> {
    const batch = await super.changesSince();
    return { changes: [...batch.changes, ...this.prs.map((pr) => ({ kind: "pull-request" as const, id: pr.id, updatedAt: pr.updatedAt, pullRequest: this.#now(pr) }))], cursor: batch.cursor };
  }

  #now(pr: PullRequest): PullRequest {
    return { ...pr, state: this.state.prs[pr.number]?.state ?? pr.state };
  }

  override async linkedPullRequests(issueNumber: number): Promise<PullRequest[]> {
    return this.prs.filter((pr) => this.links.get(pr.number)?.includes(issueNumber)).map((pr) => this.#now(pr));
  }

  override async linkedIssues(pullRequestNumber: number): Promise<number[]> {
    return this.links.get(pullRequestNumber) ?? [];
  }

  override async pullRequest(number: number): Promise<PullRequest> {
    const pr = this.prs.find((p) => p.number === number);
    if (!pr) throw new Error(`no PR #${number}`);
    return { ...this.#now(pr), ...this.live };
  }

  override async checks(_pullRequestNumber: number, sha: string, named: readonly string[]): Promise<CheckReport> {
    const checks = [...(this.checksAt.get(sha) ?? [])];
    for (const name of named) if (!checks.some((c) => c.name === name)) checks.push(check(name, "pending", false));
    return { sha, checks: checks.sort((a, b) => a.name.localeCompare(b.name)), required: [] };
  }

  override async pullRequestComments(): Promise<PullRequestComment[]> {
    return [];
  }

  override async issue(issueNumber: number): Promise<Issue | null> {
    const found = this.issues.find((i) => i.number === issueNumber);
    if (!found) return null;
    return { ...found, state: this.state.closed[issueNumber] ? "closed" : "open" };
  }

  override async merge(prNumber: number, sha: string, method?: MergeMethod): Promise<MergeOutcome> {
    this.merges.push({ number: prNumber, sha, method });
    if (this.refusal !== null) return { merged: false, refusal: this.refusal };
    const outcome = await super.merge(prNumber, sha);
    if (outcome.merged && this.closesOnMerge) {
      for (const issueNumber of this.links.get(prNumber) ?? []) this.state.closed[issueNumber] ??= "completed";
    }
    return outcome;
  }

  open(number: number, issues: number[], author: Actor = EXECUTOR): void {
    this.links.set(number, issues);
    const pr: PullRequest = {
      id: 7000 + number,
      number,
      title: "Read standard input",
      body: EVIDENCE,
      state: "open",
      draft: false,
      mergeable: null,
      conflicts: null,
      headSha: headOf(number),
      baseBranch: "main",
      author,
      createdAt: "2026-11-09T00:00:00.000Z",
      updatedAt: "2026-11-09T00:00:01.000Z",
      url: `https://github.com/acme/tally/pull/${number}`,
    };
    this.prs.push(pr);
    this.state.prs[number] = { state: "open", headSha: pr.headSha, mergeCommitSha: null };
    this.checksAt.set(headOf(number), [check("test", "passed")]);
  }

  prComments(number: number): string[] {
    return (this.state.comments[`pr:${number}`] ?? []).map((c) => c.body);
  }
}

interface Harness {
  setup: PassSetup;
  repo: RepoRecord;
  forge: MergeForge;
  runner: ScriptedRunner;
  /** The default branch head the merge guard's re-read finds, and VISION.md's blob at each commit. */
  vision: { head: string; blobs: Map<string, string> };
  processed: ChangesBeforeMerge[];
  pass(times?: number): Promise<void>;
  cleared(issueNumber: number, options?: { grades?: number }): TicketRecord;
  calls(ticketId: number, kind?: CallRecord["kind"]): CallRecord[];
  state(ticketId: number): TicketRecord["state"];
  settings(change: Partial<ReturnType<typeof repoSettingsOf>>): void;
}

async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!done()) {
    if (performance.now() > deadline) assert.fail(`timed out waiting until ${what}`);
    await immediate();
  }
}

function harness(t: TestContext, options: { processChanges?: ProcessChanges; noFlagging?: boolean } = {}): Harness {
  const setup = passSetup(t);
  const repo = setup.enroll();
  const forge = new MergeForge();
  const runner = new ScriptedRunner();
  const vision = { head: "c0ffee", blobs: new Map([["c0ffee", "blob-1"]]) };
  const processed: ChangesBeforeMerge[] = [];
  const mirror: LandingMirror & GradeMirror & MergeMirror = {
    fetchPullRequestHead: async (_number, expected) => ({ commit: expected!, fetched: false }),
    pullRequestChangedPaths: async () => ["src/cli.js"],
    pullRequestDiff: async () => "diff --git a/src/cli.js b/src/cli.js\n+const input = readStdin();\n",
    checkout: async (commit) => ({ directory: `/checkouts/${commit}`, commit, dropped: [] }),
    updateDefaultBranch: async () => ({ branch: "main", commit: vision.head }),
    visionBlob: async (commit) => vision.blobs.get(commit) ?? null,
  };
  const merger = landingMerger({
    store: setup.store,
    log: setup.log,
    dataDirectory: setup.dataDirectory,
    mirrorFor: async () => mirror,
    ...(options.noFlagging
      ? {}
      : {
          processChanges: async (input: Parameters<ProcessChanges>[0]) => {
            processed.push(input.changes);
            return options.processChanges ? options.processChanges(input) : { flagged: false };
          },
        }),
  });
  const grader = landingGrader({ store: setup.store, log: setup.log, dataDirectory: setup.dataDirectory, mirrorFor: async () => mirror, afterGrade: merger.afterGrade });
  const following = pullRequestFollowing({ store: setup.store, log: setup.log });
  const landing = landingPlanner({ store: setup.store, log: setup.log, dataDirectory: setup.dataDirectory, mirrorFor: async () => mirror, afterMechanical: merger.reusingHeld(grader) });
  const engine = new Passes({
    store: setup.store,
    log: setup.log,
    dataDirectory: setup.dataDirectory,
    forgeFor: () => forge,
    defaultBranchFor: async () => ({ updateDefaultBranch: async () => ({ branch: "main", commit: "c0ffee", fetched: false }) }),
    planners: [merger.planner, following.planner, landing],
    changeHandlers: [following.onChange],
    modelRuns: new ModelRuns({ runner, log: setup.log }),
  });
  t.after(() => engine.stop());
  const idle = () => until(() => engine.stepsRunning === 0, "every step started has finished");
  return {
    setup,
    repo,
    forge,
    runner,
    vision,
    processed,
    async pass(times = 1) {
      for (let i = 0; i < times; i++) {
        await engine.runPass();
        await idle();
      }
    },
    cleared(issueNumber, { grades = 1 } = {}) {
      const ticket = setup.store.takeIn({ repoId: repo.id, issueNumber });
      const settings = setup.store.latestSettings(repo.id)!;
      forge.issues.push(issue(issueNumber, { title: `Issue ${issueNumber}`, body: "Read standard input when no file is given.", author: REPORTER }));
      setup.store.recordCall({
        ticketId: ticket.id,
        kind: "criteria",
        reason: "Cleared for the test.",
        inputs: { issueTitle: `Issue ${issueNumber}`, issueBody: "Read standard input when no file is given." },
        detail: criteriaDetail(settings.id),
        stateTo: "cleared",
      });
      forge.state.labels[issueNumber] = ["entail:cleared"];
      for (let i = 0; i < grades; i++) {
        runner.script("grade", String(ticket.id), { output: GOOD_GRADE });
        runner.script("landing-challenge", String(ticket.id), { output: UPHELD });
      }
      return setup.store.getTicket(ticket.id)!;
    },
    calls: (ticketId, kind) => setup.store.callsForTicket(ticketId).filter((call) => kind === undefined || call.kind === kind),
    state: (ticketId) => setup.store.getTicket(ticketId)!.state,
    settings(change) {
      const latest = setup.store.latestSettings(repo.id)!;
      setup.store.saveSettings(repo.id, { ...repoSettingsOf(latest), ...change }, "Ada");
    },
  };
}

test("a passing PR merges pinned to the checked sha with the repo's merge method, after a landing comment ending \"merging at\"; entail closes the issue the forge left open and removes the label", async (t) => {
  const h = harness(t);
  const ticket = h.cleared(1);
  h.forge.open(12, [1]);
  await h.pass(3);

  assert.deepEqual(h.forge.merges, [{ number: 12, sha: headOf(12), method: "squash" }], "one merge, pinned to the checked head, with the method set at enrollment");
  const [landingComment, ...more] = h.forge.prComments(12);
  assert.deepEqual(more, [], "one comment on the PR, never a second for the merge");
  assertCommentRules(landingComment!, "Ada", ticket.id);
  assert.match(landingComment!, new RegExp(`it passes\\.[\\s\\S]*Merging at \`${headOf(12)}\`\\.\\n\\n<!-- entail ticket ${ticket.id} -->$`));
  assert.equal(h.forge.state.prs[12]!.state, "merged");

  assert.equal(h.state(ticket.id), "merged");
  const [landing] = h.calls(ticket.id, "landing");
  const detail = landing!.detail as PassingLandingDetail;
  assert.equal(detail.outcome, "met");
  assert.deepEqual(detail.merge, { decision: "merging" });
  const checks = landing!.checks as LandingChecks;
  assert.equal(checks.passed, true);
  assert.ok(checks.results.some((r) => r.check === LANDING_CHECKS.guardMergeable), "the merge guard's results are recorded with the landing check's");
  assert.deepEqual(landing!.modelRuns.map((r) => r.purpose), ["grade", "landing-challenge"]);

  const [merge, ...moreMerges] = h.calls(ticket.id, "merge");
  assert.deepEqual(moreMerges, []);
  assert.deepEqual(merge!.stateChange, { from: "landing", to: "merged" });
  const mergeDetail = merge!.detail as MergeDetail;
  assert.equal(mergeDetail.outcome, "merged");
  assert.equal(mergeDetail.landingCallId, landing!.id);
  assert.equal(mergeDetail.headSha, headOf(12));
  assert.equal(mergeDetail.mergeCommitSha, `merge-of-${headOf(12)}`);
  assert.equal(merge!.inputs?.prHeadSha, headOf(12));

  assert.equal(h.forge.state.closed[1], "completed", "entail closed the issue the forge did not");
  assert.deepEqual(h.forge.state.labels[1], [], "and removed entail:cleared");
  assert.equal(h.forge.state.sends.close, 1);
  assert.deepEqual(h.processed, [{ vision: null, issues: [] }], "flagging is asked even when nothing changed, so a ticket already flagged holds");
});

test("when the forge closes the issue on merge, entail does not close it again but still removes the label", async (t) => {
  const h = harness(t);
  const ticket = h.cleared(1);
  h.forge.closesOnMerge = true;
  h.forge.open(12, [1]);
  await h.pass(3);

  assert.equal(h.state(ticket.id), "merged");
  assert.equal(h.forge.state.sends.close, 0, "the forge already closed it");
  assert.deepEqual(h.forge.state.labels[1], []);
  assert.deepEqual(
    h.setup.store.forgeWritesForCall(h.calls(ticket.id, "merge")[0]!.id).map((w) => w.kind),
    ["label"],
  );
});

test("a merge the forge refuses leaves the ticket landing and gets one comment saying why, never repeated", async (t) => {
  const h = harness(t);
  const ticket = h.cleared(1);
  h.forge.refusal = "At least 1 approving review is required by reviewers with write access.";
  h.forge.open(12, [1]);
  await h.pass(5);

  assert.equal(h.forge.merges.length, 1, "asked once");
  assert.equal(h.state(ticket.id), "landing");
  const [landingComment, refusal, ...more] = h.forge.prComments(12);
  assert.deepEqual(more, []);
  assert.match(landingComment!, /Merging at `/);
  assertCommentRules(refusal!, "Ada", ticket.id);
  assert.match(refusal!, /The forge refused to merge this pull request at `[0-9a-f]{40}`: At least 1 approving review is required by reviewers with write access\.\n\nIt passed its landing check, but it is not merged\./);
  const [merge] = h.calls(ticket.id, "merge");
  assert.equal(merge!.stateChange, null);
  assert.deepEqual((merge!.detail as MergeDetail).refusal, { by: "forge", why: h.forge.refusal });
  assert.equal(h.forge.state.closed[1], undefined);
  assert.deepEqual(h.forge.state.labels[1], ["entail:cleared"]);
  assert.equal(h.runner.requests.length, 2, "not graded again at the same head");
});

test("a merge guard that cannot say yet holds the run with nothing posted, and a later pass merges with the same grade", async (t) => {
  const h = harness(t);
  const ticket = h.cleared(1);
  h.forge.live = { mergeable: null, conflicts: null };
  h.forge.open(12, [1]);
  await h.pass(4);

  assert.deepEqual(h.forge.prComments(12), [], "nothing posted while held");
  assert.deepEqual(h.calls(ticket.id, "landing"), []);
  assert.equal(h.runner.requests.length, 2, "graded once, and the held grade is not graded again");
  assert.ok(h.setup.logLines().some((line) => line.event === "merge-guard-hold"));

  h.forge.live = { mergeable: true, conflicts: false };
  await h.pass();
  assert.equal(h.state(ticket.id), "merged");
  assert.equal(h.runner.requests.length, 2, "the held grade was reused, with no extra model runs");
  assert.equal(h.forge.prComments(12).length, 1);
});

test("a merge guard that says no fails the landing check with one comment naming the forge's state, and nothing merges", async (t) => {
  const h = harness(t);
  const ticket = h.cleared(1);
  h.forge.live = { mergeable: false, conflicts: true };
  h.forge.open(12, [1]);
  await h.pass(4);

  assert.deepEqual(h.forge.merges, []);
  const [body, ...more] = h.forge.prComments(12);
  assert.deepEqual(more, []);
  assert.match(body!, /it does not pass: the forge's state at this head does not allow a merge\./);
  assert.match(body!, /\*\*The forge's state at this head\*\*\n\n- Not met: The PR conflicts with its base\./);
  assert.match(body!, /will not be merged at/);
  assert.doesNotMatch(body!, /merging at/i);
  const [landing] = h.calls(ticket.id, "landing");
  const detail = landing!.detail as PassingLandingDetail;
  assert.equal(detail.stage, "merge-guard");
  assert.equal(detail.outcome, "not-met");
  assert.equal(h.state(ticket.id), "landing");
});

test("just before merging, a changed VISION.md blob or issue text is processed first, and a flagged ticket's PR does not merge until the flag clears", async (t) => {
  let flagged = true;
  const h = harness(t, { processChanges: async () => ({ flagged }) });
  const ticket = h.cleared(1);
  h.forge.open(12, [1]);
  // The default branch moved after the pass read it, changing VISION.md, and the issue was edited.
  h.vision.head = "beef01";
  h.vision.blobs.set("beef01", "blob-2");
  h.forge.issues[0] = { ...h.forge.issues[0]!, body: "Read standard input, and also from a URL." };
  await h.pass(3);

  assert.deepEqual(h.forge.merges, [], "a flagged ticket's PR does not merge");
  assert.deepEqual(h.forge.prComments(12), [], "and posts nothing for the hold");
  const [changes] = h.processed;
  assert.deepEqual(changes!.vision, { fromCommit: "c0ffee", toCommit: "beef01", fromBlob: "blob-1", toBlob: "blob-2" });
  assert.deepEqual(changes!.issues.map((i) => [i.ticket.id, i.recorded.body, i.current.body]), [[ticket.id, "Read standard input when no file is given.", "Read standard input, and also from a URL."]]);

  flagged = false;
  await h.pass();
  assert.equal(h.state(ticket.id), "merged", "once the re-check lets it go ahead, it merges");
  assert.equal(h.runner.requests.length, 2, "with the grade it already had");
});

test("a default branch that moved without touching VISION.md is no vision change", async (t) => {
  const h = harness(t);
  const ticket = h.cleared(1);
  h.forge.open(12, [1]);
  h.vision.head = "beef01";
  h.vision.blobs.set("beef01", "blob-1");
  await h.pass(3);
  assert.equal(h.state(ticket.id), "merged");
  assert.deepEqual(h.processed, [{ vision: null, issues: [] }]);
});

test("with no flagging wired in, a change found just before merging is logged and flags nothing, so the PR merges", async (t) => {
  const h = harness(t, { noFlagging: true });
  const ticket = h.cleared(1);
  h.forge.open(12, [1]);
  h.vision.head = "beef01";
  h.vision.blobs.set("beef01", "blob-2");
  await h.pass(3);
  assert.equal(h.state(ticket.id), "merged");
  const logged = h.setup.logLines().find((line) => line.event === "merge-guard-changes");
  assert.deepEqual(logged?.vision, { fromCommit: "c0ffee", toCommit: "beef01", fromBlob: "blob-1", toBlob: "blob-2" });
  assert.equal(logged?.processed, false);
});

test("a linked issue closed before the merge holds the merge", async (t) => {
  const h = harness(t);
  const ticket = h.cleared(1);
  h.forge.open(12, [1]);
  h.forge.state.closed[1] = "completed";
  await h.pass(3);
  assert.deepEqual(h.forge.merges, []);
  assert.deepEqual(h.forge.prComments(12), []);
  assert.equal(h.state(ticket.id), "landing");
});

test("with two PRs for one ticket the first to pass merges, and the other gets one \"already merged\" comment and is neither checked nor closed", async (t) => {
  const h = harness(t);
  const ticket = h.cleared(1, { grades: 2 });
  h.forge.open(12, [1]);
  h.forge.open(13, [1]);
  await h.pass(4);

  assert.deepEqual(h.forge.merges.map((m) => m.number), [12]);
  assert.equal(h.state(ticket.id), "merged");
  const [already, ...more] = h.forge.prComments(13);
  assert.deepEqual(more, [], "once");
  assertCommentRules(already!, "Ada", ticket.id);
  assert.match(already!, /#1 is already merged through \[#12\]\(https:\/\/github\.com\/acme\/tally\/pull\/12\)\.\n\nentail no longer checks this pull request, and does not close it\./);
  assert.equal(h.forge.state.prs[13]!.state, "open", "not closed");
  assert.equal(h.runner.requests.length, 2, "the other PR was never graded");
  assert.deepEqual(h.calls(ticket.id, "landing").map((c) => (c.detail as PassingLandingDetail).pullRequest), [12]);
});

test("a PR linking several tickets merges only once it passes every linked ticket's criteria, ending them all as merged", async (t) => {
  const h = harness(t);
  const first = h.cleared(1);
  const second = h.cleared(2);
  h.forge.open(12, [1, 2]);
  await h.pass(4);

  assert.deepEqual(h.forge.merges.map((m) => m.number), [12], "merged once");
  assert.equal(h.state(first.id), "merged");
  assert.equal(h.state(second.id), "merged");
  const decisions = [first, second].map((t) => (h.calls(t.id, "landing")[0]!.detail as PassingLandingDetail).merge.decision).sort();
  assert.deepEqual(decisions, ["merging", "waiting"], "the first to pass waits for the other, which merges");
  const comments = h.forge.prComments(12);
  assert.equal(comments.length, 2, "one landing comment per linked ticket");
  assert.ok(comments.some((c) => /merges only once it passes its criteria at `[0-9a-f]{40}` too\./.test(c)));
  assert.ok(comments.some((c) => /Merging at `/.test(c)));
  assert.equal(h.forge.state.closed[1], "completed");
  assert.equal(h.forge.state.closed[2], "completed");
  for (const t of [first, second]) assert.equal(h.calls(t.id, "merge").length, 1);
});

test("a PR linking an issue with no criteria in force does not merge, and its landing comment says so", async (t) => {
  const h = harness(t);
  const ticket = h.cleared(1);
  h.forge.issues.push(issue(5, { author: REPORTER }));
  h.forge.open(12, [1, 5]);
  await h.pass(4);

  assert.deepEqual(h.forge.merges, []);
  const [body, ...more] = h.forge.prComments(12);
  assert.deepEqual(more, []);
  assert.match(body!, /This pull request also links #5, which has no criteria in force, so entail does not merge it at `[0-9a-f]{40}`\.\n\n<!--/);
  assert.deepEqual((h.calls(ticket.id, "landing")[0]!.detail as PassingLandingDetail).merge, { decision: "no-criteria", issues: [5] });
  assert.equal(h.state(ticket.id), "landing");
});

test("in shadow a passing PR gets a \"would merge\" call and comment, with no merge, board item or notice; switching shadow off does not merge it, and the owner's merge is recorded", async (t) => {
  const h = harness(t);
  h.settings({ shadow: true });
  const ticket = h.cleared(1);
  h.forge.open(12, [1]);
  await h.pass(4);

  assert.deepEqual(h.forge.merges, []);
  const [body, ...more] = h.forge.prComments(12);
  assert.deepEqual(more, []);
  assert.match(body!, new RegExp(`Would merge at \`${headOf(12)}\`; this repo is in shadow, so the merge is left to the owner\\.\\n\\n<!--`));
  const [wouldMerge, ...moreCalls] = h.calls(ticket.id, "would-merge");
  assert.deepEqual(moreCalls, []);
  assert.deepEqual((wouldMerge!.detail as PassingLandingDetail).merge, { decision: "shadow" });
  assert.deepEqual(h.calls(ticket.id, "landing"), []);
  assert.equal(h.setup.store.openBoardItem(ticket.id), null);
  assert.equal(h.state(ticket.id), "landing");

  h.settings({ shadow: false });
  await h.pass(3);
  assert.deepEqual(h.forge.merges, [], "switching shadow off never merges a PR that already got the comment");
  assert.equal(h.forge.prComments(12).length, 1);
  assert.equal(h.runner.requests.length, 2);

  // The owner merges it by hand.
  h.forge.state.prs[12] = { ...h.forge.state.prs[12]!, state: "merged" };
  h.forge.prs[0] = { ...h.forge.prs[0]!, updatedAt: new Date().toISOString() };
  await h.pass(2);
  assert.equal(h.state(ticket.id), "merged");
  assert.equal(h.calls(ticket.id, "merged-by-others").length, 1);
});

test("a merge that went through before a restart is recorded as entail's own merge, not as someone else's", async (t) => {
  const h = harness(t);
  const ticket = h.cleared(1);
  h.forge.open(12, [1]);
  await h.pass(); // to landing
  // As if entail recorded its passing landing call and merged, then stopped before recording the merge.
  const settings = h.setup.store.latestSettings(h.repo.id)!;
  const landing = h.setup.store.recordCall({
    ticketId: ticket.id,
    kind: "landing",
    reason: "Passed.",
    detail: { pullRequest: 12, url: "https://github.com/acme/tally/pull/12", headSha: headOf(12), criteriaVersion: 1, evidence: null, outcome: "met", stage: "challenge", merge: { decision: "merging" } },
    inputs: { prHeadSha: headOf(12), settingsVersionId: settings.id },
  });
  const intent = h.setup.store.recordForgeWriteIntent({ repoId: h.repo.id, ticketId: ticket.id, callId: landing.id, kind: "merge", target: "pr", number: 12, payload: { sha: headOf(12), method: "squash" } });
  h.forge.state.prs[12] = { state: "merged", headSha: headOf(12), mergeCommitSha: "m1" };
  h.setup.store.confirmForgeWrite({ intentId: intent.id, result: { outcome: "merged", mergeCommitSha: "m1", settled: "read the PR's state" } });
  await h.pass();

  assert.equal(h.state(ticket.id), "merged");
  assert.deepEqual(h.calls(ticket.id, "merged-by-others"), []);
  const [merge] = h.calls(ticket.id, "merge");
  assert.equal((merge!.detail as MergeDetail).landingCallId, landing.id);
  assert.equal((merge!.detail as MergeDetail).mergeCommitSha, "m1");
  assert.equal(h.forge.merges.length, 0, "the merge is not sent again");
  assert.equal(h.runner.requests.length, 0);
});
