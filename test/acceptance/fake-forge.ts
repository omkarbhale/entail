// An in-memory forge for the harness's own tests, with a local bare git
// repository standing in for the forge's git remote.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE_DESCRIPTION } from "./fixture.ts";
import type { Account, Comment, Forge, ForgeKind, Issue, NewPullRequest, PullRequest, RepoInfo } from "./forge.ts";
import { git } from "./tree.ts";

export class FakeForge implements Forge {
  readonly kind: ForgeKind;
  readonly host: string;
  readonly path: string;
  readonly remote: string;
  repoInfo: RepoInfo | undefined;
  issues: Issue[] = [];
  issueComments = new Map<number, Comment[]>();
  prs: PullRequest[] = [];
  prComments = new Map<number, Comment[]>();
  labels: string[] = ["bug"];
  /** PR numbers the forge reports as conflicting with the base. */
  conflicted = new Set<number>();
  calls: string[] = [];
  #next = 1;
  #commentId = 1000;
  #clock = Date.parse("2026-11-08T10:00:00Z");

  constructor(options: { kind?: ForgeKind; path?: string; repo?: Partial<RepoInfo> | null } = {}) {
    this.kind = options.kind ?? "github";
    this.host = this.kind === "github" ? "github.com" : "gitlab.com";
    this.path = options.path ?? "owner/entail-fixture-tally";
    this.remote = mkdtempSync(join(tmpdir(), "entail-fake-remote-"));
    git(this.remote, ["init", "--quiet", "--bare", "--initial-branch", "main"]);
    this.repoInfo =
      options.repo === null
        ? undefined
        : {
            id: 42,
            path: this.path,
            private: true,
            description: FIXTURE_DESCRIPTION,
            defaultBranch: "main",
            webUrl: `https://${this.host}/${this.path}`,
            ...options.repo,
          };
  }

  #now(): string {
    this.#clock += 1000;
    return new Date(this.#clock).toISOString();
  }

  /** The sha a branch has in the remote, if it exists. */
  ref(branch: string): string | undefined {
    try {
      return git(this.remote, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).trim();
    } catch {
      return undefined;
    }
  }

  /** A comment as entail would post it, attribution line first. */
  entailComment(on: "issue" | "pr", number: number, body: string): Comment {
    const comment = { id: this.#commentId++, body: `Speaking from Owner's entail:\n\n${body}`, createdAt: this.#now(), author: "owner" };
    const store = on === "issue" ? this.issueComments : this.prComments;
    store.set(number, [...(store.get(number) ?? []), comment]);
    return comment;
  }

  async whoami(): Promise<Account> {
    return { id: 1, login: "owner" };
  }
  async repo(): Promise<RepoInfo | undefined> {
    return this.repoInfo;
  }
  async createPrivateRepo(description: string): Promise<void> {
    this.calls.push("createPrivateRepo");
    this.repoInfo = { id: 42, path: this.path, private: true, description, defaultBranch: "main", webUrl: `https://${this.host}/${this.path}` };
  }
  async allowForcePush(): Promise<void> {
    this.calls.push("allowForcePush");
  }
  async listIssues(state: "open" | "all"): Promise<Issue[]> {
    return this.issues.filter((i) => state === "all" || i.state === "open").map((i) => ({ ...i, labels: [...i.labels] }));
  }
  async createIssue(title: string, body: string): Promise<Issue> {
    const issue: Issue = { number: this.#next++, title, body, state: "open", labels: [] };
    this.issues.push(issue);
    return { ...issue };
  }
  async deleteIssue(number: number): Promise<void> {
    this.issues = this.issues.filter((i) => i.number !== number);
    this.issueComments.delete(number);
  }
  async listIssueComments(number: number): Promise<Comment[]> {
    return [...(this.issueComments.get(number) ?? [])];
  }
  async createIssueComment(number: number, body: string): Promise<void> {
    this.issueComments.set(number, [...(this.issueComments.get(number) ?? []), { id: this.#commentId++, body, createdAt: this.#now(), author: "owner" }]);
  }
  async listLabels(): Promise<string[]> {
    return [...this.labels];
  }
  async deleteLabel(name: string): Promise<void> {
    this.labels = this.labels.filter((l) => l !== name);
  }
  #refresh(pr: PullRequest): PullRequest {
    const head = pr.state === "open" ? this.ref(pr.branch) : undefined;
    return { ...pr, headSha: head ?? pr.headSha, conflicted: this.conflicted.has(pr.number) };
  }
  async listPullRequests(state: "open" | "all"): Promise<PullRequest[]> {
    return this.prs.filter((p) => state === "all" || p.state === "open").map((p) => ({ ...this.#refresh(p), conflicted: undefined }));
  }
  async pullRequest(number: number): Promise<PullRequest> {
    return this.#refresh(this.prs.find((p) => p.number === number)!);
  }
  async createPullRequest(pr: NewPullRequest): Promise<PullRequest> {
    const head = this.ref(pr.branch);
    if (!head) throw new Error(`no branch ${pr.branch}`);
    const created: PullRequest = {
      number: this.#next++,
      title: pr.title,
      body: pr.body,
      branch: pr.branch,
      base: pr.base,
      state: "open",
      headSha: head,
      conflicted: false,
      webUrl: `https://${this.host}/${this.path}/pull/${this.#next - 1}`,
    };
    this.prs.push(created);
    return { ...created };
  }
  async discardPullRequest(number: number): Promise<void> {
    const pr = this.prs.find((p) => p.number === number)!;
    if (this.kind === "gitlab") {
      this.prs = this.prs.filter((p) => p !== pr);
      this.prComments.delete(number);
    } else if (pr.state === "open") {
      pr.state = "closed";
    }
  }
  async clearComments(): Promise<number> {
    let count = 0;
    for (const store of [this.issueComments, this.prComments]) {
      for (const comments of store.values()) count += comments.length;
      store.clear();
    }
    return count;
  }
  async listPullRequestComments(number: number): Promise<Comment[]> {
    return [...(this.prComments.get(number) ?? [])];
  }
  async createPullRequestComment(number: number, body: string): Promise<void> {
    this.prComments.set(number, [...(this.prComments.get(number) ?? []), { id: this.#commentId++, body, createdAt: this.#now(), author: "owner" }]);
  }
  async listBranches(): Promise<string[]> {
    return git(this.remote, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]).split("\n").filter(Boolean);
  }
  async deleteBranch(name: string): Promise<void> {
    git(this.remote, ["update-ref", "-d", `refs/heads/${name}`]);
  }
  gitRemote(): { url: string; credentialHelper: string } {
    return { url: this.remote, credentialHelper: "" };
  }
}
