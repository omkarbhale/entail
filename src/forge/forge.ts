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

/**
 * The forge instance a repo lives on: its version, and why entail cannot serve
 * it if it cannot. Enrollment refuses an instance with a reason (ADR-0015).
 */
export interface ForgeInstance {
  /** The version the instance reports, or null when the forge has none to read, as on github.com. */
  version: string | null;
  /** Why entail cannot serve this instance, such as a GitLab older than 15.6, or null when it can. */
  unsupported: string | null;
}

/** What changed since a cursor, and the cursor to ask from next time. */
export interface ChangeBatch {
  /** May repeat changes reported before; the core deduplicates them. */
  changes: Change[];
  cursor: ChangeCursor;
}

/** What a write or a comment read is on: an issue or a PR, by its number. */
export type ForgeTarget = "issue" | "pr";

/** A comment as the forge reports it, on an issue or a PR. */
export interface ForgeComment {
  /** The forge's numeric id for the comment. */
  id: number;
  body: string;
  author: Actor;
  /** ISO time. */
  createdAt: string;
  url: string;
}

/** A comment the forge accepted. */
export interface PostedComment {
  id: number;
  url: string;
}

/**
 * Why an issue is closed. GitHub records the reason, and closes as not
 * planned where asked; GitLab has no reason to record.
 */
export type CloseReason = "completed" | "not-planned";

/** How GitHub merges a PR: the method set at enrollment. GitLab uses the project's own. */
export type MergeMethod = "merge" | "squash" | "rebase";

/**
 * What a merge came to. Anything other than merged is a refusal, with the
 * forge's reason (ADR-0014, ADR-0015).
 */
export type MergeOutcome = { merged: true; mergeCommitSha: string | null } | { merged: false; refusal: string };

/** A PR's state as read to settle a merge: open, closed without merging, or merged. */
export interface PullRequestState {
  state: "open" | "closed" | "merged";
  headSha: string;
  /** The commit the merge made, when merged and the forge reports one. */
  mergeCommitSha: string | null;
}

/** Words entail's comments use that differ by forge. */
export interface ForgeWording {
  /** "pull request" on GitHub, "merge request" on GitLab. */
  pullRequest: string;
}

/** Every label entail writes starts with this, and it writes no other label (ADR-0013). */
export const ENTAIL_LABEL_PREFIX = "entail:";

/** The colour a missing `entail:` label is created with, as six hex digits. */
export const ENTAIL_LABEL_COLOR = "5319e7";

/** The description a missing `entail:` label is created with. */
export const ENTAIL_LABEL_DESCRIPTION = "Set by entail: see its latest comment on the issue";

/** Throws unless `label` is an `entail:` label entail may write. */
export function assertEntailLabel(label: string): void {
  if (!label.startsWith(ENTAIL_LABEL_PREFIX) || label.length === ENTAIL_LABEL_PREFIX.length || /[,\s]/.test(label)) {
    throw new Error(`entail writes only its own labels, such as entail:cleared, not ${JSON.stringify(label)}`);
  }
}

/** One forge's social layer for one enrolled repo (ADR-0015). */
export interface Forge {
  readonly setting: ForgeSetting;

  /** Words for entail's comments on this forge, such as "merge request" on GitLab. */
  readonly wording: ForgeWording;

  /**
   * The account the owner's CLI is logged in as for this host, or null when
   * it reports none. Compare it with {@link sameActor}, never by username.
   */
  currentActor(): Promise<Actor | null>;

  /** The repo's numeric project id and default branch. */
  project(): Promise<Project>;

  /** The instance the repo lives on, read so enrollment can refuse one entail cannot serve. */
  instance(): Promise<ForgeInstance>;

  /**
   * What changed in the repo's issues and issue comments since `cursor`, or
   * everything when `cursor` is null.
   *
   * @throws {RateLimitedError} when the forge's rate limit stops the read.
   * @throws {ForgeLoggedOutError} when the host's CLI is not logged in.
   */
  changesSince(cursor: ChangeCursor | null): Promise<ChangeBatch>;

  // The four writes (ADR-0015). They go out only through entail's forge
  // writer, which records each as an intent first and enforces the comment
  // rules; nothing else calls them.

  /** Posts a comment on an issue or PR, exactly as given. */
  postComment(target: ForgeTarget, number: number, body: string): Promise<PostedComment>;

  /** Adds an `entail:` label to an issue, creating the label in the repo first if it is missing. */
  addLabel(issueNumber: number, label: string): Promise<void>;

  /** Removes an `entail:` label from an issue. A label the issue does not carry is already removed. */
  removeLabel(issueNumber: number, label: string): Promise<void>;

  /** Closes an issue; on GitHub, with the reason given. An issue already closed stays closed. */
  closeIssue(issueNumber: number, reason: CloseReason): Promise<void>;

  /**
   * Merges a PR only at `sha`, never bypassing rules and never through the
   * forge's auto-merge. Every definitive outcome but merged is returned as a
   * refusal.
   *
   * @throws {MergePendingError} when the forge is still running the merge
   *   after the wait. That is no outcome yet: the writer leaves the intent
   *   unconfirmed, and asking again or settling on start reads the PR's state.
   * @throws {RateLimitedError} or {@link ForgeLoggedOutError} when the merge was not asked for at all.
   */
  merge(prNumber: number, sha: string, method?: MergeMethod): Promise<MergeOutcome>;

  // Reads that settle unconfirmed writes on start (ADR-0017).

  /** Every comment by people on an issue or PR, oldest first. */
  comments(target: ForgeTarget, number: number): Promise<ForgeComment[]>;

  /** A PR's state, to learn whether a merge went through. */
  pullRequestState(prNumber: number): Promise<PullRequestState>;
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

/** The forge was still running a merge when the wait for it ended, so the merge has no outcome yet. */
export class MergePendingError extends Error {
  readonly host: string;
  readonly prNumber: number;

  constructor(host: string, prNumber: number, waitedMs: number) {
    super(`${host} had not finished merging #${prNumber} after ${Math.round(waitedMs / 1000)} seconds`);
    this.name = "MergePendingError";
    this.host = host;
    this.prNumber = prNumber;
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
