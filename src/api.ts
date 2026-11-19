import { DrainingError } from "./loop.ts";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, isAbsolute, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { BackupView, CheckResponse, EnrollResponse, FailingView, LogFilter, SettingsView, StatusView, SuggestResponse } from "./api-types.ts";
import { checkRemote, readBackupState, shownRemote } from "./backup.ts";
import type { Case } from "./case-book.ts";
import type { EventBus } from "./events.ts";
import { type Forge, ForgeUntrustedCertificateError } from "./forge/forge.ts";
import { gitCaCertificate, TRUST_CLI, trustCertificate, trustCommand, untrustedCertificateMessage } from "./forge/trust.ts";
import { failingView, type Health } from "./health.ts";
import { EFFORTS, type Effort } from "./model-runner.ts";
import {
  answerCall,
  askBacklog,
  runSettings,
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
  stalledViews,
  type RepoViewOptions,
  undoAction,
  unenroll,
  waitingResponse,
  collaboratorName,
} from "./owner.ts";
import { SuggestionRunningError, type SuggestionRuns } from "./suggest.ts";
import { loggedRepos, readLog, readSettings, repoState, sameName, writeSettings, type GlobalSettings } from "./records.ts";
import { forgeTitle, isSelfHostedHost } from "./repo-ref.ts";

/**
 * entail's board and the small JSON API behind it, on the loopback
 * interface. The board is the built single-page app in `dist/board`; the API
 * is the single path through which the owner's answers are recorded, and the
 * browser never talks to the forge. Everything the API changes is appended to
 * the repos' logs under the owner's name; an answer is held for
 * {@link HOLD_MS} so it can be undone, and entail acts on the forge for it when
 * the window closes.
 *
 *   GET    /api/status                        whether entail is watching, when it last checked, which repos are failing and why, and whether it is drained for an update
 *   POST   /api/drain                         {}: starts no new pass and lets the running one finish, before `entail update` restarts entail; answers with the status
 *   DELETE /api/drain                         takes passes again, when an update could not restart entail
 *   GET    /api/events                        server-sent events: something changed, a repo is being checked, a check finished
 *   GET    /api/waiting[?repo=&since=]        what waits on the owner, the answers still in their undo window, and calls made alone since `since`
 *   GET    /api/log[?repo=&filter=&before=&tz=]  one page of the log, newest first, in whole days of time zone `tz`; `before=` pages back
 *   GET    /api/calls/:id                     one call
 *   POST   /api/calls/:id/confirm             {}
 *   POST   /api/calls/:id/override            {"call": "go"|"plan"|"no", "reason": "...", "differently"?: true}  on an issue's call
 *                                             {"call": "merge"|"send-back", "reason": "..."}              on a PR's call
 *   POST   /api/calls/:id/answer              {"call": "go"|"plan"|"no", "answer": "...", "accept": [0, 2]?, "as"?: "name"}     on an issue's call; accept takes only those parts of it, by position from 0, and the call is no
 *                                             {"call": "merge"|"send-back", "answer": "...", "as"?: "name"}  on a PR's call
 *                                             `as` names a collaborator the owner allowed for the repo (settings allow); the answer is then recorded under their name,
 *                                             flagged as a collaborator's, and is refused for anyone not allowed. Only an answer and its undo take `as`: confirming,
 *                                             overriding and every setting, allowing a collaborator included, are the owner's alone.
 *   POST   /api/calls/:id/undo                {"as"?: "name"}: undoes the owner's action on the call while it is held; a collaborator undoes only their own answer
 *   GET    /api/repos[?all=1]                 enrolled repos (all=1: every repo with a log)
 *   POST   /api/repos                         {"repo": "owner/name", "confirm"?: bool, "since"?: ISO time}
 *   PATCH  /api/repos/:owner/:name            {"confirm"?: bool, "model"?: string|null, "effort"?: string|null, "baseBranch"?: string|null, "pin"?: string, "unpin"?: string, "drift"?: bool, "driftEveryDays"?: 1..365|null, "genericCriteria"?: string[]|null, "allow"?: string, "disallow"?: string}
 *                                             allow lets a collaborator answer the repo's board items under that name, and disallow takes it back
 *                                             pin adds a topic to the repo's pins file and unpin takes one out; each is logged with who made it
 *   DELETE /api/repos/:owner/:name            unenrolls
 *   POST   /api/repos/:owner/:name/check      checks the repo now, and answers with what the check did
 *   POST   /api/repos/:owner/:name/backlog    judges the issues open on the forge that have no call yet
 *   POST   /api/repos/:owner/:name/suggest    {"model"?: string, "effort"?: string}: starts a run that suggests work from the vision and the product,
 *                                             filing each suggestion as an issue labelled entail:suggested; 202 with the run, 409 while one runs for the repo
 *   POST   /api/trust                         {"cli": "glab", "host": "git.example.com", "caCertificate": "/abs/ca.pem"}: sets glab to trust that CA file for that
 *                                             self-hosted host, after the owner confirmed both on the board; enrolling a host glab does not trust answers 502
 *                                             with `untrustedCertificate` (host, cli, fixable, caCertificate, command) for the board to offer it
 *   GET    /api/settings                      the owner's name, the default model and effort, the notice and start commands and the backup remote with how its last push went
 *   PATCH  /api/settings                      {"owner"?: string, "model"?: string, "effort"?: string, "notice"?: string|null, "start"?: string|null, "sendBack"?: string|null, "backup"?: string|null},
 *                                             checked as `entail settings` checks them
 *
 * A GitLab project is addressed by its whole name as one encoded segment in
 * place of `:owner/:name`, such as `/api/repos/gitlab%3Aacme%2Ftally/check`,
 * or `/api/repos/gitlab%3A%2F%2Fgit.example.com%2Facme%2Ftally/check` on a
 * self-hosted GitLab.
 * A repo on a GitHub Enterprise Server is addressed the same way, such as
 * `/api/repos/github%3A%2F%2Fghe.example.com%2Facme%2Ftally/check`.
 *
 * A call is on an issue or on a PR: each item carries `kind` ("issue" or
 * "pr") and, on a PR's call, `pr` with the criteria checklist, the facts read
 * from the forge, what the PR does beyond its criteria sorted needed, harmless or
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
  /** Whether the loop is drained for an update: it starts no new pass. */
  readonly draining: boolean;
  /** Starts no new pass; the running one finishes. */
  drain(): void;
  /** Takes passes again. */
  resume(): void;
}

export interface ApiOptions {
  dataDirectory: string;
  /**
   * The owner's display name, under which every owner's action is recorded.
   * `repo`, when given, is a repo being enrolled, whose forge's login may be
   * the only one there is.
   */
  owner: (repo?: string) => Promise<string>;
  /** The default model when the owner has set none. */
  defaultModel: string;
  book: () => Promise<Case[]>;
  /** Called after any change, so a running loop acts on it without waiting for its next poll. */
  wake?: () => void;
  now?: () => Date;
  /** How long an answer can be undone; {@link HOLD_MS} unless a test says otherwise. */
  holdMs?: number;
  loop?: BoardLoop;
  /** Whether each repo's checks are failing, as the loop in this process saw them. */
  health?: Health;
  /** What enrolling and the backlog read from the forge: that the repo can be reached, that its instance is served, and its open issues. */
  forgeFor?: (repo: string) => Pick<Forge, "project" | "instance" | "openIssueNumbers">;
  events?: EventBus;
  /** The suggestion runs started from the board, when entail runs them in this process. */
  suggestions?: Pick<SuggestionRuns, "running" | "repos" | "start">;
  /** The built board's directory; {@link BOARD_DIRECTORY} unless a test says otherwise, null for none. */
  board?: string | null;
  /** Where the board is served, for the status line and notices. */
  url?: string;
  /**
   * How the board helps with a host whose certificate `glab` does not trust:
   * the CA certificate file git is set to trust for a host, and setting `glab`
   * to trust a file for a host. The real ones unless a test replaces them.
   */
  trust?: { caCertificate: (host: string) => Promise<string | null>; apply: (host: string, file: string) => Promise<void> };
  /** The entail script this process runs, so `entail update` can tell which checkout it runs from. */
  cli?: string;
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
      if (error instanceof OwnerError) send(response, error.status, { ...error.extra, error: error.message });
      else if (error instanceof DrainingError) send(response, 409, { error: "entail is stopping for an update; check again once it has restarted" });
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
  if (path === "/api/drain") {
    if (method !== "POST" && method !== "DELETE") return send(response, 405, { error: `${method} is not allowed on ${path}` });
    if (options.loop === undefined) throw new OwnerError(409, "entail is not watching here, so there is nothing to drain");
    if (method === "POST") options.loop.drain();
    else options.loop.resume();
    options.events?.emit({ type: "changed" });
    return send(response, 200, status(options));
  }
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
      const owner = await options.owner();
      // A collaborator the owner allowed names themselves with `as`; they may only answer, and take back their own answer.
      // Confirming and overriding are the owner's, and so is everything else on the API, which never takes `as`.
      const collaborator = body.as === undefined ? undefined : collaboratorName(body.as, "as");
      if (collaborator !== undefined && sameName(collaborator, owner)) throw new OwnerError(403, `${collaborator} is the owner's own name: a collaborator answers under a name of their own`);
      if (collaborator !== undefined && action !== "answer" && action !== "undo") throw new OwnerError(403, `a collaborator may only answer a question or undo their own answer, not ${action}`);
      const by = collaborator ?? owner;
      const hold = { holdMs: options.holdMs ?? HOLD_MS, ...(collaborator === undefined ? {} : { collaborator: true }) };
      if (action === "undo") {
        const undone = undoAction(dataDirectory, id, by, now(), hold);
        options.events?.emit({ type: "changed" });
        return send(response, 200, undone);
      }
      const recorded =
        action === "confirm"
          ? await confirmCall(dataDirectory, id, by, now(), hold)
          : action === "override"
            ? await overrideCall(dataDirectory, id, by, body.call, body.reason, now(), { ...hold, differently: body.differently === true })
            : await answerCall(dataDirectory, id, by, body.call, body.answer, now(), { ...hold, ...(body.accept === undefined ? {} : { accept: body.accept }) });
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
      // Reading the repo checks it exists, the logged-in gh or glab can see it and
      // entail serves its forge's version (a self-hosted GitLab's), before anything is recorded.
      const { openIssues, unsupported } = options.forgeFor === undefined ? { openIssues: 0, unsupported: null } : await reach(repo, async () => {
        const forge = options.forgeFor!(repo);
        await forge.project();
        const { unsupported } = await forge.instance();
        return { openIssues: (await forge.openIssueNumbers()).length, unsupported };
      }, options);
      if (unsupported !== null) throw new OwnerError(409, `${repo} cannot be enrolled: ${unsupported}`);
      enroll(dataDirectory, repo, await options.owner(repo), { ...(typeof body.confirm === "boolean" ? { confirm: body.confirm } : {}), ...(since ? { since } : {}) }, now());
      const view = repoViews(dataDirectory, settings(), checkedAt(options)).find((candidate) => candidate.repo === repo)!;
      return send(response, 201, changed<EnrollResponse>({ repo: view, openIssues }));
    }
    return send(response, 405, { error: `${method} is not allowed on ${path}` });
  }
  // A GitHub repo is addressed as owner/name; a GitLab project, whose path can
  // hold subgroups, and a repo on a GitHub Enterprise Server, as its whole
  // name in one encoded segment.
  const repo = /^\/api\/repos\/(?:((?:gitlab|github)(?::|%3A)[^/]+)|([^/]+)\/([^/]+))(?:\/(check|backlog|suggest))?$/iu.exec(path);
  if (repo !== null) {
    const name = repoName(repo[1] !== undefined ? decodeURIComponent(repo[1]) : `${decodeURIComponent(repo[2]!)}/${decodeURIComponent(repo[3]!)}`);
    const action = repo[4];
    if (action === "check" && method === "POST") {
      if (!repoState(name, readLog(dataDirectory, name)).enrolled) throw new OwnerError(404, `${name} is not enrolled`);
      if (options.loop === undefined) throw new OwnerError(409, "entail is not watching: start it with entail run");
      if (options.loop.draining) throw new OwnerError(409, "entail is stopping for an update; check again once it has restarted");
      return send(response, 200, await options.loop.check(name));
    }
    if (action === "backlog" && method === "POST") {
      if (options.forgeFor === undefined) throw new OwnerError(409, `entail cannot read ${forgeTitle(name)} from here`);
      const open = await reach(name, () => options.forgeFor!(name).openIssueNumbers(), options);
      const issues = askBacklog(dataDirectory, name, await options.owner(), open, now());
      return send(response, 200, changed({ repo: name, issues }));
    }
    if (action === "suggest" && method === "POST") {
      const body = await readJson(request);
      const state = repoState(name, readLog(dataDirectory, name));
      if (!state.enrolled) throw new OwnerError(404, `${name} is not enrolled`);
      if (body.model !== undefined && (typeof body.model !== "string" || !/^[\w.:-]+$/u.test(body.model))) throw new OwnerError(400, "model is a model name");
      if (body.effort !== undefined && !(EFFORTS as readonly unknown[]).includes(body.effort)) throw new OwnerError(400, `effort is one of ${EFFORTS.join(", ")}`);
      if (options.suggestions === undefined) throw new OwnerError(409, "entail is not running here: start it with entail run, or use entail suggest");
      if (options.loop?.draining === true) throw new OwnerError(409, "entail is stopping for an update; suggest again once it has restarted");
      const uses = runSettings(state, settings());
      const choice = { model: (body.model as string | undefined) ?? uses.model, effort: (body.effort as Effort | undefined) ?? uses.effort };
      let started;
      try {
        started = options.suggestions.start(name, choice);
      } catch (error) {
        if (error instanceof SuggestionRunningError) throw new OwnerError(409, error.message);
        throw error;
      }
      return send(response, 202, { repo: name, since: started.since, model: started.model, effort: started.effort } satisfies SuggestResponse);
    }
    if (action === undefined && method === "DELETE") return send(response, 200, changed(unenroll(dataDirectory, name, await options.owner(), now())));
    if (action === undefined && method === "PATCH") {
      const change = checkSettingsChange(await readJson(request));
      return send(response, 200, changed(changeRepoSettings(dataDirectory, name, await options.owner(), change, now())));
    }
    return send(response, 405, { error: `${method} is not allowed on ${path}` });
  }

  if (path === "/api/trust") {
    if (method !== "POST") return send(response, 405, { error: `${method} is not allowed on ${path}` });
    // The one place entail writes a forge CLI's trust setting, and only for the
    // host and the file the owner confirmed on the board.
    const body = await readJson(request);
    if (body.cli !== TRUST_CLI) throw new OwnerError(400, `only ${TRUST_CLI} has a per-host trusted certificate setting; cli is "${TRUST_CLI}"`);
    if (typeof body.host !== "string" || !isSelfHostedHost(body.host)) throw new OwnerError(400, "host is the host name of a self-hosted GitLab, with no scheme or port");
    if (typeof body.caCertificate !== "string" || !isAbsolute(body.caCertificate)) throw new OwnerError(400, "caCertificate is the absolute path of the CA certificate file to trust");
    const host = body.host.toLowerCase();
    try {
      await (options.trust?.apply ?? trustCertificate)(host, body.caCertificate);
    } catch (error) {
      throw new OwnerError(409, error instanceof Error ? error.message : String(error));
    }
    return send(response, 200, { host, cli: TRUST_CLI, caCertificate: body.caCertificate });
  }

  if (path === "/api/settings") {
    if (method === "GET") return send(response, 200, settingsView(settings(), dataDirectory));
    if (method === "PATCH") {
      return send(response, 200, changed(settingsView(changeSettings(dataDirectory, options.defaultModel, await readJson(request)), dataDirectory)));
    }
    return send(response, 405, { error: `${method} is not allowed on ${path}` });
  }
  return send(response, 404, { error: `nothing at ${path}` });
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

function checkedAt(options: ApiOptions): Pick<RepoViewOptions, "checkedAt" | "failing" | "suggesting"> {
  const { loop, health, suggestions } = options;
  return {
    ...(suggestions === undefined ? {} : { suggesting: (repo: string) => suggestions.running(repo) }),
    ...(loop === undefined ? {} : { checkedAt: (repo: string) => loop.checkedAt(repo) }),
    ...(health === undefined ? {} : { failing: (repo: string) => failingOf(health, repo) }),
  };
}

function failingOf(health: Health, repo: string): FailingView | null {
  const failing = health.failing(repo);
  return failing === null ? null : failingView(failing);
}

async function reach<T>(repo: string, read: () => Promise<T>, options?: ApiOptions): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ForgeUntrustedCertificateError) {
      // The board offers to fix this, after the owner says so; nothing is changed here.
      const fixable = error.cli === TRUST_CLI && isSelfHostedHost(error.host);
      const file = fixable ? await (options?.trust?.caCertificate ?? gitCaCertificate)(error.host).catch(() => null) : null;
      throw new OwnerError(502, `entail could not read ${repo} on ${forgeTitle(repo)}: ${untrustedCertificateMessage(error.host, error.cli, error.detail, file)}`, {
        untrustedCertificate: { host: error.host, cli: error.cli, fixable, caCertificate: file, command: fixable && file !== null ? trustCommand(error.host, file) : null },
      });
    }
    throw new OwnerError(502, `entail could not read ${repo} on ${forgeTitle(repo)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function status(options: ApiOptions): StatusView {
  const repos = loggedRepos(options.dataDirectory).filter((repo) => repoState(repo, readLog(options.dataDirectory, repo)).enrolled);
  const { health } = options;
  return {
    watching: options.loop !== undefined,
    repos: repos.length,
    failing: health === undefined ? [] : repos.flatMap((repo) => {
      const failing = failingOf(health, repo);
      return failing === null ? [] : [{ repo, failing }];
    }),
    stalled: repos.flatMap((repo) => stalledViews(readLog(options.dataDirectory, repo)).map((stalled) => ({ repo, stalled }))),
    checkedAt: options.loop?.lastPassAt ?? null,
    checking: options.loop?.checking ?? false,
    draining: options.loop?.draining ?? false,
    suggesting: options.suggestions?.repos ?? [],
    pid: process.pid,
    cli: options.cli ?? null,
    url: options.url ?? null,
  };
}

function settingsView(settings: GlobalSettings, dataDirectory: string): SettingsView {
  return { owner: settings.owner, model: settings.model, effort: settings.effort, notice: settings.notice ?? null, start: settings.start ?? null, sendBack: settings.sendBack ?? null, backup: backupView(dataDirectory, settings.backup ?? null) };
}

/** The backup as the board shows it: the remote, with any password in its URL hidden, and how its last push went. */
export function backupView(dataDirectory: string, remote: string | null): BackupView {
  if (remote === null) return { remote: null, pushedAt: null, problem: null };
  const state = readBackupState(dataDirectory);
  const current = state.remote === remote;
  return { remote: shownRemote(remote), pushedAt: current ? state.pushedAt : null, problem: current ? state.problem : null };
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
    if (!["owner", "model", "effort", "notice", "start", "sendBack", "backup"].includes(key)) throw new OwnerError(400, `no setting named ${key}`);
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
  if (change.sendBack !== undefined) {
    if (change.sendBack !== null && (typeof change.sendBack !== "string" || /[\r\n]/u.test(change.sendBack))) throw new OwnerError(400, "sendBack is a command on one line, or null to hand nothing back");
    settings.sendBack = change.sendBack === null || change.sendBack.trim() === "" ? null : change.sendBack.trim();
  }
  if (change.backup !== undefined) {
    const remote = typeof change.backup === "string" ? checkRemote(change.backup) : null;
    if (change.backup !== null && remote === null) throw new OwnerError(400, "backup is a git remote URL on one line, or null to back nothing up");
    settings.backup = remote;
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
