/**
 * The social layer of a forge: issues, PRs, comments, checks and identity, read through one
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
 * A PR: a GitHub pull request or a GitLab merge request, as the forge reports
 * it. Its description and comments are the author's words, untrusted input.
 */
export interface PullRequest {
  /** The forge's numeric id for the PR. */
  id: number;
  /** The PR's number within its repo, as people refer to it: a pull request's number or a merge request's iid. */
  number: number;
  title: string;
  /** The PR's description. */
  body: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  /**
   * Whether the forge says it would merge the PR now, or null when it has not
   * worked that out yet or the PR came from a list, which does not carry it.
   * {@link Forge.pullRequest} reads it live.
   */
  mergeable: boolean | null;
  /** Whether the PR conflicts with its base, or null when that is not known, as for {@link mergeable}. */
  conflicts: boolean | null;
  /** The sha of the PR's current head commit. */
  headSha: string;
  /** The branch the PR would merge into. */
  baseBranch: string;
  author: Actor;
  /** ISO time. */
  createdAt: string;
  /** ISO time. */
  updatedAt: string;
  url: string;
}

/** A comment on a PR's conversation. */
export interface PullRequestComment {
  /** The forge's numeric id for the comment. */
  id: number;
  /** The number of the PR it is on. */
  pullRequestNumber: number;
  body: string;
  author: Actor;
  /** ISO time. */
  createdAt: string;
  /** ISO time. */
  updatedAt: string;
  url: string;
}

/**
 * Where a check stands: pending until it finishes, then passed or failed.
 * GitHub's neutral and skipped results count as passed, and a GitLab job
 * allowed to fail follows GitLab's own pipeline status (ADR-0015).
 */
export type CheckStatus = "pending" | "passed" | "failed";

/** One result the forge reports for a commit, known by its name (see the glossary's Check). */
export interface Check {
  name: string;
  status: CheckStatus;
  /**
   * False for a check a criterion or generic criterion names that has not
   * reported at this sha. Such a check is pending, never failed.
   */
  reported: boolean;
  /** Where the forge shows the check's result, or null when it gives no link. */
  url: string | null;
}

/**
 * Something the forge requires before it merges into the default branch: a
 * required check on GitHub, or GitLab's pipeline when "pipelines must
 * succeed" is on.
 */
export interface RequiredCheck {
  name: string;
  /** Whether it has reported at the sha, whatever its result. */
  reported: boolean;
}

/** The checks at one sha, and what the forge requires before merging (ADR-0015). */
export interface CheckReport {
  sha: string;
  /** One entry per check name, sorted by name, including named checks that have not reported. */
  checks: Check[];
  required: RequiredCheck[];
}

/** The checks that reported on one commit of the default branch. */
export interface CommitChecks {
  sha: string;
  /** One entry per check name, sorted by name. */
  checks: Check[];
}

/**
 * One thing the forge reports as changed. Its kind, id and update time
 * identify it; the core deduplicates on those three (ADR-0015).
 */
export type Change =
  | { kind: "issue"; id: number; updatedAt: string; issue: Issue }
  | { kind: "issue-comment"; id: number; updatedAt: string; comment: IssueComment }
  | { kind: "pull-request"; id: number; updatedAt: string; pullRequest: PullRequest }
  | { kind: "pull-request-comment"; id: number; updatedAt: string; comment: PullRequestComment };

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

/** A way GitHub merges a PR. GitLab has no such setting: the project's own merge method applies. */
export type MergeMethod = "squash" | "merge" | "rebase";

/** Every merge method, in the order enrollment offers them. */
export const MERGE_METHODS: readonly MergeMethod[] = ["squash", "merge", "rebase"];

/**
 * What the logged-in account may do in a repo, read at enrollment (ADR-0018).
 * Enrollment refuses an account that cannot add labels and comment, and warns,
 * but still enrolls, when it may lack permission to merge.
 */
export interface RepoAccess {
  /** Why the account cannot add labels to issues and comment on them, or null when it can. */
  cannotLabelAndComment: string | null;
  /** Why the account may lack permission to merge into the default branch, or null when it has it. */
  mayLackMerge: string | null;
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

  /**
   * The account a username names on this host, or null when no such user
   * exists. Usernames are resolved once, when the owner lists an executor, and
   * the numeric id is kept from then on (ADR-0015).
   */
  actorByUsername(username: string): Promise<Actor | null>;

  /** The repo's numeric project id and default branch. */
  project(): Promise<Project>;

  /** The instance the repo lives on, read so enrollment can refuse one entail cannot serve. */
  instance(): Promise<ForgeInstance>;

  /** What the logged-in account may do in the repo. */
  access(): Promise<RepoAccess>;

  /**
   * The merge methods the repo allows, for a forge where entail must pick one:
   * GitHub, which has no repo default. Null on GitLab, where the project's own
   * merge method applies. An empty list means the forge did not say, as GitHub
   * does for an account without push access.
   */
  mergeMethods(): Promise<MergeMethod[] | null>;

  /** The numbers of the repo's open issues, which enrollment leaves alone (ADR-0018). */
  openIssueNumbers(): Promise<number[]>;

  /**
   * What changed in the repo's issues, PRs and their comments since `cursor`,
   * or everything when `cursor` is null. A PR's description, head or state
   * changing reports the PR again.
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

  /** One PR, read live, with whether the forge would merge it and whether it conflicts. */
  pullRequest(number: number): Promise<PullRequest>;

  /** Every comment on a PR's conversation, oldest first. The PR's description is {@link PullRequest.body}. */
  pullRequestComments(number: number): Promise<PullRequestComment[]>;

  /**
   * The issue's PRs, each read live: the PRs in this repo that the forge's own
   * linked-issue data says close the issue (closing issue references on
   * GitHub, the merge requests that close it on GitLab) and whose base is the
   * default branch. PR text is never parsed, so a PR that only mentions the
   * issue is not one of them (ADR-0013). Closed and merged PRs are included.
   */
  linkedPullRequests(issueNumber: number): Promise<PullRequest[]>;

  /**
   * The numbers of the issues in this repo that the forge's own linked-issue
   * data says the PR closes, or none when the PR's base is not the default
   * branch (ADR-0013).
   */
  linkedIssues(pullRequestNumber: number): Promise<number[]>;

  /**
   * The checks at `sha` on a PR, and what the forge requires before merging
   * into the default branch (ADR-0015). Each name in `named` (the checks the
   * frozen criteria and generic criteria name) that has not reported is a
   * pending check. On GitLab the checks are the jobs of the pipeline attached
   * to the PR's current head, used only when its sha is `sha`.
   */
  checks(pullRequestNumber: number, sha: string, named: readonly string[]): Promise<CheckReport>;

  /** The checks that reported on the default branch's most recent commits, newest first. */
  recentDefaultBranchChecks(commits: number): Promise<CommitChecks[]>;
}

/**
 * Whether every check in the report has finished. With no named checks and no
 * checks at all, every check has finished (ADR-0015).
 */
export function allChecksFinished(report: CheckReport): boolean {
  return report.checks.every((check) => check.status !== "pending");
}

/** Whether every check in the report has passed. */
export function allChecksPassed(report: CheckReport): boolean {
  return report.checks.every((check) => check.status === "passed");
}

/** Whether everything the forge requires before merging has reported at the report's sha. */
export function requiredChecksReported(report: CheckReport): boolean {
  return report.required.every((required) => required.reported);
}

/**
 * The checks as one entry per name, sorted by name, with each name in `named`
 * that has not reported added as a pending check. Two results under one name,
 * such as a GitHub check run and a commit status, count as one check: failed
 * if either failed, else pending if either is pending, else passed.
 */
export function checksByName(reported: readonly Check[], named: readonly string[] = []): Check[] {
  const byName = new Map<string, Check>();
  for (const check of reported) {
    const seen = byName.get(check.name);
    byName.set(check.name, seen ? { ...seen, status: worse(seen.status, check.status), url: seen.url ?? check.url } : check);
  }
  for (const name of named) {
    if (!byName.has(name)) byName.set(name, { name, status: "pending", reported: false, url: null });
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const STATUS_RANK: Record<CheckStatus, number> = { passed: 0, pending: 1, failed: 2 };

function worse(a: CheckStatus, b: CheckStatus): CheckStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
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
