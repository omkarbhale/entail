import type { ForgeKind, ForgeSetting } from "./forge/forge.ts";

/**
 * How entail names a repo, and the forge setting the name stands for. A
 * GitHub repo is `owner/name`, on github.com, as it always was, so the logs
 * and settings kept for it read unchanged. A GitLab project is
 * `gitlab:namespace/name` on gitlab.com, with any depth of subgroups in the
 * namespace, such as `gitlab:acme/tools/tally`. A project on a self-hosted
 * GitLab is `gitlab://host/namespace/name`, such as
 * `gitlab://git.example.com/acme/tally`: the `//` after the prefix names the
 * host, and can never start a gitlab.com name, whose path segments are never
 * empty. The prefix keeps the forges apart: `:` never appears in a GitHub
 * name.
 *
 * Everything above the forge layer reaches a forge through
 * {@link repoSetting} and the forge factory, and links to a repo's pages
 * through the URL helpers here, so nothing else tells the forges apart.
 */

/** What starts the name of a GitLab project. */
export const GITLAB_PREFIX = "gitlab:";
/** What starts the name of a project on a self-hosted GitLab, before its host. */
export const SELF_HOSTED_PREFIX = "gitlab://";

const HOSTS: Record<ForgeKind, string> = { github: "github.com", gitlab: "gitlab.com" };
const TITLES: Record<ForgeKind, string> = { github: "GitHub", gitlab: "GitLab" };
const CLIS: Record<ForgeKind, "gh" | "glab"> = { github: "gh", gitlab: "glab" };

/** One segment of a repo path: letters, digits, `_`, `.` and `-`, and never `.` or `..` alone. */
const PART = /^(?!\.{1,2}$)[\w.-]+$/u;
/** GitLab nests subgroups at most 20 deep, so a project path has at most 21 segments. */
const GITLAB_MAX_SEGMENTS = 21;
/** A self-hosted GitLab's host, as `glab api --hostname` takes it: a host name only, with no scheme, port or path. */
const HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/iu;

/**
 * The forge setting a repo name stands for.
 *
 * @throws {RangeError} when `repo` is not a repo name.
 */
export function repoSetting(repo: string): ForgeSetting {
  if (repo.startsWith(SELF_HOSTED_PREFIX)) {
    const rest = repo.slice(SELF_HOSTED_PREFIX.length);
    const slash = rest.indexOf("/");
    const host = (slash < 0 ? rest : rest.slice(0, slash)).toLowerCase();
    if (!HOST.test(host)) throw new RangeError(`not a repo: ${repo} (expected gitlab://host/group/name, with a host name and no scheme or port)`);
    // gitlab.com has its own name, so one project never has two; github.com is never a GitLab.
    if (host === HOSTS.gitlab) throw new RangeError(`not a repo: ${repo} (a project on gitlab.com is named gitlab:group/name)`);
    if (host === HOSTS.github) throw new RangeError(`not a repo: ${repo} (github.com is not a GitLab host)`);
    return { forge: "gitlab", host, path: gitlabPath(slash < 0 ? "" : rest.slice(slash + 1), repo) };
  }
  if (repo.startsWith(GITLAB_PREFIX)) return { forge: "gitlab", host: HOSTS.gitlab, path: gitlabPath(repo.slice(GITLAB_PREFIX.length), repo) };
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts.every((part) => PART.test(part))) throw new RangeError(`not a repo: ${repo} (expected owner/name, gitlab:group/name, or gitlab://host/group/name)`);
  return { forge: "github", host: HOSTS.github, path: repo };
}

/** A GitLab project's path within its name, checked. */
function gitlabPath(path: string, repo: string): string {
  const parts = path.split("/");
  if (parts.length < 2 || parts.length > GITLAB_MAX_SEGMENTS || !parts.every((part) => PART.test(part))) {
    throw new RangeError(`not a repo: ${repo} (expected ${repo.startsWith(SELF_HOSTED_PREFIX) ? "gitlab://host/group/name" : "gitlab:group/name"})`);
  }
  return path;
}

/** Whether `text` is a repo name: `owner/name`, `gitlab:group/name` or `gitlab://host/group/name`. */
export function isRepo(text: string): boolean {
  try {
    repoSetting(text);
    return true;
  } catch {
    return false;
  }
}

/** Whether `host` is one a self-hosted GitLab's projects can be named on: a host name that is neither gitlab.com nor github.com. */
export function isSelfHostedHost(host: string): boolean {
  return HOST.test(host) && host.toLowerCase() !== HOSTS.gitlab && host.toLowerCase() !== HOSTS.github;
}

/** The repo name for a forge setting: the inverse of {@link repoSetting}. A GitLab setting with no host is on gitlab.com. */
export function repoOf(setting: Pick<ForgeSetting, "forge" | "path"> & { host?: string }): string {
  if (setting.forge !== "gitlab") return setting.path;
  const host = (setting.host ?? HOSTS.gitlab).toLowerCase();
  return host === HOSTS.gitlab ? `${GITLAB_PREFIX}${setting.path}` : `${SELF_HOSTED_PREFIX}${host}/${setting.path}`;
}

/**
 * A repo as the owner typed it, in the form its log is kept under, or null
 * when it names none: trimmed, lower-cased, and with a trailing `.git` or a
 * trailing slash taken off. A github.com or gitlab.com web address is taken as
 * its repo. A self-hosted GitLab's address is taken with `gitlab:` written
 * before it, such as `gitlab:https://git.example.com/acme/tally`, since only
 * the owner can say which forge a host runs. Anything after a GitLab
 * project's `/-/`, such as its issues, is taken off.
 */
export function canonicalRepo(text: string): string | null {
  let repo = text.trim();
  const web = /^https:\/\/(github\.com|gitlab\.com)\/(.+)$/iu.exec(repo);
  const selfHosted = /^gitlab:(?:https?:)?\/\/([^/]+)\/(.+)$/iu.exec(repo);
  if (web !== null) repo = web[1]!.toLowerCase() === HOSTS.gitlab ? `${GITLAB_PREFIX}${projectPart(web[2]!)}` : web[2]!;
  else if (selfHosted !== null) {
    const host = selfHosted[1]!.toLowerCase();
    repo = host === HOSTS.gitlab ? `${GITLAB_PREFIX}${projectPart(selfHosted[2]!)}` : `${SELF_HOSTED_PREFIX}${host}/${projectPart(selfHosted[2]!)}`;
  }
  repo = repo.replace(/\/$/u, "").replace(/\.git$/u, "").toLowerCase();
  return isRepo(repo) ? repo : null;
}

/** A GitLab project's path from the part of its address after the host: a page inside the project, such as its issues, sits after `/-/`. */
function projectPart(path: string): string {
  return path.replace(/\/-(?:\/.*)?$/u, "");
}

/** The host a forge's repos are on unless named otherwise: github.com, or gitlab.com for a `gitlab:` name. */
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
