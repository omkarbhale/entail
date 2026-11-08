// What the acceptance run reads back from a fixture repo's forge after a run,
// to check entail from the outside (ADR-0010): every issue with its comments
// and label history, every PR with its comments, merge and the checks at its
// head, and VISION.md at any commit. Like the rest of the harness it goes
// through the owner's `gh` and `glab` and shares nothing with entail's adapter.
import { ApiForge, runCommand, type Comment, type ForgeKind, type Json, type Runner } from "./forge.ts";

export interface LabelEvent {
  action: "add" | "remove";
  label: string;
  at: string;
}

export interface AuditedIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  /** GitHub's reason for a close (`completed`, `not_planned`); null on GitLab and for an open issue. */
  stateReason: string | null;
  labels: string[];
  comments: Comment[];
  labelEvents: LabelEvent[];
}

export interface CheckRun {
  name: string;
  /** `success`, `failure`, `pending` and the like, as the forge words it, lower case. */
  conclusion: string;
  completedAt: string | null;
}

export interface AuditedPullRequest {
  number: number;
  title: string;
  body: string;
  branch: string;
  state: "open" | "closed" | "merged";
  headSha: string;
  createdAt: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  webUrl: string;
  comments: Comment[];
  /** The checks reported on the PR's head. */
  checks: CheckRun[];
}

export interface ForgeAudit {
  readonly kind: ForgeKind;
  readonly host: string;
  readonly path: string;
  /** The issues with these numbers. */
  issues(numbers: readonly number[]): Promise<AuditedIssue[]>;
  /** The PRs opened at or after `since` (GitHub keeps the PRs of earlier runs, closed). */
  pullRequests(since: string): Promise<AuditedPullRequest[]>;
  /** VISION.md (or another file) at a commit, or undefined when it is not there. */
  fileAt(path: string, sha: string): Promise<string | undefined>;
  /** The sha the default branch points at. */
  branchHead(branch: string): Promise<string>;
}

export function createAudit(options: { kind: ForgeKind; host: string; path: string; runner?: Runner }): ForgeAudit {
  const runner = options.runner ?? runCommand;
  return options.kind === "github"
    ? new GitHubAudit(options.host, options.path, runner)
    : new GitLabAudit(options.host, options.path, runner);
}

function byTime(a: { createdAt: string; id: number }, b: { createdAt: string; id: number }): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id - b.id;
}

/** The latest run of each check name, by completion. */
function latestPerName(runs: CheckRun[]): CheckRun[] {
  const latest = new Map<string, CheckRun>();
  for (const run of runs) {
    const seen = latest.get(run.name);
    if (!seen || (run.completedAt ?? "9999") > (seen.completedAt ?? "9999")) latest.set(run.name, run);
  }
  return [...latest.values()];
}

class GitHubAudit extends ApiForge implements ForgeAudit {
  readonly kind = "github";

  constructor(host: string, path: string, runner: Runner) {
    super("gh", host, path, runner);
  }

  get #repo(): string {
    return `repos/${this.path}`;
  }

  #comments(items: Json[]): Comment[] {
    return items
      .map((item) => ({ id: item.id, body: item.body ?? "", createdAt: item.created_at, author: item.user?.login ?? "" }))
      .sort(byTime);
  }

  async issues(numbers: readonly number[]): Promise<AuditedIssue[]> {
    const items = (await this.list(`${this.#repo}/issues?state=all`)).filter(
      (item) => item.pull_request === undefined && numbers.includes(item.number),
    );
    const issues: AuditedIssue[] = [];
    for (const item of items) {
      const events = await this.list(`${this.#repo}/issues/${item.number}/events`);
      issues.push({
        number: item.number,
        title: item.title,
        body: item.body ?? "",
        state: item.state === "open" ? "open" : "closed",
        stateReason: item.state === "open" ? null : (item.state_reason ?? null),
        labels: (item.labels as Json[]).map((label) => (typeof label === "string" ? label : label.name)),
        comments: this.#comments(await this.list(`${this.#repo}/issues/${item.number}/comments`)),
        labelEvents: events
          .filter((event) => event.event === "labeled" || event.event === "unlabeled")
          .map((event) => ({ action: event.event === "labeled" ? "add" : "remove", label: event.label?.name ?? "", at: event.created_at })),
      });
    }
    return issues.sort((a, b) => a.number - b.number);
  }

  async pullRequests(since: string): Promise<AuditedPullRequest[]> {
    const prs: AuditedPullRequest[] = [];
    for (const item of await this.list(`${this.#repo}/pulls?state=all`)) {
      if (item.created_at < since) continue;
      const runs = (await this.api("GET", `${this.#repo}/commits/${item.head.sha}/check-runs?per_page=100`)).check_runs as Json[];
      prs.push({
        number: item.number,
        title: item.title,
        body: item.body ?? "",
        branch: item.head.ref,
        state: item.merged_at ? "merged" : item.state === "open" ? "open" : "closed",
        headSha: item.head.sha,
        createdAt: item.created_at,
        mergedAt: item.merged_at ?? null,
        mergeCommitSha: item.merged_at ? (item.merge_commit_sha ?? null) : null,
        webUrl: item.html_url,
        comments: this.#comments(await this.list(`${this.#repo}/issues/${item.number}/comments`)),
        checks: latestPerName(
          runs.map((run) => ({
            name: run.name,
            conclusion: String(run.status === "completed" ? run.conclusion : run.status).toLowerCase(),
            completedAt: run.completed_at ?? null,
          })),
        ),
      });
    }
    return prs.sort((a, b) => a.number - b.number);
  }

  async fileAt(path: string, sha: string): Promise<string | undefined> {
    try {
      const file = await this.api("GET", `${this.#repo}/contents/${path}?ref=${sha}`);
      return Buffer.from(file.content as string, "base64").toString("utf8");
    } catch (error) {
      if (error instanceof Error && /\b404\b|Not Found/i.test(error.message)) return undefined;
      throw error;
    }
  }

  async branchHead(branch: string): Promise<string> {
    return (await this.api("GET", `${this.#repo}/branches/${encodeURIComponent(branch)}`)).commit.sha;
  }
}

class GitLabAudit extends ApiForge implements ForgeAudit {
  readonly kind = "gitlab";

  constructor(host: string, path: string, runner: Runner) {
    super("glab", host, path, runner);
  }

  get #project(): string {
    return `projects/${encodeURIComponent(this.path)}`;
  }

  async #notes(kind: "issues" | "merge_requests", number: number): Promise<Comment[]> {
    const items = await this.list(`${this.#project}/${kind}/${number}/notes?sort=asc&order_by=created_at`);
    return items
      .filter((item) => item.system !== true)
      .map((item) => ({ id: item.id, body: item.body ?? "", createdAt: item.created_at, author: item.author?.username ?? "" }))
      .sort(byTime);
  }

  async issues(numbers: readonly number[]): Promise<AuditedIssue[]> {
    const issues: AuditedIssue[] = [];
    for (const item of await this.list(`${this.#project}/issues?scope=all`)) {
      if (!numbers.includes(item.iid)) continue;
      const events = await this.list(`${this.#project}/issues/${item.iid}/resource_label_events`);
      issues.push({
        number: item.iid,
        title: item.title,
        body: item.description ?? "",
        state: item.state === "opened" ? "open" : "closed",
        stateReason: null,
        labels: item.labels as string[],
        comments: await this.#notes("issues", item.iid),
        labelEvents: events.map((event) => ({
          action: event.action === "add" ? "add" : "remove",
          label: event.label?.name ?? "",
          at: event.created_at,
        })),
      });
    }
    return issues.sort((a, b) => a.number - b.number);
  }

  async pullRequests(since: string): Promise<AuditedPullRequest[]> {
    const prs: AuditedPullRequest[] = [];
    for (const item of await this.list(`${this.#project}/merge_requests?scope=all`)) {
      if (item.created_at < since) continue;
      const statuses = await this.list(`${this.#project}/repository/commits/${item.sha}/statuses`);
      prs.push({
        number: item.iid,
        title: item.title,
        body: item.description ?? "",
        branch: item.source_branch,
        state: item.state === "merged" ? "merged" : item.state === "opened" ? "open" : "closed",
        headSha: item.sha,
        createdAt: item.created_at,
        mergedAt: item.merged_at ?? null,
        mergeCommitSha: item.state === "merged" ? (item.merge_commit_sha ?? item.squash_commit_sha ?? null) : null,
        webUrl: item.web_url,
        comments: await this.#notes("merge_requests", item.iid),
        checks: latestPerName(
          statuses.map((status) => ({
            name: status.name,
            conclusion: String(status.status === "failed" ? "failure" : status.status).toLowerCase(),
            completedAt: status.finished_at ?? null,
          })),
        ),
      });
    }
    return prs.sort((a, b) => a.number - b.number);
  }

  async fileAt(path: string, sha: string): Promise<string | undefined> {
    try {
      const file = await this.api("GET", `${this.#project}/repository/files/${encodeURIComponent(path)}?ref=${sha}`);
      return Buffer.from(file.content as string, "base64").toString("utf8");
    } catch (error) {
      if (error instanceof Error && /\b404\b|Not Found/i.test(error.message)) return undefined;
      throw error;
    }
  }

  async branchHead(branch: string): Promise<string> {
    return (await this.api("GET", `${this.#project}/repository/branches/${encodeURIComponent(branch)}`)).commit.id;
  }
}
