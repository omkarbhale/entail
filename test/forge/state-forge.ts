import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  assertEntailLabel,
  type Actor,
  type ChangeBatch,
  type CloseReason,
  type Forge,
  type ForgeComment,
  type ForgeInstance,
  type ForgeSetting,
  type ForgeTarget,
  type ForgeWording,
  MergePendingError,
  type MergeOutcome,
  type PostedComment,
  type Project,
  type PullRequestState,
} from "../../src/forge/forge.ts";

/** A forge's state as the writes change it, kept as JSON so it outlives a killed process. */
export interface ForgeState {
  nextId: number;
  /** Comments by `issue:<n>` or `pr:<n>`. */
  comments: Record<string, { id: number; body: string; authorId: number; createdAt: string }[]>;
  /** Labels each issue carries. */
  labels: Record<string, string[]>;
  /** Labels created in the repo. */
  repoLabels: string[];
  /** Each closed issue's close reason. */
  closed: Record<string, CloseReason>;
  prs: Record<string, PullRequestState>;
  /** How many times each write reached the forge. */
  sends: { comment: number; addLabel: number; removeLabel: number; close: number; merge: number };
}

export type WriteName = keyof ForgeState["sends"];

export interface StateForgeOptions {
  /** Where the state is kept; in memory only when absent. */
  file?: string;
  /** The account the CLI is logged in as, which every comment is posted by. */
  actorId?: number;
  /** Called before a write reaches the forge; throwing stops it there. */
  beforeWrite?: (write: WriteName) => void;
  /** Makes a merge throw {@link MergePendingError} after it was sent, as a merge still running when the wait ended. */
  mergePending?: boolean;
  /** Called after a write was applied and saved; throwing (or exiting) loses the answer. */
  afterWrite?: (write: WriteName) => void;
}

/**
 * A {@link Forge} that keeps a forge's state for entail's four writes, for
 * tests above the adapters: the forge writer, its intents and settling on
 * start. Reads other than the ones settling uses are not supported.
 */
export class StateForge implements Forge {
  readonly setting: ForgeSetting = { forge: "github", host: "github.com", path: "acme/tally" };
  readonly wording: ForgeWording = { pullRequest: "pull request" };
  readonly #options: StateForgeOptions;
  #memory: ForgeState;

  constructor(options: StateForgeOptions = {}, initial: Partial<ForgeState> = {}) {
    this.#options = options;
    this.#memory = {
      nextId: 8001,
      comments: {},
      labels: {},
      repoLabels: [],
      closed: {},
      prs: {},
      sends: { comment: 0, addLabel: 0, removeLabel: 0, close: 0, merge: 0 },
      ...initial,
    };
    if (options.file && !existsSync(options.file)) this.#save(this.#memory);
  }

  get state(): ForgeState {
    return this.#options.file ? (JSON.parse(readFileSync(this.#options.file, "utf8")) as ForgeState) : this.#memory;
  }

  async postComment(target: ForgeTarget, number: number, body: string): Promise<PostedComment> {
    return this.#write("comment", (state) => {
      const id = state.nextId++;
      const key = `${target}:${number}`;
      (state.comments[key] ??= []).push({ id, body, authorId: this.#actorId, createdAt: new Date(0).toISOString() });
      return { id, url: commentUrl(target, number, id) };
    });
  }

  async addLabel(issueNumber: number, label: string): Promise<void> {
    assertEntailLabel(label);
    this.#write("addLabel", (state) => {
      if (!state.repoLabels.includes(label)) state.repoLabels.push(label);
      const labels = (state.labels[issueNumber] ??= []);
      if (!labels.includes(label)) labels.push(label);
    });
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    assertEntailLabel(label);
    this.#write("removeLabel", (state) => {
      state.labels[issueNumber] = (state.labels[issueNumber] ?? []).filter((l) => l !== label);
    });
  }

  async closeIssue(issueNumber: number, reason: CloseReason): Promise<void> {
    this.#write("close", (state) => {
      state.closed[issueNumber] ??= reason;
    });
  }

  async merge(prNumber: number, sha: string): Promise<MergeOutcome> {
    return this.#write("merge", (state) => {
      const pr = state.prs[prNumber];
      if (!pr) return { merged: false, refusal: "no such pull request" };
      if (pr.state === "merged") return { merged: true, mergeCommitSha: pr.mergeCommitSha };
      if (pr.state !== "open") return { merged: false, refusal: "the pull request is closed" };
      if (pr.headSha !== sha) return { merged: false, refusal: "the head moved" };
      if (this.#options.mergePending) throw new MergePendingError(this.setting.host, prNumber, 0);
      const mergeCommitSha = `merge-of-${sha}`;
      state.prs[prNumber] = { ...pr, state: "merged", mergeCommitSha };
      return { merged: true, mergeCommitSha };
    });
  }

  async comments(target: ForgeTarget, number: number): Promise<ForgeComment[]> {
    return (this.state.comments[`${target}:${number}`] ?? []).map((c) => ({
      id: c.id,
      body: c.body,
      author: this.#actor(c.authorId),
      createdAt: c.createdAt,
      url: commentUrl(target, number, c.id),
    }));
  }

  async pullRequestState(prNumber: number): Promise<PullRequestState> {
    const pr = this.state.prs[prNumber];
    if (!pr) throw new Error(`no PR #${prNumber}`);
    return pr;
  }

  async currentActor(): Promise<Actor | null> {
    return this.#actor(this.#actorId);
  }
  async project(): Promise<Project> {
    throw new Error("not supported");
  }
  async instance(): Promise<ForgeInstance> {
    throw new Error("not supported");
  }
  async changesSince(): Promise<ChangeBatch> {
    throw new Error("not supported");
  }

  get #actorId(): number {
    return this.#options.actorId ?? 1001;
  }

  #actor(id: number): Actor {
    return { forge: "github", host: "github.com", id, username: id === this.#actorId ? "owner" : `user${id}` };
  }

  #write<T>(name: WriteName, apply: (state: ForgeState) => T): T {
    this.#options.beforeWrite?.(name);
    const state = this.state;
    state.sends[name]++;
    const result = apply(state);
    this.#save(state);
    this.#options.afterWrite?.(name);
    return result;
  }

  #save(state: ForgeState): void {
    if (this.#options.file) writeFileSync(this.#options.file, JSON.stringify(state));
    else this.#memory = state;
  }
}

function commentUrl(target: ForgeTarget, number: number, id: number): string {
  return `https://github.com/acme/tally/${target === "issue" ? "issues" : "pull"}/${number}#issuecomment-${id}`;
}
