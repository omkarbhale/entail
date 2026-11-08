import {
  type Actor,
  type Change,
  type ChangeBatch,
  type ChangeCursor,
  type Forge,
  type ForgeInstance,
  ForgeLoggedOutError,
  ForgeRequestError,
  type ForgeSetting,
  type Issue,
  type IssueComment,
  type Project,
  RateLimitedError,
} from "./forge.ts";
import { type ForgeResponse, type Transport, TransportError } from "./transport.ts";

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
/** A host only, as `glab api --hostname` takes it: no scheme, port or path, so never a base URL. */
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
/** A namespace path and project name, with any depth of subgroups. */
const PROJECT_PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/;

interface GitLabCursor {
  /** The newest issue update time read so far; null until an issue was read. */
  since: string | null;
}

/**
 * The GitLab adapter of the {@link Forge} interface, read side, for gitlab.com
 * and self-hosted GitLab alike: gitlab.com is just the host `gitlab.com`, and
 * the owner's `glab` supplies each host's protocol, API host and login
 * (ADR-0015). It uses nothing above the Free/CE tier.
 *
 * GitLab has no conditional requests and no time filter on notes. Change
 * detection re-reads the issues updated within {@link CHANGE_OVERLAP_MS} before
 * the cursor, then pages each touched issue's notes newest first until it
 * reaches notes already seen, which are the ones last updated before that same
 * window.
 */
export class GitLabForge implements Forge {
  readonly setting: ForgeSetting;
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

  async project(): Promise<Project> {
    const path = this.#projectRef;
    const project = await this.#getJson(path);
    return {
      forge: "gitlab",
      host: this.setting.host,
      id: this.#field(project, "id", "number", path),
      path: this.setting.path,
      defaultBranch: this.#field(project, "default_branch", "string", path),
    };
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
    // Everything last updated before this was read on an earlier pass.
    const seenBefore = from.since === null ? null : Date.parse(from.since) - CHANGE_OVERLAP_MS;

    const params = new URLSearchParams({ order_by: "updated_at", sort: "desc", per_page: String(PAGE_SIZE) });
    if (seenBefore !== null) params.set("updated_after", new Date(seenBefore).toISOString());
    const rawIssues = await this.#readPages(`${this.#projectRef}/issues`, params, () => false);

    const changes: Change[] = [];
    let newest = from.since === null ? null : Date.parse(from.since);
    for (const raw of rawIssues) {
      const issue = this.#issue(raw);
      changes.push({ kind: "issue", id: issue.id, updatedAt: issue.updatedAt, issue });
      const updated = Date.parse(issue.updatedAt);
      if (newest === null || updated > newest) newest = updated;

      // An issue with no notes by people has none to report; system notes are not comments.
      if (isObject(raw) && raw.user_notes_count === 0) continue;
      for (const note of await this.#notesSince(issue, seenBefore)) {
        changes.push({ kind: "issue-comment", id: note.id, updatedAt: note.updatedAt, comment: note });
      }
    }
    const next: GitLabCursor = { since: newest === null ? null : new Date(newest).toISOString() };
    return { changes, cursor: JSON.stringify(next) };
  }

  /**
   * One issue's notes by people, newest update first, paging only until a
   * note last updated before `seenBefore`: that note and every older one were
   * read before. With no `seenBefore`, every note is read.
   */
  async #notesSince(issue: Issue, seenBefore: number | null): Promise<IssueComment[]> {
    const params = new URLSearchParams({ order_by: "updated_at", sort: "desc", per_page: String(PAGE_SIZE) });
    const seen = (raw: unknown): boolean => {
      if (seenBefore === null) return false;
      const updated = isObject(raw) && typeof raw.updated_at === "string" ? Date.parse(raw.updated_at) : NaN;
      return !Number.isNaN(updated) && updated < seenBefore;
    };
    const notes = await this.#readPages(`${this.#projectRef}/issues/${issue.number}/notes`, params, seen);
    return notes.filter((raw) => !(isObject(raw) && raw.system === true)).map((raw) => this.#note(raw, issue));
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
      this.#ensureOk(response, path);
      const body = parseJson(response, this.setting.host, path);
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

  async #getJson(path: string): Promise<unknown> {
    const response = await this.#get(path);
    this.#ensureOk(response, path);
    return parseJson(response, this.setting.host, path);
  }

  async #get(path: string): Promise<ForgeResponse> {
    try {
      return await this.#transport.request({ host: this.setting.host, method: "GET", path });
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
    if (status === 429) throw new RateLimitedError(this.setting.host, rateLimitReset(response));
    // glab sends no token for a host it has none for, and an expired or revoked
    // token is refused the same way.
    if (status === 401) throw new ForgeLoggedOutError(this.setting.host, `GET ${path} answered HTTP 401`);
    let detail = response.body.slice(0, 200);
    try {
      const body: unknown = JSON.parse(response.body);
      if (isObject(body) && typeof body.message === "string") detail = body.message;
      else if (isObject(body) && typeof body.error === "string") detail = body.error;
    } catch {
      // Not JSON; the start of the body is the detail.
    }
    throw new ForgeRequestError(this.setting.host, status, "GET", path, detail);
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

const EMPTY_CURSOR: GitLabCursor = { since: null };

function parseCursor(cursor: ChangeCursor): GitLabCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    return EMPTY_CURSOR;
  }
  if (isObject(parsed) && typeof parsed.since === "string" && !Number.isNaN(Date.parse(parsed.since))) {
    return { since: parsed.since };
  }
  return EMPTY_CURSOR;
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

function parseJson(response: ForgeResponse, host: string, path: string): unknown {
  try {
    return JSON.parse(response.body);
  } catch {
    throw new ForgeRequestError(host, response.status, "GET", path, "the response body is not JSON");
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An update time as ISO, so both forges' times compare as equal strings. */
function isoTime(value: string): string {
  return new Date(value).toISOString();
}
