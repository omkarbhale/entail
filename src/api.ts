import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Case } from "./case-book.ts";
import { EFFORTS, type Effort } from "./model-runner.ts";
import {
  answerCall,
  changeRepoSettings,
  checkSettingsChange,
  confirmCall,
  enroll,
  itemView,
  logItems,
  overrideCall,
  OwnerError,
  repoName,
  repoViews,
  unenroll,
  waitingItems,
} from "./owner.ts";
import { readSettings, writeSettings, type GlobalSettings } from "./records.ts";

/**
 * The owner's side as a small JSON API on the loopback interface, for the
 * board. Everything it changes is appended to the repos' logs under the
 * owner's name; entail acts on GitHub for it on its next pass, and `wake` asks
 * a running loop to make that pass now.
 *
 *   GET    /api/waiting[?repo=owner/name]     what waits on the owner: questions, then calls to confirm
 *   GET    /api/log[?repo=owner/name]         every call, owner's action and post, oldest first
 *   GET    /api/calls/:id                     one call
 *   POST   /api/calls/:id/confirm             {}
 *   POST   /api/calls/:id/override            {"call": "go"|"no", "reason": "..."}            on an issue's call
 *                                             {"call": "merge"|"send-back", "reason": "..."}  on a PR's call
 *   POST   /api/calls/:id/answer              {"call": "go"|"no", "answer": "..."}            on an issue's call
 *                                             {"call": "merge"|"send-back", "answer": "..."}  on a PR's call
 *   GET    /api/repos[?all=1]                 enrolled repos (all=1: every repo with a log)
 *   POST   /api/repos                         {"repo": "owner/name", "confirm"?: bool, "since"?: ISO time}
 *   PATCH  /api/repos/:owner/:name            {"confirm"?: bool, "model"?: string|null, "effort"?: string|null}
 *   DELETE /api/repos/:owner/:name            unenrolls
 *   GET    /api/settings                      the owner's name and the default model and effort
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
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_BODY_BYTES = 64 * 1024;

export function createApi(options: ApiOptions): Server {
  return createServer((request, response) => {
    handle(options, request, response).catch((error: unknown) => {
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
  if (method !== "GET") {
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) return send(response, 403, { error: "entail's API takes no requests from another origin" });
    if (!/^application\/json\b/u.test(request.headers["content-type"] ?? "")) return send(response, 415, { error: "send JSON, with Content-Type: application/json" });
  }
  const url = new URL(request.url ?? "/", `http://${host}`);
  const path = url.pathname.replace(/\/+$/u, "");
  const { dataDirectory } = options;
  const now = () => options.now?.() ?? new Date();
  const changed = <T>(value: T): T => {
    options.wake?.();
    return value;
  };
  const repoParam = () => {
    const repo = url.searchParams.get("repo");
    return repo === null || repo === "" ? undefined : repoName(repo);
  };

  if (method === "GET" && path === "/api/waiting") return send(response, 200, { items: waitingItems(dataDirectory, await options.book(), repoParam()) });
  if (method === "GET" && path === "/api/log") return send(response, 200, { items: logItems(dataDirectory, await options.book(), repoParam()) });

  const call = /^\/api\/calls\/(\d+)(?:\/(confirm|override|answer))?$/u.exec(path);
  if (call !== null) {
    const id = Number(call[1]);
    const action = call[2];
    if (action === undefined && method === "GET") return send(response, 200, itemView(dataDirectory, id, await options.book()));
    if (action !== undefined && method === "POST") {
      const body = await readJson(request);
      const by = await options.owner();
      if (action === "confirm") return send(response, 200, changed(await confirmCall(dataDirectory, id, by, now())));
      if (action === "override") return send(response, 200, changed(await overrideCall(dataDirectory, id, by, body.call, body.reason, now())));
      return send(response, 200, changed(await answerCall(dataDirectory, id, by, body.call, body.answer, now())));
    }
    return send(response, 405, { error: `${method} is not allowed on ${path}` });
  }

  if (path === "/api/repos") {
    if (method === "GET") return send(response, 200, { repos: repoViews(dataDirectory, settingsOf(options), { all: url.searchParams.get("all") === "1" }) });
    if (method === "POST") {
      const body = await readJson(request);
      if (typeof body.repo !== "string") throw new OwnerError(400, "repo is required, as owner/name");
      if (body.confirm !== undefined && typeof body.confirm !== "boolean") throw new OwnerError(400, "confirm is true or false");
      const since = body.since === undefined ? undefined : new Date(String(body.since));
      if (since !== undefined && Number.isNaN(since.getTime())) throw new OwnerError(400, "since is an ISO time");
      const state = enroll(dataDirectory, body.repo, await options.owner(), { ...(typeof body.confirm === "boolean" ? { confirm: body.confirm } : {}), ...(since ? { since } : {}) }, now());
      return send(response, 201, changed(state));
    }
    return send(response, 405, { error: `${method} is not allowed on ${path}` });
  }
  const repo = /^\/api\/repos\/([^/]+)\/([^/]+)$/u.exec(path);
  if (repo !== null) {
    const name = repoName(`${decodeURIComponent(repo[1]!)}/${decodeURIComponent(repo[2]!)}`);
    if (method === "DELETE") return send(response, 200, changed(unenroll(dataDirectory, name, await options.owner(), now())));
    if (method === "PATCH") {
      const change = checkSettingsChange(await readJson(request));
      return send(response, 200, changed(changeRepoSettings(dataDirectory, name, await options.owner(), change, now())));
    }
    return send(response, 405, { error: `${method} is not allowed on ${path}` });
  }

  if (path === "/api/settings") {
    if (method === "GET") return send(response, 200, settingsOf(options));
    if (method === "PATCH") return send(response, 200, changed(changeSettings(dataDirectory, options.defaultModel, await readJson(request))));
    return send(response, 405, { error: `${method} is not allowed on ${path}` });
  }
  return send(response, 404, { error: `nothing at ${path}` });
}

function settingsOf(options: ApiOptions): GlobalSettings {
  return readSettings(options.dataDirectory, { model: options.defaultModel });
}

/** Changes the settings for every repo, checked as they arrive from the board or the command line. */
export function changeSettings(dataDirectory: string, defaultModel: string, change: Record<string, unknown>): GlobalSettings {
  const settings = readSettings(dataDirectory, { model: defaultModel });
  for (const key of Object.keys(change)) {
    if (!["owner", "model", "effort"].includes(key)) throw new OwnerError(400, `no setting named ${key}`);
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
