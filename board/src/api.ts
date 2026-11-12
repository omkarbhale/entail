import type {
  ActionView,
  CallView,
  CheckResponse,
  EnrollResponse,
  LogFilter,
  LogPage,
  OwnerCallName,
  RepoView,
  SettingsView,
  StatusView,
  WaitingResponse,
} from "../../src/api-types.ts";

export type * from "../../src/api-types.ts";

/**
 * The board's only way to entail: its JSON API on the same host. The board
 * never talks to GitHub; entail's own process records every answer and acts
 * on GitHub for it.
 */

/** A request entail refused, or one that never reached it. */
export class ApiError extends Error {
  readonly status: number;
  /** Whether entail did not answer at all, so nothing can have been recorded. */
  readonly network: boolean;
  constructor(status: number, message: string, network: boolean) {
    super(message);
    this.status = status;
    this.network = network;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, "entail did not answer", true);
  }
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    // Not JSON: an error page from something in between.
  }
  if (!response.ok) {
    const message = typeof parsed === "object" && parsed !== null && typeof (parsed as { error?: unknown }).error === "string" ? (parsed as { error: string }).error : `entail answered ${response.status}`;
    throw new ApiError(response.status, message, response.status >= 500 && response.status !== 502);
  }
  return parsed as T;
}

const repoPath = (repo: string) => repo.split("/").map(encodeURIComponent).join("/");

export const api = {
  status: () => request<StatusView>("GET", "/api/status"),
  waiting: (since: string | null) => request<WaitingResponse>("GET", `/api/waiting${since === null ? "" : `?since=${encodeURIComponent(since)}`}`),
  log: (options: { repo: string | null; filter: LogFilter; before: string | null; timeZone: string }) => {
    const query = new URLSearchParams({ filter: options.filter, tz: options.timeZone });
    if (options.repo !== null) query.set("repo", options.repo);
    if (options.before !== null) query.set("before", options.before);
    return request<LogPage>("GET", `/api/log?${query}`);
  },
  repos: () => request<{ repos: RepoView[] }>("GET", "/api/repos"),
  settings: () => request<SettingsView>("GET", "/api/settings"),

  confirm: (id: number) => request<ActionView>("POST", `/api/calls/${id}/confirm`, {}),
  override: (id: number, call: OwnerCallName, reason: string, differently: boolean) =>
    request<ActionView>("POST", `/api/calls/${id}/override`, differently ? { call, reason, differently } : { call, reason }),
  answer: (id: number, call: OwnerCallName, answer: string) => request<ActionView>("POST", `/api/calls/${id}/answer`, { call, answer }),
  undo: (id: number) => request<{ undone: ActionView; call: CallView }>("POST", `/api/calls/${id}/undo`, {}),

  enroll: (repo: string) => request<EnrollResponse>("POST", "/api/repos", { repo }),
  unenroll: (repo: string) => request<unknown>("DELETE", `/api/repos/${repoPath(repo)}`, {}),
  changeRepo: (repo: string, change: { confirm?: boolean; model?: string | null; effort?: string | null }) => request<unknown>("PATCH", `/api/repos/${repoPath(repo)}`, change),
  check: (repo: string) => request<CheckResponse>("POST", `/api/repos/${repoPath(repo)}/check`, {}),
  backlog: (repo: string) => request<{ repo: string; issues: number[] }>("POST", `/api/repos/${repoPath(repo)}/backlog`, {}),
  changeSettings: (change: Partial<SettingsView>) => request<SettingsView>("PATCH", "/api/settings", change),
};

/** What to say when an action did not go through: nothing was recorded, and the owner's words are kept. */
export function failureText(error: unknown, what = "nothing was recorded and nothing was sent to GitHub"): string {
  if (error instanceof ApiError && !error.network) return `Not recorded: ${error.message}.`;
  return `entail did not answer, so ${what}. Try again.`;
}
