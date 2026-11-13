import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Git, GitError } from "./git.ts";
import type { OperationalLog } from "./operational-log.ts";

/** The forges a repo can live on. */
export type ForgeName = "github" | "gitlab";

/**
 * Which repo a mirror belongs to: forge, host and the forge's numeric
 * project id, so that a renamed or transferred repo keeps its mirror.
 */
export interface MirrorKey {
  forge: ForgeName;
  host: string;
  projectId: number;
}

/** Where the mirror fetches from, and how git authenticates there. */
export interface MirrorRemote {
  url: string;
  /**
   * The git credential helper, such as `!gh auth git-credential`, that is the
   * only one git uses; null for a remote that needs none.
   */
  credentialHelper: string | null;
}

/** The default branch's head on the remote. */
export interface DefaultBranchHead {
  branch: string;
  commit: string;
}

/** The forge's own CLI, through which git authenticates. */
const CLI: Record<ForgeName, string> = { github: "gh", gitlab: "glab" };

/**
 * The remote of a repo on its forge: HTTPS at the host, authenticated through
 * the owner's `gh` or `glab`, so that entail never holds a token.
 */
export function forgeRemote(forge: ForgeName, host: string, path: string): MirrorRemote {
  return { url: `https://${host}/${path}.git`, credentialHelper: `!${CLI[forge]} auth git-credential` };
}

/** The ref a forge keeps a PR's head at. */
export function pullRequestHeadRef(forge: ForgeName, number: number): string {
  if (!Number.isSafeInteger(number) || number <= 0) throw new RangeError(`not a PR number: ${number}`);
  return forge === "github" ? `refs/pull/${number}/head` : `refs/merge-requests/${number}/head`;
}

/** Where the mirror keeps a fetched PR head, the same on both forges. */
function localPullRequestRef(number: number): string {
  return `refs/entail/pull/${number}/head`;
}

const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

/** Where the git mirrors live inside the data directory. */
export const MIRRORS_DIRECTORY = "mirrors";
/** Where the read-only checkouts live inside the data directory. */
export const CHECKOUTS_DIRECTORY = "checkouts";

/** The directories of one repo's mirror and checkouts in the data directory. */
export function mirrorPaths(dataDirectory: string, key: MirrorKey): { mirror: string; checkouts: string } {
  if (!Number.isSafeInteger(key.projectId) || key.projectId <= 0) {
    throw new RangeError(`not a project id: ${key.projectId}`);
  }
  const host = encodeURIComponent(key.host.toLowerCase());
  if (host === "" || host === "." || host === "..") throw new RangeError(`not a host: ${key.host}`);
  const repo = [key.forge, host, String(key.projectId)];
  return {
    mirror: join(dataDirectory, MIRRORS_DIRECTORY, ...repo) + ".git",
    checkouts: join(dataDirectory, CHECKOUTS_DIRECTORY, ...repo),
  };
}

export interface MirrorOptions {
  dataDirectory: string;
  key: MirrorKey;
  remote: MirrorRemote;
  /** Where a checkout records the symlinks it left out. */
  log?: OperationalLog;
}

/** A read-only checkout of the repo at one commit, for model runs to read. */
export interface Checkout {
  directory: string;
  commit: string;
  /**
   * Paths of symlinks the commit holds that the checkout leaves out because
   * they point outside it. Empty when an existing checkout is reused.
   */
  dropped: string[];
}

/**
 * The local, fetch-only git mirror of one repo, kept in the data directory.
 * entail reads repository content from it: VISION.md and each PR's diff and
 * changed paths. It never pushes.
 *
 * Fetches are only of the default branch, and of a PR's head when one is
 * needed, so the mirror holds no other branch.
 */
export class Mirror {
  readonly key: MirrorKey;
  readonly remote: MirrorRemote;
  readonly directory: string;
  readonly checkoutsDirectory: string;
  readonly git: Git;
  readonly #log: OperationalLog | undefined;

  private constructor(options: MirrorOptions, paths: { mirror: string; checkouts: string }) {
    this.key = options.key;
    this.remote = options.remote;
    this.#log = options.log;
    this.directory = paths.mirror;
    this.checkoutsDirectory = paths.checkouts;
    // Only the forge CLI's helper authenticates, never one from the owner's
    // own git configuration, and the mirror never fetches tags. A checkout
    // holds each file's bytes as committed, whatever line endings the
    // machine's git would write (Git for Windows turns LF into CRLF). On
    // Windows a symlink is checked out as a file holding its target, since
    // making links there needs a privilege most users lack.
    const config = ["credential.helper=", "fetch.recurseSubmodules=false", "core.autocrlf=false", "core.eol=lf"];
    if (process.platform === "win32") config.push("core.symlinks=false");
    if (options.remote.credentialHelper !== null) config.push(`credential.helper=${options.remote.credentialHelper}`);
    this.git = new Git(paths.mirror, config);
  }

  /** Opens the repo's mirror, creating an empty one if it does not exist yet. */
  static async open(options: MirrorOptions): Promise<Mirror> {
    const paths = mirrorPaths(options.dataDirectory, options.key);
    const mirror = new Mirror(options, paths);
    if (!(await exists(join(paths.mirror, "HEAD")))) await mirror.#create();
    return mirror;
  }

  async #create(): Promise<void> {
    await mkdir(dirname(this.directory), { recursive: true, mode: 0o700 });
    // Created beside its final path and moved there, so a crash never leaves
    // a half-made mirror.
    const staging = `${this.directory}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await new Git(staging).run(["init", "--bare", "--quiet"]);
      await rename(staging, this.directory);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      if (!(await exists(join(this.directory, "HEAD")))) throw error;
    }
  }

  /** Asks the remote for its default branch and that branch's head, with `git ls-remote`. */
  async remoteDefaultBranch(): Promise<DefaultBranchHead> {
    const out = await this.git.text(["ls-remote", "--symref", "--end-of-options", this.remote.url, "HEAD"]);
    const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/mu.exec(out)?.[1];
    const commit = /^([0-9a-f]+)\tHEAD$/mu.exec(out)?.[1];
    if (branch === undefined || commit === undefined) {
      throw new GitError(["ls-remote", "--symref", this.remote.url, "HEAD"], 0, `the remote reports no default branch: ${out}`);
    }
    return { branch, commit };
  }

  /**
   * Brings the default branch up to date: checks its head with
   * `git ls-remote` and fetches only when the mirror does not have that
   * commit yet. `fetched` says whether it fetched.
   */
  async updateDefaultBranch(): Promise<DefaultBranchHead & { fetched: boolean }> {
    const head = await this.remoteDefaultBranch();
    const ref = `refs/heads/${head.branch}`;
    let fetched = false;
    if (!(await this.hasCommit(head.commit))) {
      await this.#fetch(`+${ref}:${ref}`);
      fetched = true;
    }
    // The branch may have moved again since ls-remote; the mirror records the
    // head that was checked, which it now holds either way.
    await this.git.run(["update-ref", "--no-deref", ref, head.commit]);
    await this.git.run(["symbolic-ref", "HEAD", ref]);
    return { ...head, fetched };
  }

  /**
   * Fetches a PR's head from `refs/pull/<n>/head` (GitHub) or
   * `refs/merge-requests/<iid>/head` (GitLab), unless the mirror already has
   * the head commit the forge reported. Returns the head commit.
   *
   * @param expectedHead the head the forge reports for the PR, if known.
   */
  async fetchPullRequestHead(number: number, expectedHead?: string): Promise<{ commit: string; fetched: boolean }> {
    const local = localPullRequestRef(number);
    if (expectedHead !== undefined && (await this.hasCommit(expectedHead))) {
      await this.git.run(["update-ref", "--no-deref", local, expectedHead]);
      return { commit: await this.resolve(expectedHead), fetched: false };
    }
    await this.#fetch(`+${pullRequestHeadRef(this.key.forge, number)}:${local}`);
    return { commit: await this.resolve(local), fetched: true };
  }

  async #fetch(refspec: string): Promise<void> {
    await this.git.run(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--end-of-options", this.remote.url, refspec]);
  }

  /** Whether the mirror holds a commit. */
  async hasCommit(commit: string): Promise<boolean> {
    const result = await this.git.run(["cat-file", "-e", "--end-of-options", `${commit}^{commit}`], { okExitCodes: [1, 128] });
    return result.exitCode === 0;
  }

  /** Resolves a revision the mirror holds to its full commit sha. */
  async resolve(revision: string): Promise<string> {
    return (await this.git.text(["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`])).trim();
  }

  /**
   * A PR's whole diff at a head: what the head changes since it left the base
   * branch, computed by git and never truncated. Renames show as a deletion
   * and an addition, so both paths count as changed.
   *
   * @param base the target branch's head, such as the default branch's.
   */
  async pullRequestDiff(base: string, head: string): Promise<string> {
    return this.git.text([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--binary",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--end-of-options",
      `${base}...${head}`,
    ]);
  }

  /** Every path a PR changes at a head, as git reports them, sorted. */
  async pullRequestChangedPaths(base: string, head: string): Promise<string[]> {
    const out = await this.git.text(["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", "--end-of-options", `${base}...${head}`]);
    return out
      .split("\0")
      .filter((path) => path !== "")
      .sort();
  }

  /** Every file path in the repo at a commit, as git reports them, sorted. */
  async pullRequestHeadPaths(head: string): Promise<string[]> {
    const out = await this.git.text(["ls-tree", "-r", "-z", "--name-only", "--end-of-options", head]);
    return out
      .split("\0")
      .filter((path) => path !== "")
      .sort();
  }

  /**
   * A read-only checkout of the repo at a commit, for a model run to read. It
   * is kept in the data directory and reused for the same commit; its files
   * and directories cannot be written until {@link removeCheckout}. Symlinks
   * pointing outside the checkout are left out and logged.
   */
  async checkout(commit: string): Promise<Checkout> {
    if (!FULL_SHA.test(commit)) throw new RangeError(`a checkout needs a full commit sha, not ${commit}`);
    const sha = await this.resolve(commit);
    const directory = join(this.checkoutsDirectory, sha);
    if ((await checkoutCommit(directory)) === sha) return { directory, commit: sha, dropped: [] };
    // A directory without its marker is what a crashed removal leaves behind.
    await removeTree(directory);

    await mkdir(this.checkoutsDirectory, { recursive: true, mode: 0o700 });
    const staging = `${directory}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const index = `${staging}.index`;
    let dropped: string[] = [];
    try {
      await mkdir(staging);
      const env = { GIT_INDEX_FILE: index };
      await this.git.run([`--work-tree=${staging}`, "read-tree", sha], { env });
      await this.git.run([`--work-tree=${staging}`, "checkout-index", "--all", "--force"], { env });
      dropped = await dropEscapingLinks(staging);
      await makeReadOnly(staging);
      // The marker goes in place before the checkout does, so a checkout
      // never appears without it.
      await writeFile(`${staging}.commit`, `${sha}\n`);
      await rename(`${staging}.commit`, commitMarker(directory));
      await rename(staging, directory);
    } catch (error) {
      await removeTree(staging);
      if (!(await exists(directory))) throw error;
    } finally {
      await rm(index, { force: true });
      await rm(`${staging}.commit`, { force: true });
    }
    if (dropped.length > 0) {
      this.#log?.warn("checkout.symlinks_dropped", { commit: sha, dropped });
    }
    return { directory, commit: sha, dropped };
  }

  /** Removes the read-only checkout at a commit, if there is one. */
  async removeCheckout(commit: string): Promise<void> {
    if (!FULL_SHA.test(commit)) throw new RangeError(`a checkout is named by a full commit sha, not ${commit}`);
    const directory = join(this.checkoutsDirectory, commit);
    // The marker goes first, so a partly removed checkout is never taken for a whole one.
    await rm(commitMarker(directory), { force: true });
    await removeTree(directory);
  }
}

/**
 * The marker the mirror keeps beside a read-only checkout, outside the tree
 * the model reads, recording the commit the checkout holds. A checkout is a
 * plain tree with no `.git`, so this is how it is known to be at a commit.
 */
function commitMarker(directory: string): string {
  return `${resolve(directory)}.commit`;
}

/**
 * The commit a whole read-only checkout made by {@link Mirror.checkout}
 * holds, or null if the directory is not one.
 */
export async function checkoutCommit(directory: string): Promise<string | null> {
  try {
    if (!(await stat(directory)).isDirectory()) return null;
    const commit = (await readFile(commitMarker(directory), "utf8")).trim();
    return FULL_SHA.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes every symlink whose target lies outside the tree, whether written
 * as an absolute path, with `..`, or reached through another link, and returns
 * their paths relative to the tree, sorted.
 */
async function dropEscapingLinks(root: string): Promise<string[]> {
  const links: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isSymbolicLink()) links.push(path);
    }
  };
  await walk(root);

  const inside = (path: string): boolean => {
    const from = relative(root, path);
    return from === "" || (from !== ".." && !from.startsWith(`..${sep}`) && !isAbsolute(from));
  };
  const dropped: string[] = [];
  const drop = async (link: string): Promise<void> => {
    await rm(link, { force: true });
    dropped.push(relative(root, link).split(sep).join("/"));
  };

  const remaining: string[] = [];
  for (const link of links) {
    if (inside(resolve(dirname(link), await readlink(link)))) remaining.push(link);
    else await drop(link);
  }
  const realRoot = await realpath(root);
  for (const link of remaining) {
    const real = await realpath(link).catch(() => null);
    if (real !== null && relative(realRoot, real).split(sep)[0] === "..") await drop(link);
  }
  return dropped.sort();
}

/** Takes write permission off every file and directory, never following a link. */
async function makeReadOnly(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await makeReadOnly(path);
    else if (entry.isFile()) await chmod(path, (await lstat(path)).mode & 0o555);
  }
  await chmod(directory, 0o555);
}

/** Removes a tree made read-only by {@link makeReadOnly}. */
async function removeTree(directory: string): Promise<void> {
  if (!(await exists(directory))) return;
  const restore = async (path: string): Promise<void> => {
    await chmod(path, 0o700);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await restore(join(path, entry.name));
    }
  };
  await restore(directory);
  await rm(directory, { recursive: true, force: true });
}
