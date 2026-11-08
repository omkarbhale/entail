// Setting up the fixture repos and resetting them to tally's starting state:
// code and VISION.md, issues T1–T13, no `entail:` labels, no PR or branch.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  DEFAULT_BRANCH,
  FIXTURE_DESCRIPTION,
  FIXTURE_ISSUES,
  FIXTURE_MARKER,
  STARTING_COMMIT,
  startingTree,
  type TicketId,
} from "./fixture.ts";
import { ForgeError, type Forge, type RepoInfo } from "./forge.ts";
import { git, writeTree } from "./tree.ts";

export type HarnessEvent = Record<string, unknown> & { event: string };
export type Log = (event: HarnessEvent) => void;

/** The reset refuses a repo that is not a fixture repo. */
export class NotAFixtureError extends Error {}

/**
 * Checks that a repo is one of the fixture repos: private, carrying the
 * fixture marker in its description, and not entail's own repo.
 */
export function assertFixture(forge: Forge, repo: RepoInfo | undefined): asserts repo is RepoInfo {
  const where = `${forge.kind} ${forge.host}/${forge.path}`;
  if (!repo) throw new NotAFixtureError(`${where} does not exist; run the setup command first`);
  const name = repo.path.split("/").at(-1)!.toLowerCase();
  if (name === "entail") throw new NotAFixtureError(`${where} is entail's own repo; the harness never touches it`);
  if (!repo.private) throw new NotAFixtureError(`${where} is not private; the fixture repos are private`);
  if (!repo.description.includes(FIXTURE_MARKER)) {
    throw new NotAFixtureError(`${where} has no "${FIXTURE_MARKER}" in its description, so it is not a fixture repo`);
  }
}

/** Builds the starting commit in a fresh repository and returns its sha. */
export function buildStartingCommit(directory: string): string {
  git(directory, ["init", "--quiet", "--initial-branch", DEFAULT_BRANCH]);
  writeTree(directory, startingTree());
  git(directory, ["add", "--all"]);
  const env = {
    GIT_AUTHOR_NAME: STARTING_COMMIT.name,
    GIT_AUTHOR_EMAIL: STARTING_COMMIT.email,
    GIT_AUTHOR_DATE: STARTING_COMMIT.date,
    GIT_COMMITTER_NAME: STARTING_COMMIT.name,
    GIT_COMMITTER_EMAIL: STARTING_COMMIT.email,
    GIT_COMMITTER_DATE: STARTING_COMMIT.date,
  };
  git(directory, ["-c", "commit.gpgsign=false", "commit", "--quiet", "--no-verify", "--message", STARTING_COMMIT.message], env);
  return git(directory, ["rev-parse", "HEAD"]).trim();
}

/** git arguments that authenticate through the forge's CLI, and only through it. */
export function credentialArgs(forge: Forge): string[] {
  return ["-c", "credential.helper=", "-c", `credential.helper=${forge.gitRemote().credentialHelper}`];
}

export interface ResetResult {
  forge: string;
  repo: string;
  startingSha: string;
  pushed: boolean;
  issues: { id: TicketId; number: number }[];
  removed: { pullRequests: number; branches: number; issues: number; labels: number; comments: number };
}

/**
 * Brings a fixture repo back to tally's starting state. Every step reads the
 * forge first and only removes or adds what differs, so running it again, or
 * after an interrupted run, ends in the same state.
 */
export async function resetFixture(forge: Forge, log: Log = () => {}, options: SettleOptions = {}): Promise<ResetResult> {
  const repo = await forge.repo();
  assertFixture(forge, repo);
  const where = `${forge.kind}:${repo.path}`;
  log({ event: "reset-started", repo: where });

  const removed = { pullRequests: 0, branches: 0, issues: 0, labels: 0, comments: 0 };

  for (const pr of await forge.listPullRequests(forge.kind === "gitlab" ? "all" : "open")) {
    await forge.discardPullRequest(pr.number);
    removed.pullRequests += 1;
  }

  for (const branch of await forge.listBranches()) {
    if (branch === DEFAULT_BRANCH) continue;
    await forge.deleteBranch(branch);
    removed.branches += 1;
  }

  const start = await pushStartingCommit(forge);

  for (const issue of await forge.listIssues("all")) {
    try {
      await forge.deleteIssue(issue.number);
      removed.issues += 1;
    } catch (error) {
      // A list read just after a delete can still name the deleted issue.
      if (!(error instanceof ForgeError && error.notFound)) throw error;
    }
  }

  for (const label of await forge.listLabels()) {
    if (!label.startsWith("entail:")) continue;
    await forge.deleteLabel(label);
    removed.labels += 1;
  }

  removed.comments = await forge.clearComments();

  const issues: ResetResult["issues"] = [];
  for (const fixture of FIXTURE_ISSUES) {
    const issue = await forge.createIssue(fixture.title, fixture.body);
    issues.push({ id: fixture.id, number: issue.number });
  }

  await settled(forge, issues.map((i) => i.number), options);

  const result = { forge: forge.kind, repo: where, startingSha: start.sha, pushed: start.pushed, issues, removed };
  log({ event: "reset-finished", ...result });
  return result;
}

export interface SettleOptions {
  /** How long to wait between reads while the forge catches up. */
  delayMs?: number;
  attempts?: number;
}

/**
 * Waits until the forge lists exactly the issues the reset filed: GitHub's
 * issue list can lag a few seconds behind creates and deletes, and the run
 * that follows must see the starting state.
 */
async function settled(forge: Forge, numbers: readonly number[], options: SettleOptions): Promise<void> {
  const expected = [...numbers].sort((a, b) => a - b).join(",");
  const attempts = options.attempts ?? 20;
  for (let attempt = 1; ; attempt += 1) {
    const listed = (await forge.listIssues("all")).map((i) => i.number).sort((a, b) => a - b).join(",");
    if (listed === expected) return;
    if (attempt >= attempts) throw new Error(`${forge.kind} still lists issues ${listed}, not ${expected}`);
    await sleep(options.delayMs ?? 3000);
  }
}

async function pushStartingCommit(forge: Forge): Promise<{ sha: string; pushed: boolean }> {
  const directory = mkdtempSync(join(tmpdir(), "entail-fixture-"));
  try {
    const sha = buildStartingCommit(directory);
    const { url } = forge.gitRemote();
    const auth = credentialArgs(forge);
    const remote = git(directory, [...auth, "ls-remote", url, `refs/heads/${DEFAULT_BRANCH}`]).split(/\s/)[0] ?? "";
    if (remote === sha) return { sha, pushed: false };
    await forge.allowForcePush(DEFAULT_BRANCH);
    git(directory, [...auth, "push", "--quiet", "--force", url, `HEAD:refs/heads/${DEFAULT_BRANCH}`]);
    return { sha, pushed: true };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** What differs between a fixture repo and its starting state; empty when it is there. */
export async function startingStateDifferences(forge: Forge): Promise<string[]> {
  const repo = await forge.repo();
  assertFixture(forge, repo);
  const differences: string[] = [];
  const directory = mkdtempSync(join(tmpdir(), "entail-fixture-"));
  try {
    const sha = buildStartingCommit(directory);
    const remote = git(directory, [...credentialArgs(forge), "ls-remote", forge.gitRemote().url, `refs/heads/${DEFAULT_BRANCH}`]);
    if (!remote.startsWith(sha)) differences.push(`${DEFAULT_BRANCH} is not the starting commit ${sha}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  if (repo.defaultBranch !== DEFAULT_BRANCH) differences.push(`the default branch is ${repo.defaultBranch}`);
  const branches = (await forge.listBranches()).filter((b) => b !== DEFAULT_BRANCH);
  if (branches.length > 0) differences.push(`extra branches: ${branches.join(", ")}`);
  const open = await forge.listPullRequests("open");
  if (open.length > 0) differences.push(`open PRs: ${open.map((pr) => pr.number).join(", ")}`);
  const labels = (await forge.listLabels()).filter((l) => l.startsWith("entail:"));
  if (labels.length > 0) differences.push(`entail labels: ${labels.join(", ")}`);
  const issues = await forge.listIssues("all");
  const expected = FIXTURE_ISSUES.map((i) => i.title);
  const actual = issues
    .slice()
    .sort((a, b) => a.number - b.number)
    .map((i) => `${i.state === "open" ? "" : "(closed) "}${i.title}${i.labels.length ? ` [${i.labels.join(", ")}]` : ""}`);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    differences.push(`issues are ${JSON.stringify(actual)}, not ${JSON.stringify(expected)}`);
  }
  for (const issue of issues) {
    const fixture = FIXTURE_ISSUES.find((i) => i.title === issue.title);
    if (fixture && issue.body !== fixture.body) differences.push(`issue ${issue.number} (${fixture.id}) has another body`);
    if ((await forge.listIssueComments(issue.number)).length > 0) differences.push(`issue ${issue.number} has comments`);
  }
  return differences;
}

/** Creates a fixture repo if it is missing, then resets it. */
export async function setupFixture(forge: Forge, log: Log = () => {}, options: SettleOptions = {}): Promise<ResetResult> {
  if ((await forge.repo()) === undefined) {
    await forge.createPrivateRepo(FIXTURE_DESCRIPTION);
    log({ event: "repo-created", forge: forge.kind, repo: forge.path });
  }
  return resetFixture(forge, log, options);
}
