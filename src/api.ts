import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { CheckResponse, EnrollResponse, LogFilter, SettingsView, StatusView } from "./api-types.ts";
import type { Case } from "./case-book.ts";
import type { EventBus } from "./events.ts";
import type { Forge } from "./forge/forge.ts";
import { EFFORTS, type Effort } from "./model-runner.ts";
import {
  answerCall,
  askBacklog,
  changeRepoSettings,
  checkSettingsChange,
  confirmCall,
  enroll,
  HOLD_MS,
  itemView,
  logPage,
  overrideCall,
  OwnerError,
  repoName,
  repoViews,
  undoAction,
  unenroll,
  waitingResponse,
} from "./owner.ts";
import { loggedRepos, readLog, readSettings, repoState, writeSettings, type GlobalSettings } from "./records.ts";

/**
 * entail's board and the small JSON API behind it, on the loopback
 * interface. The board is the built single-page app in `dist/board`; the API
 * is the single path through which the owner's answers are recorded, and the
 * browser never talks to GitHub. Everything the API changes is appended to
 * the repos' logs under the owner's name; an answer is held for
 * {@link HOLD_MS} so it can be undone, and entail acts on GitHub for it when
 * the window closes.
 *
 *   GET    /api/status                        whether entail is watching, and when it last checked
 *   GET    /api/events                        server-sent events: something changed, a repo is being checked, a check finished
 *   GET    /api/waiting[?repo=&since=]        what waits on the owner, the answers still in their undo window, and calls made alone since `since`
 *   GET    /api/log[?repo=&filter=&before=&tz=]  one page of the log, newest first, in whole days of time zone `tz`; `before=` pages back
 *   GET    /api/calls/:id                     one call
 *   POST   /api/calls/:id/confirm             {}
 *   POST   /api/calls/:id/override            {"call": "go"|"no", "reason": "...", "differently"?: true}  on an issue's call
 *                                             {"call": "merge"|"send-back", "reason": "..."}              on a PR's call
 *   POST   /api/calls/:id/answer              {"call": "go"|"no", "answer": "..."}            on an issue's call
 *                                             {"call": "merge"|"send-back", "answer": "..."}  on a PR's call
 *   POST   /api/calls/:id/undo                {}: undoes the owner's action on the call while it is held
 *   GET    /api/repos[?all=1]                 enrolled repos (all=1: every repo with a log)
 *   POST   /api/repos                         {"repo": "owner/name", "confirm"?: bool, "since"?: ISO time}
 *   PATCH  /api/repos/:owner/:name            {"confirm"?: bool, "model"?: string|null, "effort"?: string|null}
 *   DELETE /api/repos/:owner/:name            unenrolls
 *   POST   /api/repos/:owner/:name/check      checks the repo now, and answers with what the check did
 *   POST   /api/repos/:owner/:name/backlog    judges the issues open on GitHub that have no call yet
 *   GET    /api/settings                      the owner's name, the default model and effort, the notice and start commands (read only here)
 *   PATCH  /api/settings                      {"owner"?: string, "model"?: string, "effort"?: string}
 *
 * A call is on an issue or on a PR: each item carries `kind` ("issue" or
 * "pr") and, on a PR's call, `pr` with the criteria checklist, the facts read
 * from GitHub, what the PR does beyond its criteria sorted needed, harmless or
 * unwanted, and what entail did on the PR (see `CallView` and
 * `PullRequestView` in owner.ts). In the log, a call item names its kind in
 * `callKind`, and entail's acts on PRs are `pr-acted` items.
 *
 * It answers only requests addressed to the loopback host by name and, for
 * writes, only JSON from no other origin, so a web page open in the owner's
 * browser cannot act as the owner.
 */

/** What the API needs of the loop that watches and acts, when one runs in this process. */
export interface BoardLoop {
  check(repo: string): Promise<CheckResponse>;
  /** Acts as soon as `at` passes: an owner's action whose window closes then. */
  schedule(at: Date): void;
  /** Runs a pass soon, without waiting for it. */
  wake(): void;
  checkedAt(repo: string): string | null;
  readonly lastPassAt: string | null;
  readonly checking: boolean;
}

export interface ApiOptions {
  dataDirectory: string;
  /** The owner's display name, under which every owner's action is recorded. */
  owner: () => Promise<string>;
  /** The default model when the owner has set none. */
  defaultModel: string;
  book: () => Promise<Case[]>;
  /** Called after any change, so a running loop acts on it without waiting for its next poll. */
  wake?: () => void;
  now?: () => Date;
  /** How long an answer can be undone; {@link HOLD_MS} unless a test says otherwise. */
  holdMs?: number;
  loop?: BoardLoop;
  /** What enrolling and the backlog read from GitHub: that the repo can be reached, and its open issues. */
  forgeFor?: (repo: string) => Pick<Forge, "project" | "openIssueNumbers">;
  events?: EventBus;
  /** The built board's directory; {@link BOARD_DIRECTORY} unless a test says otherwise, null for none. */
  board?: string | null;
  /** Where the board is served, for the status line and notices. */
  url?: string;
}

/** The built board: `dist/board`, next to the compiled server, or found from the sources. */
export const BOARD_DIRECTORY: string | null =
  [new URL("./board/", import.meta.url), new URL("../dist/board/", import.meta.url)].map((url) => fileURLToPath(url)).find((path) => existsSync(join(path, "index.html"))) ?? null;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_BODY_BYTES = 64 * 1024;
const FILTERS: readonly LogFilter[] = ["all", "waiting", "overridden", "questions", "prs"];

export function createApi(options: ApiOptions): Server {
  return createServer((request, response) => {
    handle(options, request, response).catch((error: unknown) => {
      if (response.headersSent) return response.end();
      if (error instanceof OwnerError) send(response, error.status, { error: error.message });
      else send(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
}

async function handle(options: ApiOptions, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const host = request.headers.host ?? "";
  const hostname = host.replace(/:\d+$/u, "");
  if (!LOOPBACK_HOSTS.has(hostname)) return send(response, 403, { error: "entail's API answers only on the loopback host" });
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) return send(response, 403, { error: "entail's API takes no requests from another origin" });
    if (!/^application\/json\b/u.test(request.headers["content-type"] ?? "")) return send(response, 415, { error: "send JSON, with Content-Type: application/json" });
  }
  const url = new URL(request.url ?? "/", `http://${host}`);
  if (!url.pathname.startsWith("/api/") && url.pathname !== "/api") return serveBoard(options, url.pathname, method, response);

  const path = url.pathname.replace(/\/+$/u, "");
  const { dataDirectory } = options;
  const now = () => options.now?.() ?? new Date();
  const changed = <T>(value: T): T => {
    options.wake?.();
    options.loop?.wake();
    options.events?.emit({ type: "changed" });
    return value;
  };
  const repoParam = () => {
    const repo = url.searchParams.get("repo");
    return repo === null || repo === "" ? undefined : repoName(repo);
  };
  const settings = () => readSettings(dataDirectory, { model: options.defaultModel });

  if (method === "GET" && path === "/api/status") return send(response, 200, status(options));
  if (method === "GET" && path === "/api/events") return events(options, request, response);
  if (method === "GET" && path === "/api/waiting") {
    const since = url.searchParams.get("since");
    return send(response, 200, waitingResponse(dataDirectory, await options.book(), { ...optional("repo", repoParam()), ...optional("since", since === null || since === "" ? undefined : since), now: now() }));
  }
  if (method === "GET" && path === "/api/log") {
    const filter = (url.searchParams.get("filter") ?? "all") as LogFilter;
    if (!FILTERS.includes(filter)) throw new OwnerError(400, `filter is one of ${FILTERS.join(", ")}`);
    const before = url.searchParams.get("before");
    if (before !== null && !/^\d{4}-\d{2}-\d{2}$/u.test(before)) throw new OwnerError(400, "before is a day, YYYY-MM-DD");
    const timeZone = url.searchParams.get("tz");
    return send(response, 200, logPage(dataDirectory, await options.book(), { ...optional("repo", repoParam()), filter, ...optional("before", before ?? undefined), ...optional("timeZone", timeZone ?? undefined) }));
  }

  const call = /^\/api\/calls\/(\d+)(?:\/(confirm|override|answer|undo))?$/u.exec(path);
  if (call !== null) {
    const id = Number(call[1]);
    const action = call[2];
    if (action === undefined && method === "GET") return send(response, 200, itemView(dataDirectory, id, await options.book()));
    if (action !== undefined && method === "POST") {
      const body = await readJson(request);
      const by = await options.owner();
      const hold = { holdMs: options.holdMs ?? HOLD_MS };
      if (action === "undo") {
        const undone = undoAction(dataDirectory, id, by, now());
        options.events?.emit({ type: "changed" });
        return send(response, 200, undone);
      }
      const recorded =
        action === "confirm"
          ? await confirmCall(dataDirectory, id, by, now(), hold)
          : action === "override"
            ? await overrideCall(dataDirectory, id, by, body.call, body.reason, now(), { ...hold, differently: body.differently === true })
            : await answerCall(dataDirectory, id, by, body.call, body.answer, now(), hold);
      if (recorded.holdUntil !== undefined) options.loop?.schedule(new Date(recorded.holdUntil));
      options.events?.emit({ type: "changed" });
      return send(response, 200, recorded);
    }
    return send(response, 405, { error: `${method} is not allowed on ${path}` });
  }

  if (path === "/api/repos") {
    if (method === "GET") return send(response, 200, { repos: repoViews(dataDirectory, settings(), { all: url.searchParams.get("all") === "1", ...checkedAt(options) }) });
    if (method === "POST") {
      const body = await readJson(request);
      if (typeof body.repo !== "string") throw new OwnerError(400, "repo is required, as owner/name");
      const repo = repoName(body.repo);
      if (body.confirm !== undefined && typeof body.confirm !== "boolean") throw new OwnerError(400, "confirm is true or false");
      const since = body.since === undefined ? undefined : new Date(String(body.since));
      if (since !== undefined && Number.isNaN(since.getTime())) throw new OwnerError(400, "since is an ISO time");
      if (repoState(repo, readLog(dataDirectory, repo)).enrolled) throw new OwnerError(409, `${repo} is already enrolled`);
      // Reading the repo checks it exists and the logged-in gh can see it, before anything is recorded.
      const openIssues = options.forgeFor === undefined ? 0 : await reach(repo, async () => {
        const forge = options.forgeFor!(repo);
        await forge.project();
        return (await forge.openIssueNumbers()).length;
      });
      enroll(dataDirectory, repo, await options.owner(), { ...(typeof body.confirm === "boolean" ? { confirm: body.confirm } : {}), ...(since ? { since } : {}) }, now());
      const view = repoViews(dataDirectory, settings(), checkedAt(options)).find((candidate) => candidate.repo === repo)!;
      return send(response, 201, changed<EnrollResponse>({ repo: view, openIssues }));
    }
    return send(response, 405, { error: `${method} is not allowed on ${path}` });
  }
  const repo = /^\/api\/repos\/([^/]+)\/([^/]+)(?:\/(check|backlog))?$/u.exec(path);
  if (repo !== null) {
    const name = repoName(`${decodeURIComponent(repo[1]!)}/${decodeURIComponent(repo[2]!)}`);
    const action = repo[3];
    if (action === "check" && method === "POST") {
      if (!repoState(name, readLog(dataDirectory, name)).enrolled) throw new OwnerError(404, `${name} is not enrolled`);
      if (options.loop === undefined) throw new OwnerError(409, "entail is not watching: start it with entail run");
      return send(response, 200, await options.loop.check(name));
    }
    if (action === "backlog" && method === "POST") {
      if (options.forgeFor === undefined) throw new OwnerError(409, "entail cannot read GitHub from here");
      const open = await reach(name, () => options.forgeFor!(name).openIssueNumbers());
      const issues = askBacklog(dataDirectory, name, await options.owner(), open, now());
      return send(response, 200, changed({ repo: name, issues }));
    }
    if (action === undefined && method === "DELETE") return send(response, 200, changed(unenroll(dataDirectory, name, await options.owner(), now())));
    if (action === undefined && method === "PATCH") {
      const change = checkSettingsChange(await readJson(request));
      return send(response, 200, changed(changeRepoSettings(dataDirectory, name, await options.owner(), change, now())));
    }
    return send(response, 405, { error: `${method} is not allowed on ${path}` });
  }

  if (path === "/api/settings") {
    if (method === "GET") return send(response, 200, settingsView(settings()));
    if (method === "PATCH") {
      const change = await readJson(request);
      if ("notice" in change) throw new OwnerError(400, "the notice command is set from the command line, not here: entail settings --notice '<command>' (or --notice none)");
      if ("start" in change) throw new OwnerError(400, "the start command is set from the command line, not here: entail settings --start '<command>' (or --start none)");
      return send(response, 200, changed(settingsView(changeSettings(dataDirectory, options.defaultModel, change))));
    }
    return send(response, 405, { error: `${method} is not allowed on ${path}` });
  }
  return send(response, 404, { error: `nothing at ${path}` });
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

function checkedAt(options: ApiOptions): { checkedAt?: (repo: string) => string | null } {
  const loop = options.loop;
  return loop === undefined ? {} : { checkedAt: (repo) => loop.checkedAt(repo) };
}

async function reach<T>(repo: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw new OwnerError(502, `entail could not read ${repo} on GitHub: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function status(options: ApiOptions): StatusView {
  const repos = loggedRepos(options.dataDirectory).filter((repo) => repoState(repo, readLog(options.dataDirectory, repo)).enrolled).length;
  return {
    watching: options.loop !== undefined,
    repos,
    checkedAt: options.loop?.lastPassAt ?? null,
    checking: options.loop?.checking ?? false,
    url: options.url ?? null,
  };
}

function settingsView(settings: GlobalSettings): SettingsView {
  return { owner: settings.owner, model: settings.model, effort: settings.effort, notice: settings.notice ?? null, start: settings.start ?? null };
}

/** Server-sent events: one `data:` line of JSON per event, and a comment every 25 s so the connection stays open. */
function events(options: ApiOptions, request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Content-Type-Options": "nosniff" });
  response.write("retry: 2000\n\n");
  const off = options.events?.on((event) => response.write(`data: ${JSON.stringify(event)}\n\n`));
  const beat = setInterval(() => response.write(": still here\n\n"), 25_000);
  beat.unref();
  request.on("close", () => {
    clearInterval(beat);
    off?.();
  });
}

/** Changes the settings for every repo, checked as they arrive from the board or the command line. */
export function changeSettings(dataDirectory: string, defaultModel: string, change: Record<string, unknown>): GlobalSettings {
  const settings = readSettings(dataDirectory, { model: defaultModel });
  for (const key of Object.keys(change)) {
    if (!["owner", "model", "effort", "notice", "start"].includes(key)) throw new OwnerError(400, `no setting named ${key}`);
  }
  if (change.owner !== undefined) {
    if (typeof change.owner !== "string" || change.owner.trim() === "" || /[\r\n]/u.test(change.owner)) throw new OwnerError(400, "owner is the owner's name, on one line");
    settings.owner = change.owner.trim();
  }
  if (change.model !== undefined) {
    if (typeof change.model !== "string" || !/^[\w.:-]+$/u.test(change.model)) throw new OwnerError(400, "model is a model name");
    settings.model = change.model;
  }
  if (change.effort !== undefined) {
    if (!(EFFORTS as readonly unknown[]).includes(change.effort)) throw new OwnerError(400, `effort is one of ${EFFORTS.join(", ")}`);
    settings.effort = change.effort as Effort;
  }
  if (change.notice !== undefined) {
    if (change.notice !== null && (typeof change.notice !== "string" || /[\r\n]/u.test(change.notice))) throw new OwnerError(400, "notice is a command on one line, or null for no notices");
    settings.notice = change.notice === null || change.notice.trim() === "" ? null : change.notice.trim();
  }
  if (change.start !== undefined) {
    if (change.start !== null && (typeof change.start !== "string" || /[\r\n]/u.test(change.start))) throw new OwnerError(400, "start is a command on one line, or null to start nothing");
    settings.start = change.start === null || change.start.trim() === "" ? null : change.start.trim();
  }
  writeSettings(dataDirectory, settings);
  return settings;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new OwnerError(400, "the request body is too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new OwnerError(400, "the request body is not JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new OwnerError(400, "the request body is a JSON object");
  return value as Record<string, unknown>;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body, null, 2)}\n`;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(text);
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

/** The built board: `index.html` at `/`, and its hashed assets, which never change and are cached for good. */
function serveBoard(options: ApiOptions, pathname: string, method: string, response: ServerResponse): void {
  if (method !== "GET" && method !== "HEAD") return send(response, 405, { error: `${method} is not allowed on ${pathname}` });
  const directory = options.board === undefined ? BOARD_DIRECTORY : options.board;
  if (directory === null) {
    response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    response.end("entail's board is not built. Run npm run build in entail's checkout; the API is still at /api/.\n");
    return;
  }
  const relative = pathname === "/" || pathname === "/index.html" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const file = normalize(join(directory, relative));
  if (!file.startsWith(normalize(directory + sep)) || !existsSync(file) || !statSync(file).isFile()) return send(response, 404, { error: `nothing at ${pathname}` });
  const isIndex = relative === "index.html";
  response.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
    "Cache-Control": isIndex ? "no-store" : "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...(isIndex
      ? { "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" }
      : {}),
  });
  response.end(method === "HEAD" ? undefined : readFileSync(file));
}
