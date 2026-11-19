import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loggedRepos, logFile } from "../src/records.ts";
import { blobUrl, canonicalRepo, forgeTitle, isRepo, issueUrl, repoOf, repoSetting, repoUrl } from "../src/repo-ref.ts";
import { pinsFile } from "../src/pins.ts";
import { caseSlug, landingCaseSlug } from "../src/case-book.ts";

test("a GitHub repo is owner/name on github.com, exactly as before", () => {
  assert.deepEqual(repoSetting("acme/tally"), { forge: "github", host: "github.com", path: "acme/tally" });
  assert.equal(repoOf(repoSetting("acme/tally")), "acme/tally");
  assert.equal(forgeTitle("acme/tally"), "GitHub");
  assert.equal(issueUrl("acme/tally", 7), "https://github.com/acme/tally/issues/7");
  assert.equal(blobUrl("acme/tally", "abc", "VISION.md"), "https://github.com/acme/tally/blob/abc/VISION.md");
  for (const bad of ["acme", "acme/tally/x", "../x", "acme/..", "a b/c", "acme:x/y"]) assert.equal(isRepo(bad), false, bad);
});

test("a GitLab project is gitlab:namespace/name on gitlab.com, with any depth of subgroups", () => {
  assert.deepEqual(repoSetting("gitlab:acme/tally"), { forge: "gitlab", host: "gitlab.com", path: "acme/tally" });
  assert.deepEqual(repoSetting("gitlab:acme/tools/cli/tally"), { forge: "gitlab", host: "gitlab.com", path: "acme/tools/cli/tally" });
  assert.equal(repoOf({ forge: "gitlab", path: "acme/tools/tally" }), "gitlab:acme/tools/tally");
  assert.equal(forgeTitle("gitlab:acme/tally"), "GitLab");
  assert.equal(repoUrl("gitlab:acme/tools/tally"), "https://gitlab.com/acme/tools/tally");
  assert.equal(issueUrl("gitlab:acme/tally", 7), "https://gitlab.com/acme/tally/-/issues/7");
  assert.equal(blobUrl("gitlab:acme/tally", "abc", "VISION.md"), "https://gitlab.com/acme/tally/-/blob/abc/VISION.md");
  for (const bad of ["gitlab:tally", "gitlab:", "gitlab:acme/../x", "gitlab:acme//x", "gitlab:a b/c"]) assert.equal(isRepo(bad), false, bad);
});

test("a project on a self-hosted GitLab is gitlab://host/namespace/name, on that host", () => {
  assert.deepEqual(repoSetting("gitlab://git.example.com/acme/tally"), { forge: "gitlab", host: "git.example.com", path: "acme/tally" });
  assert.deepEqual(repoSetting("gitlab://git.example.com/acme/tools/cli/tally"), { forge: "gitlab", host: "git.example.com", path: "acme/tools/cli/tally" });
  assert.deepEqual(repoSetting("gitlab://localhost/acme/tally"), { forge: "gitlab", host: "localhost", path: "acme/tally" });
  assert.equal(repoOf({ forge: "gitlab", host: "git.example.com", path: "acme/tally" }), "gitlab://git.example.com/acme/tally");
  assert.equal(repoOf({ forge: "gitlab", host: "gitlab.com", path: "acme/tally" }), "gitlab:acme/tally");
  assert.equal(forgeTitle("gitlab://git.example.com/acme/tally"), "GitLab");
  assert.equal(repoUrl("gitlab://git.example.com/acme/tools/tally"), "https://git.example.com/acme/tools/tally");
  assert.equal(issueUrl("gitlab://git.example.com/acme/tally", 7), "https://git.example.com/acme/tally/-/issues/7");
  assert.equal(blobUrl("gitlab://git.example.com/acme/tally", "abc", "VISION.md"), "https://git.example.com/acme/tally/-/blob/abc/VISION.md");
  for (const bad of [
    "gitlab://git.example.com/tally",
    "gitlab://git.example.com",
    "gitlab:///acme/tally",
    "gitlab://git.example.com:8443/acme/tally",
    "gitlab://-git.example.com/acme/tally",
    "gitlab://git.example.com/acme/../x",
    "gitlab://gitlab.com/acme/tally",
    "gitlab://github.com/acme/tally",
  ]) {
    assert.equal(isRepo(bad), false, bad);
  }
});

test("a gitlab.com name reads as before: a first group with dots in it is a group, not a host", () => {
  assert.deepEqual(repoSetting("gitlab:git.example.com/acme/tally"), { forge: "gitlab", host: "gitlab.com", path: "git.example.com/acme/tally" });
  assert.deepEqual(repoSetting("gitlab:a/b/c/d/e/f"), { forge: "gitlab", host: "gitlab.com", path: "a/b/c/d/e/f" });
  assert.equal(canonicalRepo("gitlab:git.example.com/acme/tally"), "gitlab:git.example.com/acme/tally");
});

test("a self-hosted GitLab's project as typed: its name, or gitlab: before its address", () => {
  assert.equal(canonicalRepo(" GitLab://Git.Example.com/Acme/Tally "), "gitlab://git.example.com/acme/tally");
  assert.equal(canonicalRepo("gitlab:https://git.example.com/acme/tools/tally/"), "gitlab://git.example.com/acme/tools/tally");
  assert.equal(canonicalRepo("gitlab:https://git.example.com/acme/tally/-/issues/3"), "gitlab://git.example.com/acme/tally");
  assert.equal(canonicalRepo("gitlab:https://git.example.com/acme/tally.git"), "gitlab://git.example.com/acme/tally");
  assert.equal(canonicalRepo("gitlab:http://git.example.com/acme/tally"), "gitlab://git.example.com/acme/tally");
  // gitlab.com keeps its one name, however it is typed.
  assert.equal(canonicalRepo("gitlab://gitlab.com/acme/tally"), "gitlab:acme/tally");
  assert.equal(canonicalRepo("gitlab:https://gitlab.com/acme/tally"), "gitlab:acme/tally");
  // Only the owner can say a host runs GitLab.
  assert.equal(canonicalRepo("https://git.example.com/acme/tally"), null);
  assert.equal(canonicalRepo("gitlab:https://git.example.com:8443/acme/tally"), null);
  assert.equal(canonicalRepo("gitlab:https://github.com/acme/tally"), null);
});

test("a self-hosted GitLab's pins and cases are kept under its host, apart from gitlab.com's", () => {
  assert.equal(pinsFile("/d", repoSetting("gitlab://git.example.com/acme/tally")), join("/d", "pins", "git.example.com", "acme", "tally.md"));
  assert.equal(caseSlug("gitlab://git.example.com/acme/tools/tally", 12), "gitlab-git.example.com-acme-tools-tally-12");
  assert.equal(landingCaseSlug("gitlab://git.example.com/acme/tally", 3), "gitlab-git.example.com-acme-tally-pr-3");
  assert.equal(landingCaseSlug("gitlab:acme/tally", 3), "gitlab-acme-tally-pr-3");
});

test("a repo as typed is trimmed, lower-cased and taken from its web address", () => {
  assert.equal(canonicalRepo(" Acme/Tally "), "acme/tally");
  assert.equal(canonicalRepo("https://github.com/acme/tally.git"), "acme/tally");
  assert.equal(canonicalRepo("GitLab:Acme/Tools/Tally"), "gitlab:acme/tools/tally");
  assert.equal(canonicalRepo("https://gitlab.com/acme/tools/tally/"), "gitlab:acme/tools/tally");
  assert.equal(canonicalRepo("https://gitlab.com/acme/tally/-/issues/3"), "gitlab:acme/tally");
  assert.equal(canonicalRepo("https://gitlab.com/acme/tally.git"), "gitlab:acme/tally");
  assert.equal(canonicalRepo("https://gitlab.com/tally"), null);
  assert.equal(canonicalRepo("acme/tally/x"), null);
});

test("each forge's logs are kept under its host, a GitLab project's subgroups as directories, and found again", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "entail-repos-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.equal(logFile(directory, "acme/tally"), join(directory, "log", "github.com", "acme", "tally.jsonl"));
  assert.equal(logFile(directory, "gitlab:acme/tools/tally"), join(directory, "log", "gitlab.com", "acme", "tools", "tally.jsonl"));
  assert.equal(logFile(directory, "gitlab://git.example.com/acme/tools/tally"), join(directory, "log", "git.example.com", "acme", "tools", "tally.jsonl"));
  const repos = ["acme/tally", "gitlab:acme/tally", "gitlab:acme/tools/tally", "gitlab://git.example.com/acme/tally", "gitlab://git.example.com/acme/tools/tally", "gitlab://localhost/x/y"];
  for (const repo of repos) {
    mkdirSync(join(logFile(directory, repo), ".."), { recursive: true });
    writeFileSync(logFile(directory, repo), "");
  }
  assert.deepEqual(loggedRepos(directory), [...repos].sort());
});
