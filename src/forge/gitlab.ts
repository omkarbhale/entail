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
import { type ForgeMethod, type ForgeRequest, type ForgeResponse, type Transport, TransportError } from "./transport.ts";

/**
 * The oldest GitLab entail serves: 15.6 is the first version with a merge
 * request's `detailed_merge_status` (ADR-0015).
 */
export const MINIMUM_GITLAB_VERSION = { major: 15, minor: 6 } as const;

/**
 * How far before the cursor each read of issues reaches back. GitLab updates an
 * issue's last-update time at most once a minute and has no conditional
 * requests, so change detection re-reads a window of at least two minutes
 * (ADR-0015); the core drops what it has already seen.
 */
export const CHANGE_OVERLAP_MS = 2 * 60_000;

const PAGE_SIZE = 100;
/** How long to wait on a rate limit that names no reset time. */
const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;
/** GitLab's access levels, as its API reports them. */
const ACCESS = { planner: 15, reporter: 20, developer: 30, maintainer: 40 } as const;

/** A host only, as `glab api --hostname` takes it: no scheme, port or path, so never a base URL. */
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
/** A namespace path and project name, with any depth of subgroups. */
const PROJECT_PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/;
/** A GitLab username: letters, digits, `_`, `.` and `-`, starting with a letter, digit or `_`. */
const GITLAB_USERNAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/;

interface GitLabCursor {
  /** The newest issue update time read so far; null until an issue was read. */
  since: string | null;
  /** The newest merge request update time read so far; null until one was read. */
  mergeRequestsSince: string | null;
}

/**
 * What GitLab calls its pipeline when it is the one thing it requires before a
 * merge, under "pipelines must succeed".
 */
export const REQUIRED_PIPELINE = "pipeline";

/** The `detailed_merge_status`es under which GitLab has not finished working out mergeability. */
const MERGE_STATUS_UNKNOWN = new Set(["unchecked", "checking", "preparing", "approvals_syncing"]);

/**
 * The GitLab adapter of the {@link Forge} interface, read side, for gitlab.com
 * and self-hosted GitLab alike: gitlab.com is just the host `gitlab.com`, and
 * the owner's `glab` supplies each host's protocol, API host and login
 * (ADR-0015). It uses nothing above the Free/CE tier.
 *
 * GitLab has no conditional requests and no time filter on notes. Change
 * detection re-reads the issues and merge requests updated within
 * {@link CHANGE_OVERLAP_MS} before the cursor, then pages each touched one's
 * notes newest first until it reaches notes already seen, which are the ones
 * last updated before that same window.
 */
export class GitLabForge implements Forge {
  readonly setting: ForgeSetting;
  readonly wording: ForgeWording = { pullRequest: "merge request" };
  readonly #transport: Transport;
  /** The project as GitLab's API names it: its path, URL-encoded into one segment. */
  readonly #projectRef: string;

  constructor(setting: ForgeSetting, transport: Transport) {
    if (setting.forge !== "gitlab") {
      throw new Error(`the GitLab adapter cannot serve a ${setting.forge} repo`);
    }
    if (!HOST.test(setting.host)) {
      throw new Error(`a GitLab host is a host name such as gitlab.com, with no scheme, port or path, not ${JSON.stringify(setting.host)}`);
    }
    if (!PROJECT_PATH.test(setting.path) || setting.path.split("/").some((segment) => /^\.+$/.test(segment))) {
      throw new Error(`a GitLab project path is namespace/name, not ${JSON.stringify(setting.path)}`);
    }
    this.setting = setting;
    this.#transport = transport;
    this.#projectRef = `projects/${encodeURIComponent(setting.path)}`;
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

  /** Read from the users list filtered on the exact username, which GitLab matches regardless of case. */
  async actorByUsername(username: string): Promise<Actor | null> {
    if (!GITLAB_USERNAME.test(username)) return null;
    const path = `users?${new URLSearchParams({ username })}`;
    const users = await this.#getJson(path);
    if (!Array.isArray(users)) throw this.#malformed(200, path, "expected a list");
    const found = users.find((user) => isObject(user) && typeof user.username === "string" && user.username.toLowerCase() === username.toLowerCase());
    return found === undefined ? null : this.#actor(found, "user");
  }

  async project(): Promise<Project> {
    return this.#project(await this.#getJson(this.#projectRef));
  }

  #project(project: unknown): Project {
    const path = this.#projectRef;
    return {
      forge: "gitlab",
      host: this.setting.host,
      id: this.#field(project, "id", "number", path),
      path: this.setting.path,
      defaultBranch: this.#field(project, "default_branch", "string", path),
    };
  }

  /**
   * Read from the project's `permissions` for the logged-in account: the
   * higher of its project and group access level, or everything for an
   * instance administrator. Labelling an issue needs Planner or Reporter
   * access, and commenting needs issues to be turned on. A Developer may merge
   * only where the default branch's protection allows it, so anything below
   * Maintainer may lack permission to merge.
   */
  async access(): Promise<RepoAccess> {
    const path = this.#projectRef;
    const [user, project] = [await this.#getJson("user"), await this.#getJson(path)];
    const admin = isObject(user) && user.is_admin === true;
    const permissions = isObject(project) && isObject(project.permissions) ? project.permissions : {};
    const level = Math.max(accessLevel(permissions.project_access), accessLevel(permissions.group_access));
    const issuesOff =
      isObject(project) && (project.issues_enabled === false || project.issues_access_level === "disabled");

    let cannotLabelAndComment: string | null = null;
    if (issuesOff) cannotLabelAndComment = "the project has issues turned off";
    else if (!admin && level < ACCESS.planner) {
      cannotLabelAndComment =
        level === 0
          ? "the logged-in account is not a member of the project; adding labels needs Planner or Reporter access or more"
          : "the logged-in account has Guest access only; adding labels needs Planner or Reporter access or more";
    }
    let mayLackMerge: string | null = null;
    if (!admin && level < ACCESS.developer) {
      mayLackMerge = "the logged-in account has less than Developer access, and merging needs at least that";
    } else if (!admin && level < ACCESS.maintainer) {
      mayLackMerge = "the logged-in account has Developer access, which merges only where the default branch's protection allows Developers";
    }
    return { cannotLabelAndComment, mayLackMerge };
  }

  /** GitLab applies the project's own merge method and squash default, so entail picks none. */
  async mergeMethods(): Promise<MergeMethod[] | null> {
    return null;
  }

  async openIssueNumbers(): Promise<number[]> {
    const params = new URLSearchParams({ state: "opened", per_page: String(PAGE_SIZE) });
    const raw = await this.#readPages(`${this.#projectRef}/issues`, params, () => false);
    return raw.map((issue) => this.#field(issue, "iid", "number", "issue")).sort((a, b) => a - b);
  }

  /**
   * The instance's version from `/api/v4/version`. One older than
   * {@link MINIMUM_GITLAB_VERSION}, or one entail cannot read, is unsupported,
   * so enrollment can refuse it (ADR-0015).
   */
  async instance(): Promise<ForgeInstance> {
    const version = this.#field(await this.#getJson("version"), "version", "string", "version");
    return { version, unsupported: unsupportedGitLabVersion(version) };
  }

  async changesSince(cursor: ChangeCursor | null): Promise<ChangeBatch> {
    const from = cursor === null ? EMPTY_CURSOR : parseCursor(cursor);
    const changes: Change[] = [];

    // Everything last updated before this was read on an earlier pass.
    const issuesSeenBefore = seenBefore(from.since);
    const rawIssues = await this.#readPages(`${this.#projectRef}/issues`, updatedAfter(issuesSeenBefore), () => false);
    let issuesNewest = from.since === null ? null : Date.parse(from.since);
    for (const raw of rawIssues) {
      const issue = this.#issue(raw);
      changes.push({ kind: "issue", id: issue.id, updatedAt: issue.updatedAt, issue });
      issuesNewest = newer(issuesNewest, issue.updatedAt);

      // An issue with no notes by people has none to report; system notes are not comments.
      if (isObject(raw) && raw.user_notes_count === 0) continue;
      for (const raw of await this.#notesSince(`issues/${issue.number}`, issuesSeenBefore)) {
        const note = this.#note(raw, issue);
        changes.push({ kind: "issue-comment", id: note.id, updatedAt: note.updatedAt, comment: note });
      }
    }

    const mergeRequestsSeenBefore = seenBefore(from.mergeRequestsSince);
    const rawMergeRequests = await this.#readPages(
      `${this.#projectRef}/merge_requests`,
      updatedAfter(mergeRequestsSeenBefore),
      () => false,
    );
    let mergeRequestsNewest = from.mergeRequestsSince === null ? null : Date.parse(from.mergeRequestsSince);
    for (const raw of rawMergeRequests) {
      const pullRequest = this.#mergeRequest(raw, false);
      changes.push({ kind: "pull-request", id: pullRequest.id, updatedAt: pullRequest.updatedAt, pullRequest });
      mergeRequestsNewest = newer(mergeRequestsNewest, pullRequest.updatedAt);

      if (isObject(raw) && raw.user_notes_count === 0) continue;
      for (const raw of await this.#notesSince(`merge_requests/${pullRequest.number}`, mergeRequestsSeenBefore)) {
        const comment = this.#mergeRequestNote(raw, pullRequest);
        changes.push({ kind: "pull-request-comment", id: comment.id, updatedAt: comment.updatedAt, comment });
      }
    }

    const next: GitLabCursor = { since: isoOrNull(issuesNewest), mergeRequestsSince: isoOrNull(mergeRequestsNewest) };
    return { changes, cursor: JSON.stringify(next) };
  }

  async pullRequest(number: number): Promise<PullRequest> {
    // Asking for a recheck keeps a merge status GitLab left unchecked from staying so.
    const path = `${this.#projectRef}/merge_requests/${pathNumber(number)}?with_merge_status_recheck=true`;
    return this.#mergeRequest(await this.#getJson(path), true);
  }

  /** Every note by people on the merge request, oldest first; system notes are not comments. */
  async pullRequestComments(number: number): Promise<PullRequestComment[]> {
    const path = `${this.#projectRef}/merge_requests/${pathNumber(number)}`;
    // The notes API gives no web URL, so each note's is the merge request's, anchored at the note.
    const url = this.#field(await this.#getJson(path), "web_url", "string", "merge request");
    const params = new URLSearchParams({ order_by: "created_at", sort: "asc", per_page: String(PAGE_SIZE) });
    const notes = await this.#readPages(`${path}/notes`, params, () => false);
    return notes.filter((raw) => !(isObject(raw) && raw.system === true)).map((raw) => this.#mergeRequestNote(raw, { number, url }));
  }

  async linkedPullRequests(issueNumber: number): Promise<PullRequest[]> {
    const project = await this.#getJson(this.#projectRef);
    const { id, defaultBranch } = this.#project(project);
    const params = new URLSearchParams({ per_page: String(PAGE_SIZE) });
    const closing = await this.#readPages(`${this.#projectRef}/issues/${pathNumber(issueNumber)}/closed_by`, params, () => false);
    const numbers: number[] = [];
    for (const raw of closing) {
      // A merge request in another project can close this issue too; it is not this repo's PR.
      if (!isObject(raw) || raw.project_id !== id || raw.target_branch !== defaultBranch) continue;
      const number = this.#field(raw, "iid", "number", "merge request");
      if (!numbers.includes(number)) numbers.push(number);
    }
    numbers.sort((a, b) => a - b);
    const pullRequests: PullRequest[] = [];
    for (const number of numbers) pullRequests.push(await this.pullRequest(number));
    return pullRequests;
  }

  async linkedIssues(pullRequestNumber: number): Promise<number[]> {
    const { id, defaultBranch } = this.#project(await this.#getJson(this.#projectRef));
    const number = pathNumber(pullRequestNumber);
    const mergeRequest = await this.#getJson(`${this.#projectRef}/merge_requests/${number}`);
    if (this.#field(mergeRequest, "target_branch", "string", "merge request") !== defaultBranch) return [];
    const params = new URLSearchParams({ per_page: String(PAGE_SIZE) });
    const issues = await this.#readPages(`${this.#projectRef}/merge_requests/${number}/closes_issues`, params, () => false);
    const numbers: number[] = [];
    for (const raw of issues) {
      if (!isObject(raw) || raw.project_id !== id) continue;
      const issue = this.#field(raw, "iid", "number", "issue");
      if (!numbers.includes(issue)) numbers.push(issue);
    }
    return numbers.sort((a, b) => a - b);
  }

  /**
   * The jobs of the pipeline GitLab attaches to the merge request's current
   * head, used only when both the head and that pipeline are at `sha`: a
   * pipeline for another sha says nothing about this one. The pipeline is
   * required when the project's "pipelines must succeed" is on.
   */
  async checks(pullRequestNumber: number, sha: string, named: readonly string[]): Promise<CheckReport> {
    const project = await this.#getJson(this.#projectRef);
    const pipelineRequired = isObject(project) && project.only_allow_merge_if_pipeline_succeeds === true;
    const mergeRequest = await this.#getJson(`${this.#projectRef}/merge_requests/${pathNumber(pullRequestNumber)}`);
    const pipeline = isObject(mergeRequest) ? mergeRequest.head_pipeline : undefined;
    const atSha =
      isObject(mergeRequest) && mergeRequest.sha === sha && isObject(pipeline) && pipeline.sha === sha
        ? this.#field(pipeline, "id", "number", "merge request head pipeline")
        : null;
    const reported = atSha === null ? [] : await this.#jobs(atSha);
    return {
      sha,
      checks: checksByName(reported, named),
      required: pipelineRequired ? [{ name: REQUIRED_PIPELINE, reported: atSha !== null }] : [],
    };
  }

  /** The jobs of the default branch's most recent pipelines, one pipeline per commit. */
  async recentDefaultBranchChecks(commits: number): Promise<CommitChecks[]> {
    const { defaultBranch } = await this.project();
    const params = new URLSearchParams({ ref: defaultBranch, order_by: "id", sort: "desc", per_page: String(pageCount(commits)) });
    const path = `${this.#projectRef}/pipelines?${params}`;
    const pipelines = await this.#getJson(path);
    if (!Array.isArray(pipelines)) throw this.#malformed(200, path, "expected a list");
    const recent: CommitChecks[] = [];
    for (const pipeline of pipelines) {
      const sha = this.#field(pipeline, "sha", "string", "pipeline");
      // A commit run more than once keeps its newest pipeline, which comes first.
      if (recent.some((commit) => commit.sha === sha) || recent.length >= commits) continue;
      recent.push({ sha, checks: checksByName(await this.#jobs(this.#field(pipeline, "id", "number", "pipeline"))) });
    }
    return recent;
  }

  /** A pipeline's jobs, without the retried ones, as checks. */
  async #jobs(pipelineId: number): Promise<Check[]> {
    const params = new URLSearchParams({ per_page: String(PAGE_SIZE) });
    const jobs = await this.#readPages(`${this.#projectRef}/pipelines/${pathNumber(pipelineId)}/jobs`, params, () => false);
    return jobs.map((job) => {
      const where = "pipeline job";
      return {
        name: this.#field(job, "name", "string", where),
        status: jobStatus(this.#field(job, "status", "string", where), isObject(job) && job.allow_failure === true),
        reported: true,
        url: isObject(job) && typeof job.web_url === "string" ? job.web_url : null,
      };
    });
  }

  /**
   * The notes on an issue or merge request (`noteable`), newest update first,
   * paging only until a note last updated before `seenBefore`: that note and
   * every older one were read before. With no `seenBefore`, every note is
   * read. System notes are left out; they are not comments.
   */
  async #notesSince(noteable: string, seenBefore: number | null): Promise<unknown[]> {
    const params = new URLSearchParams({ order_by: "updated_at", sort: "desc", per_page: String(PAGE_SIZE) });
    const seen = (raw: unknown): boolean => {
      if (seenBefore === null) return false;
      const updated = isObject(raw) && typeof raw.updated_at === "string" ? Date.parse(raw.updated_at) : NaN;
      return !Number.isNaN(updated) && updated < seenBefore;
    };
    const notes = await this.#readPages(`${this.#projectRef}/${noteable}/notes`, params, seen);
    return notes.filter((raw) => !(isObject(raw) && raw.system === true));
  }

  /**
   * Reads a list page by page, following GitLab's `x-next-page`, and stops at
   * the first item `stop` accepts, leaving that item and the rest out.
   */
  async #readPages(base: string, params: URLSearchParams, stop: (item: unknown) => boolean): Promise<unknown[]> {
    const items: unknown[] = [];
    let path = `${base}?${params}`;
    for (;;) {
      const response = await this.#get(path);
      this.#ensureOk(response, path, "GET");
      const body = parseJson(response, this.setting.host, path, "GET");
      if (!Array.isArray(body)) throw this.#malformed(response.status, path, "expected a list");
      for (const item of body) {
        if (stop(item)) return items;
        items.push(item);
      }
      const next = response.headers["x-next-page"]?.trim();
      if (!next) return items;
      const nextParams = new URLSearchParams(params);
      nextParams.set("page", next);
      path = `${base}?${nextParams}`;
    }
  }


  // Writes

  async postComment(target: ForgeTarget, number: number, body: string): Promise<PostedComment> {
    const path = `${this.#projectRef}/${noteableSegment(target)}/${number}/notes`;
    const note = await this.#sendJson("POST", path, { body });
    const id = this.#field(note, "id", "number", path);
    return { id, url: this.#noteUrl(target, number, id) };
  }

  async addLabel(issueNumber: number, label: string): Promise<void> {
    assertEntailLabel(label);
    await this.#ensureLabel(label);
    await this.#sendJson("PUT", `${this.#projectRef}/issues/${issueNumber}`, { add_labels: label });
  }

  /** GitLab ignores removing a label the issue does not carry, so it is already removed. */
  async removeLabel(issueNumber: number, label: string): Promise<void> {
    assertEntailLabel(label);
    await this.#sendJson("PUT", `${this.#projectRef}/issues/${issueNumber}`, { remove_labels: label });
  }

  /** GitLab records no close reason, so every close is the same. */
  async closeIssue(issueNumber: number, _reason: CloseReason): Promise<void> {
    await this.#sendJson("PUT", `${this.#projectRef}/issues/${issueNumber}`, { state_event: "close" });
  }

  /**
   * Merges through `merge` pinned to `sha`, with the project's own merge
   * method and without `auto_merge`, so GitLab merges now or refuses.
   */
  async merge(prNumber: number, sha: string, _method?: MergeMethod): Promise<MergeOutcome> {
    const path = `${this.#projectRef}/merge_requests/${prNumber}/merge`;
    const response = await this.#send("PUT", path, { sha });
    const { status } = response;
    if (status >= 500 || status === 401 || status === 429) this.#ensureOk(response, path, "PUT");
    if (status < 200 || status >= 300) {
      return { merged: false, refusal: `GitLab refused the merge (HTTP ${status}): ${errorDetail(response)}` };
    }
    const mr = parseJson(response, this.setting.host, path, "PUT");
    const state = this.#field(mr, "state", "string", path);
    if (state !== "merged") return { merged: false, refusal: `GitLab left the merge request ${state} instead of merging it` };
    return { merged: true, mergeCommitSha: mergeCommitOf(mr) };
  }

  // Reads that settle writes

  async comments(target: ForgeTarget, number: number): Promise<ForgeComment[]> {
    const params = new URLSearchParams({ order_by: "created_at", sort: "asc", per_page: String(PAGE_SIZE) });
    const notes = await this.#readPages(`${this.#projectRef}/${noteableSegment(target)}/${number}/notes`, params, () => false);
    return notes
      .filter((raw) => !(isObject(raw) && raw.system === true))
      .map((raw) => {
        const where = "note";
        const id = this.#field(raw, "id", "number", where);
        return {
          id,
          body: isObject(raw) && typeof raw.body === "string" ? raw.body : "",
          author: this.#actor(isObject(raw) ? raw.author : undefined, `${where} author`),
          createdAt: isoTime(this.#field(raw, "created_at", "string", where)),
          url: this.#noteUrl(target, number, id),
        };
      });
  }

  async pullRequestState(prNumber: number): Promise<PullRequestState> {
    const path = `${this.#projectRef}/merge_requests/${prNumber}`;
    const mr = await this.#getJson(path);
    const state = this.#field(mr, "state", "string", path);
    const merged = state === "merged";
    return {
      // A locked merge request is one GitLab is merging right now: still open.
      state: merged ? "merged" : state === "closed" ? "closed" : "open",
      headSha: this.#field(mr, "sha", "string", path),
      mergeCommitSha: merged ? mergeCommitOf(mr) : null,
    };
  }

  /** Creates `label` in the project unless it is there already. */
  async #ensureLabel(label: string): Promise<void> {
    const path = `${this.#projectRef}/labels/${encodeURIComponent(label)}`;
    const found = await this.#send("GET", path);
    if (found.status !== 404) {
      this.#ensureOk(found, path, "GET");
      return;
    }
    const create = `${this.#projectRef}/labels`;
    const created = await this.#send("POST", create, {
      name: label,
      color: `#${ENTAIL_LABEL_COLOR}`,
      description: ENTAIL_LABEL_DESCRIPTION,
    });
    // 409 is GitLab's answer when the label was created meanwhile.
    if (created.status === 409) return;
    this.#ensureOk(created, create, "POST");
  }

  /**
   * A note's web URL. The notes API gives none, so it is built from the host
   * and path the owner's `glab` reaches, anchored at the note.
   */
  #noteUrl(target: ForgeTarget, number: number, id: number): string {
    return `https://${this.setting.host}/${this.setting.path}/-/${noteableSegment(target)}/${number}#note_${id}`;
  }

  async #sendJson(method: ForgeMethod, path: string, body: unknown): Promise<unknown> {
    const response = await this.#send(method, path, body);
    this.#ensureOk(response, path, method);
    return response.body.trim() === "" ? null : parseJson(response, this.setting.host, path, method);
  }

  async #getJson(path: string): Promise<unknown> {
    const response = await this.#get(path);
    this.#ensureOk(response, path, "GET");
    return parseJson(response, this.setting.host, path, "GET");
  }

  #get(path: string): Promise<ForgeResponse> {
    return this.#request({ host: this.setting.host, method: "GET", path });
  }

  #send(method: ForgeMethod, path: string, body?: unknown): Promise<ForgeResponse> {
    return this.#request({ host: this.setting.host, method, path, ...(body === undefined ? {} : { body }) });
  }

  async #request(request: ForgeRequest): Promise<ForgeResponse> {
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
    if (status === 429) throw new RateLimitedError(this.setting.host, rateLimitReset(response));
    // glab sends no token for a host it has none for, and an expired or revoked
    // token is refused the same way.
    if (status === 401) throw new ForgeLoggedOutError(this.setting.host, `${method} ${path} answered HTTP 401`);
    throw new ForgeRequestError(this.setting.host, status, method, path, errorDetail(response));
  }

  #actor(raw: unknown, where: string): Actor {
    return {
      forge: "gitlab",
      host: this.setting.host,
      id: this.#field(raw, "id", "number", where),
      username: this.#field(raw, "username", "string", where),
    };
  }

  #issue(raw: unknown): Issue {
    const where = "issue";
    const labels = isObject(raw) && Array.isArray(raw.labels) ? raw.labels : [];
    const state = this.#field(raw, "state", "string", where);
    if (state !== "opened" && state !== "closed") throw this.#malformed(200, where, `unknown state ${state}`);
    return {
      id: this.#field(raw, "id", "number", where),
      number: this.#field(raw, "iid", "number", where),
      title: this.#field(raw, "title", "string", where),
      body: isObject(raw) && typeof raw.description === "string" ? raw.description : "",
      state: state === "opened" ? "open" : "closed",
      author: this.#actor(isObject(raw) ? raw.author : undefined, `${where} author`),
      labels: labels.map((label) => (typeof label === "string" ? label : this.#field(label, "name", "string", `${where} label`))),
      createdAt: isoTime(this.#field(raw, "created_at", "string", where)),
      updatedAt: isoTime(this.#field(raw, "updated_at", "string", where)),
      url: this.#field(raw, "web_url", "string", where),
    };
  }

  /** A note on `issue`. The notes API gives no web URL, so it is the issue's, anchored at the note. */
  #note(raw: unknown, issue: Issue): IssueComment {
    const where = "issue note";
    const id = this.#field(raw, "id", "number", where);
    return {
      id,
      issueNumber: issue.number,
      body: isObject(raw) && typeof raw.body === "string" ? raw.body : "",
      author: this.#actor(isObject(raw) ? raw.author : undefined, `${where} author`),
      createdAt: isoTime(this.#field(raw, "created_at", "string", where)),
      updatedAt: isoTime(this.#field(raw, "updated_at", "string", where)),
      url: `${issue.url}#note_${id}`,
    };
  }

  /**
   * A merge request. Mergeability is reported only from a single read (`live`):
   * a list's merge status can be stale, and GitHub's lists carry none.
   */
  #mergeRequest(raw: unknown, live: boolean): PullRequest {
    const where = "merge request";
    const state = this.#field(raw, "state", "string", where);
    // `locked` is the moment GitLab is merging it, still open until it is merged.
    if (state !== "opened" && state !== "locked" && state !== "closed" && state !== "merged") {
      throw this.#malformed(200, where, `unknown state ${state}`);
    }
    const mergeStatus = isObject(raw) && typeof raw.detailed_merge_status === "string" ? raw.detailed_merge_status : "unchecked";
    const known = live && !MERGE_STATUS_UNKNOWN.has(mergeStatus);
    return {
      id: this.#field(raw, "id", "number", where),
      number: this.#field(raw, "iid", "number", where),
      title: this.#field(raw, "title", "string", where),
      body: isObject(raw) && typeof raw.description === "string" ? raw.description : "",
      state: state === "opened" || state === "locked" ? "open" : state,
      draft: isObject(raw) && (raw.draft === true || raw.work_in_progress === true),
      mergeable: known ? mergeStatus === "mergeable" : null,
      conflicts: known ? mergeStatus === "conflict" || (isObject(raw) && raw.has_conflicts === true) : null,
      headSha: this.#field(raw, "sha", "string", where),
      baseBranch: this.#field(raw, "target_branch", "string", where),
      author: this.#actor(isObject(raw) ? raw.author : undefined, `${where} author`),
      createdAt: isoTime(this.#field(raw, "created_at", "string", where)),
      updatedAt: isoTime(this.#field(raw, "updated_at", "string", where)),
      url: this.#field(raw, "web_url", "string", where),
    };
  }

  /** A note on a merge request. The notes API gives no web URL, so it is the merge request's, anchored at the note. */
  #mergeRequestNote(raw: unknown, mergeRequest: { number: number; url: string }): PullRequestComment {
    const where = "merge request note";
    const id = this.#field(raw, "id", "number", where);
    return {
      id,
      pullRequestNumber: mergeRequest.number,
      body: isObject(raw) && typeof raw.body === "string" ? raw.body : "",
      author: this.#actor(isObject(raw) ? raw.author : undefined, `${where} author`),
      createdAt: isoTime(this.#field(raw, "created_at", "string", where)),
      updatedAt: isoTime(this.#field(raw, "updated_at", "string", where)),
      url: `${mergeRequest.url}#note_${id}`,
    };
  }

  #field<K extends "string" | "number">(raw: unknown, name: string, type: K, where: string): K extends "string" ? string : number {
    const value = isObject(raw) ? raw[name] : undefined;
    if (typeof value !== type) throw this.#malformed(200, where, `${name} is not a ${type}`);
    return value as K extends "string" ? string : number;
  }

  #malformed(status: number, where: string, detail: string): ForgeRequestError {
    return new ForgeRequestError(this.setting.host, status, "GET", where, `unexpected response: ${detail}`);
  }
}

/**
 * Why entail cannot serve a GitLab of this version, or null when it can. The
 * version is as `/api/v4/version` reports it, such as `16.4.1` on Community
 * Edition, `17.5.0-ee` on Enterprise Edition or `18.6.0-pre` on gitlab.com.
 */
export function unsupportedGitLabVersion(version: string): string | null {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!match) return `GitLab reports a version entail cannot read: ${JSON.stringify(version)}`;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const { major: needMajor, minor: needMinor } = MINIMUM_GITLAB_VERSION;
  if (major > needMajor || (major === needMajor && minor >= needMinor)) return null;
  return `GitLab ${version} is older than ${needMajor}.${needMinor}, the oldest version entail serves`;
}

const EMPTY_CURSOR: GitLabCursor = { since: null, mergeRequestsSince: null };

/** The access level in a `project_access` or `group_access` entry, 0 when there is none. */
function accessLevel(entry: unknown): number {
  return isObject(entry) && typeof entry.access_level === "number" ? entry.access_level : 0;
}

function parseCursor(cursor: ChangeCursor): GitLabCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    return EMPTY_CURSOR;
  }
  if (!isObject(parsed)) return EMPTY_CURSOR;
  return { since: validTime(parsed.since), mergeRequestsSince: validTime(parsed.mergeRequestsSince) };
}

function validTime(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

/** The time before which everything was read on an earlier pass, or null when nothing was. */
function seenBefore(since: string | null): number | null {
  return since === null ? null : Date.parse(since) - CHANGE_OVERLAP_MS;
}

/** A list read newest update first, from `seenBefore` on when there is one. */
function updatedAfter(seenBefore: number | null): URLSearchParams {
  const params = new URLSearchParams({ order_by: "updated_at", sort: "desc", per_page: String(PAGE_SIZE) });
  if (seenBefore !== null) params.set("updated_after", new Date(seenBefore).toISOString());
  return params;
}

function newer(newest: number | null, updatedAt: string): number {
  const updated = Date.parse(updatedAt);
  return newest === null || updated > newest ? updated : newest;
}

function isoOrNull(time: number | null): string | null {
  return time === null ? null : new Date(time).toISOString();
}

/**
 * A job's status as GitLab's own pipeline status counts it (ADR-0015): a job
 * allowed to fail that failed or was cancelled does not fail the pipeline, and
 * a manual job allowed to fail does not hold it up. Skipped counts as passed.
 */
function jobStatus(status: string, allowFailure: boolean): CheckStatus {
  switch (status) {
    case "success":
    case "skipped":
      return "passed";
    case "failed":
    case "canceled":
      return allowFailure ? "passed" : "failed";
    case "manual":
      return allowFailure ? "passed" : "pending";
    default:
      // created, waiting_for_resource, preparing, pending, running, scheduled, canceling and any later state.
      return "pending";
  }
}

/** A merge request, issue or pipeline number checked before it goes into a path. */
function pathNumber(number: number): number {
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`not an issue, merge request or pipeline number: ${number}`);
  return number;
}

/** How many commits to ask for, within what one page holds. */
function pageCount(commits: number): number {
  if (!Number.isSafeInteger(commits) || commits <= 0) throw new Error(`not a number of commits: ${commits}`);
  return Math.min(commits, PAGE_SIZE);
}

/**
 * The reset time of GitLab's 429: `RateLimit-Reset` in epoch seconds, else
 * `Retry-After` seconds from now, else a minute from now.
 */
function rateLimitReset(response: ForgeResponse): Date {
  const reset = Number(response.headers["ratelimit-reset"]);
  if (response.headers["ratelimit-reset"] !== undefined && Number.isFinite(reset) && reset > 0) {
    return new Date(reset * 1000);
  }
  const retryAfter = Number(response.headers["retry-after"]);
  if (response.headers["retry-after"] !== undefined && Number.isFinite(retryAfter)) {
    return new Date(Date.now() + retryAfter * 1000);
  }
  return new Date(Date.now() + DEFAULT_RATE_LIMIT_WAIT_MS);
}

function parseJson(response: ForgeResponse, host: string, path: string, method: ForgeMethod): unknown {
  try {
    return JSON.parse(response.body);
  } catch {
    throw new ForgeRequestError(host, response.status, method, path, "the response body is not JSON");
  }
}

/** GitLab's own message for an error response, or the start of its body. */
function errorDetail(response: ForgeResponse): string {
  try {
    const body: unknown = JSON.parse(response.body);
    if (isObject(body) && typeof body.message === "string") return body.message;
    if (isObject(body) && typeof body.error === "string") return body.error;
  } catch {
    // Not JSON; the start of the body is the detail.
  }
  return response.body.slice(0, 200);
}

/** Where GitLab's API keeps a target's notes. */
function noteableSegment(target: ForgeTarget): "issues" | "merge_requests" {
  return target === "issue" ? "issues" : "merge_requests";
}

/** The commit a merged merge request made: the merge commit, or the squash commit when it was squashed alone. */
function mergeCommitOf(mr: unknown): string | null {
  if (!isObject(mr)) return null;
  if (typeof mr.merge_commit_sha === "string") return mr.merge_commit_sha;
  if (typeof mr.squash_commit_sha === "string") return mr.squash_commit_sha;
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An update time as ISO, so both forges' times compare as equal strings. */
function isoTime(value: string): string {
  return new Date(value).toISOString();
}
