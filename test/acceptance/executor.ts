// The scripted test executor (ADR-0010). It plays the executor on the fixture
// repos and reacts only to entail's labels: for an issue labelled
// `entail:cleared` it opens the prepared PR, linked with the forge's closing
// keyword and carrying an `entail evidence` section; for one labelled
// `entail:investigate` it posts the prepared `entail findings` comment. It
// keeps no state of its own: every pass re-reads the forge, so it can be
// stopped and started again at any time.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  evidenceBasis,
  failingLandingComment,
  isFindings,
  latestCriteriaComment,
  latestQuestionsComment,
  renderEvidence,
  renderFindings,
} from "./comments.ts";
import { DEFAULT_BRANCH, fixtureIssueByTitle, type TicketId } from "./fixture.ts";
import type { Comment, Forge, Issue, PullRequest } from "./forge.ts";
import { PREPARED_CHANGES, PREPARED_FINDINGS, type PreparedChange } from "./prepared.ts";
import { credentialArgs, type Log } from "./reset.ts";
import { git, readTree, runTests, writeTree, type TestRun } from "./tree.ts";

export const CLEARED_LABEL = "entail:cleared";
export const INVESTIGATE_LABEL = "entail:investigate";

const BRANCH = /^executor\/(t\d+)-issue-(\d+)$/;

/** The branch of the prepared PR for a ticket's issue. */
export function branchFor(id: TicketId, issue: number): string {
  return `executor/${id.toLowerCase()}-issue-${issue}`;
}

function parseBranch(branch: string): { id: TicketId; issue: number } | undefined {
  const match = BRANCH.exec(branch);
  return match ? { id: match[1]!.toUpperCase() as TicketId, issue: Number(match[2]) } : undefined;
}

const STEP_TRAILER = /^Prepared-Step: (T\d+) (\d+)\/(\d+)$/m;

const IDENTITY = ["-c", "user.name=entail test executor", "-c", "user.email=entail-test-executor@users.noreply.github.com"];

/** The PR description: the closing keyword, what the change does and its evidence. */
export function pullRequestBody(issue: number, change: PreparedChange, evidence: string): string {
  return `Closes #${issue}\n\n${change.summary}\n\n${evidence}\n`;
}

/** A local clone of a fixture repo where the executor builds its branches. */
export class Workspace {
  readonly directory: string;
  readonly #forge: Forge;

  constructor(forge: Forge, workDirectory: string) {
    this.#forge = forge;
    this.directory = join(workDirectory, `${forge.kind}-${forge.path.replaceAll("/", "-")}`);
  }

  #git(args: readonly string[]): string {
    return git(this.directory, [...IDENTITY, ...credentialArgs(this.#forge), ...args]);
  }

  /** Clones the repo once, then fetches every branch. */
  fetch(): void {
    if (!existsSync(join(this.directory, ".git"))) {
      mkdirSync(this.directory, { recursive: true });
      git(this.directory, [...credentialArgs(this.#forge), "clone", "--quiet", this.#forge.gitRemote().url, "."]);
    }
    this.#git(["fetch", "--quiet", "--prune", "--force", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
  }

  /** The sha a branch has on the forge, as last fetched. */
  head(branch: string): string | undefined {
    try {
      return this.#git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]).trim();
    } catch {
      return undefined;
    }
  }

  /** How many of the change's steps the branch's head holds. */
  stepsAt(branch: string): number {
    const message = this.#git(["log", "-1", "--format=%B", `refs/remotes/origin/${branch}`]);
    return Number(STEP_TRAILER.exec(message)?.[2] ?? 0);
  }

  /**
   * Points the branch at `base` plus the change's steps `from`..`to`
   * (exclusive), one commit each, and returns the new head.
   */
  build(branch: string, base: string, change: PreparedChange, from: number, to: number): string {
    this.#git(["checkout", "--quiet", "--force", "-B", branch, base]);
    this.#git(["clean", "--quiet", "--force", "-d", "-x"]);
    for (let step = from; step < to; step += 1) {
      const before = readTree(this.directory);
      const after = new Map(before);
      change.steps[step]!.apply(after);
      writeTree(this.directory, after, before);
      this.#git(["add", "--all"]);
      const message = `${change.steps[step]!.subject}\n\nPrepared-Step: ${change.id} ${step + 1}/${change.steps.length}\n`;
      this.#git(["-c", "commit.gpgsign=false", "commit", "--quiet", "--no-verify", "--message", message]);
    }
    return this.#git(["rev-parse", "HEAD"]).trim();
  }

  /** Whether two commits hold the same files. */
  sameTree(a: string, b: string): boolean {
    return this.#git(["rev-parse", `${a}^{tree}`]).trim() === this.#git(["rev-parse", `${b}^{tree}`]).trim();
  }

  push(branch: string): void {
    this.#git(["push", "--quiet", "--force", "origin", `refs/heads/${branch}:refs/heads/${branch}`]);
    this.#git(["update-ref", `refs/remotes/origin/${branch}`, "HEAD"]);
  }

  /** Runs tally's tests at a commit. */
  testsAt(sha: string): TestRun {
    this.#git(["checkout", "--quiet", "--force", "--detach", sha]);
    this.#git(["clean", "--quiet", "--force", "-d", "-x"]);
    return runTests(this.directory);
  }
}

export interface ExecutorOptions {
  forge: Forge;
  workspace: Workspace;
  log: Log;
}

/** One pass of the scripted executor over a fixture repo. */
export class ScriptedExecutor {
  readonly #forge: Forge;
  readonly #workspace: Workspace;
  readonly #log: Log;
  readonly #said = new Set<string>();

  constructor(options: ExecutorOptions) {
    this.#forge = options.forge;
    this.#workspace = options.workspace;
    this.#log = options.log;
  }

  /** Logs a waiting or skipping note once, not on every pass. */
  #once(key: string, event: Parameters<Log>[0]): void {
    if (this.#said.has(key)) return;
    this.#said.add(key);
    this.#log(event);
  }

  async pass(): Promise<void> {
    const issues = await this.#forge.listIssues("open");
    const prs = await this.#forge.listPullRequests("all");
    this.#workspace.fetch();

    for (const issue of issues) {
      if (issue.labels.includes(INVESTIGATE_LABEL)) await this.#investigate(issue);
      if (issue.labels.includes(CLEARED_LABEL)) await this.#open(issue, prs);
    }
    for (const pr of prs) {
      if (pr.state === "open" && parseBranch(pr.branch)) await this.#maintain(pr);
    }
  }

  async #investigate(issue: Issue): Promise<void> {
    const fixture = fixtureIssueByTitle(issue.title);
    const finding = fixture && PREPARED_FINDINGS.get(fixture.id);
    if (!fixture || !finding) {
      this.#once(`no-findings:${issue.number}`, { event: "no-prepared-findings", issue: issue.number, title: issue.title });
      return;
    }
    const comments = await this.#forge.listIssueComments(issue.number);
    const questions = latestQuestionsComment(comments);
    if (!questions) {
      this.#once(`no-questions:${issue.number}`, { event: "waiting-for-questions", ticket: fixture.id, issue: issue.number });
      return;
    }
    if (comments.some((c) => c.id !== questions.id && c.createdAt >= questions.createdAt && isFindings(c.body))) return;
    await this.#forge.createIssueComment(issue.number, renderFindings(questions, finding));
    this.#log({ event: "findings-posted", ticket: fixture.id, issue: issue.number, questionsComment: questions.id });
  }

  async #open(issue: Issue, prs: readonly PullRequest[]): Promise<void> {
    const fixture = fixtureIssueByTitle(issue.title);
    const change = fixture && PREPARED_CHANGES.get(fixture.id);
    if (!fixture || !change) {
      this.#once(`no-change:${issue.number}`, { event: "no-prepared-change", issue: issue.number, title: issue.title });
      return;
    }
    const branch = branchFor(fixture.id, issue.number);
    if (prs.some((pr) => pr.branch === branch)) return;

    const criteria = latestCriteriaComment(await this.#forge.listIssueComments(issue.number));
    if (!criteria) {
      this.#once(`no-criteria:${issue.number}`, { event: "waiting-for-criteria", ticket: fixture.id, issue: issue.number });
      return;
    }
    // The first PR holds only the first step: for T1 that is the push that fails CI.
    const head = this.#workspace.build(branch, `refs/remotes/origin/${DEFAULT_BRANCH}`, change, 0, 1);
    this.#workspace.push(branch);
    const evidence = renderEvidence(change, criteria, head, this.#workspace.testsAt(head));
    const pr = await this.#forge.createPullRequest({
      branch,
      base: DEFAULT_BRANCH,
      title: change.steps[0]!.subject,
      body: pullRequestBody(issue.number, change, evidence),
    });
    this.#log({ event: "pr-opened", ticket: fixture.id, issue: issue.number, pr: pr.number, url: pr.webUrl, head });
  }

  async #maintain(listed: PullRequest): Promise<void> {
    const { id, issue } = parseBranch(listed.branch)!;
    const change = PREPARED_CHANGES.get(id);
    if (!change) return;
    const pr = await this.#forge.pullRequest(listed.number);
    if (pr.state !== "open" || this.#workspace.head(pr.branch) !== pr.headSha) return;
    const steps = this.#workspace.stepsAt(pr.branch);

    // Another PR merged into the same code: rebuild on the default branch, as an executor would.
    if (pr.conflicted === true) {
      const head = this.#workspace.build(pr.branch, `refs/remotes/origin/${DEFAULT_BRANCH}`, change, 0, steps);
      // The forge can report a conflict a while after it is gone; a rebuild that changes nothing is not pushed.
      if (this.#workspace.sameTree(head, pr.headSha)) return;
      this.#workspace.push(pr.branch);
      this.#log({ event: "pr-rebuilt", ticket: id, pr: pr.number, head, steps });
      return;
    }

    const prComments = await this.#forge.listPullRequestComments(pr.number);

    // T1: the fix is pushed once entail has commented on the failing head.
    if (steps < change.steps.length && failingLandingComment(prComments, pr.headSha)) {
      const head = this.#workspace.build(pr.branch, `refs/remotes/origin/${pr.branch}`, change, steps, steps + 1);
      this.#workspace.push(pr.branch);
      this.#log({ event: "fix-pushed", ticket: id, pr: pr.number, failedHead: pr.headSha, head });
      return;
    }

    // Report evidence again whenever the head or entail's criteria changed.
    const criteria = latestCriteriaComment(await this.#forge.listIssueComments(issue));
    if (!criteria) return;
    const reports: Pick<Comment, "body">[] = [{ body: pr.body }, ...prComments];
    const basis = reports.map((report) => evidenceBasis(report.body)).findLast((b) => b !== undefined);
    if (basis?.criteriaCommentId === criteria.id && basis.headSha === pr.headSha) return;
    const evidence = renderEvidence(change, criteria, pr.headSha, this.#workspace.testsAt(pr.headSha));
    await this.#forge.createPullRequestComment(pr.number, evidence);
    this.#log({ event: "evidence-posted", ticket: id, pr: pr.number, head: pr.headSha, criteriaComment: criteria.id });
  }
}
