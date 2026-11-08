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
  RateLimitedError,
} from "./forge.ts";
import { type ForgeMethod, type ForgeResponse, type Transport, TransportError } from "./transport.ts";

/** The only GitHub host in MVP-1; GitHub Enterprise Server is out of it (ADR-0015). */
export const GITHUB_HOST = "github.com";

const PAGE_SIZE = 100;
/** GitHub asks clients to wait at least a minute when it gives no reset time. */
const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;
const REPO_PATH = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
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
}

/**
 * The GitHub adapter of the {@link Forge} interface, read side.
 *
 * Change detection uses ETag-conditional reads of the repo's issues and issue
 * comments, newest update first, so any change alters the first page and an
 * unchanged list answers 304, which costs no rate limit (ADR-0015).
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

  /** github.com is the only GitHub host, with no version to read, so it is always served. */
  async instance(): Promise<ForgeInstance> {
    return { version: null, unsupported: null };
  }

  async changesSince(cursor: ChangeCursor | null): Promise<ChangeBatch> {
    const from = cursor === null ? { issues: EMPTY_LIST_CURSOR, comments: EMPTY_LIST_CURSOR } : parseCursor(cursor);
    const issues = await this.#readList(`repos/${this.setting.path}/issues`, { state: "all" }, from.issues);
    const comments = await this.#readList(`repos/${this.setting.path}/issues/comments`, {}, from.comments);

    const changes: Change[] = [];
    for (const raw of issues.items) {
      // The issues list also carries pull requests; only issues are reported here.
      if (isObject(raw) && "pull_request" in raw) continue;
      const issue = this.#issue(raw);
      changes.push({ kind: "issue", id: issue.id, updatedAt: issue.updatedAt, issue });
    }
    for (const raw of comments.items) {
      // Comments on pull requests share this list; only comments on issues are reported here.
      if (isObject(raw) && typeof raw.html_url === "string" && /\/pull\/\d+/.test(raw.html_url)) continue;
      const comment = this.#comment(raw);
      changes.push({ kind: "issue-comment", id: comment.id, updatedAt: comment.updatedAt, comment });
    }
    const next: GitHubCursor = { issues: issues.cursor, comments: comments.cursor };
    return { changes, cursor: JSON.stringify(next) };
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

  #malformed(status: number, where: string, detail: string): ForgeRequestError {
    return new ForgeRequestError(this.setting.host, status, "GET", where, `unexpected response: ${detail}`);
  }
}

const EMPTY_LIST_CURSOR: ListCursor = { since: null, etag: null };

function parseCursor(cursor: ChangeCursor): GitHubCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    return { issues: EMPTY_LIST_CURSOR, comments: EMPTY_LIST_CURSOR };
  }
  if (isObject(parsed) && isListCursor(parsed.issues) && isListCursor(parsed.comments)) {
    return { issues: parsed.issues, comments: parsed.comments };
  }
  return { issues: EMPTY_LIST_CURSOR, comments: EMPTY_LIST_CURSOR };
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
