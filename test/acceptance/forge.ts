// The harness's own small forge client, through the owner's `gh` and `glab`.
// It is test tooling and shares nothing with entail's forge adapter: the
// acceptance test checks entail from the outside, through the forge.
import { spawn } from "node:child_process";

export type ForgeKind = "github" | "gitlab";

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs a CLI. Tests substitute a scripted one. */
export type Runner = (command: string, args: readonly string[], input?: string) => Promise<CommandResult>;

export const runCommand: Runner = (command, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("close", (status) => resolve({ status: status ?? 1, stdout, stderr }));
    child.stdin.end(input ?? "");
  });

export class ForgeError extends Error {
  readonly notFound: boolean;
  constructor(message: string, notFound = false) {
    super(message);
    this.notFound = notFound;
  }
}

export interface Account {
  id: number;
  login: string;
}

export interface RepoInfo {
  /** The forge's numeric id for the repo. */
  id: number;
  path: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  webUrl: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  author: string;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  branch: string;
  base: string;
  state: "open" | "closed" | "merged";
  headSha: string;
  /** Whether the forge reports a conflict with the base; undefined while it is still working it out. */
  conflicted: boolean | undefined;
  webUrl: string;
}

export interface NewPullRequest {
  branch: string;
  base: string;
  title: string;
  body: string;
}

/** What the harness does on a fixture repo's forge. */
export interface Forge {
  readonly kind: ForgeKind;
  readonly host: string;
  /** The repo's path on the forge, `owner/name` or a GitLab namespace path. */
  readonly path: string;
  whoami(): Promise<Account>;
  /** The repo, or undefined when it does not exist. */
  repo(): Promise<RepoInfo | undefined>;
  createPrivateRepo(description: string): Promise<void>;
  /** Lets the harness force-push the default branch (GitLab protects it by default). */
  allowForcePush(branch: string): Promise<void>;
  listIssues(state: "open" | "all"): Promise<Issue[]>;
  createIssue(title: string, body: string): Promise<Issue>;
  deleteIssue(number: number): Promise<void>;
  listIssueComments(number: number): Promise<Comment[]>;
  createIssueComment(number: number, body: string): Promise<void>;
  listLabels(): Promise<string[]>;
  deleteLabel(name: string): Promise<void>;
  listPullRequests(state: "open" | "all"): Promise<PullRequest[]>;
  pullRequest(number: number): Promise<PullRequest>;
  createPullRequest(pr: NewPullRequest): Promise<PullRequest>;
  /**
   * Removes a PR from the starting state: GitLab deletes the merge request,
   * GitHub (which cannot delete one) closes it.
   */
  discardPullRequest(number: number): Promise<void>;
  /**
   * Deletes every comment left on the repo's issues and PRs, and returns how
   * many. GitLab deletes notes with their issue or merge request, so it has
   * none left by then.
   */
  clearComments(): Promise<number>;
  listPullRequestComments(number: number): Promise<Comment[]>;
  createPullRequestComment(number: number, body: string): Promise<void>;
  listBranches(): Promise<string[]>;
  deleteBranch(name: string): Promise<void>;
  /** The URL to push to and the git credential helper that authenticates through the CLI. */
  gitRemote(): { url: string; credentialHelper: string };
}

export interface ForgeOptions {
  kind: ForgeKind;
  /** `github.com` or `gitlab.com`. */
  host: string;
  path: string;
  runner?: Runner;
}

export function createForge(options: ForgeOptions): Forge {
  const runner = options.runner ?? runCommand;
  return options.kind === "github"
    ? new GitHubForge(options.host, options.path, runner)
    : new GitLabForge(options.host, options.path, runner);
}

// Forge responses are read field by field.
export type Json = any;

const PAGE_SIZE = 100;

/** Calls `<cli> api` and parses the JSON it prints. */
export abstract class ApiForge {
  readonly host: string;
  readonly path: string;
  readonly #cli: string;
  readonly #runner: Runner;

  constructor(cli: string, host: string, path: string, runner: Runner) {
    this.#cli = cli;
    this.host = host;
    this.path = path;
    this.#runner = runner;
  }

  async api(method: string, endpoint: string, body?: unknown): Promise<Json> {
    const args = ["api", "--hostname", this.host, "--method", method, endpoint];
    if (body !== undefined) args.push("--header", "Content-Type: application/json", "--input", "-");
    const result = await this.#runner(this.#cli, args, body === undefined ? undefined : JSON.stringify(body));
    if (result.status !== 0) {
      const detail = `${result.stderr.trim()} ${result.stdout.trim()}`.trim();
      throw new ForgeError(`${this.#cli} api ${method} ${endpoint} failed: ${detail}`, /\b404\b|Not Found/i.test(detail));
    }
    const text = result.stdout.trim();
    return text === "" ? undefined : JSON.parse(text);
  }

  /** Reads every page of a list endpoint. */
  async list(endpoint: string): Promise<Json[]> {
    const items: Json[] = [];
    for (let page = 1; ; page += 1) {
      const separator = endpoint.includes("?") ? "&" : "?";
      const batch = (await this.api("GET", `${endpoint}${separator}per_page=${PAGE_SIZE}&page=${page}`)) as Json[];
      items.push(...batch);
      if (batch.length < PAGE_SIZE) return items;
    }
  }

  async run(args: readonly string[]): Promise<Json> {
    const result = await this.#runner(this.#cli, args);
    if (result.status !== 0) throw new ForgeError(`${this.#cli} ${args.join(" ")} failed: ${result.stderr.trim()}`);
    return result.stdout;
  }
}

function byCreation(a: Comment, b: Comment): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id - b.id;
}

class GitHubForge extends ApiForge implements Forge {
  readonly kind = "github";

  constructor(host: string, path: string, runner: Runner) {
    super("gh", host, path, runner);
  }

  get #repo(): string {
    return `repos/${this.path}`;
  }

  async whoami(): Promise<Account> {
    const user = await this.api("GET", "user");
    return { id: user.id, login: user.login };
  }

  async repo(): Promise<RepoInfo | undefined> {
    try {
      const repo = await this.api("GET", this.#repo);
      return {
        id: repo.id,
        path: repo.full_name,
        private: repo.private === true,
        description: repo.description ?? "",
        defaultBranch: repo.default_branch,
        webUrl: repo.html_url,
      };
    } catch (error) {
      if (error instanceof ForgeError && error.notFound) return undefined;
      throw error;
    }
  }

  async createPrivateRepo(description: string): Promise<void> {
    const name = this.path.split("/").at(-1)!;
    await this.api("POST", "user/repos", { name, description, private: true, has_wiki: false, has_projects: false });
  }

  async allowForcePush(): Promise<void> {
    // A new GitHub repo has no branch protection; the fixture adds none.
  }

  async listIssues(state: "open" | "all"): Promise<Issue[]> {
    const items = await this.list(`${this.#repo}/issues?state=${state}`);
    return items.filter((item) => item.pull_request === undefined).map((item) => this.#issue(item));
  }

  #issue(item: Json): Issue {
    return {
      number: item.number,
      title: item.title,
      body: item.body ?? "",
      state: item.state === "open" ? "open" : "closed",
      labels: (item.labels as Json[]).map((label) => (typeof label === "string" ? label : label.name)),
    };
  }

  async createIssue(title: string, body: string): Promise<Issue> {
    return this.#issue(await this.api("POST", `${this.#repo}/issues`, { title, body }));
  }

  async deleteIssue(number: number): Promise<void> {
    const issue = await this.api("GET", `${this.#repo}/issues/${number}`);
    await this.run([
      "api",
      "graphql",
      "--hostname",
      this.host,
      "-f",
      "query=mutation($id: ID!) { deleteIssue(input: { issueId: $id }) { clientMutationId } }",
      "-f",
      `id=${issue.node_id}`,
    ]);
  }

  async listIssueComments(number: number): Promise<Comment[]> {
    const items = await this.list(`${this.#repo}/issues/${number}/comments`);
    return items.map((item) => this.#comment(item)).sort(byCreation);
  }

  #comment(item: Json): Comment {
    return { id: item.id, body: item.body ?? "", createdAt: item.created_at, author: item.user?.login ?? "" };
  }

  async createIssueComment(number: number, body: string): Promise<void> {
    await this.api("POST", `${this.#repo}/issues/${number}/comments`, { body });
  }

  async listLabels(): Promise<string[]> {
    return (await this.list(`${this.#repo}/labels`)).map((label) => label.name);
  }

  async deleteLabel(name: string): Promise<void> {
    await this.api("DELETE", `${this.#repo}/labels/${encodeURIComponent(name)}`);
  }

  async listPullRequests(state: "open" | "all"): Promise<PullRequest[]> {
    return (await this.list(`${this.#repo}/pulls?state=${state}`)).map((item) => this.#pull(item));
  }

  #pull(item: Json): PullRequest {
    const conflicted =
      item.mergeable === false || item.mergeable_state === "dirty" ? true : item.mergeable === true ? false : undefined;
    return {
      number: item.number,
      title: item.title,
      body: item.body ?? "",
      branch: item.head.ref,
      base: item.base.ref,
      state: item.merged_at ? "merged" : item.state === "open" ? "open" : "closed",
      headSha: item.head.sha,
      conflicted,
      webUrl: item.html_url,
    };
  }

  async pullRequest(number: number): Promise<PullRequest> {
    return this.#pull(await this.api("GET", `${this.#repo}/pulls/${number}`));
  }

  async createPullRequest(pr: NewPullRequest): Promise<PullRequest> {
    return this.#pull(
      await this.api("POST", `${this.#repo}/pulls`, { title: pr.title, head: pr.branch, base: pr.base, body: pr.body }),
    );
  }

  async discardPullRequest(number: number): Promise<void> {
    const pr = await this.pullRequest(number);
    if (pr.state === "open") await this.api("PATCH", `${this.#repo}/pulls/${number}`, { state: "closed" });
  }

  async clearComments(): Promise<number> {
    const comments = await this.list(`${this.#repo}/issues/comments`);
    for (const comment of comments) await this.api("DELETE", `${this.#repo}/issues/comments/${comment.id}`);
    return comments.length;
  }

  async listPullRequestComments(number: number): Promise<Comment[]> {
    return this.listIssueComments(number);
  }

  async createPullRequestComment(number: number, body: string): Promise<void> {
    await this.createIssueComment(number, body);
  }

  async listBranches(): Promise<string[]> {
    return (await this.list(`${this.#repo}/branches`)).map((branch) => branch.name);
  }

  async deleteBranch(name: string): Promise<void> {
    await this.api("DELETE", `${this.#repo}/git/refs/heads/${name.split("/").map(encodeURIComponent).join("/")}`);
  }

  gitRemote(): { url: string; credentialHelper: string } {
    return { url: `https://${this.host}/${this.path}.git`, credentialHelper: "!gh auth git-credential" };
  }
}

class GitLabForge extends ApiForge implements Forge {
  readonly kind = "gitlab";

  constructor(host: string, path: string, runner: Runner) {
    super("glab", host, path, runner);
  }

  get #project(): string {
    return `projects/${encodeURIComponent(this.path)}`;
  }

  async whoami(): Promise<Account> {
    const user = await this.api("GET", "user");
    return { id: user.id, login: user.username };
  }

  async repo(): Promise<RepoInfo | undefined> {
    try {
      const project = await this.api("GET", this.#project);
      return {
        id: project.id,
        path: project.path_with_namespace,
        private: project.visibility === "private",
        description: project.description ?? "",
        defaultBranch: project.default_branch ?? "main",
        webUrl: project.web_url,
      };
    } catch (error) {
      if (error instanceof ForgeError && error.notFound) return undefined;
      throw error;
    }
  }

  async createPrivateRepo(description: string): Promise<void> {
    const name = this.path.split("/").at(-1)!;
    await this.api("POST", "projects", {
      name,
      path: name,
      description,
      visibility: "private",
      initialize_with_readme: false,
      default_branch: "main",
    });
  }

  async allowForcePush(branch: string): Promise<void> {
    // GitLab protects the default branch against force-pushes; the fixture's
    // reset rewrites it, so the protection is removed.
    try {
      await this.api("DELETE", `${this.#project}/protected_branches/${encodeURIComponent(branch)}`);
    } catch (error) {
      if (!(error instanceof ForgeError && error.notFound)) throw error;
    }
  }

  async listIssues(state: "open" | "all"): Promise<Issue[]> {
    const query = state === "open" ? "state=opened" : "scope=all";
    return (await this.list(`${this.#project}/issues?${query}`)).map((item) => this.#issue(item));
  }

  #issue(item: Json): Issue {
    return {
      number: item.iid,
      title: item.title,
      body: item.description ?? "",
      state: item.state === "opened" ? "open" : "closed",
      labels: item.labels as string[],
    };
  }

  async createIssue(title: string, body: string): Promise<Issue> {
    return this.#issue(await this.api("POST", `${this.#project}/issues`, { title, description: body }));
  }

  async deleteIssue(number: number): Promise<void> {
    await this.api("DELETE", `${this.#project}/issues/${number}`);
  }

  async #notes(kind: "issues" | "merge_requests", number: number): Promise<Comment[]> {
    const items = await this.list(`${this.#project}/${kind}/${number}/notes?sort=asc&order_by=created_at`);
    return items
      .filter((item) => item.system !== true)
      .map((item) => ({ id: item.id, body: item.body ?? "", createdAt: item.created_at, author: item.author?.username ?? "" }))
      .sort(byCreation);
  }

  listIssueComments(number: number): Promise<Comment[]> {
    return this.#notes("issues", number);
  }

  async createIssueComment(number: number, body: string): Promise<void> {
    await this.api("POST", `${this.#project}/issues/${number}/notes`, { body });
  }

  async listLabels(): Promise<string[]> {
    return (await this.list(`${this.#project}/labels`)).map((label) => label.name);
  }

  async deleteLabel(name: string): Promise<void> {
    await this.api("DELETE", `${this.#project}/labels/${encodeURIComponent(name)}`);
  }

  async listPullRequests(state: "open" | "all"): Promise<PullRequest[]> {
    const query = state === "open" ? "state=opened" : "scope=all";
    return (await this.list(`${this.#project}/merge_requests?${query}`)).map((item) => this.#pull(item));
  }

  #pull(item: Json): PullRequest {
    const status = item.detailed_merge_status as string | undefined;
    const conflicted =
      item.has_conflicts === true || status === "conflict"
        ? true
        : status === "checking" || status === "unchecked" || status === "preparing"
          ? undefined
          : false;
    return {
      number: item.iid,
      title: item.title,
      body: item.description ?? "",
      branch: item.source_branch,
      base: item.target_branch,
      state: item.state === "merged" ? "merged" : item.state === "opened" ? "open" : "closed",
      headSha: item.sha,
      conflicted,
      webUrl: item.web_url,
    };
  }

  async pullRequest(number: number): Promise<PullRequest> {
    return this.#pull(await this.api("GET", `${this.#project}/merge_requests/${number}`));
  }

  async createPullRequest(pr: NewPullRequest): Promise<PullRequest> {
    return this.#pull(
      await this.api("POST", `${this.#project}/merge_requests`, {
        source_branch: pr.branch,
        target_branch: pr.base,
        title: pr.title,
        description: pr.body,
      }),
    );
  }

  async discardPullRequest(number: number): Promise<void> {
    await this.api("DELETE", `${this.#project}/merge_requests/${number}`);
  }

  async clearComments(): Promise<number> {
    return 0;
  }

  listPullRequestComments(number: number): Promise<Comment[]> {
    return this.#notes("merge_requests", number);
  }

  async createPullRequestComment(number: number, body: string): Promise<void> {
    await this.api("POST", `${this.#project}/merge_requests/${number}/notes`, { body });
  }

  async listBranches(): Promise<string[]> {
    return (await this.list(`${this.#project}/repository/branches`)).map((branch) => branch.name);
  }

  async deleteBranch(name: string): Promise<void> {
    await this.api("DELETE", `${this.#project}/repository/branches/${encodeURIComponent(name)}`);
  }

  gitRemote(): { url: string; credentialHelper: string } {
    return { url: `https://${this.host}/${this.path}.git`, credentialHelper: "!glab auth git-credential" };
  }
}
