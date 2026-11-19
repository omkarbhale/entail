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
  SuggestResponse,
  WaitingResponse,
} from "../../src/api-types.ts";

export type * from "../../src/api-types.ts";

/**
 * The board's only way to entail: its JSON API on the same host. The board
 * never talks to GitHub or GitLab; entail's own process records every answer
 * and acts on the forge for it.
 */

/** A request entail refused, or one that never reached it. */
/** A host whose certificate the forge's CLI refuses as signed by an authority it does not know. */
export interface UntrustedCertificate {
  host: string;
  cli: string;
  /** Whether entail can set the CLI to trust the host's certificate authority: only `glab` has a per-host setting for it. */
  fixable: boolean;
  /** The CA certificate file git is set to trust for the host, when git names one. */
  caCertificate: string | null;
  command: string | null;
}

export class ApiError extends Error {
  readonly status: number;
  /** Whether entail did not answer at all, so nothing can have been recorded. */
  readonly network: boolean;
  /** Set when the forge's CLI does not trust the host's certificate, with what the board needs to offer the fix. */
  readonly untrustedCertificate: UntrustedCertificate | null;
  constructor(status: number, message: string, network: boolean, untrustedCertificate: UntrustedCertificate | null = null) {
    super(message);
    this.status = status;
    this.network = network;
    this.untrustedCertificate = untrustedCertificate;
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
    const untrusted = typeof parsed === "object" && parsed !== null ? ((parsed as { untrustedCertificate?: UntrustedCertificate }).untrustedCertificate ?? null) : null;
    throw new ApiError(response.status, message, response.status >= 500 && response.status !== 502, untrusted);
  }
  return parsed as T;
}

/** A change to the settings for every repo, as `PATCH /api/settings` takes it: null turns a command or the backup off. */
export interface SettingsChange {
  owner?: string;
  model?: string;
  effort?: SettingsView["effort"];
  notice?: string | null;
  start?: string | null;
  backup?: string | null;
}

/** A repo in the API's paths: `owner/name` for GitHub; a GitLab project, whose path can hold subgroups, and a repo on a GitHub Enterprise Server, as one encoded segment. */
const repoPath = (repo: string) => (repo.startsWith("gitlab:") || repo.startsWith("github://") ? encodeURIComponent(repo) : repo.split("/").map(encodeURIComponent).join("/"));

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
  trustCertificate: (host: string, caCertificate: string) => request<{ host: string; caCertificate: string }>("POST", "/api/trust", { cli: "glab", host, caCertificate }),
  unenroll: (repo: string) => request<unknown>("DELETE", `/api/repos/${repoPath(repo)}`, {}),
  changeRepo: (repo: string, change: { confirm?: boolean; model?: string | null; effort?: string | null; baseBranch?: string | null; pin?: string; unpin?: string }) => request<unknown>("PATCH", `/api/repos/${repoPath(repo)}`, change),
  check: (repo: string) => request<CheckResponse>("POST", `/api/repos/${repoPath(repo)}/check`, {}),
  backlog: (repo: string) => request<{ repo: string; issues: number[] }>("POST", `/api/repos/${repoPath(repo)}/backlog`, {}),
  suggest: (repo: string, choice: { model: string; effort: string }) => request<SuggestResponse>("POST", `/api/repos/${repoPath(repo)}/suggest`, choice),
  changeSettings: (change: SettingsChange) => request<SettingsView>("PATCH", "/api/settings", change),
};

/** What to say when an action did not go through: nothing was recorded, and the owner's words are kept. */
export function failureText(error: unknown, what = "nothing was recorded and nothing was sent to GitHub"): string {
  if (error instanceof ApiError && !error.network) return `Not recorded: ${error.message}.`;
  return `entail did not answer, so ${what}. Try again.`;
}
