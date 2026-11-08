// A store with enrolled repos and a forge stand-in for tests of the pass.
import type { TestContext } from "node:test";
import type { Actor, ChangeBatch, ForgeComment, ForgeSetting, Issue } from "../src/forge/forge.ts";
import { OperationalLog } from "../src/operational-log.ts";
import type { DefaultBranchSource } from "../src/pass.ts";
import { enrollmentSettings } from "../src/repo-settings.ts";
import { Store, type RepoRecord } from "../src/store.ts";
import { StateForge } from "./forge/state-forge.ts";
import { tempDirectory } from "./git-fixture.ts";

/** When the fixture's repos are enrolled. */
export const ENROLLED_AT = "2026-11-08T12:00:00.000Z";
export const OWNER_ID = 1001;

export function actor(id: number, username = id === OWNER_ID ? "owner" : `user${id}`, host = "github.com"): Actor {
  return { forge: "github", host, id, username };
}

export function issue(number: number, fields: Partial<Issue> = {}): Issue {
  return {
    id: 9000 + number,
    number,
    title: `Issue ${number}`,
    body: `The body of issue ${number}.`,
    state: "open",
    author: actor(OWNER_ID),
    labels: [],
    createdAt: "2026-11-08T12:30:00.000Z",
    updatedAt: "2026-11-08T12:30:00.000Z",
    url: `https://github.com/acme/tally/issues/${number}`,
    ...fields,
  };
}

export function comment(id: number, issueNumber: number, author: Actor, body: string): ForgeComment {
  return { id, body, author, createdAt: "2026-11-08T12:31:00.000Z", url: `https://github.com/acme/tally/issues/${issueNumber}#issuecomment-${id}` };
}

/**
 * A forge that reports its issues as changes. It keeps no cursor of its own:
 * every read reports every issue again, so only the core's deduplication and
 * the store keep an issue from being taken in twice.
 */
export class IntakeForge extends StateForge {
  override readonly setting: ForgeSetting;
  issues: Issue[] = [];
  readonly issueComments = new Map<number, ForgeComment[]>();
  readonly transferred = new Set<number>();
  /** Thrown by the next read of changes, then cleared. */
  failChanges: Error | null = null;
  /** Thrown when an issue's comments are read. */
  failComments = new Map<number, Error>();
  readonly reads = { changes: 0, transferred: 0, comments: 0 };

  constructor(host = "github.com", path = "acme/tally") {
    super();
    this.setting = { forge: "github", host, path };
  }

  override async changesSince(): Promise<ChangeBatch> {
    this.reads.changes++;
    const failure = this.failChanges;
    if (failure) {
      this.failChanges = null;
      throw failure;
    }
    return {
      changes: this.issues.map((i) => ({ kind: "issue", id: i.id, updatedAt: i.updatedAt, issue: i })),
      cursor: `read ${this.reads.changes}`,
    };
  }

  override async transferredIn(issueNumber: number): Promise<boolean> {
    this.reads.transferred++;
    return this.transferred.has(issueNumber);
  }

  override async comments(_target: "issue" | "pr", number: number): Promise<ForgeComment[]> {
    this.reads.comments++;
    const failure = this.failComments.get(number);
    if (failure) throw failure;
    return this.issueComments.get(number) ?? [];
  }
}

/** A default branch whose head never moves. */
export const STILL_HEAD: DefaultBranchSource = {
  updateDefaultBranch: async () => ({ branch: "main", commit: "c0ffee", fetched: false }),
};

export interface PassSetup {
  store: Store;
  dataDirectory: string;
  log: OperationalLog;
  /** The operational log's lines, parsed. */
  logLines(): Record<string, unknown>[];
  /** Enrolls a repo, recorded as enrolled at {@link ENROLLED_AT}, with `openIssueNumbers` open then. */
  enroll(options?: { projectId?: number; host?: string; path?: string; openIssueNumbers?: number[] }): RepoRecord;
}

export function passSetup(t: TestContext): PassSetup {
  const dataDirectory = tempDirectory(t, "pass");
  // The store's clock reads the time now, except while a repo is enrolled.
  let held: Date | null = null;
  const store = Store.openIn(dataDirectory, { now: () => held ?? new Date() });
  t.after(() => store.close());
  store.saveGlobalSettings({ ownerDisplayName: "Ada" }, "Ada");
  const lines: string[] = [];
  const log = new OperationalLog(dataDirectory, { echo: (line) => lines.push(line) });
  return {
    store,
    dataDirectory,
    log,
    logLines: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    enroll(options = {}) {
      held = new Date(ENROLLED_AT);
      try {
        return store.enroll({
          repo: {
            forge: "github",
            host: options.host ?? "github.com",
            projectId: options.projectId ?? 5001,
            path: options.path ?? "acme/tally",
            ownerAccountId: OWNER_ID,
            ownerLogin: "owner",
          },
          settings: enrollmentSettings("owner-stated", "squash"),
          savedBy: "Ada",
          visionSha: "c0ffee",
          visionLines: ["Tally counts words in text."],
          visionOrigin: "owner-stated",
          openIssueNumbers: options.openIssueNumbers ?? [],
        }).repo;
      } finally {
        held = null;
      }
    },
  };
}
