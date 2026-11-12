import { setTimeout as sleep } from "node:timers/promises";
import {
  type Actor,
  assertEntailLabel,
  type Change,
  type ChangeBatch,
  type ChangeCursor,
  type CloseReason,
  ENTAIL_LABEL_COLOR,
  ENTAIL_LABEL_DESCRIPTION,
  type Check,
  type CheckReport,
  type CheckStatus,
  checksByName,
  type CommitChecks,
  type Forge,
  type ForgeComment,
  type ForgeInstance,
  ForgeLoggedOutError,
  ForgeRequestError,
  MergePendingError,
  type ForgeSetting,
  type ForgeTarget,
  type ForgeWording,
  type Issue,
  type IssueComment,
  type MergeMethod,
  type MergeOutcome,
  type PostedComment,
  type Project,
  type PullRequestState,
  type PullRequest,
  type PullRequestComment,
  RateLimitedError,
  type RepoAccess,
} from "./forge.ts";
import { type ForgeMethod, type ForgeResponse, type Transport, TransportError } from "./transport.ts";

/** The only GitHub host served; GitHub Enterprise Server is not. */
export const GITHUB_HOST = "github.com";

const PAGE_SIZE = 100;
/** GitHub asks clients to wait at least a minute when it gives no reset time. */
const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;
const REPO_PATH = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** A GitHub login: letters, digits and single hyphens, at most 39 characters, or an app's `name[bot]`. */
const GITHUB_USERNAME = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}(?:\[bot\])?$/;
/** How often a merge GitHub is still running in the background is read again. */
const MERGE_POLL_INTERVAL_MS = 2_000;
/** How long to wait for a background merge before it counts as still pending. */
const MERGE_WAIT_MS = 120_000;

export interface GitHubForgeOptions {
  /** How often a background merge is read again; tests set 0. */
  mergePollIntervalMs?: number;
  /** How long a background merge is waited for. */
  mergeWaitMs?: number;
}

/** Where one ETag-conditional list read got to. */
interface ListCursor {
  /** The newest update time read so far, asked for with `since`; null until something was read. */
  since: string | null;
  /** The ETag of the first page last read at this `since`, or null when there is none to send. */
  etag: string | null;
}

interface GitHubCursor {
  issues: ListCursor;
  comments: ListCursor;
  pulls: ListCursor;
}

/** A commit sha as a path segment: hex only, so it can never reach another endpoint. */
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * The PRs whose closing issue references name an issue, from GitHub's GraphQL
 * API: REST has no closing references. Closed and merged PRs are included.
 */
const CLOSED_BY_QUERY = `query ($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    databaseId
    defaultBranchRef { name }
    issue(number: $number) {
      closedByPullRequestsReferences(first: 100, after: $after, includeClosedPrs: true) {
        nodes { number baseRefName repository { databaseId } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

/** The issues a PR's closing issue references name, from GitHub's GraphQL API. */
const CLOSING_ISSUES_QUERY = `query ($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    databaseId
    defaultBranchRef { name }
    pullRequest(number: $number) {
      baseRefName
      closingIssuesReferences(first: 100, after: $after) {
        nodes { number repository { databaseId } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

/**
 * Whether an issue has a transferred event: GitHub records one on an issue
 * moved in from another repo. REST has no field for it.
 */
const TRANSFERRED_QUERY = `query ($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      timelineItems(itemTypes: [TRANSFERRED_EVENT], first: 1, after: $after) { totalCount }
    }
  }
}`;

/**
 * The GitHub adapter of the {@link Forge} interface, read side.
 *
 * Change detection uses ETag-conditional reads of the repo's issues, issue and
 * PR comments, and PRs, newest update first, so any change alters the first
 * page and an unchanged list answers 304, which costs no rate limit.
 */
export class GitHubForge implements Forge {
  readonly setting: ForgeSetting;
  readonly wording: ForgeWording = { pullRequest: "pull request" };
  readonly #transport: Transport;
  readonly #mergePollIntervalMs: number;
  readonly #mergeWaitMs: number;

  constructor(setting: ForgeSetting, transport: Transport, options: GitHubForgeOptions = {}) {
    if (setting.forge !== "github") {
      throw new Error(`the GitHub adapter cannot serve a ${setting.forge} repo`);
    }
    if (setting.host !== GITHUB_HOST) {
      throw new Error(`GitHub Enterprise Server is not supported: the GitHub host must be ${GITHUB_HOST}, not ${setting.host}`);
    }
    if (!REPO_PATH.test(setting.path)) {
      throw new Error(`a GitHub repo path is owner/name, not ${JSON.stringify(setting.path)}`);
    }
    this.setting = setting;
    this.#transport = transport;
    this.#mergePollIntervalMs = options.mergePollIntervalMs ?? MERGE_POLL_INTERVAL_MS;
    this.#mergeWaitMs = options.mergeWaitMs ?? MERGE_WAIT_MS;
  }

  async currentActor(): Promise<Actor | null> {
    try {
      const user = await this.#getJson("user");
      return this.#actor(user, "user");
    } catch (error) {
      if (error instanceof ForgeLoggedOutError) return null;
      throw error;
    }
  }

  /** A user or bot account; an organization cannot open issues or PRs. */
  async actorByUsername(username: string): Promise<Actor | null> {
    if (!GITHUB_USERNAME.test(username)) return null;
    const path = `users/${username}`;
    const response = await this.#get(path, {});
    if (response.status === 404) return null;
    this.#ensureOk(response, path, "GET");
    const user = parseJson(response, this.setting.host, path, "GET");
    if (isObject(user) && user.type === "Organization") return null;
    return this.#actor(user, "user");
  }

  async project(): Promise<Project> {
    const path = `repos/${this.setting.path}`;
    const repo = await this.#getJson(path);
    return {
      forge: "github",
      host: this.setting.host,
      id: field(repo, "id", "number", path),
      path: this.setting.path,
      defaultBranch: field(repo, "default_branch", "string", path),
    };
  }

  /** Public by the repo's `visibility`, or by `private` where GitHub reports no visibility. */
  async isPublic(): Promise<boolean> {
    const path = `repos/${this.setting.path}`;
    const repo = await this.#getJson(path);
    if (isObject(repo) && typeof repo.visibility === "string") return repo.visibility === "public";
    if (isObject(repo) && typeof repo.private === "boolean") return !repo.private;
    throw new ForgeRequestError(GITHUB_HOST, 200, "GET", path, "unexpected response: neither visibility nor private is set");
  }

  /**
   * Read from the repo's `permissions` for the logged-in account. Labelling
   * needs triage access; commenting needs only read access, unless the repo
   * has issues turned off. Merging needs push access, and branch rules may
   * still refuse it, so push access is all entail can see.
   */
  async access(): Promise<RepoAccess> {
    const path = `repos/${this.setting.path}`;
    const repo = await this.#getJson(path);
    const permissions = isObject(repo) && isObject(repo.permissions) ? repo.permissions : null;
    const can = (role: string) => permissions !== null && permissions[role] === true;
    const push = can("admin") || can("maintain") || can("push");
    let cannotLabelAndComment: string | null = null;
    if (permissions === null) {
      cannotLabelAndComment = "GitHub did not report what the logged-in account may do in this repo";
    } else if (isObject(repo) && repo.has_issues === false) {
      cannotLabelAndComment = "the repo has issues turned off";
    } else if (!push && !can("triage")) {
      cannotLabelAndComment = "the logged-in account has read access only; adding labels needs triage access or more";
    }
    return {
      cannotLabelAndComment,
      mayLackMerge: push ? null : "the logged-in account has no push access, which merging needs",
    };
  }

  /** The methods the repo allows; GitHub reports them only to accounts with push access. */
  async mergeMethods(): Promise<MergeMethod[]> {
    const path = `repos/${this.setting.path}`;
    const repo = await this.#getJson(path);
    const allowed: Record<MergeMethod, string> = {
      squash: "allow_squash_merge",
      merge: "allow_merge_commit",
      rebase: "allow_rebase_merge",
    };
    return (Object.keys(allowed) as MergeMethod[]).filter((method) => isObject(repo) && repo[allowed[method]] === true);
  }

  async openIssueNumbers(): Promise<number[]> {
    const params = new URLSearchParams({ state: "open", per_page: String(PAGE_SIZE) });
    let path = `repos/${this.setting.path}/issues?${params}`;
    const numbers: number[] = [];
    for (;;) {
      const page = await this.#get(path, {});
      this.#ensureOk(page, path, "GET");
      const body = parseJson(page, this.setting.host, path, "GET");
      if (!Array.isArray(body)) throw this.#malformed(page.status, path, "expected a list");
      for (const raw of body) {
        // The issues list also carries pull requests.
        if (isObject(raw) && "pull_request" in raw) continue;
        numbers.push(field(raw, "number", "number", "issue"));
      }
      const next = nextPagePath(page.headers.link);
      if (next === null) break;
      path = next;
    }
    return numbers.sort((a, b) => a - b);
  }

  async transferredIn(issueNumber: number): Promise<boolean> {
    const repository = await this.#graphqlRepository(TRANSFERRED_QUERY, pathNumber(issueNumber), null);
    const items = graphqlField(graphqlField(repository, "issue"), "timelineItems");
    if (typeof items.totalCount !== "number") throw this.#malformed(200, "graphql", "no totalCount for the transferred events");
    return items.totalCount > 0;
  }

  async issue(issueNumber: number): Promise<Issue | null> {
    const path = `repos/${this.setting.path}/issues/${pathNumber(issueNumber)}`;
    const response = await this.#get(path, {});
    // Gone: never opened, or deleted. A transferred issue answers with a redirect to its new repo.
    if (response.status === 404 || response.status === 410 || response.status === 301) return null;
    this.#ensureOk(response, path, "GET");
    const raw = parseJson(response, this.setting.host, path, "GET");
    // The issues API answers for pull requests too, which are not issues.
    if (isObject(raw) && "pull_request" in raw) return null;
    const issue = this.#issue(raw);
    // A transferred issue, followed to its new repo, is no longer this repo's issue by that number.
    return issue.number === issueNumber ? issue : null;
  }

  /** github.com is the only GitHub host, with no version to read, so it is always served. */
  async instance(): Promise<ForgeInstance> {
    return { version: null, unsupported: null };
  }

  async changesSince(cursor: ChangeCursor | null): Promise<ChangeBatch> {
    const from = cursor === null ? EMPTY_CURSOR : parseCursor(cursor);
    const issues = await this.#readList(`repos/${this.setting.path}/issues`, { state: "all" }, from.issues);
    const comments = await this.#readList(`repos/${this.setting.path}/issues/comments`, {}, from.comments);
    const pulls = await this.#readPulls(from.pulls);

    const changes: Change[] = [];
    for (const raw of issues.items) {
      // The issues list also carries pull requests, which the pulls list reports in full.
      if (isObject(raw) && "pull_request" in raw) continue;
      const issue = this.#issue(raw);
      changes.push({ kind: "issue", id: issue.id, updatedAt: issue.updatedAt, issue });
    }
    for (const raw of comments.items) {
      // Comments on a pull request's conversation share this list with comments on issues.
      if (isObject(raw) && typeof raw.html_url === "string" && /\/pull\/\d+/.test(raw.html_url)) {
        const comment = this.#pullRequestComment(raw);
        changes.push({ kind: "pull-request-comment", id: comment.id, updatedAt: comment.updatedAt, comment });
        continue;
      }
      const comment = this.#comment(raw);
      changes.push({ kind: "issue-comment", id: comment.id, updatedAt: comment.updatedAt, comment });
    }
    for (const raw of pulls.items) {
      const pullRequest = this.#pullRequest(raw);
      changes.push({ kind: "pull-request", id: pullRequest.id, updatedAt: pullRequest.updatedAt, pullRequest });
    }
    const next: GitHubCursor = { issues: issues.cursor, comments: comments.cursor, pulls: pulls.cursor };
    return { changes, cursor: JSON.stringify(next) };
  }

  async pullRequest(number: number): Promise<PullRequest> {
    return this.#pullRequest(await this.#getJson(`repos/${this.setting.path}/pulls/${pathNumber(number)}`));
  }

  /** The PR's conversation comments: GitHub keeps them as comments on the PR's issue. Review comments are not among them. */
  async pullRequestComments(number: number): Promise<PullRequestComment[]> {
    const path = `repos/${this.setting.path}/issues/${pathNumber(number)}/comments?per_page=${PAGE_SIZE}`;
    const comments = await this.#readPages(path, (body) => body);
    return comments.map((raw) => this.#pullRequestComment(raw));
  }

  async linkedPullRequests(issueNumber: number): Promise<PullRequest[]> {
    const numbers: number[] = [];
    let after: string | null = null;
    for (;;) {
      const repository = await this.#graphqlRepository(CLOSED_BY_QUERY, pathNumber(issueNumber), after);
      const connection = graphqlField(graphqlField(repository, "issue"), "closedByPullRequestsReferences");
      const defaultBranch = defaultBranchOf(repository);
      for (const node of graphqlNodes(connection)) {
        if (!isObject(node) || !isObject(node.repository) || node.repository.databaseId !== repository.databaseId) continue;
        if (node.baseRefName !== defaultBranch || typeof node.number !== "number") continue;
        if (!numbers.includes(node.number)) numbers.push(node.number);
      }
      after = nextGraphqlPage(connection);
      if (after === null) break;
    }
    numbers.sort((a, b) => a - b);
    const pullRequests: PullRequest[] = [];
    for (const number of numbers) pullRequests.push(await this.pullRequest(number));
    return pullRequests;
  }

  async linkedIssues(pullRequestNumber: number): Promise<number[]> {
    const numbers: number[] = [];
    let after: string | null = null;
    for (;;) {
      const repository = await this.#graphqlRepository(CLOSING_ISSUES_QUERY, pathNumber(pullRequestNumber), after);
      const pull = graphqlField(repository, "pullRequest");
      if (pull.baseRefName !== defaultBranchOf(repository)) return [];
      const connection = graphqlField(pull, "closingIssuesReferences");
      for (const node of graphqlNodes(connection)) {
        if (!isObject(node) || !isObject(node.repository) || node.repository.databaseId !== repository.databaseId) continue;
        if (typeof node.number === "number" && !numbers.includes(node.number)) numbers.push(node.number);
      }
      after = nextGraphqlPage(connection);
      if (after === null) break;
    }
    return numbers.sort((a, b) => a - b);
  }

  /**
   * Check runs and commit statuses at the sha together, with the checks the
   * default branch's rules require: its rulesets and its branch protection.
   * GitHub's checks belong to the commit, so the PR number is not needed.
   */
  async checks(_pullRequestNumber: number, sha: string, named: readonly string[]): Promise<CheckReport> {
    const at = checkedSha(sha);
    const { defaultBranch } = await this.project();
    const required = await this.#requiredChecks(defaultBranch);
    const reported = await this.#checksAt(at);
    return {
      sha,
      checks: checksByName(reported, named),
      required: required.map((name) => ({ name, reported: reported.some((check) => check.name === name) })),
    };
  }

  async recentDefaultBranchChecks(commits: number): Promise<CommitChecks[]> {
    const { defaultBranch } = await this.project();
    const path = `repos/${this.setting.path}/commits?${new URLSearchParams({ sha: defaultBranch, per_page: String(pageCount(commits)) })}`;
    const list = await this.#getJson(path);
    if (!Array.isArray(list)) throw this.#malformed(200, path, "expected a list");
    const recent: CommitChecks[] = [];
    for (const commit of list.slice(0, commits)) {
      const sha = checkedSha(field(commit, "sha", "string", "commit"));
      recent.push({ sha, checks: checksByName(await this.#checksAt(sha)) });
    }
    return recent;
  }

  /** The check names the branch's rulesets and branch protection require, each once. */
  async #requiredChecks(branch: string): Promise<string[]> {
    const required: string[] = [];
    const add = (name: unknown) => {
      if (typeof name === "string" && !required.includes(name)) required.push(name);
    };
    const ref = branchSegment(branch);

    const protection = await this.#unlessPlanLacksIt(() => this.#getJson(`repos/${this.setting.path}/branches/${ref}`), null);
    const statusChecks = isObject(protection) && isObject(protection.protection) ? protection.protection.required_status_checks : undefined;
    if (isObject(statusChecks)) {
      for (const context of Array.isArray(statusChecks.contexts) ? statusChecks.contexts : []) add(context);
      for (const check of Array.isArray(statusChecks.checks) ? statusChecks.checks : []) add(isObject(check) ? check.context : undefined);
    }

    const rules = await this.#unlessPlanLacksIt(
      () => this.#readPages(`repos/${this.setting.path}/rules/branches/${ref}?per_page=${PAGE_SIZE}`, (body) => body),
      [],
    );
    for (const rule of rules) {
      if (!isObject(rule) || rule.type !== "required_status_checks" || !isObject(rule.parameters)) continue;
      const checks = rule.parameters.required_status_checks;
      for (const check of Array.isArray(checks) ? checks : []) add(isObject(check) ? check.context : undefined);
    }
    return required;
  }

  /**
   * Reads branch protection or rulesets, or returns `none` when GitHub says
   * the repo's plan has no such feature: a private repo on GitHub Free answers
   * 403 "Upgrade to GitHub Pro or make this repository public to enable this
   * feature." Such a repo can have no rules there, so they require no check;
   * every check at the head still has to pass. Any other refusal still fails.
   */
  async #unlessPlanLacksIt<T>(read: () => Promise<T>, none: T): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (error instanceof ForgeRequestError && error.status === 403 && PLAN_LACKS_FEATURE.test(error.message)) return none;
      throw error;
    }
  }

  /** Every check run and commit status at the sha, the latest of each. */
  async #checksAt(sha: string): Promise<Check[]> {
    const base = `repos/${this.setting.path}/commits/${sha}`;
    const runs = await this.#readPages(`${base}/check-runs?filter=latest&per_page=${PAGE_SIZE}`, (body) =>
      isObject(body) ? body.check_runs : undefined,
    );
    // The combined status holds only the latest status for each context.
    const statuses = await this.#readPages(`${base}/status?per_page=${PAGE_SIZE}`, (body) => (isObject(body) ? body.statuses : undefined));

    const checks: Check[] = [];
    for (const run of runs) {
      const where = "check run";
      checks.push({
        name: field(run, "name", "string", where),
        status: checkRunStatus(field(run, "status", "string", where), isObject(run) ? run.conclusion : null),
        reported: true,
        url: isObject(run) && typeof run.html_url === "string" ? run.html_url : null,
      });
    }
    for (const status of statuses) {
      const where = "commit status";
      checks.push({
        name: field(status, "context", "string", where),
        status: commitStatus(field(status, "state", "string", where)),
        reported: true,
        url: isObject(status) && typeof status.target_url === "string" && status.target_url !== "" ? status.target_url : null,
      });
    }
    return checks;
  }

  /**
   * Runs a GraphQL query about this repo and returns its `repository`. A
   * GraphQL error is answered with HTTP 200, so the body is read for it.
   */
  async #graphqlRepository(query: string, number: number, after: string | null): Promise<Record<string, unknown>> {
    const [owner, name] = this.setting.path.split("/");
    const path = "graphql";
    const body = { query, variables: { owner, name, number, after } };
    let response: ForgeResponse;
    try {
      response = await this.#transport.request({ host: this.setting.host, method: "POST", path, body });
    } catch (error) {
      if (error instanceof TransportError && error.loggedOut) throw new ForgeLoggedOutError(this.setting.host, error.message);
      throw error;
    }
    this.#ensureOk(response, path, "POST");
    const parsed = parseJson(response, this.setting.host, path, "POST");
    const errors = isObject(parsed) && Array.isArray(parsed.errors) ? parsed.errors : [];
    if (errors.some((error) => isObject(error) && error.type === "RATE_LIMITED")) {
      const reset = Number(response.headers["x-ratelimit-reset"]);
      throw new RateLimitedError(
        this.setting.host,
        Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : new Date(Date.now() + DEFAULT_RATE_LIMIT_WAIT_MS),
      );
    }
    if (errors.length > 0) {
      const messages = errors.map((error) => (isObject(error) && typeof error.message === "string" ? error.message : "unknown error"));
      throw new ForgeRequestError(this.setting.host, response.status, "POST", path, messages.join("; "));
    }
    const data = isObject(parsed) ? parsed.data : undefined;
    if (!isObject(data) || !isObject(data.repository)) throw this.#malformed(response.status, path, "no repository in the GraphQL data");
    return data.repository;
  }

  /**
   * Reads the PR list newest update first, conditionally on the cursor's
   * ETag. The list takes no `since`, so pages are read only until a PR last
   * updated before the cursor; its request never changes, so its ETag is kept.
   */
  async #readPulls(cursor: ListCursor): Promise<{ items: unknown[]; cursor: ListCursor }> {
    const params = new URLSearchParams({ state: "all", sort: "updated", direction: "desc", per_page: String(PAGE_SIZE) });
    const first = `repos/${this.setting.path}/pulls?${params}`;
    const headers: Record<string, string> = cursor.etag === null ? {} : { "If-None-Match": cursor.etag };
    const response = await this.#get(first, headers);
    if (response.status === 304) return { items: [], cursor };

    const since = cursor.since === null ? null : Date.parse(cursor.since);
    const items: unknown[] = [];
    let newest = since;
    let page: ForgeResponse = response;
    let path = first;
    pages: for (;;) {
      this.#ensureOk(page, path, "GET");
      const body = parseJson(page, this.setting.host, path, "GET");
      if (!Array.isArray(body)) throw this.#malformed(page.status, path, "expected a list");
      for (const item of body) {
        const updated = isObject(item) && typeof item.updated_at === "string" ? Date.parse(item.updated_at) : NaN;
        if (since !== null && !Number.isNaN(updated) && updated < since) break pages;
        items.push(item);
        if (!Number.isNaN(updated) && (newest === null || updated > newest)) newest = updated;
      }
      const next = nextPagePath(page.headers.link);
      if (next === null) break;
      path = next;
      page = await this.#get(path, {});
    }
    return { items, cursor: { since: newest === null ? null : githubTime(newest), etag: response.headers.etag ?? null } };
  }

  /** Every item of a paged read, following the `Link` header; `items` finds the list in each page's body. */
  async #readPages(first: string, items: (body: unknown) => unknown): Promise<unknown[]> {
    const all: unknown[] = [];
    let path = first;
    for (;;) {
      const response = await this.#get(path, {});
      this.#ensureOk(response, path, "GET");
      const list = items(parseJson(response, this.setting.host, path, "GET"));
      if (!Array.isArray(list)) throw this.#malformed(response.status, path, "expected a list");
      all.push(...list);
      const next = nextPagePath(response.headers.link);
      if (next === null) return all;
      path = next;
    }
  }

  /**
   * Reads a list newest update first, conditionally on the cursor's ETag. A 304
   * leaves the cursor as it was. Otherwise every page is read, and the cursor
   * moves `since` to the newest update seen; the ETag is kept only while
   * `since` stays put, as it belongs to that exact request.
   */
  async #readList(
    base: string,
    query: Record<string, string>,
    cursor: ListCursor,
  ): Promise<{ items: unknown[]; cursor: ListCursor }> {
    const params = new URLSearchParams({ ...query, sort: "updated", direction: "desc", per_page: String(PAGE_SIZE) });
    if (cursor.since !== null) params.set("since", cursor.since);
    const first = `${base}?${params}`;
    const headers: Record<string, string> = cursor.etag === null ? {} : { "If-None-Match": cursor.etag };

    const response = await this.#get(first, headers);
    if (response.status === 304) return { items: [], cursor };

    const items: unknown[] = [];
    let page: ForgeResponse = response;
    let path = first;
    for (;;) {
      this.#ensureOk(page, path, "GET");
      const body = parseJson(page, this.setting.host, path, "GET");
      if (!Array.isArray(body)) throw this.#malformed(page.status, path, "expected a list");
      items.push(...body);
      const next = nextPagePath(page.headers.link);
      if (next === null) break;
      path = next;
      page = await this.#get(path, {});
    }

    let newest: number | null = cursor.since === null ? null : Date.parse(cursor.since);
    for (const item of items) {
      const updated = isObject(item) && typeof item.updated_at === "string" ? Date.parse(item.updated_at) : NaN;
      if (!Number.isNaN(updated) && (newest === null || updated > newest)) newest = updated;
    }
    const since = newest === null ? null : githubTime(newest);
    const etag = since === cursor.since ? (response.headers.etag ?? null) : null;
    return { items, cursor: { since, etag } };
  }


  // Writes

  /** Issues and PRs share GitHub's issue comments, so both post there. */
  async postComment(_target: ForgeTarget, number: number, body: string): Promise<PostedComment> {
    const path = `repos/${this.setting.path}/issues/${number}/comments`;
    const comment = await this.#sendJson("POST", path, { body });
    return { id: field(comment, "id", "number", path), url: field(comment, "html_url", "string", path) };
  }

  async addLabel(issueNumber: number, label: string): Promise<void> {
    assertEntailLabel(label);
    await this.#ensureLabel(label);
    const path = `repos/${this.setting.path}/issues/${issueNumber}/labels`;
    await this.#sendJson("POST", path, { labels: [label] });
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    assertEntailLabel(label);
    const path = `repos/${this.setting.path}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`;
    const response = await this.#send("DELETE", path);
    // GitHub answers 404 when the issue does not carry the label: it is already removed.
    if (response.status === 404) return;
    this.#ensureOk(response, path, "DELETE");
  }

  async closeIssue(issueNumber: number, reason: CloseReason): Promise<void> {
    const path = `repos/${this.setting.path}/issues/${issueNumber}`;
    await this.#sendJson("PATCH", path, { state: "closed", state_reason: reason === "not-planned" ? "not_planned" : "completed" });
  }

  async reopenIssue(issueNumber: number): Promise<void> {
    const path = `repos/${this.setting.path}/issues/${issueNumber}`;
    await this.#sendJson("PATCH", path, { state: "open" });
  }

  /**
   * Merges through `merge-async`, pinned to `sha`, as a direct merge that
   * bypasses no rules. GitHub may run the merge in the background, so a
   * pending merge is read again until it merges or fails, or until
   * {@link MERGE_WAIT_MS} has passed, which throws {@link MergePendingError}.
   */
  async merge(prNumber: number, sha: string, method?: MergeMethod): Promise<MergeOutcome> {
    const path = `repos/${this.setting.path}/pulls/${prNumber}/merge-async`;
    const body: Record<string, unknown> = { sha, merge_action: "direct_merge", bypass_rules: false };
    if (method) body.merge_method = method;
    const started = await this.#send("PUT", path, body);
    const refusal = this.#refusal(started, path, "PUT");
    if (refusal !== null) return { merged: false, refusal };

    const deadline = Date.now() + this.#mergeWaitMs;
    let result = parseJson(started, this.setting.host, path, "PUT");
    for (;;) {
      const status = isObject(result) ? result.status : undefined;
      const details = isObject(result) && isObject(result.details) ? result.details : {};
      const message = typeof details.message === "string" ? details.message : null;
      if (status === "merged") {
        return { merged: true, mergeCommitSha: typeof details.sha === "string" ? details.sha : null };
      }
      if (status === "failed") return { merged: false, refusal: message ?? "GitHub reported that the merge failed" };
      if (status === "enqueued") return { merged: false, refusal: "GitHub put the pull request in a merge queue instead of merging it" };
      if (status !== "pending" || typeof details.uuid !== "string") {
        throw new ForgeRequestError(this.setting.host, started.status, "PUT", path, `unexpected merge status ${String(status)}`);
      }
      if (Date.now() >= deadline) {
        throw new MergePendingError(this.setting.host, prNumber, this.#mergeWaitMs);
      }
      if (this.#mergePollIntervalMs > 0) await sleep(this.#mergePollIntervalMs);
      result = await this.#getJson(`${path}/${encodeURIComponent(details.uuid)}`);
    }
  }

  // Reads that settle writes

  async comments(_target: ForgeTarget, number: number): Promise<ForgeComment[]> {
    const items = await this.#readAll(`repos/${this.setting.path}/issues/${number}/comments?per_page=${PAGE_SIZE}`);
    return items.map((raw) => {
      const { issueNumber: _issueNumber, updatedAt: _updatedAt, ...comment } = this.#comment(raw);
      return comment;
    });
  }

  async pullRequestState(prNumber: number): Promise<PullRequestState> {
    const path = `repos/${this.setting.path}/pulls/${prNumber}`;
    const pr = await this.#getJson(path);
    const merged = isObject(pr) && pr.merged === true;
    const state = field(pr, "state", "string", path);
    const head = isObject(pr) ? pr.head : undefined;
    return {
      state: merged ? "merged" : state === "open" ? "open" : "closed",
      headSha: field(head, "sha", "string", `${path} head`),
      mergeCommitSha: merged && isObject(pr) && typeof pr.merge_commit_sha === "string" ? pr.merge_commit_sha : null,
    };
  }

  /** Creates `label` in the repo unless it is there already. */
  async #ensureLabel(label: string): Promise<void> {
    const path = `repos/${this.setting.path}/labels/${encodeURIComponent(label)}`;
    const found = await this.#send("GET", path);
    if (found.status !== 404) {
      this.#ensureOk(found, path, "GET");
      return;
    }
    const create = `repos/${this.setting.path}/labels`;
    const created = await this.#send("POST", create, { name: label, color: ENTAIL_LABEL_COLOR, description: ENTAIL_LABEL_DESCRIPTION });
    // 422 is GitHub's answer when the label was created meanwhile.
    if (created.status === 422 && /already_exists/.test(created.body)) return;
    this.#ensureOk(created, create, "POST");
  }

  /**
   * Why GitHub refused a merge, or null when it accepted it. A rate limit
   * or a refused login is thrown, as nothing was asked; any other 4xx is the
   * forge's refusal; a 5xx is thrown, as the merge's fate is unknown.
   */
  #refusal(response: ForgeResponse, path: string, method: ForgeMethod): string | null {
    const { status } = response;
    if (status >= 200 && status < 300) return null;
    if (status >= 500 || rateLimitReset(response) || status === 401) this.#ensureOk(response, path, method);
    return `GitHub refused the merge (HTTP ${status}): ${errorDetail(response)}`;
  }

  /** Every item of a list, following its `Link` pages. */
  async #readAll(first: string): Promise<unknown[]> {
    const items: unknown[] = [];
    let path: string | null = first;
    while (path !== null) {
      const page = await this.#send("GET", path);
      this.#ensureOk(page, path, "GET");
      const body = parseJson(page, this.setting.host, path, "GET");
      if (!Array.isArray(body)) throw this.#malformed(page.status, path, "expected a list");
      items.push(...body);
      path = nextPagePath(page.headers.link);
    }
    return items;
  }

  async #sendJson(method: ForgeMethod, path: string, body: unknown): Promise<unknown> {
    const response = await this.#send(method, path, body);
    this.#ensureOk(response, path, method);
    return response.body.trim() === "" ? null : parseJson(response, this.setting.host, path, method);
  }

  async #getJson(path: string): Promise<unknown> {
    const response = await this.#get(path, {});
    this.#ensureOk(response, path, "GET");
    return parseJson(response, this.setting.host, path, "GET");
  }

  #get(path: string, headers: Record<string, string>): Promise<ForgeResponse> {
    return this.#request({ host: this.setting.host, method: "GET", path, headers });
  }

  #send(method: ForgeMethod, path: string, body?: unknown): Promise<ForgeResponse> {
    return this.#request({ host: this.setting.host, method, path, ...(body === undefined ? {} : { body }) });
  }

  async #request(request: Parameters<Transport["request"]>[0]): Promise<ForgeResponse> {
    try {
      return await this.#transport.request(request);
    } catch (error) {
      if (error instanceof TransportError && error.loggedOut) {
        throw new ForgeLoggedOutError(this.setting.host, error.message);
      }
      throw error;
    }
  }

  /** Throws for anything but a 2xx: a rate limit with its reset time, a refused login, or a request error. */
  #ensureOk(response: ForgeResponse, path: string, method: ForgeMethod): void {
    const { status } = response;
    if (status >= 200 && status < 300) return;
    const resetAt = rateLimitReset(response);
    if (resetAt) throw new RateLimitedError(this.setting.host, resetAt);
    if (status === 401) throw new ForgeLoggedOutError(this.setting.host, `${method} ${path} answered HTTP 401`);
    throw new ForgeRequestError(this.setting.host, status, method, path, errorDetail(response));
  }

  #actor(raw: unknown, where: string): Actor {
    return {
      forge: "github",
      host: this.setting.host,
      id: field(raw, "id", "number", where),
      username: field(raw, "login", "string", where),
    };
  }

  #issue(raw: unknown): Issue {
    const where = "issue";
    const labels = isObject(raw) && Array.isArray(raw.labels) ? raw.labels : [];
    const state = field(raw, "state", "string", where);
    if (state !== "open" && state !== "closed") throw this.#malformed(200, where, `unknown state ${state}`);
    return {
      id: field(raw, "id", "number", where),
      number: field(raw, "number", "number", where),
      title: field(raw, "title", "string", where),
      body: isObject(raw) && typeof raw.body === "string" ? raw.body : "",
      state,
      author: this.#actor(isObject(raw) ? raw.user : undefined, `${where} user`),
      labels: labels.map((label) => (typeof label === "string" ? label : field(label, "name", "string", `${where} label`))),
      createdAt: isoTime(field(raw, "created_at", "string", where)),
      updatedAt: isoTime(field(raw, "updated_at", "string", where)),
      url: field(raw, "html_url", "string", where),
    };
  }

  #comment(raw: unknown): IssueComment {
    const where = "issue comment";
    const issueUrl = field(raw, "issue_url", "string", where);
    const issueNumber = Number(/\/issues\/(\d+)$/.exec(issueUrl)?.[1]);
    if (!Number.isInteger(issueNumber)) throw this.#malformed(200, where, `no issue number in ${issueUrl}`);
    return {
      id: field(raw, "id", "number", where),
      issueNumber,
      body: isObject(raw) && typeof raw.body === "string" ? raw.body : "",
      author: this.#actor(isObject(raw) ? raw.user : undefined, `${where} user`),
      createdAt: isoTime(field(raw, "created_at", "string", where)),
      updatedAt: isoTime(field(raw, "updated_at", "string", where)),
      url: field(raw, "html_url", "string", where),
    };
  }

  /** A PR from the pulls API. A list's PRs carry no mergeability, so theirs is null. */
  #pullRequest(raw: unknown): PullRequest {
    const where = "pull request";
    const state = field(raw, "state", "string", where);
    if (state !== "open" && state !== "closed") throw this.#malformed(200, where, `unknown state ${state}`);
    const merged = isObject(raw) && (typeof raw.merged_at === "string" || raw.merged === true);
    const head = isObject(raw) ? raw.head : undefined;
    const base = isObject(raw) ? raw.base : undefined;
    // `mergeable` is null while GitHub works it out; `mergeable_state` says what else stands in the way.
    const mergeable = isObject(raw) && typeof raw.mergeable === "boolean" ? raw.mergeable : null;
    const mergeableState = isObject(raw) && typeof raw.mergeable_state === "string" ? raw.mergeable_state : "unknown";
    const known = mergeable !== null && mergeableState !== "unknown";
    return {
      id: field(raw, "id", "number", where),
      number: field(raw, "number", "number", where),
      title: field(raw, "title", "string", where),
      body: isObject(raw) && typeof raw.body === "string" ? raw.body : "",
      state: merged ? "merged" : state,
      draft: isObject(raw) && raw.draft === true,
      mergeable: known ? mergeable && MERGEABLE_STATES.has(mergeableState) : null,
      conflicts: known ? mergeable === false || mergeableState === "dirty" : null,
      headSha: field(head, "sha", "string", `${where} head`),
      baseBranch: field(base, "ref", "string", `${where} base`),
      author: this.#actor(isObject(raw) ? raw.user : undefined, `${where} user`),
      createdAt: isoTime(field(raw, "created_at", "string", where)),
      updatedAt: isoTime(field(raw, "updated_at", "string", where)),
      url: field(raw, "html_url", "string", where),
    };
  }

  /** A comment on a PR's conversation, which GitHub keeps as a comment on the PR's issue. */
  #pullRequestComment(raw: unknown): PullRequestComment {
    const { issueNumber, ...comment } = this.#comment(raw);
    return { ...comment, pullRequestNumber: issueNumber };
  }

  #malformed(status: number, where: string, detail: string): ForgeRequestError {
    return new ForgeRequestError(this.setting.host, status, "GET", where, `unexpected response: ${detail}`);
  }
}

const EMPTY_LIST_CURSOR: ListCursor = { since: null, etag: null };
const EMPTY_CURSOR: GitHubCursor = { issues: EMPTY_LIST_CURSOR, comments: EMPTY_LIST_CURSOR, pulls: EMPTY_LIST_CURSOR };

function parseCursor(cursor: ChangeCursor): GitHubCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    return EMPTY_CURSOR;
  }
  if (isObject(parsed) && isListCursor(parsed.issues) && isListCursor(parsed.comments)) {
    // A cursor from before PRs were read starts their list afresh.
    const pulls = isListCursor(parsed.pulls) ? parsed.pulls : EMPTY_LIST_CURSOR;
    return { issues: parsed.issues, comments: parsed.comments, pulls };
  }
  return EMPTY_CURSOR;
}

/** The `mergeable_state`s under which GitHub would merge a PR now; `unstable` means only checks it does not require failed. */
const MERGEABLE_STATES = new Set(["clean", "unstable", "has_hooks"]);

/** A check run's status: neutral and skipped count as passed. */
function checkRunStatus(status: string, conclusion: unknown): CheckStatus {
  if (status !== "completed") return "pending";
  return conclusion === "success" || conclusion === "neutral" || conclusion === "skipped" ? "passed" : "failed";
}

/** A commit status's state: `error` and `failure` are both failed. */
function commitStatus(state: string): CheckStatus {
  if (state === "success") return "passed";
  if (state === "pending") return "pending";
  return "failed";
}

/** A sha checked before it goes into a path. */
function checkedSha(sha: string): string {
  if (!SHA.test(sha)) throw new Error(`not a commit sha: ${JSON.stringify(sha)}`);
  return sha;
}

/** A PR or issue number checked before it goes into a path. */
function pathNumber(number: number): number {
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`not an issue or PR number: ${number}`);
  return number;
}

/** How many commits to ask for, within what one page holds. */
function pageCount(commits: number): number {
  if (!Number.isSafeInteger(commits) || commits <= 0) throw new Error(`not a number of commits: ${commits}`);
  return Math.min(commits, PAGE_SIZE);
}

/** A branch name as path segments: each part encoded, its slashes kept. */
function branchSegment(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

function graphqlField(raw: unknown, name: string): Record<string, unknown> {
  const value = isObject(raw) ? raw[name] : undefined;
  if (!isObject(value)) throw new ForgeRequestError(GITHUB_HOST, 200, "POST", "graphql", `unexpected response: no ${name}`);
  return value;
}

function graphqlNodes(connection: Record<string, unknown>): unknown[] {
  return Array.isArray(connection.nodes) ? connection.nodes : [];
}

function nextGraphqlPage(connection: Record<string, unknown>): string | null {
  const info = connection.pageInfo;
  return isObject(info) && info.hasNextPage === true && typeof info.endCursor === "string" ? info.endCursor : null;
}

function defaultBranchOf(repository: Record<string, unknown>): string {
  return field(repository.defaultBranchRef, "name", "string", "repository default branch");
}

function isListCursor(value: unknown): value is ListCursor {
  return (
    isObject(value) &&
    (value.since === null || (typeof value.since === "string" && !Number.isNaN(Date.parse(value.since)))) &&
    (value.etag === null || typeof value.etag === "string")
  );
}

/**
 * The reset time of a rate-limit response, or null when the response is not
 * one. GitHub answers 403 or 429 with `x-ratelimit-remaining: 0` and the reset
 * in epoch seconds for its primary limit, and with `retry-after` seconds for
 * its secondary limits.
 */
function rateLimitReset(response: ForgeResponse): Date | null {
  const { status, headers } = response;
  if (status !== 403 && status !== 429) return null;
  const retryAfter = Number(headers["retry-after"]);
  if (headers["retry-after"] !== undefined && Number.isFinite(retryAfter)) {
    return new Date(Date.now() + retryAfter * 1000);
  }
  if (headers["x-ratelimit-remaining"] === "0") {
    const reset = Number(headers["x-ratelimit-reset"]);
    return Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : new Date(Date.now() + DEFAULT_RATE_LIMIT_WAIT_MS);
  }
  if (status === 429) return new Date(Date.now() + DEFAULT_RATE_LIMIT_WAIT_MS);
  return null;
}

/** The API path of the `rel="next"` page in a `Link` header, or null on the last page. */
function nextPagePath(link: string | undefined): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match?.[1]) {
      const url = new URL(match[1]);
      return `${url.pathname.replace(/^\//, "")}${url.search}`;
    }
  }
  return null;
}

function parseJson(response: ForgeResponse, host: string, path: string, method: ForgeMethod): unknown {
  try {
    return JSON.parse(response.body);
  } catch {
    throw new ForgeRequestError(host, response.status, method, path, "the response body is not JSON");
  }
}

/** GitHub's refusal of a feature the repo's plan does not have, such as rulesets on a private repo on GitHub Free. */
const PLAN_LACKS_FEATURE = /Upgrade to GitHub Pro or make this repository public/i;

/** GitHub's own message for an error response, or the start of its body. */
function errorDetail(response: ForgeResponse): string {
  try {
    const body: unknown = JSON.parse(response.body);
    if (isObject(body) && typeof body.message === "string") return body.message;
  } catch {
    // Not JSON; the start of the body is the detail.
  }
  return response.body.slice(0, 200);
}

function field<K extends "string" | "number">(
  raw: unknown,
  name: string,
  type: K,
  where: string,
): K extends "string" ? string : number {
  const value = isObject(raw) ? raw[name] : undefined;
  if (typeof value !== type) {
    throw new ForgeRequestError(GITHUB_HOST, 200, "GET", where, `unexpected response: ${name} is not a ${type}`);
  }
  return value as K extends "string" ? string : number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An update time as ISO, so both forges' times compare as equal strings. */
function isoTime(value: string): string {
  return new Date(value).toISOString();
}

/** A time in the second-precision form GitHub's `since` takes. */
function githubTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}
