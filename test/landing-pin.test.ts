import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import { afterAnswerPlanner, answersInForce, pinsSeen, verdictCallOfRaise } from "../src/after-answer.ts";
import { answerOutcome, answerPostsComment, recordBoardAnswer, type ChosenAnswer } from "../src/answer.ts";
import { decisionSentence, whyRaised, type BoardItemSnapshot } from "../src/board-item.ts";
import { assertCommentRules } from "../src/comment-rules.ts";
import { criteriaInForce, owedAnsweredCriteria, type CriteriaDetail, type Criterion } from "../src/criteria.ts";
import { judgedPins, type RecordedVerdict } from "../src/decider.ts";
import type { Actor, ChangeBatch, Check, CheckReport, Issue, MergeMethod, MergeOutcome, PullRequest, PullRequestComment } from "../src/forge/forge.ts";
import type { LandingMirror } from "../src/landing.ts";
import { landingPlanner } from "../src/landing.ts";
import { landingGrader, type GradeMirror, type LandingChallengeOutput } from "../src/landing-grade.ts";
import { MERGE_AS_IS, pinnedPathsToRaise, pinnedPathsTouched, landingPinRaising } from "../src/landing-pin.ts";
import { landingMerger, passingClosing, type MergeDetail, type MergeMirror, type PassingLandingDetail } from "../src/merge.ts";
import { Mirror } from "../src/mirror.ts";
import type { GradeOutput } from "../src/model-schemas.ts";
import { ModelRuns } from "../src/model-runs.ts";
import { Notifier, NOTICES_FILE } from "../src/notice.ts";
import { Passes } from "../src/pass.ts";
import { pullRequestFollowing } from "../src/pull-requests.ts";
import { repoSettingsOf, type GenericCriterion, type Pin } from "../src/repo-settings.ts";
import { ScriptedRunner } from "../src/scripted-runner.ts";
import type { CallRecord, RepoRecord, TicketRecord } from "../src/store.ts";
import { FixtureRepo } from "./git-fixture.ts";
import { actor, IntakeForge, issue, passSetup, type PassSetup } from "./pass-fixture.ts";

const EXECUTOR = actor(2001, "executor");
const REPORTER = actor(3001, "reporter");
const ORIGIN = "http://127.0.0.1:7419";
const VISION = "# tally\n\ntally counts the words of text files.\n";
const FORMAT_PIN: Pin = { topic: "the output format", paths: ["src/format.js"], keywords: [] };

const C1: Criterion = {
  id: "C1",
  sentence: "Running tally with no file reads standard input.",
  source: { kind: "issue", ref: null },
  checks: [{ kind: "changes_path", argument: "src/**" }],
  states_reading: null,
};
const G1: GenericCriterion = { id: "G1", sentence: "The check `test` passes.", check: { kind: "check_passes", argument: "test" }, source: ".github/workflows/ci.yml" };
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

function settledVerdict(visionSha: string): RecordedVerdict {
  return {
    size: { value: "fits", reason: "One flag." },
    readings: [{ id: "R1", reading: "Read standard input when no file is given.", observed_outcome: "`echo a b | tally` prints 2." }],
    pins_touched: [],
    vision_check: [{ line: "tally counts the words of text files.", mark: "matches" }],
    verdict: "settled",
    citations: [{ lines: ["tally counts the words of text files."], reading: "R1" }] as RecordedVerdict["citations"],
    why_unopposed: null,
    reading_chosen: null,
    why_raised: null,
    open_readings: [],
    close_evidence: [],
    questions: [],
    reason: "The vision settles it.",
    model: "m",
    session_id: null,
    vision_sha: visionSha,
    duration_ms: 1,
    estimated_cost_usd: null,
    usage: null,
    pin_matches: [],
  };
}

function criteriaDetail(settingsVersionId: number, verdictCallId: number, fields: Partial<CriteriaDetail> = {}): CriteriaDetail {
  return {
    outcome: "criteria",
    verdictCallId,
    version: 1,
    criteria: [C1],
    genericCriteria: [G1],
    settingsVersionId,
    product_call: null,
    verdict: "settled",
    why_unopposed: null,
    reading_chosen: null,
    fences: [],
    ...fields,
  };
}

function check(name: string, status: Check["status"], reported = true): Check {
  return { name, status, reported, url: null };
}

function headOf(number: number, push = 0): string {
  return `${String(number).padStart(4, "0")}${String(push).padStart(4, "0")}`.padEnd(40, "f");
}

// Which paths a pin's globs touch, and which of them raise a ticket at landing.

test("a pinned path is touched when a pin's path glob matches a changed path, VISION.md's included", () => {
  const pins = judgedPins([FORMAT_PIN, { topic: "docs", paths: ["docs/**"], keywords: ["docs"] }]);
  assert.deepEqual(pinnedPathsTouched(pins, ["src/cli.js", "src/format.js", "VISION.md", "docs/a/b.md"]), [
    { pin: "The product's vision, VISION.md", glob: "VISION.md", path: "VISION.md" },
    { pin: "the output format", glob: "src/format.js", path: "src/format.js" },
    { pin: "docs", glob: "docs/**", path: "docs/a/b.md" },
  ]);
  assert.deepEqual(pinnedPathsTouched(pins, ["src/cli.js"]), []);
});

test("an unopposed ticket's fenced criteria raise nothing, and a pin the owner's answer covered raises nothing", () => {
  const pins = judgedPins([FORMAT_PIN]);
  const changedPaths = ["src/format.js", "VISION.md"];
  assert.deepEqual(pinnedPathsToRaise({ criteria: { verdict: "unopposed", goAheadCallId: null }, pins, seen: [], changedPaths }), []);
  assert.equal(pinnedPathsToRaise({ criteria: { verdict: "settled" }, pins, seen: [], changedPaths }).length, 2);
  // Cleared by the owner's answer, an unopposed verdict's criteria carry no fences, so the pins are checked.
  assert.equal(pinnedPathsToRaise({ criteria: { verdict: "unopposed", goAheadCallId: 9 }, pins, seen: [], changedPaths }).length, 2);
  assert.deepEqual(
    pinnedPathsToRaise({ criteria: { verdict: "settled" }, pins, seen: [" the output format "], changedPaths }).map((p) => p.pin),
    ["The product's vision, VISION.md"],
  );
});

test("a landing pin item names the PR and its pinned paths, and the landing comment says the PR waits for the owner", () => {
  const paths = [{ pin: "the output format", glob: "src/format.js", path: "src/format.js" }];
  const why = whyRaised(
    { kind: "landing_pin", pullRequest: 12, paths, pins: [{ pin: "the output format", why: "PR #12 changes `src/format.js`" }] },
    { commit: "c0ffee", lines: [], unquotable: [] } as unknown as Parameters<typeof whyRaised>[1],
  );
  assert.equal(why.tag, "pin: the output format");
  assert.deepEqual(why.pinnedPaths, paths);
  assert.match(why.text, /^PR #12 passed everything else in its landing check, but it changes pinned paths: `src\/format\.js` \(the pin “the output format”, by its path `src\/format\.js`\)\./);
  assert.equal(decisionSentence(7, why), "Merge the PR for issue #7, which changes a path of the pin “the output format”?");
  const closing = passingClosing({ pullRequest: "pull request" }, headOf(12), { decision: "owner", paths });
  assert.match(closing, /^This pull request changes pinned paths, and a touched pin always comes to the owner:\n\n- `src\/format\.js`: the pin “the output format”, by its path `src\/format\.js`\n\nentail raised it to the owner and does not merge it at `[0-9a-f]{40}` until the owner decides\./);
});

test("the review says what each answer to a landing pin item does", () => {
  const snapshot = { landing: { pullRequest: 12, url: "u", headSha: headOf(12), landingCallId: 1, paths: [] } } as Partial<BoardItemSnapshot>;
  const merge = { shape: "option", optionId: MERGE_AS_IS, note: null, showNoteOnIssue: false } as const;
  assert.equal(answerOutcome(merge, "github", snapshot).state, "merged");
  assert.match(answerOutcome(merge, "github", snapshot).next[0]!, /verifies PR #12 at [0-9a-f]{12} again through the merge guard/);
  assert.equal(answerPostsComment(merge, snapshot), false);
  const own = { shape: "own-words", optionId: null, note: null, showNoteOnIssue: false } as const;
  assert.equal(answerOutcome(own, "github", snapshot).state, "deciding");
  assert.match(answerOutcome(own, "github", snapshot).next.join(" "), /new version of the criteria[\s\S]*PR #12 is then checked again/);
  assert.equal(answerPostsComment(own, snapshot), true);
  assert.equal(answerOutcome({ ...own, shape: "dont-go-ahead" }, "github", snapshot).state, "cancelled");
});

// The pin check at landing, on the pass.

class PinForge extends IntakeForge {
  prs: PullRequest[] = [];
  readonly links = new Map<number, number[]>();
  readonly checksAt = new Map<string, Check[]>();
  readonly merges: { number: number; sha: string; method: MergeMethod | undefined }[] = [];
  refusal: string | null = null;
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
    return super.merge(prNumber, sha);
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
    this.checksAt.set(pr.headSha, [check("test", "passed")]);
  }

  /** A new push to an open PR: a new head, with its checks green. */
  push(number: number, push: number): void {
    const pr = this.prs.find((p) => p.number === number)!;
    pr.headSha = headOf(number, push);
    pr.updatedAt = new Date(Date.parse(pr.updatedAt) + 1000).toISOString();
    this.state.prs[number] = { state: "open", headSha: pr.headSha, mergeCommitSha: null };
    this.checksAt.set(pr.headSha, [check("test", "passed")]);
  }

  prComments(number: number): string[] {
    return (this.state.comments[`pr:${number}`] ?? []).map((c) => c.body);
  }

  issueCommentsOn(number: number): string[] {
    return (this.state.comments[`issue:${number}`] ?? []).map((c) => c.body);
  }
}

interface Harness {
  setup: PassSetup;
  repo: RepoRecord;
  forge: PinForge;
  runner: ScriptedRunner;
  /** The paths the PRs change. */
  changed: string[];
  visionSha: string;
  pass(times?: number): Promise<void>;
  cleared(issueNumber: number, fields?: Partial<CriteriaDetail>): TicketRecord;
  grades(ticketId: number, times?: number): void;
  calls(ticketId: number, kind?: CallRecord["kind"]): CallRecord[];
  state(ticketId: number): TicketRecord["state"];
  settings(change: Partial<ReturnType<typeof repoSettingsOf>>): void;
  answer(ticketId: number, answer: Pick<ChosenAnswer, "shape" | "optionId" | "text">): void;
  notices(): Record<string, unknown>[];
}

async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!done()) {
    if (performance.now() > deadline) assert.fail(`timed out waiting until ${what}`);
    await immediate();
  }
}

async function harness(t: TestContext, options: { pins?: Pin[] } = { pins: [FORMAT_PIN] }): Promise<Harness> {
  const setup = passSetup(t);
  const repo = setup.enroll();
  const latest = () => setup.store.latestSettings(repo.id)!;
  if (options.pins) setup.store.saveSettings(repo.id, { ...repoSettingsOf(latest()), pins: options.pins }, "Ada");
  const fixture = new FixtureRepo(t);
  fixture.write("VISION.md", VISION).write("src/format.js", "export const format = (n) => String(n);\n");
  const visionSha = fixture.commit("vision");
  fixture.push();
  const boardMirror = await Mirror.open({
    dataDirectory: setup.dataDirectory,
    key: { forge: "github", host: "github.com", projectId: repo.projectId },
    remote: { url: fixture.remote, credentialHelper: null },
  });
  await boardMirror.updateDefaultBranch();
  const forge = new PinForge();
  const runner = new ScriptedRunner();
  const changed = ["src/cli.js", "src/format.js"];
  const mirror: LandingMirror & GradeMirror & MergeMirror = {
    fetchPullRequestHead: async (_number, expected) => ({ commit: expected!, fetched: false }),
    pullRequestChangedPaths: async () => [...changed],
    pullRequestDiff: async () => "diff --git a/src/cli.js b/src/cli.js\n+const input = readStdin();\n",
    checkout: async (commit) => ({ directory: `/checkouts/${commit}`, commit, dropped: [] }),
    updateDefaultBranch: async () => ({ branch: "main", commit: "c0ffee" }),
    visionBlob: async () => "blob-1",
  };
  const notifier = new Notifier({ connectorName: () => "file", dataDirectory: setup.dataDirectory, log: setup.log });
  const common = { store: setup.store, log: setup.log, dataDirectory: setup.dataDirectory };
  const pins = landingPinRaising({ ...common, notifier, boardOrigin: ORIGIN, mirrorFor: async () => boardMirror });
  const merger = landingMerger({ ...common, mirrorFor: async () => mirror, raiseForPins: pins.raise });
  const grader = landingGrader({ ...common, mirrorFor: async () => mirror, afterGrade: merger.afterGrade });
  const following = pullRequestFollowing(common);
  const engine = new Passes({
    ...common,
    forgeFor: () => forge,
    defaultBranchFor: async () => ({ updateDefaultBranch: async () => ({ branch: "main", commit: "c0ffee", fetched: false }) }),
    planners: [
      afterAnswerPlanner(common),
      merger.planner,
      following.planner,
      pins.planner,
      landingPlanner({ ...common, mirrorFor: async () => mirror, afterMechanical: merger.reusingHeld(grader) }),
    ],
    changeHandlers: [following.onChange],
    modelRuns: new ModelRuns({ runner, log: setup.log }),
  });
  t.after(() => engine.stop());
  const grades = (ticketId: number, times = 1) => {
    for (let i = 0; i < times; i++) {
      runner.script("grade", String(ticketId), { output: GOOD_GRADE });
      runner.script("landing-challenge", String(ticketId), { output: UPHELD });
    }
  };
  return {
    setup,
    repo,
    forge,
    runner,
    changed,
    visionSha,
    async pass(times = 1) {
      for (let i = 0; i < times; i++) {
        await engine.runPass();
        await until(() => engine.stepsRunning === 0, "every step started has finished");
      }
    },
    cleared(issueNumber, fields = {}) {
      const ticket = setup.store.takeIn({ repoId: repo.id, issueNumber });
      forge.issues.push(issue(issueNumber, { title: `Issue ${issueNumber}`, body: "Read standard input when no file is given.", author: REPORTER }));
      const inputs = { issueTitle: `Issue ${issueNumber}`, issueBody: "Read standard input when no file is given." };
      const verdict = setup.store.recordCall({ ticketId: ticket.id, kind: "verdict", reason: "Settled.", inputs, detail: settledVerdict(visionSha) });
      setup.store.recordCall({
        ticketId: ticket.id,
        kind: "criteria",
        reason: "Cleared for the test.",
        inputs,
        detail: criteriaDetail(latest().id, verdict.id, fields),
        stateTo: "cleared",
      });
      forge.state.labels[issueNumber] = ["entail:cleared"];
      grades(ticket.id);
      return setup.store.getTicket(ticket.id)!;
    },
    grades,
    calls: (ticketId, kind) => setup.store.callsForTicket(ticketId).filter((call) => kind === undefined || call.kind === kind),
    state: (ticketId) => setup.store.getTicket(ticketId)!.state,
    settings(change) {
      setup.store.saveSettings(repo.id, { ...repoSettingsOf(latest()), ...change }, "Ada");
    },
    answer(ticketId, answer) {
      const item = setup.store.openBoardItem(ticketId)!;
      const recorded = recordBoardAnswer(setup.store, {
        itemId: item.id,
        shownVersion: 1,
        answeredBy: "Ada",
        answer: { ...answer, note: null, showNoteOnIssue: false },
        locked: null,
      });
      assert.ok("recorded" in recorded, "the answer is recorded");
    },
    notices() {
      const path = join(setup.dataDirectory, NOTICES_FILE);
      if (!existsSync(path)) return [];
      return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
}

/** A settled ticket whose PR #12 touches the pinned `src/format.js`, raised to the board. */
async function raisedAtLanding(h: Harness): Promise<TicketRecord> {
  const ticket = h.cleared(1);
  h.forge.open(12, [1]);
  await h.pass(3);
  assert.equal(h.state(ticket.id), "on-the-board");
  return h.setup.store.getTicket(ticket.id)!;
}

test("a PR that passes everything else but touches a pinned path raises one board item naming the paths, and is not merged", async (t) => {
  const h = await harness(t);
  const ticket = await raisedAtLanding(h);

  assert.deepEqual(h.forge.merges, [], "the PR stays unmerged");
  assert.equal(h.forge.state.prs[12]!.state, "open");
  assert.deepEqual(h.runner.requests.map((r) => r.kind), ["grade", "landing-challenge"], "raised only after the grade and the challenge passed");

  const [landing, ...moreLandings] = h.calls(ticket.id, "landing");
  assert.deepEqual(moreLandings, []);
  const detail = landing!.detail as PassingLandingDetail;
  assert.equal(detail.outcome, "met");
  assert.deepEqual(detail.merge, { decision: "owner", paths: [{ pin: "the output format", glob: "src/format.js", path: "src/format.js" }] });
  const [raise, ...moreRaises] = h.calls(ticket.id, "raise");
  assert.deepEqual(moreRaises, []);
  assert.deepEqual(raise!.stateChange, { from: "landing", to: "on-the-board" });
  assert.equal(verdictCallOfRaise(raise!, h.calls(ticket.id))?.kind, "verdict", "the raise rests on the verdict of the criteria the PR was checked against");

  const [landingComment, ...morePr] = h.forge.prComments(12);
  assert.deepEqual(morePr, [], "one landing comment on the PR, and no comment that the issue has no criteria");
  assertCommentRules(landingComment!, "Ada", ticket.id);
  assert.match(landingComment!, /it passes\.[\s\S]*This pull request changes pinned paths[\s\S]*`src\/format\.js`: the pin “the output format”/);
  assert.doesNotMatch(landingComment!, /Merging at/);

  const items = h.setup.store.boardItemsForTicket(ticket.id);
  assert.equal(items.length, 1);
  const item = items[0]!.item;
  const snapshot = item.snapshot as BoardItemSnapshot;
  assert.equal(item.whyRaised, "landing_pin");
  assert.equal(snapshot.decision, "Merge the PR for issue #1, which changes a path of the pin “the output format”?");
  assert.deepEqual(snapshot.landing, {
    pullRequest: 12,
    url: "https://github.com/acme/tally/pull/12",
    headSha: headOf(12),
    landingCallId: landing!.id,
    paths: [{ pin: "the output format", glob: "src/format.js", path: "src/format.js" }],
  });
  assert.deepEqual(snapshot.form.options.map((o) => [o.id, o.title]), [[MERGE_AS_IS, "Merge this PR as it is"]]);
  assert.match(snapshot.why.text, /`src\/format\.js` \(the pin “the output format”, by its path `src\/format\.js`\)/);
  assert.equal(snapshot.visionCheck.commit, h.visionSha);

  assert.equal(h.forge.issueCommentsOn(1).length, 1, "the intake comment links the board");
  assert.match(h.forge.issueCommentsOn(1)[0]!, /entail raised this issue to the owner/);
  assert.deepEqual(h.forge.state.labels[1], [], "entail:cleared comes off while the ticket is on the board");
  assert.equal(h.notices().length, 1);

  await h.pass(2);
  assert.equal(h.setup.store.boardItemsForTicket(ticket.id).length, 1, "raised once");
  assert.deepEqual(h.forge.merges, []);
});

test("a PR that would fail anyway raises no item: a failed check, or a merge guard that says no", async (t) => {
  const h = await harness(t);
  const failing = h.cleared(1);
  h.forge.open(12, [1]);
  h.forge.checksAt.set(headOf(12), [check("test", "failed")]);
  await h.pass(3);
  assert.equal(h.state(failing.id), "landing");
  assert.equal(h.runner.requests.length, 0, "it failed before any model was used");

  const refused = h.cleared(2);
  h.forge.open(13, [2]);
  h.forge.live = { mergeable: false, conflicts: true };
  await h.pass(3);
  assert.equal(h.state(refused.id), "landing", "the merge guard said no, so nothing goes to the owner");
  const [landing] = h.calls(refused.id, "landing");
  assert.equal((landing!.detail as PassingLandingDetail).stage, "merge-guard");

  assert.equal(h.setup.store.boardItemsForTicket(failing.id).length + h.setup.store.boardItemsForTicket(refused.id).length, 0);
  assert.deepEqual(h.forge.merges, []);
});

test("a pin the owner's answer on this ticket already covered raises nothing, and the PR merges", async (t) => {
  const h = await harness(t);
  const { store } = h.setup;
  const ticket = store.takeIn({ repoId: h.repo.id, issueNumber: 1 });
  h.forge.issues.push(issue(1, { title: "Issue 1", body: "Read standard input when no file is given.", author: REPORTER }));
  const inputs = { issueTitle: "Issue 1", issueBody: "Read standard input when no file is given." };
  // The verdict found the pin touched, the owner answered its item and went ahead, and the criteria cleared the ticket.
  const verdict = store.recordCall({ ticketId: ticket.id, kind: "verdict", reason: "Touches a pin.", inputs, detail: { ...settledVerdict(h.visionSha), verdict: "needs_the_owner" } });
  const raise = store.recordCall({ ticketId: ticket.id, kind: "raise", reason: "Raised.", detail: { basedOnCallId: verdict.id }, stateTo: "on-the-board" });
  const item = store.raiseBoardItem({
    ticketId: ticket.id,
    callId: raise.id,
    decision: "Go ahead with issue #1, which touches the pin “the output format”?",
    whyRaised: "pin",
    snapshot: { version: 1, why: { pins: [{ pin: "the output format", why: "it names the format" }] }, form: { options: [] } },
  });
  store.recordAnswer({ boardItemId: item.id, answeredBy: "Ada", shape: "own-words", optionId: null, text: "Go ahead.", note: null, showNoteOnIssue: false });
  const goAhead = store.recordCall({ ticketId: ticket.id, kind: "go-ahead", reason: "Going ahead.", detail: { boardItemId: item.id, verdictCallId: verdict.id, pinsSeen: ["the output format"] }, stateTo: "deciding" });
  store.recordCall({
    ticketId: ticket.id,
    kind: "criteria",
    reason: "Cleared on the answer.",
    inputs,
    detail: criteriaDetail(store.latestSettings(h.repo.id)!.id, verdict.id, { goAheadCallId: goAhead.id, pinsSeen: ["the output format"] }),
    stateTo: "cleared",
  });
  h.forge.state.labels[1] = ["entail:cleared"];
  h.grades(ticket.id);
  assert.deepEqual(pinsSeen(store, ticket.id), ["the output format"]);

  h.forge.open(12, [1]);
  await h.pass(3);
  assert.equal(store.boardItemsForTicket(ticket.id).length, 1, "no new item");
  assert.equal(h.state(ticket.id), "merged");
  assert.deepEqual(h.forge.merges, [{ number: 12, sha: headOf(12), method: "squash" }]);
});

test("an unopposed ticket, fenced off the pins by its criteria, is not raised for a pinned path at landing", async (t) => {
  const h = await harness(t);
  const ticket = h.cleared(1, { verdict: "unopposed" });
  h.forge.open(12, [1]);
  await h.pass(3);
  assert.equal(h.setup.store.boardItemsForTicket(ticket.id).length, 0);
  assert.equal(h.state(ticket.id), "merged");
});

test("the landing check uses the pins current at check time", async (t) => {
  const h = await harness(t, { pins: [] });
  const ticket = h.cleared(1);
  // A pin saved after the ticket was cleared still counts at landing.
  h.settings({ pins: [FORMAT_PIN] });
  h.forge.open(12, [1]);
  await h.pass(3);
  assert.equal(h.state(ticket.id), "on-the-board");

  const other = h.cleared(2);
  h.settings({ pins: [] });
  h.forge.open(13, [2]);
  h.changed.splice(0, h.changed.length, "src/cli.js", "src/format.js");
  await h.pass(3);
  assert.equal(h.state(other.id), "merged", "a pin removed before the check no longer raises it");
});

test("in shadow a PR touching a pinned path gets the \"would merge\" comment, with no board item", async (t) => {
  const h = await harness(t);
  h.settings({ shadow: true });
  const ticket = h.cleared(1);
  h.forge.open(12, [1]);
  await h.pass(3);
  assert.equal(h.setup.store.boardItemsForTicket(ticket.id).length, 0);
  assert.equal(h.calls(ticket.id, "would-merge").length, 1);
  assert.deepEqual(h.forge.merges, []);
});

test("\"Merge this PR as it is\" verifies the same head again through the merge guard and merges it", async (t) => {
  const h = await harness(t);
  const ticket = await raisedAtLanding(h);
  h.answer(ticket.id, { shape: "option", optionId: MERGE_AS_IS, text: null });
  await h.pass(2);

  assert.equal(h.state(ticket.id), "merged");
  assert.deepEqual(h.forge.merges, [{ number: 12, sha: headOf(12), method: "squash" }], "merged once, pinned to the head the landing check verified");
  const [merge, ...more] = h.calls(ticket.id, "merge");
  assert.deepEqual(more, []);
  assert.deepEqual(merge!.stateChange, { from: "on-the-board", to: "merged" });
  const answer = h.setup.store.boardItemsForTicket(ticket.id)[0]!.answer!;
  assert.equal(merge!.answerId, answer.id, "the merge is the call that cites the answer");
  const detail = merge!.detail as MergeDetail;
  assert.equal(detail.outcome, "merged");
  assert.equal(detail.landingCallId, h.calls(ticket.id, "landing")[0]!.id);
  assert.equal(h.forge.state.closed[1], "completed");
  assert.deepEqual(h.calls(ticket.id, "go-ahead"), [], "no criteria are written for it");
  assert.deepEqual(answersInForce(h.setup.store, ticket.id), [], "it is no answer the criteria cite");
  assert.equal(h.forge.issueCommentsOn(1).length, 1, "only the intake comment that raised it");
});

test("\"Merge this PR as it is\" holds while the guard cannot say, and a guard that says no takes the ticket back to landing with one comment", async (t) => {
  const h = await harness(t);
  const ticket = await raisedAtLanding(h);
  h.answer(ticket.id, { shape: "option", optionId: MERGE_AS_IS, text: null });
  h.forge.live = { mergeable: null, conflicts: null };
  await h.pass(2);
  assert.equal(h.state(ticket.id), "on-the-board", "held, with nothing posted");
  assert.equal(h.forge.prComments(12).length, 1);

  h.forge.live = { mergeable: false, conflicts: true };
  await h.pass(3);
  assert.equal(h.state(ticket.id), "landing");
  assert.deepEqual(h.forge.merges, []);
  const [merge] = h.calls(ticket.id, "merge");
  assert.deepEqual(merge!.stateChange, { from: "on-the-board", to: "landing" });
  assert.deepEqual((merge!.detail as MergeDetail).refusal, { by: "entail", why: "The PR conflicts with its base." });
  const comments = h.forge.prComments(12);
  assert.equal(comments.length, 2);
  assert.match(comments[1]!, /^entail did not merge this pull request at `[0-9a-f]{40}`: The PR conflicts with its base\./m);
  assert.deepEqual(h.forge.state.labels[1], ["entail:cleared"], "the label is back while the ticket is landing");
  assert.equal(h.setup.store.boardItemsForTicket(ticket.id).length, 1, "the pin the owner saw does not raise it again at the same head");
});

test("a merge the forge refuses on \"Merge this PR as it is\" goes back to landing with one comment saying why", async (t) => {
  const h = await harness(t);
  const ticket = await raisedAtLanding(h);
  h.forge.refusal = "At least 1 approving review is required.";
  h.answer(ticket.id, { shape: "option", optionId: MERGE_AS_IS, text: null });
  await h.pass(3);
  assert.equal(h.forge.merges.length, 1);
  assert.equal(h.state(ticket.id), "landing");
  assert.match(h.forge.prComments(12).at(-1)!, /The forge refused to merge this pull request at `[0-9a-f]{40}`: At least 1 approving review is required\./);
});

test("the owner's own words write a new criteria version from them, and the PR checked again merges without raising the seen pin", async (t) => {
  const h = await harness(t);
  const ticket = await raisedAtLanding(h);
  h.answer(ticket.id, { shape: "own-words", optionId: null, text: "Go ahead, but don't touch src/format.js." });
  await h.pass();

  assert.equal(h.state(ticket.id), "deciding");
  const [goAhead] = h.calls(ticket.id, "go-ahead");
  const verdict = h.calls(ticket.id, "verdict")[0]!;
  assert.equal((goAhead!.detail as { verdictCallId: number }).verdictCallId, verdict.id, "criteria are written for the verdict, not run again");
  assert.deepEqual((goAhead!.detail as { pinsSeen: string[] }).pinsSeen, ["the output format"]);
  assert.equal(owedAnsweredCriteria(h.setup.store.getTicket(ticket.id)!, h.calls(ticket.id))?.id, goAhead!.id, "the criteria step owes a new version");
  assert.deepEqual(answersInForce(h.setup.store, ticket.id).map((g) => g.answer.text), ["Go ahead, but don't touch src/format.js."]);
  assert.deepEqual(h.forge.merges, []);

  // The criteria step writes version 2 from the owner's words, with that fence, and clears the ticket.
  const fenced: Criterion = { ...C1, checks: [...C1.checks, { kind: "leaves_path", argument: "src/format.js" }] };
  h.setup.store.recordCall({
    ticketId: ticket.id,
    kind: "criteria",
    reason: "Criteria version 2 from the owner's words.",
    detail: criteriaDetail(h.setup.store.latestSettings(h.repo.id)!.id, verdict.id, { version: 2, criteria: [fenced], goAheadCallId: goAhead!.id, pinsSeen: ["the output format"] }),
    stateTo: "cleared",
  });
  assert.equal(criteriaInForce(h.calls(ticket.id))?.version, 2);
  // The executor pushes a change that leaves the pinned path alone.
  h.changed.splice(0, h.changed.length, "src/cli.js");
  h.forge.push(12, 1);
  h.grades(ticket.id);
  await h.pass(4);
  assert.equal(h.setup.store.boardItemsForTicket(ticket.id).length, 1, "no new item");
  assert.equal(h.state(ticket.id), "merged");
  assert.deepEqual(h.forge.merges, [{ number: 12, sha: headOf(12, 1), method: "squash" }]);
});

test("\"Don't go ahead\" cancels the ticket and closes the issue, and nothing merges", async (t) => {
  const h = await harness(t);
  const ticket = await raisedAtLanding(h);
  h.answer(ticket.id, { shape: "dont-go-ahead", optionId: null, text: null });
  await h.pass(2);
  assert.equal(h.state(ticket.id), "cancelled");
  assert.equal(h.forge.state.closed[1], "not-planned");
  assert.deepEqual(h.forge.merges, []);
  assert.equal(h.forge.state.prs[12]!.state, "open", "the PR is not closed");
});

test("a new push withdraws the item, and the landing check runs again on the new head", async (t) => {
  const h = await harness(t);
  const ticket = await raisedAtLanding(h);
  const first = h.setup.store.boardItemsForTicket(ticket.id)[0]!.item;

  h.forge.push(12, 1);
  h.grades(ticket.id);
  await h.pass();
  const history = h.setup.store.boardItem(first.id)!;
  assert.ok(history.withdrawal !== null, "the item is withdrawn");
  assert.equal(history.withdrawal!.reason, "A new push arrived on the pull request this item was about.");
  const [push] = h.calls(ticket.id, "new-push");
  assert.deepEqual(push!.stateChange, { from: "on-the-board", to: "landing" });
  assert.deepEqual(h.forge.state.labels[1], ["entail:cleared"]);

  await h.pass(3);
  const items = h.setup.store.boardItemsForTicket(ticket.id);
  assert.equal(items.length, 2, "the new head still touches the pin, so it is raised again for that head");
  assert.equal((items[1]!.item.snapshot as BoardItemSnapshot).landing!.headSha, headOf(12, 1));
  assert.equal(h.calls(ticket.id, "landing").length, 2);
  assert.equal(h.runner.requests.filter((r) => r.kind === "grade").length, 2, "graded again on the new head");
  assert.equal(
    recordBoardAnswer(h.setup.store, {
      itemId: first.id,
      shownVersion: 1,
      answeredBy: "Ada",
      answer: { shape: "option", optionId: MERGE_AS_IS, text: null, note: null, showNoteOnIssue: false },
      locked: null,
    }).hasOwnProperty("refused"),
    true,
    "the withdrawn item takes no answer",
  );
});

test("a PR waiting on a second linked ticket raises no item; the item is raised on the run where the last linked ticket passes", async (t) => {
  const h = await harness(t);
  const first = h.cleared(1);
  const second = h.cleared(2);
  h.forge.open(12, [1, 2]);
  await h.pass(4);

  const decisions = [first, second].map((ticket) => ({ ticket, decision: (h.calls(ticket.id, "landing")[0]!.detail as PassingLandingDetail).merge.decision }));
  const waiting = decisions.find((d) => d.decision === "waiting")!;
  const owner = decisions.find((d) => d.decision === "owner")!;
  assert.ok(waiting && owner, "the first to pass waits, the last to pass decides");
  assert.equal(h.setup.store.boardItemsForTicket(waiting.ticket.id).length, 0, "no item while waiting on the other ticket");
  assert.equal(h.setup.store.boardItemsForTicket(owner.ticket.id).length, 1, "the item is raised by the run that decides");
  assert.equal(h.notices().length, 1);
  assert.deepEqual(h.forge.merges, []);
});
