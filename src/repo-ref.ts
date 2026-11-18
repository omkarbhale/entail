import type { ForgeKind, ForgeSetting } from "./forge/forge.ts";

/**
 * How entail names a repo, and the forge setting the name stands for. A
 * GitHub repo is `owner/name`, on github.com, as it always was, so the logs
 * and settings kept for it read unchanged. A GitLab project is
 * `gitlab:namespace/name` on gitlab.com, with any depth of subgroups in the
 * namespace, such as `gitlab:acme/tools/tally`. The prefix keeps the two
 * apart: `:` never appears in a GitHub name.
 *
 * Everything above the forge layer reaches a forge through
 * {@link repoSetting} and the forge factory, and links to a repo's pages
 * through the URL helpers here, so nothing else tells the forges apart.
 */

/** What starts the name of a GitLab project. */
export const GITLAB_PREFIX = "gitlab:";

const HOSTS: Record<ForgeKind, string> = { github: "github.com", gitlab: "gitlab.com" };
const TITLES: Record<ForgeKind, string> = { github: "GitHub", gitlab: "GitLab" };
const CLIS: Record<ForgeKind, "gh" | "glab"> = { github: "gh", gitlab: "glab" };

/** One segment of a repo path: letters, digits, `_`, `.` and `-`, and never `.` or `..` alone. */
const PART = /^(?!\.{1,2}$)[\w.-]+$/u;
/** GitLab nests subgroups at most 20 deep, so a project path has at most 21 segments. */
const GITLAB_MAX_SEGMENTS = 21;

/**
 * The forge setting a repo name stands for.
 *
 * @throws {RangeError} when `repo` is not a repo name.
 */
export function repoSetting(repo: string): ForgeSetting {
  if (repo.startsWith(GITLAB_PREFIX)) {
    const path = repo.slice(GITLAB_PREFIX.length);
    const parts = path.split("/");
    if (parts.length < 2 || parts.length > GITLAB_MAX_SEGMENTS || !parts.every((part) => PART.test(part))) {
      throw new RangeError(`not a repo: ${repo} (expected gitlab:group/name)`);
    }
    return { forge: "gitlab", host: HOSTS.gitlab, path };
  }
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts.every((part) => PART.test(part))) throw new RangeError(`not a repo: ${repo} (expected owner/name, or gitlab:group/name)`);
  return { forge: "github", host: HOSTS.github, path: repo };
}

/** Whether `text` is a repo name, `owner/name` or `gitlab:group/name`. */
export function isRepo(text: string): boolean {
  try {
    repoSetting(text);
    return true;
  } catch {
    return false;
  }
}

/** The repo name for a forge setting: the inverse of {@link repoSetting} for the hosts entail names. */
export function repoOf(setting: Pick<ForgeSetting, "forge" | "path">): string {
  return setting.forge === "gitlab" ? `${GITLAB_PREFIX}${setting.path}` : setting.path;
}

/**
 * A repo as the owner typed it, in the form its log is kept under, or null
 * when it names none: trimmed, lower-cased, and with a github.com or
 * gitlab.com web address (and anything after a GitLab project's `/-/`), a
 * trailing `.git` or a trailing slash taken off.
 */
export function canonicalRepo(text: string): string | null {
  let repo = text.trim();
  const web = /^https:\/\/(github\.com|gitlab\.com)\/(.+)$/iu.exec(repo);
  // A GitLab page inside a project, such as its issues, sits after `/-/`.
  if (web !== null) repo = web[1]!.toLowerCase() === "gitlab.com" ? `${GITLAB_PREFIX}${web[2]!.replace(/\/-(?:\/.*)?$/u, "")}` : web[2]!;
  repo = repo.replace(/\/$/u, "").replace(/\.git$/u, "").toLowerCase();
  return isRepo(repo) ? repo : null;
}

/** The host entail names a forge's repos on: github.com or gitlab.com. */
export function forgeHost(forge: ForgeKind): string {
  return HOSTS[forge];
}

/** The forge a repo lives on. */
export function forgeOf(repo: string): ForgeKind {
  return repo.startsWith(GITLAB_PREFIX) ? "gitlab" : "github";
}

/** The forge's name as people say it: GitHub or GitLab. */
export function forgeTitle(repo: string): string {
  return TITLES[forgeOf(repo)];
}

/** The owner's CLI for the repo's forge: `gh` or `glab`. */
export function forgeCli(repo: string): "gh" | "glab" {
  return CLIS[forgeOf(repo)];
}

/** The repo's web page. A name that is not a repo's, such as one from a hand-edited case, is taken as a path on github.com. */
export function repoUrl(repo: string): string {
  if (!isRepo(repo)) return `https://${HOSTS.github}/${repo}`;
  const { host, path } = repoSetting(repo);
  return `https://${host}/${path}`;
}

/** An issue's web page. GitLab keeps a project's own pages under `/-/`. */
export function issueUrl(repo: string, issue: number): string {
  return `${repoUrl(repo)}${forgeOf(repo) === "gitlab" ? "/-" : ""}/issues/${issue}`;
}

/** A file's web page at a commit. */
export function blobUrl(repo: string, commit: string, file: string): string {
  return `${repoUrl(repo)}${forgeOf(repo) === "gitlab" ? "/-" : ""}/blob/${commit}/${file}`;
}
