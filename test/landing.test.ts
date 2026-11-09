import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import { assertCommentRules, markedTickets } from "../src/comment-rules.ts";
import type { CriteriaDetail, Criterion } from "../src/criteria.ts";
import type { Actor, ChangeBatch, Check, CheckReport, PullRequest, PullRequestComment } from "../src/forge/forge.ts";
import {
  evidenceKey,
  failingLandingText,
  LANDING_CHECKS,
  landingPlanner,
  landingTrigger,
  mechanicalStage,
  namedChecks,
  type LandingChecks,
  type LandingDetail,
  type LandingMirror,
  type LandingRunKey,
  type MechanicalPass,
} from "../src/landing.ts";
import { ModelRuns } from "../src/model-runs.ts";
import { Passes } from "../src/pass.ts";
import { pullRequestFollowing } from "../src/pull-requests.ts";
import type { GenericCriterion } from "../src/repo-settings.ts";
import { ScriptedRunner } from "../src/scripted-runner.ts";
import type { RepoRecord, TicketRecord } from "../src/store.ts";
import { actor, IntakeForge, passSetup, STILL_HEAD, type PassSetup } from "./pass-fixture.ts";

const EXECUTOR = actor(2001, "executor");

const C1: Criterion = {
  id: "C1",
  sentence: "Running tally on a file counts its lines.",
  source: { kind: "issue", ref: null },
  checks: [{ kind: "changes_path", argument: "src/**" }],
  states_reading: null,
};
const C2: Criterion = {
  id: "C2",
  sentence: "The vision stays as it is.",
  source: { kind: "issue", ref: null },
  checks: [{ kind: "leaves_path", argument: "VISION.md" }],
  states_reading: null,
};
const C3: Criterion = { id: "C3", sentence: "The help text names the new flag.", source: { kind: "issue", ref: null }, checks: [], states_reading: null };
const G1: GenericCriterion = { id: "G1", sentence: "The check `test` passes.", check: { kind: "check_passes", argument: "test" }, source: ".github/workflows/ci.yml" };

/** Every path in the repo at a PR's head. */
const HEAD_PATHS = ["README.md", "VISION.md", "docs/a.md", "src/a.js", "src/count.js"];

function criteriaDetail(version: number, settingsVersionId: number, criteria: Criterion[] = [C1, C2, C3], genericCriteria: GenericCriterion[] = [G1]): CriteriaDetail {
  return {
    outcome: "criteria",
    verdictCallId: 1,
    version,
    criteria,
    genericCriteria,
    settingsVersionId,
    product_call: null,
    verdict: "unopposed",
    why_unopposed: "Nothing in the vision speaks to it.",
    reading_chosen: null,
    fences: [],
  };
}

function check(name: string, status: Check["status"], reported = true): Check {
  return { name, status, reported, url: null };
}

function report(sha: string, checks: Check[], required: CheckReport["required"] = []): CheckReport {
  return { sha, checks, required };
}

const OPEN_PR = { number: 12, state: "open" as const, draft: false, baseBranch: "main", headSha: "a".repeat(40) };

// The trigger rule.

test("the landing check does not run while a check at the head is pending, a named check has not reported, or a required check has not reported", () => {
  const criteria = criteriaDetail(1, 1);
  const base = { pr: OPEN_PR, defaultBranch: "main", criteria, evidence: null, done: [] };
  const sha = OPEN_PR.headSha;

  const pending = landingTrigger({ ...base, report: report(sha, [check("lint", "passed"), check("test", "pending")]) });
  assert.deepEqual(pending, { run: false, why: "checks are pending: test" });

  const unreported = landingTrigger({ ...base, report: report(sha, [check("lint", "passed"), check("test", "pending", false)]) });
  assert.equal(unreported.run, false, "a named check that has not reported is pending");

  const required = landingTrigger({ ...base, report: report(sha, [check("test", "passed")], [{ name: "deploy", reported: false }]) });
  assert.deepEqual(required, { run: false, why: "required checks have not reported: deploy" });

  const elsewhere = landingTrigger({ ...base, report: report("b".repeat(40), [check("test", "passed")]) });
  assert.equal(elsewhere.run, false, "checks read at another sha are not the head's");

  const finished = landingTrigger({ ...base, report: report(sha, [check("lint", "failed"), check("test", "passed")]) });
  assert.deepEqual(finished, { run: true, key: { pullRequest: 12, headSha: sha, evidence: null, criteriaVersion: 1 } }, "a failed check has finished");

  const none = landingTrigger({ ...base, report: report(sha, []) });
  assert.equal(none.run, true, "with no named checks and no checks at all, every check has finished");
});

test("the landing check does not run on a draft, a closed PR, a PR into another branch, or a ticket with no criteria in force", () => {
  const finished = report(OPEN_PR.headSha, [check("test", "passed")]);
  const base = { defaultBranch: "main", criteria: criteriaDetail(1, 1), report: finished, evidence: null, done: [] };
  assert.deepEqual(landingTrigger({ ...base, pr: { ...OPEN_PR, draft: true } }), { run: false, why: "it is a draft" });
  assert.deepEqual(landingTrigger({ ...base, pr: { ...OPEN_PR, state: "closed" } }), { run: false, why: "it is closed" });
  assert.equal(landingTrigger({ ...base, pr: { ...OPEN_PR, baseBranch: "release" } }).run, false);
  assert.deepEqual(landingTrigger({ ...base, pr: OPEN_PR, criteria: null }), { run: false, why: "its ticket has no criteria in force" });
});

test("the landing check runs exactly once per head sha, evidence section and criteria version", () => {
  const sha = OPEN_PR.headSha;
  const evidence = evidenceKey({ section: "## entail evidence\n\nC1: ran it — 3 lines" });
  const done: LandingRunKey = { pullRequest: 12, headSha: sha, evidence, criteriaVersion: 1 };
  const base = { pr: OPEN_PR, defaultBranch: "main", criteria: criteriaDetail(1, 1), report: report(sha, [check("test", "passed")]), evidence, done: [done] };

  assert.equal(landingTrigger(base).run, false, "already run at this key");
  assert.equal(landingTrigger({ ...base, pr: { ...OPEN_PR, headSha: "c".repeat(40) }, report: report("c".repeat(40), [check("test", "passed")]) }).run, true, "a new push");
  assert.equal(landingTrigger({ ...base, evidence: evidenceKey({ section: "## entail evidence\n\nC1: ran it again — 3 lines" }) }).run, true, "a new evidence section");
  assert.equal(landingTrigger({ ...base, evidence: null }).run, true, "the evidence section removed");
  assert.equal(landingTrigger({ ...base, criteria: criteriaDetail(2, 1) }).run, true, "a new criteria version");
  assert.equal(landingTrigger({ ...base, pr: { ...OPEN_PR, number: 13 } }).run, true, "another PR for the ticket is checked on its own");

  assert.equal(evidenceKey({ section: "## entail evidence\n\nC1: x\n" }), evidenceKey({ section: "## entail evidence\n\nC1: x" }), "surrounding whitespace is no new section");
  assert.equal(evidenceKey(null), null);
});

// Stage one.

test("stage one runs every criterion's and generic criterion's mechanical checks against the changed paths and the check results", () => {
  const criteria = criteriaDetail(1, 1);
  assert.deepEqual(namedChecks(criteria), ["test"]);

  const passing = mechanicalStage({ pr: { conflicts: false }, criteria, report: report("s", [check("test", "passed")]), changedPaths: ["README.md", "src/count.js"], headPaths: HEAD_PATHS });
  assert.equal(passing.checks.passed, true);
  assert.deepEqual(
    passing.ids.map((id) => [id.id, id.met, id.checks.map((c) => c.passed)]),
    [
      ["C1", null, [true]],
      ["C2", null, [true]],
      ["C3", null, []],
      ["G1", null, [true]],
    ],
    "nothing is met before grading; mechanical checks only fail ids",
  );

  const failing = mechanicalStage({ pr: { conflicts: null }, criteria, report: report("s", [check("test", "failed")]), changedPaths: ["VISION.md", "docs/a.md"], headPaths: HEAD_PATHS });
  assert.equal(failing.checks.passed, false);
  assert.deepEqual(
    failing.ids.map((id) => [id.id, id.met]),
    [
      ["C1", false],
      ["C2", false],
      ["C3", null],
      ["G1", false],
    ],
  );
  const byName = new Map(failing.checks.results.map((r) => [r.check, r]));
  assert.equal(byName.get(LANDING_CHECKS.checksPassed)?.passed, false);
  assert.equal(byName.get(LANDING_CHECKS.noConflicts)?.passed, true, "mergeability not worked out yet does not fail stage one");
  assert.match(byName.get(LANDING_CHECKS.criteria)!.failure!, /C1: the PR changes no file matching `src\/\*\*`\. C2: the PR changes `VISION\.md`, which matches `VISION\.md`\./);
  assert.match(byName.get(LANDING_CHECKS.genericCriteria)!.failure!, /G1: the check `test` failed at this head\./);

  const conflicted = mechanicalStage({ pr: { conflicts: true }, criteria, report: report("s", [check("test", "passed")]), changedPaths: ["src/a.js"], headPaths: HEAD_PATHS });
  assert.equal(conflicted.checks.passed, false);
  assert.deepEqual(conflicted.ids.map((id) => id.met), [null, null, null, null]);
});

test("a changes-path glob that matches no file in the repo at the head does not fail; the criterion falls to grading (#155)", () => {
  // C1 pinned src/cli.js; another ticket moved the code into src/count.js before the PR landed.
  const pinned = criteriaDetail(1, 1, [{ ...C1, checks: [{ kind: "changes_path", argument: "src/cli.js" }, { kind: "check_passes", argument: "test" }] }], []);
  const headPaths = ["README.md", "src/count.js"];
  const stale = mechanicalStage({ pr: { conflicts: false }, criteria: pinned, report: report("s", [check("test", "passed")]), changedPaths: ["src/count.js"], headPaths });
  assert.equal(stale.checks.passed, true);
  assert.deepEqual(stale.ids.map((id) => [id.id, id.met, id.checks.map((c) => c.passed)]), [["C1", null, [true, true]]], "not failed, and not met until graded");
  assert.match(stale.ids[0]!.checks[0]!.detail, /no file in the repo at this head matches `src\/cli\.js`, so this check does not apply and the criterion is graded/);

  // The glob still names a file at the head that the PR leaves alone: the check fails as before.
  const live = mechanicalStage({ pr: { conflicts: false }, criteria: pinned, report: report("s", [check("test", "passed")]), changedPaths: ["README.md"], headPaths: [...headPaths, "src/cli.js"] });
  assert.equal(live.checks.passed, false);
  assert.match(live.checks.results.find((r) => r.check === LANDING_CHECKS.criteria)!.failure!, /C1: the PR changes no file matching `src\/cli\.js`\./);
});

test("the failing landing comment names the unmet ids and the head sha, and says a new push or evidence section gets it checked again", () => {
  const sha = "d".repeat(40);
  const stage = mechanicalStage({ pr: { conflicts: false }, criteria: criteriaDetail(2, 1), report: report(sha, [check("test", "passed")]), changedPaths: ["docs/a.md"], headPaths: HEAD_PATHS });
  const text = failingLandingText({ wording: { pullRequest: "merge request" }, issueNumber: 7, headSha: sha, criteriaVersion: 2, stage });
  assert.match(text, new RegExp(`^Landing check of this merge request at \`${sha}\`: it does not pass, and C1 is not met\\.`));
  assert.match(text, /\*\*Criteria for #7\*\* \(version 2\)/);
  assert.match(text, /- \*\*C1\*\* Running tally on a file counts its lines\.\n {2}Not met: the PR changes no file matching `src\/\*\*` \(changes path `src\/\*\*`\)\./);
  assert.match(text, /- \*\*C2\*\* The vision stays as it is\.\n {2}Not graded: its mechanical checks passed/);
  assert.match(text, /- \*\*C3\*\* The help text names the new flag\.\n {2}Not graded: it has no mechanical check/);
  assert.match(text, /\*\*Generic criteria\*\*\n\n- \*\*G1\*\* The check `test` passes\./);
  assert.match(text, new RegExp(`This merge request will not be merged at \`${sha}\`\\. A new push, or a new \`entail evidence\` section, gets it checked again\\.$`));
  assert.doesNotMatch(text, /forge's state/, "the forge's state is listed only when it fails");
  assert.ok(text.split("\n").every((line) => !line.trimStart().startsWith("/")), "no line starts with /");
});

// The landing step on the pass.

/** A forge whose PRs link issues, carry checks at their heads and comments by their authors. */
class LandingForge extends IntakeForge {
  prs: PullRequest[] = [];
  readonly links = new Map<number, number[]>();
  /** Checks at each head sha. */
  readonly checksAt = new Map<string, Check[]>();
  readonly prCommentsBy = new Map<number, PullRequestComment[]>();
  checkReads = 0;
  #clock = Date.parse("2026-11-09T00:00:00.000Z");

  override async changesSince(): Promise<ChangeBatch> {
    const batch = await super.changesSince();
    return {
      changes: [...batch.changes, ...this.prs.map((pr) => ({ kind: "pull-request" as const, id: pr.id, updatedAt: pr.updatedAt, pullRequest: pr }))],
      cursor: batch.cursor,
    };
  }

  override async linkedPullRequests(issueNumber: number): Promise<PullRequest[]> {
    return this.prs.filter((pr) => this.links.get(pr.number)?.includes(issueNumber));
  }

  override async linkedIssues(pullRequestNumber: number): Promise<number[]> {
    return this.links.get(pullRequestNumber) ?? [];
  }

  override async checks(_pullRequestNumber: number, sha: string, named: readonly string[]): Promise<CheckReport> {
    this.checkReads++;
    const reported = this.checksAt.get(sha) ?? [];
    const checks = [...reported];
    for (const name of named) if (!checks.some((c) => c.name === name)) checks.push(check(name, "pending", false));
    return report(sha, checks.sort((a, b) => a.name.localeCompare(b.name)));
  }

  override async pullRequestComments(number: number): Promise<PullRequestComment[]> {
    return this.prCommentsBy.get(number) ?? [];
  }

  open(number: number, issues: number[], fields: Partial<PullRequest> = {}, author: Actor = EXECUTOR): void {
    this.links.set(number, issues);
    this.prs.push({
      id: 7000 + number,
      number,
      title: `PR ${number}`,
      body: "",
      state: "open",
      draft: false,
      mergeable: true,
      conflicts: false,
      headSha: sha(number, 1),
      baseBranch: "main",
      author,
      createdAt: this.#tick(),
      updatedAt: this.#tick(),
      url: `https://github.com/acme/tally/pull/${number}`,
      ...fields,
    });
  }

  update(number: number, fields: Partial<PullRequest>): void {
    this.prs = this.prs.map((pr) => (pr.number === number ? { ...pr, ...fields, updatedAt: this.#tick() } : pr));
  }

  /** Posts a comment on a PR by `author`. */
  commentOnPr(number: number, body: string, author: Actor = EXECUTOR): void {
    const list = this.prCommentsBy.get(number) ?? [];
    const id = 9900 + list.length;
    const at = this.#tick();
    list.push({ id, pullRequestNumber: number, body, author, createdAt: at, updatedAt: at, url: `https://github.com/acme/tally/pull/${number}#issuecomment-${id}` });
    this.prCommentsBy.set(number, list);
  }

  prComments(number: number): string[] {
    return (this.state.comments[`pr:${number}`] ?? []).map((c) => c.body);
  }

  issueCommentBodies(number: number): string[] {
    return (this.state.comments[`issue:${number}`] ?? []).map((c) => c.body);
  }

  #tick(): string {
    this.#clock += 1000;
    return new Date(this.#clock).toISOString();
  }
}

/** A full sha for PR `number`'s `push`th head. */
function sha(number: number, push: number): string {
  return `${String(number).padStart(4, "0")}${String(push).padStart(4, "0")}`.padEnd(40, "e");
}

interface Harness {
  setup: PassSetup;
  repo: RepoRecord;
  forge: LandingForge;
  runner: ScriptedRunner;
  /** The paths each head changes. */
  changed: Map<string, string[]>;
  /** What a passing stage one handed on. */
  handedOn: MechanicalPass[];
  pass(times?: number): Promise<void>;
  restart(): void;
  /** Takes issue `issueNumber` in and clears it with `detail`'s criteria. */
  cleared(issueNumber: number, detail?: CriteriaDetail): TicketRecord;
  get(ticketId: number): TicketRecord;
  landingCalls(ticketId: number): ReturnType<PassSetup["store"]["callsForTicket"]>;
}

async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!done()) {
    if (performance.now() > deadline) assert.fail(`timed out waiting until ${what}`);
    await immediate();
  }
}

function harness(t: TestContext, options: { handOn?: boolean } = {}): Harness {
  const setup = passSetup(t);
  const repo = setup.enroll();
  const forge = new LandingForge();
  const runner = new ScriptedRunner();
  const changed = new Map<string, string[]>();
  const handedOn: MechanicalPass[] = [];
  const mirror: LandingMirror = {
    fetchPullRequestHead: async (_number, expected) => ({ commit: expected!, fetched: false }),
    pullRequestChangedPaths: async (base, head) => {
      assert.equal(base, "c0ffee", "the diff is taken against the default branch head the pass saw");
      return changed.get(head) ?? [];
    },
    pullRequestHeadPaths: async () => HEAD_PATHS,
  };
  let engine: Passes;
  const start = () => {
    const following = pullRequestFollowing({ store: setup.store, log: setup.log });
    const landing = landingPlanner({
      store: setup.store,
      log: setup.log,
      dataDirectory: setup.dataDirectory,
      mirrorFor: async () => mirror,
      ...(options.handOn
        ? {
            // As grading would, records the run's landing call.
            afterMechanical: async (passed: MechanicalPass) => {
              handedOn.push(passed);
              setup.store.recordCall({
                ticketId: passed.ticket.id,
                kind: "landing",
                reason: "Graded for the test.",
                inputs: { prHeadSha: passed.key.headSha },
                detail: { pullRequest: passed.key.pullRequest, headSha: passed.key.headSha, evidence: null, criteriaVersion: passed.key.criteriaVersion },
              });
            },
          }
        : {}),
    });
    engine = new Passes({
      store: setup.store,
      log: setup.log,
      dataDirectory: setup.dataDirectory,
      forgeFor: () => forge,
      defaultBranchFor: async () => STILL_HEAD,
      planners: [following.planner, landing],
      changeHandlers: [following.onChange],
      modelRuns: new ModelRuns({ runner, log: setup.log }),
    });
    t.after(() => engine.stop());
  };
  start();
  return {
    setup,
    repo,
    forge,
    runner,
    changed,
    handedOn,
    async pass(times = 1) {
      for (let i = 0; i < times; i++) {
        await engine.runPass();
        await until(() => engine.stepsRunning === 0, "every step started has finished");
      }
    },
    restart() {
      void engine.stop();
      start();
    },
    cleared(issueNumber, detail) {
      const ticket = setup.store.takeIn({ repoId: repo.id, issueNumber });
      const settings = setup.store.latestSettings(repo.id)!;
      setup.store.recordCall({ ticketId: ticket.id, kind: "criteria", reason: "Cleared for the test.", detail: detail ?? criteriaDetail(1, settings.id), stateTo: "cleared" });
      return setup.store.getTicket(ticket.id)!;
    },
    get: (ticketId) => setup.store.getTicket(ticketId)!,
    landingCalls: (ticketId) => setup.store.callsForTicket(ticketId).filter((call) => call.kind === "landing"),
  };
}

test("a failing mechanical check posts one landing comment on the PR naming the unmet ids and the head sha, uses no model, and leaves the ticket landing", async (t) => {
  const h = harness(t);
  const ticket = h.cleared(1);
  const head = sha(12, 1);
  h.forge.open(12, [1], { body: "Counts lines.\n\n## entail evidence\n\nC1: ran `tally -l a.txt` — 3\nG1: ran `npm test` — passed" });
  h.changed.set(head, ["docs/usage.md"]);

  // Checks pending: nothing is posted, and the ticket moves to landing.
  await h.pass(2);
  assert.equal(h.get(ticket.id).state, "landing");
  assert.deepEqual(h.forge.prComments(12), [], "no comment while checks are pending");
  assert.deepEqual(h.landingCalls(ticket.id), []);

  h.forge.checksAt.set(head, [check("test", "passed")]);
  await h.pass();

  const [body, ...more] = h.forge.prComments(12);
  assert.ok(body, "one landing comment on the PR");
  assert.deepEqual(more, []);
  assert.deepEqual(h.forge.issueCommentBodies(1), [], "never on the issue");
  assertCommentRules(body, "Ada", ticket.id);
  assert.match(body, /^Speaking from Ada's entail:/);
  assert.deepEqual(markedTickets(body), [ticket.id]);
  assert.match(body, new RegExp(`at \`${head}\`: it does not pass, and C1 is not met\\.`));
  assert.match(body, new RegExp(`This pull request will not be merged at \`${head}\``));
  assert.equal(h.runner.requests.length, 0, "no model is used");

  assert.equal(h.get(ticket.id).state, "landing", "a failed landing leaves the ticket landing");
  const [call, ...moreCalls] = h.landingCalls(ticket.id);
  assert.ok(call);
  assert.deepEqual(moreCalls, []);
  assert.equal(call.stateChange, null);
  assert.equal(call.inputs?.prHeadSha, head);
  const detail = call.detail as LandingDetail;
  const settingsId = h.setup.store.latestSettings(h.repo.id)!.id;
  assert.equal(detail.criteriaVersion, 1);
  assert.equal(detail.genericCriteriaVersion, settingsId, "the generic criteria version frozen with the criteria");
  assert.equal(detail.headSha, head);
  assert.equal(detail.pullRequest, 12);
  assert.equal(detail.outcome, "not-met");
  assert.deepEqual(detail.changedPaths, ["docs/usage.md"]);
  assert.equal(detail.evidence?.source.kind, "description");
  assert.equal((call.checks as LandingChecks).passed, false);
  assert.equal(call.modelRuns.length, 0);
  assert.equal(call.postedComments.length, 1, "the comment is posted for the call");
  assert.match(call.reason, /C1 not met/);
});

test("a failed landing is not checked again until a new push, a new evidence section or a new criteria version, across restarts", async (t) => {
  const h = harness(t);
  const ticket = h.cleared(1);
  const first = sha(12, 1);
  h.forge.open(12, [1]);
  h.forge.checksAt.set(first, [check("test", "passed")]);
  h.changed.set(first, ["docs/usage.md"]);
  await h.pass(3);
  assert.equal(h.forge.prComments(12).length, 1);

  // The same head, evidence and criteria: nothing again, whatever passes and restarts.
  h.forge.update(12, { title: "Retitled" });
  await h.pass(2);
  h.restart();
  await h.pass(2);
  assert.equal(h.forge.prComments(12).length, 1, "once per head, evidence section and criteria version");

  // A new evidence section from the PR's author.
  h.forge.commentOnPr(12, "## entail evidence\n\nC1: ran it — 3 lines");
  await h.pass();
  assert.equal(h.forge.prComments(12).length, 2, "a new evidence section gets it checked again");
  assert.equal((h.landingCalls(ticket.id).at(-1)!.detail as LandingDetail).evidence?.source.kind, "comment");

  // A comment by someone else is no evidence section.
  h.forge.commentOnPr(12, "## entail evidence\n\nC1: done", actor(2002));
  await h.pass();
  assert.equal(h.forge.prComments(12).length, 2);

  // A new push.
  const second = sha(12, 2);
  h.forge.update(12, { headSha: second });
  h.forge.checksAt.set(second, [check("test", "pending")]);
  h.changed.set(second, ["docs/usage.md", "VISION.md"]);
  await h.pass();
  assert.equal(h.forge.prComments(12).length, 2, "not while the new head's checks are pending");
  h.forge.checksAt.set(second, [check("test", "passed")]);
  await h.pass();
  assert.equal(h.forge.prComments(12).length, 3, "a new push gets it checked again");
  assert.match(h.forge.prComments(12)[2]!, new RegExp(`at \`${second}\`: it does not pass, and C1, C2 are not met\\.`));

  // A new criteria version.
  const settings = h.setup.store.latestSettings(h.repo.id)!;
  h.setup.store.recordCall({ ticketId: ticket.id, kind: "criteria", reason: "A new criteria version for the test.", detail: criteriaDetail(2, settings.id) });
  await h.pass();
  assert.equal(h.forge.prComments(12).length, 4, "a new criteria version gets it checked again");
  assert.equal((h.landingCalls(ticket.id).at(-1)!.detail as LandingDetail).criteriaVersion, 2);

  assert.equal(h.get(ticket.id).state, "landing");
  assert.equal(h.runner.requests.length, 0);
});

test("a draft is never checked or commented on, and is checked once it is ready", async (t) => {
  const h = harness(t);
  const ticket = h.cleared(1);
  const head = sha(12, 1);
  h.forge.open(12, [1], { draft: true });
  h.forge.checksAt.set(head, [check("test", "failed")]);
  h.changed.set(head, ["src/count.js"]);
  await h.pass(3);
  assert.equal(h.get(ticket.id).state, "landing");
  assert.deepEqual(h.forge.prComments(12), [], "no comment on a draft");

  h.forge.update(12, { draft: false });
  await h.pass(2);
  const [body] = h.forge.prComments(12);
  assert.ok(body);
  assert.match(body, /it does not pass, and G1 is not met/);
  assert.match(body, /\*\*The forge's state at this head\*\*\n\n- Not met: `test` failed at this head\./);
});

test("a PR whose first stage passes is handed on to grading, with nothing posted or recorded by stage one, and not again once grading recorded the run", async (t) => {
  const h = harness(t, { handOn: true });
  const ticket = h.cleared(1);
  const head = sha(12, 1);
  h.forge.open(12, [1]);
  h.forge.checksAt.set(head, [check("test", "passed")]);
  h.changed.set(head, ["src/count.js"]);
  await h.pass(4);

  assert.equal(h.handedOn.length, 1, "once, however many passes");
  const [passed] = h.handedOn;
  assert.equal(passed!.key.headSha, head);
  assert.equal(passed!.stage.checks.passed, true);
  assert.deepEqual(h.forge.prComments(12), [], "stage one posts nothing for a passing run");
  assert.deepEqual(
    h.landingCalls(ticket.id).map((call) => call.reason),
    ["Graded for the test."],
    "the only landing call is the one grading recorded",
  );
  assert.equal(h.runner.requests.length, 0);
});

test("a passing first stage with no later stage wired in records nothing and is not repeated on every pass", async (t) => {
  const h = harness(t);
  const ticket = h.cleared(1);
  const head = sha(12, 1);
  h.forge.open(12, [1]);
  h.forge.checksAt.set(head, [check("test", "passed")]);
  h.changed.set(head, ["src/count.js"]);
  await h.pass(3);
  assert.deepEqual(h.forge.prComments(12), []);
  assert.deepEqual(h.landingCalls(ticket.id), []);
  const passedLines = h.setup.logLines().filter((line) => line.event === "landing-mechanical-passed");
  assert.equal(passedLines.length, 1);
});

test("several PRs for one ticket are each checked on their own", async (t) => {
  const h = harness(t);
  const ticket = h.cleared(1);
  for (const number of [12, 13]) {
    h.forge.open(number, [1]);
    h.forge.checksAt.set(sha(number, 1), [check("test", "passed")]);
  }
  h.changed.set(sha(12, 1), ["docs/a.md"]);
  h.changed.set(sha(13, 1), ["src/a.js", "VISION.md"]);
  await h.pass(3);
  assert.match(h.forge.prComments(12)[0]!, /C1 is not met/);
  assert.match(h.forge.prComments(13)[0]!, /C2 is not met/);
  assert.deepEqual(
    h.landingCalls(ticket.id).map((call) => (call.detail as LandingDetail).pullRequest),
    [12, 13],
  );
});
