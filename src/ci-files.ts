import { existsSync } from "node:fs";
import { join } from "node:path";
import { Git } from "./git.ts";
import { mirrorPaths } from "./mirror.ts";
import type { RepoRecord } from "./store.ts";

/**
 * Where a repo's CI is configured: GitHub Actions workflows and GitLab CI
 * files. When these change after the generic criteria were confirmed, the
 * repo's settings page shows a passive hint, and nothing else (ADR-0018).
 */
export const CI_FILE_PATHS: readonly string[] = [".github/workflows", ".gitlab-ci.yml", ".gitlab/ci"];

/** The repo's mirror, or null when it has not been set up or has nothing fetched. */
function mirrorGit(dataDirectory: string, repo: RepoRecord): Git | null {
  const { mirror } = mirrorPaths(dataDirectory, { forge: repo.forge, host: repo.host, projectId: repo.projectId });
  return existsSync(join(mirror, "HEAD")) ? new Git(mirror) : null;
}

/** The commit the mirror holds as the default branch's head, or null when it holds none. */
export async function mirrorDefaultBranchHead(dataDirectory: string, repo: RepoRecord): Promise<string | null> {
  const git = mirrorGit(dataDirectory, repo);
  if (git === null) return null;
  const result = await git.run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { okExitCodes: [1, 128] });
  return result.exitCode === 0 ? result.stdout.toString("utf8").trim() : null;
}

/** The CI files as of the default-branch commit the generic criteria were confirmed against, and as of the mirror's head now. */
export interface CiFilesComparison {
  confirmedAt: string;
  head: string;
  /** The CI files added, removed or changed between the two, by path. */
  changed: string[];
}

/**
 * Compares the repo's CI files at `confirmedAt` with those at the mirror's
 * default-branch head. Null when there is nothing to compare: no mirror, or a
 * commit the mirror does not hold. A failure to read is no hint, never an error.
 */
export async function compareCiFiles(dataDirectory: string, repo: RepoRecord, confirmedAt: string): Promise<CiFilesComparison | null> {
  const git = mirrorGit(dataDirectory, repo);
  if (git === null || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(confirmedAt)) return null;
  try {
    const head = await mirrorDefaultBranchHead(dataDirectory, repo);
    if (head === null) return null;
    const known = await git.run(["cat-file", "-e", "--end-of-options", `${confirmedAt}^{commit}`], { okExitCodes: [1, 128] });
    if (known.exitCode !== 0) return null;
    if (head === confirmedAt) return { confirmedAt, head, changed: [] };
    const out = await git.text(["diff", "--name-only", "--no-renames", "-z", confirmedAt, head, "--", ...CI_FILE_PATHS]);
    return { confirmedAt, head, changed: out.split("\0").filter((path) => path !== "") };
  } catch {
    return null;
  }
}
