import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { ChangeDeduplicator } from "../src/changes.ts";
import { CursorStore } from "../src/cursors.ts";
import type { Actor, Change, ForgeComment, Issue, IssueComment, PostedComment, Project } from "../src/forge/forge.ts";
import type { Verdict } from "../src/judgment.ts";
import { JUDGMENT_KIND } from "../src/judgment.ts";
import { appendEntry, type GlobalSettings } from "../src/records.ts";
import { ScriptedRunner } from "../src/scripted-runner.ts";
import { runPass, type PassOptions, type PassReport, type WatchForge } from "../src/watch.ts";

export const REPO = "acme/tally";
export const OWNER = "Omkar";
export const VISION = "# Vision\n\ntally counts words offline.\nNew features are opt-in.\n";
export const SHA = "a".repeat(40);
export const ENROLLED_AT = "2026-11-12T09:00:00.000Z";

const person = (id: number, username: string): Actor => ({ forge: "github", host: "github.com", id, username });
export const REPORTER = person(2002, "reporter");
export const OWNER_ACCOUNT = person(1001, "omkarbhale");

/**
 * A forge in memory that reports changes the way GitHub does: everything
 * after the cursor, an issue again whenever it is updated (a comment on it
 * included), and entail's own comments among them.
 */
export class FakeForge implements WatchForge {
  readonly setting = { forge: "github", host: "github.com", path: REPO } as const;
  readonly issues = new Map<number, Issue>();
  readonly commentsOn = new Map<number, ForgeComment[]>();
  readonly posted: { issue: number; body: string; id: number }[] = [];
  readonly closed: number[] = [];
  readonly reopened: number[] = [];
  readonly #changes: Change[] = [];
  #clock = Date.parse("2026-11-12T10:00:00Z");
  #nextId = 7000;
  /** Set to make every read fail, as a forge outage would. */
  down = false;

  tick(): string {
    this.#clock += 60_000;
    return new Date(this.#clock).toISOString();
  }

  /** Files an issue; `createdAt` before the enrollment makes it an old issue. */
  file(number: number, title: string, body = "", options: { createdAt?: string; author?: Actor } = {}): Issue {
    const at = this.tick();
    const issue: Issue = {
      id: 9000 + number,
      number,
      title,
      body,
      state: "open",
      author: options.author ?? REPORTER,
      labels: [],
      createdAt: options.createdAt ?? at,
      updatedAt: at,
      url: `https://github.com/${REPO}/issues/${number}`,
    };
    this.issues.set(number, issue);
    this.#changes.push({ kind: "issue", id: issue.id, updatedAt: at, issue: { ...issue } });
    return issue;
  }

  edit(number: number, change: { title?: string; body?: string; state?: "open" | "closed" }): void {
    const issue = this.issues.get(number)!;
    Object.assign(issue, change, { updatedAt: this.tick() });
    this.#changes.push({ kind: "issue", id: issue.id, updatedAt: issue.updatedAt, issue: { ...issue } });
  }

  comment(number: number, body: string, author: Actor = REPORTER): IssueComment {
    const at = this.tick();
    const id = this.#nextId++;
    const comment: IssueComment = { id, issueNumber: number, body, author, createdAt: at, updatedAt: at, url: `https://github.com/${REPO}/issues/${number}#issuecomment-${id}` };
    this.commentsOn.set(number, [...(this.commentsOn.get(number) ?? []), { id, body, author, createdAt: at, url: comment.url }]);
    this.#changes.push({ kind: "issue-comment", id, updatedAt: at, comment });
    const issue = this.issues.get(number);
    if (issue) {
      issue.updatedAt = at;
      this.#changes.push({ kind: "issue", id: issue.id, updatedAt: at, issue: { ...issue } });
    }
    return comment;
  }

  async project(): Promise<Project> {
    this.#check();
    return { forge: "github", host: "github.com", id: 77, path: REPO, defaultBranch: "main" };
  }

  async changesSince(cursor: string | null) {
    this.#check();
    const from = cursor === null ? 0 : Number(cursor);
    return { changes: this.#changes.slice(from), cursor: String(this.#changes.length) };
  }

  async issue(number: number): Promise<Issue | null> {
    this.#check();
    const issue = this.issues.get(number);
    return issue === undefined ? null : { ...issue };
  }

  async comments(_target: "issue" | "pr", number: number): Promise<ForgeComment[]> {
    this.#check();
    return [...(this.commentsOn.get(number) ?? [])];
  }

  async postComment(_target: "issue" | "pr", number: number, body: string): Promise<PostedComment> {
    this.#check();
    const comment = this.comment(number, body, OWNER_ACCOUNT);
    this.posted.push({ issue: number, body, id: comment.id });
    return { id: comment.id, url: comment.url };
  }

  async closeIssue(number: number): Promise<void> {
    this.#check();
    this.closed.push(number);
    this.edit(number, { state: "closed" });
  }

  async reopenIssue(number: number): Promise<void> {
    this.#check();
    this.reopened.push(number);
    this.edit(number, { state: "open" });
  }

  #check(): void {
    if (this.down) throw new Error("the forge is down");
  }
}

export function verdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    call: "go",
    reason: "Counting words in more places makes tally more useful.",
    rests_on: { vision_lines: [], cases: [] },
    large: false,
    large_because: "",
    criteria: [],
    question: null,
    ...overrides,
  };
}

export interface Harness {
  dataDirectory: string;
  forge: FakeForge;
  runner: ScriptedRunner;
  printed: string[];
  /** Scripts the next judgment on an issue. */
  script(issue: number, ...verdicts: (Verdict | "fail")[]): void;
  pass(overrides?: Partial<PassOptions>): Promise<PassReport>;
  options(overrides?: Partial<PassOptions>): PassOptions;
}

export function harness(t: TestContext, options: { confirm?: boolean; settings?: Partial<GlobalSettings> } = {}): Harness {
  const dataDirectory = mkdtempSync(join(tmpdir(), "entail-watch-"));
  t.after(() => rmSync(dataDirectory, { recursive: true, force: true }));
  appendEntry(dataDirectory, REPO, { type: "enrolled", by: OWNER, since: ENROLLED_AT, confirm: options.confirm ?? true }, new Date(ENROLLED_AT));
  const forge = new FakeForge();
  const runner = new ScriptedRunner();
  const printed: string[] = [];
  const cursors = new CursorStore(dataDirectory);
  const seen = new Map<string, ChangeDeduplicator>();
  const settings: GlobalSettings = { owner: OWNER, model: "claude-opus-5-5", effort: "low", ...options.settings };
  const build = (overrides: Partial<PassOptions> = {}): PassOptions => ({
    dataDirectory,
    owner: OWNER,
    settings,
    forgeFor: () => forge,
    reader: async () => ({ checkout: "/checkout", sha: SHA, vision: { text: VISION, commit: SHA }, pins: [] }),
    runner,
    cursors,
    seen,
    book: async () => [],
    log: null,
    dryRun: false,
    print: (text) => printed.push(text),
    ...overrides,
  });
  return {
    dataDirectory,
    forge,
    runner,
    printed,
    script(issue, ...verdicts) {
      runner.script(
        JUDGMENT_KIND,
        `${REPO}#${issue}`,
        ...verdicts.map((v) => (v === "fail" ? { failure: { kind: "error" as const, message: "the run broke" } } : { output: v, facts: { estimatedCostUsd: 0.05 } })),
      );
    },
    pass: (overrides) => runPass(build(overrides)),
    options: build,
  };
}
