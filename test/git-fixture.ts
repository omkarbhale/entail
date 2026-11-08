// Real local git repositories for tests: a working repo that commits, and a
// bare repo that stands in for the forge's remote.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";

/** git's environment for fixtures: a fixed identity and none of the user's config. */
function fixtureEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("GIT_")) env[name] = value;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.com",
  };
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: fixtureEnv(), encoding: "utf8", maxBuffer: 1 << 30 }).trim();
}

export function tempDirectory(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `entail-${prefix}-`));
  t.after(() => {
    // Read-only checkouts left behind need write permission back to be removed.
    execFileSync("chmod", ["-R", "u+w", dir]);
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** A working repository with a bare remote it pushes to. */
export class FixtureRepo {
  readonly work: string;
  readonly remote: string;

  constructor(t: TestContext, branch = "main") {
    const root = tempDirectory(t, "repo");
    this.work = join(root, "work");
    this.remote = join(root, "remote.git");
    mkdirSync(this.work);
    git(root, "init", "--quiet", "--bare", `--initial-branch=${branch}`, this.remote);
    git(this.work, "init", "--quiet", `--initial-branch=${branch}`);
    git(this.work, "remote", "add", "origin", this.remote);
  }

  write(path: string, content: string): this {
    const full = join(this.work, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    return this;
  }

  remove(path: string): this {
    git(this.work, "rm", "--quiet", "-r", "--", path);
    return this;
  }

  /** Commits everything staged or changed and returns the new commit's sha. */
  commit(message: string): string {
    git(this.work, "add", "--all");
    git(this.work, "commit", "--quiet", "--allow-empty", "-m", message);
    return this.head();
  }

  head(): string {
    return git(this.work, "rev-parse", "HEAD");
  }

  /** Pushes the current branch to the remote's branch of the same name. */
  push(branch = "main"): this {
    git(this.work, "push", "--quiet", "--force", "origin", `HEAD:refs/heads/${branch}`);
    return this;
  }

  /** Puts a commit at a ref on the remote, such as a PR head ref. */
  pushRef(commit: string, ref: string): this {
    git(this.work, "push", "--quiet", "--force", "origin", `${commit}:${ref}`);
    return this;
  }

  checkout(...args: string[]): this {
    git(this.work, "checkout", "--quiet", ...args);
    return this;
  }
}
