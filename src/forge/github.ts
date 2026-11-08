import {
  type Actor,
  type Change,
  type ChangeBatch,
  type ChangeCursor,
  type Forge,
  ForgeLoggedOutError,
  ForgeRequestError,
  type ForgeSetting,
  type Issue,
  type IssueComment,
  type Project,
  RateLimitedError,
} from "./forge.ts";
import { type ForgeResponse, type Transport, TransportError } from "./transport.ts";

/** The only GitHub host in MVP-1; GitHub Enterprise Server is out of it (ADR-0015). */
export const GITHUB_HOST = "github.com";

const PAGE_SIZE = 100;
/** GitHub asks clients to wait at least a minute when it gives no reset time. */
const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;
const REPO_PATH = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

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
  readonly #transport: Transport;

  constructor(setting: ForgeSetting, transport: Transport) {
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
      this.#ensureOk(page, path);
      const body = parseJson(page, this.setting.host, path);
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

  async #getJson(path: string): Promise<unknown> {
    const response = await this.#get(path, {});
    this.#ensureOk(response, path);
    return parseJson(response, this.setting.host, path);
  }

  async #get(path: string, headers: Record<string, string>): Promise<ForgeResponse> {
    try {
      return await this.#transport.request({ host: this.setting.host, method: "GET", path, headers });
    } catch (error) {
      if (error instanceof TransportError && error.loggedOut) {
        throw new ForgeLoggedOutError(this.setting.host, error.message);
      }
      throw error;
    }
  }

  /** Throws for anything but a 2xx: a rate limit with its reset time, a refused login, or a request error. */
  #ensureOk(response: ForgeResponse, path: string): void {
    const { status } = response;
    if (status >= 200 && status < 300) return;
    const resetAt = rateLimitReset(response);
    if (resetAt) throw new RateLimitedError(this.setting.host, resetAt);
    if (status === 401) throw new ForgeLoggedOutError(this.setting.host, `GET ${path} answered HTTP 401`);
    let detail = response.body.slice(0, 200);
    try {
      const body: unknown = JSON.parse(response.body);
      if (isObject(body) && typeof body.message === "string") detail = body.message;
    } catch {
      // Not JSON; the start of the body is the detail.
    }
    throw new ForgeRequestError(this.setting.host, status, "GET", path, detail);
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

function parseJson(response: ForgeResponse, host: string, path: string): unknown {
  try {
    return JSON.parse(response.body);
  } catch {
    throw new ForgeRequestError(host, response.status, "GET", path, "the response body is not JSON");
  }
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
