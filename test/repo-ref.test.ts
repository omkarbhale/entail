import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loggedRepos, logFile } from "../src/records.ts";
import { blobUrl, canonicalRepo, forgeTitle, isRepo, issueUrl, repoOf, repoSetting, repoUrl } from "../src/repo-ref.ts";

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
  for (const repo of ["acme/tally", "gitlab:acme/tally", "gitlab:acme/tools/tally"]) {
    mkdirSync(join(logFile(directory, repo), ".."), { recursive: true });
    writeFileSync(logFile(directory, repo), "");
  }
  assert.deepEqual(loggedRepos(directory), ["acme/tally", "gitlab:acme/tally", "gitlab:acme/tools/tally"]);
});
