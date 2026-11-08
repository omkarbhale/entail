/**
 * The social layer of a forge: issues, comments and identity, read through one
 * interface with one adapter per forge (ADR-0015). Nothing above this
 * interface names a forge; repository content comes from git, not from here.
 */

/** Which forge a repo lives on. It is stated by the owner, never guessed from the host. */
export type ForgeKind = "github" | "gitlab";

/**
 * A repo's forge setting: the forge, its host and the repo's path there. It
 * holds no credentials and no base URL; the owner's own CLI for the host
 * supplies both (ADR-0015).
 */
export interface ForgeSetting {
  forge: ForgeKind;
  /** The forge's host, such as `github.com`, `gitlab.com` or a self-hosted GitLab's host. */
  host: string;
  /** The repo's path on the host, such as `acme/tally`. */
  path: string;
}

/**
 * Someone acting on a forge: the forge, the host and the numeric user id. The
 * username is kept for display only and is never compared; use
 * {@link sameActor} for every identity comparison (ADR-0015).
 */
export interface Actor {
  forge: ForgeKind;
  host: string;
  id: number;
  /** For display only. A renamed account keeps its id. */
  username: string;
}

/** Whether two actors are the same account: same forge, host and numeric user id. */
export function sameActor(a: Actor, b: Actor): boolean {
  return a.forge === b.forge && a.host === b.host && a.id === b.id;
}

/**
 * An enrolled repo's project as the forge knows it. Records are keyed on
 * forge, host and the numeric project id, so a renamed or transferred repo
 * keeps its records (ADR-0015).
 */
export interface Project {
  forge: ForgeKind;
  host: string;
  /** The forge's numeric project id. */
  id: number;
  /** The path it was read through; it can change, the id does not. */
  path: string;
  defaultBranch: string;
}

/** The key a project's records and operational state are kept under. */
export function projectKey(project: Pick<Project, "forge" | "host" | "id">): string {
  return `${project.forge}:${project.host}:${project.id}`;
}

/** An issue as the forge reports it. Its text is the reporter's words, never the owner's. */
export interface Issue {
  /** The forge's numeric id for the issue. */
  id: number;
  /** The issue's number within its repo, as people refer to it. */
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  author: Actor;
  labels: string[];
  /** ISO time. */
  createdAt: string;
  /** ISO time. */
  updatedAt: string;
  url: string;
}

/** A comment on an issue. */
export interface IssueComment {
  /** The forge's numeric id for the comment. */
  id: number;
  /** The number of the issue it is on. */
  issueNumber: number;
  body: string;
  author: Actor;
  /** ISO time. */
  createdAt: string;
  /** ISO time. */
  updatedAt: string;
  url: string;
}

/**
 * One thing the forge reports as changed. Its kind, id and update time
 * identify it; the core deduplicates on those three (ADR-0015).
 */
export type Change =
  | { kind: "issue"; id: number; updatedAt: string; issue: Issue }
  | { kind: "issue-comment"; id: number; updatedAt: string; comment: IssueComment };

/**
 * Where an adapter's change detection got to, opaque to everything above the
 * adapter. Cursors are operational state, not records: losing one costs only
 * a re-scan (ADR-0015).
 */
export type ChangeCursor = string;

/** What changed since a cursor, and the cursor to ask from next time. */
export interface ChangeBatch {
  /** May repeat changes reported before; the core deduplicates them. */
  changes: Change[];
  cursor: ChangeCursor;
}

/** One forge's social layer for one enrolled repo (ADR-0015). */
export interface Forge {
  readonly setting: ForgeSetting;

  /**
   * The account the owner's CLI is logged in as for this host, or null when
   * it reports none. Compare it with {@link sameActor}, never by username.
   */
  currentActor(): Promise<Actor | null>;

  /** The repo's numeric project id and default branch. */
  project(): Promise<Project>;

  /**
   * What changed in the repo's issues and issue comments since `cursor`, or
   * everything when `cursor` is null.
   *
   * @throws {RateLimitedError} when the forge's rate limit stops the read.
   * @throws {ForgeLoggedOutError} when the host's CLI is not logged in.
   */
  changesSince(cursor: ChangeCursor | null): Promise<ChangeBatch>;
}

/**
 * The forge refused a read for its rate limit. The pass honours it until
 * {@link RateLimitedError.resetAt} instead of backing off (spec section 1).
 */
export class RateLimitedError extends Error {
  readonly host: string;
  readonly resetAt: Date;

  constructor(host: string, resetAt: Date) {
    super(`${host} is rate limited until ${resetAt.toISOString()}`);
    this.name = "RateLimitedError";
    this.host = host;
    this.resetAt = resetAt;
  }
}

/** The host's CLI is not logged in, or its login was refused. This halts the host's repos. */
export class ForgeLoggedOutError extends Error {
  readonly host: string;

  constructor(host: string, detail: string) {
    super(`the CLI for ${host} is not logged in: ${detail}`);
    this.name = "ForgeLoggedOutError";
    this.host = host;
  }
}

/** The forge answered a request with an error status, or with a body entail cannot read. */
export class ForgeRequestError extends Error {
  readonly host: string;
  readonly status: number;
  readonly method: string;
  readonly path: string;

  constructor(host: string, status: number, method: string, path: string, detail: string) {
    super(`${method} ${path} on ${host} failed with HTTP ${status}: ${detail}`);
    this.name = "ForgeRequestError";
    this.host = host;
    this.status = status;
    this.method = method;
    this.path = path;
  }
}
