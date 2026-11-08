// A forge stand-in for enrollment tests, and a repo with a VISION.md on a
// local bare remote that the mirror fetches from.
import type { TestContext } from "node:test";
import { Enroller } from "../src/enrollment.ts";
import type {
  Actor,
  ChangeBatch,
  Forge,
  ForgeInstance,
  ForgeSetting,
  MergeMethod,
  Project,
  RepoAccess,
} from "../src/forge/forge.ts";
import { Store } from "../src/store.ts";
import { StateForge } from "./forge/state-forge.ts";
import { FixtureRepo, tempDirectory } from "./git-fixture.ts";

/** What the fake forge answers; a value that is an Error is thrown instead. */
export interface FakeForgeWorld {
  actor: Actor | null | Error;
  projectId: number;
  project?: Error;
  instance: ForgeInstance;
  access: RepoAccess | Error;
  mergeMethods: MergeMethod[] | null;
  openIssues: number[] | Error;
}

export function worldFor(forge: "github" | "gitlab", host: string): FakeForgeWorld {
  return {
    actor: { forge, host, id: 1001, username: "owner" },
    projectId: 5001,
    instance: { version: forge === "gitlab" ? "17.5.0" : null, unsupported: null },
    access: { cannotLabelAndComment: null, mayLackMerge: null },
    mergeMethods: forge === "github" ? ["squash", "merge", "rebase"] : null,
    openIssues: [3, 1],
  };
}

export class FakeForge extends StateForge {
  override readonly setting: ForgeSetting;
  readonly #world: FakeForgeWorld;

  constructor(setting: ForgeSetting, world: FakeForgeWorld) {
    super();
    this.setting = setting;
    this.#world = world;
  }

  override async currentActor(): Promise<Actor | null> {
    return answer(this.#world.actor);
  }

  override async project(): Promise<Project> {
    if (this.#world.project) throw this.#world.project;
    const { forge, host, path } = this.setting;
    return { forge, host, path, id: this.#world.projectId, defaultBranch: "main" };
  }

  override async instance(): Promise<ForgeInstance> {
    return this.#world.instance;
  }

  override async access(): Promise<RepoAccess> {
    return answer(this.#world.access);
  }

  override async mergeMethods(): Promise<MergeMethod[] | null> {
    return this.#world.mergeMethods;
  }

  override async openIssueNumbers(): Promise<number[]> {
    return answer(this.#world.openIssues);
  }

  override async changesSince(): Promise<ChangeBatch> {
    throw new Error("enrollment reads no changes");
  }
}

function answer<T>(value: T | Error): T {
  if (value instanceof Error) throw value;
  return value;
}

export const VISION = "# Tally\n\nTally counts words in text.\nTally   reads standard input.\n";

export interface EnrollmentSetup {
  store: Store;
  dataDirectory: string;
  repo: FixtureRepo;
  world: FakeForgeWorld;
  enroller: Enroller;
  /** The settings each forge adapter was created for. */
  created: ForgeSetting[];
}

/**
 * An enroller over a fresh store, a fake forge answering `world`, and a repo
 * whose default branch holds `vision` (none when null).
 */
export function enrollmentSetup(
  t: TestContext,
  options: { forge?: "github" | "gitlab"; host?: string; vision?: string | null; displayName?: string | null } = {},
): EnrollmentSetup {
  const forge = options.forge ?? "github";
  const host = options.host ?? (forge === "github" ? "github.com" : "gitlab.example.org");
  const dataDirectory = tempDirectory(t, "data");
  let tick = 0;
  const store = Store.openIn(dataDirectory, { now: () => new Date(Date.UTC(2026, 10, 8, 12, 0, tick++)) });
  t.after(() => store.close());
  const displayName = options.displayName === undefined ? "Ada" : options.displayName;
  if (displayName !== null) store.saveGlobalSettings({ ownerDisplayName: displayName }, displayName);

  const repo = new FixtureRepo(t);
  const vision = options.vision === undefined ? VISION : options.vision;
  if (vision !== null) repo.write("VISION.md", vision);
  repo.write("README.md", "tally\n").commit("start");
  repo.push();

  const world = worldFor(forge, host);
  const created: ForgeSetting[] = [];
  const enroller = new Enroller({
    store,
    dataDirectory,
    createForge: (setting) => {
      created.push(setting);
      return new FakeForge(setting, world);
    },
    remoteFor: () => ({ url: repo.remote, credentialHelper: null }),
  });
  return { store, dataDirectory, repo, world, enroller, created };
}
