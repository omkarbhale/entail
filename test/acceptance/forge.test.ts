import assert from "node:assert/strict";
import { test } from "node:test";
import { createForge, type CommandResult, type Runner } from "./forge.ts";

interface Call {
  command: string;
  args: readonly string[];
  input: string | undefined;
}

/** A runner that answers each `api` call by method and endpoint. */
function scripted(responses: Record<string, unknown>): { runner: Runner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: Runner = async (command, args, input) => {
    calls.push({ command, args, input });
    const method = args[args.indexOf("--method") + 1];
    const endpoint = args[args.indexOf("--method") + 2];
    const key = `${method} ${endpoint}`;
    if (!(key in responses)) return { status: 1, stdout: "", stderr: `gh: Not Found (HTTP 404) ${key}` } satisfies CommandResult;
    const response = responses[key];
    return { status: 0, stdout: response === undefined ? "" : JSON.stringify(response), stderr: "" };
  };
  return { runner, calls };
}

test("GitHub: calls go through `gh api` on the stated host, with JSON bodies on standard input", async () => {
  const { runner, calls } = scripted({ "POST repos/o/r/issues": { number: 7, title: "t", body: "b", state: "open", labels: [] } });
  const forge = createForge({ kind: "github", host: "github.com", path: "o/r", runner });
  const issue = await forge.createIssue("t", "b");
  assert.deepEqual(issue, { number: 7, title: "t", body: "b", state: "open", labels: [] });
  assert.equal(calls[0]!.command, "gh");
  assert.deepEqual(calls[0]!.args, ["api", "--hostname", "github.com", "--method", "POST", "repos/o/r/issues", "--header", "Content-Type: application/json", "--input", "-"]);
  assert.deepEqual(JSON.parse(calls[0]!.input!), { title: "t", body: "b" });
});

test("GitHub: issue lists leave out PRs and read every page; a missing repo is undefined", async () => {
  const page1 = Array.from({ length: 100 }, (_, n) => ({ number: n + 1, title: `i${n}`, body: null, state: "open", labels: [{ name: "entail:cleared" }] }));
  const page2 = [{ number: 101, title: "pr", state: "open", labels: [], pull_request: {} }];
  const { runner } = scripted({
    "GET repos/o/r/issues?state=open&per_page=100&page=1": page1,
    "GET repos/o/r/issues?state=open&per_page=100&page=2": page2,
  });
  const forge = createForge({ kind: "github", host: "github.com", path: "o/r", runner });
  const issues = await forge.listIssues("open");
  assert.equal(issues.length, 100);
  assert.deepEqual(issues[0]!.labels, ["entail:cleared"]);
  assert.equal(await forge.repo(), undefined);
});

test("GitHub: a PR's conflict comes from `mergeable` and `mergeable_state`", async () => {
  const pull = (mergeable: boolean | null, state: string) => ({
    number: 3, title: "t", body: "Closes #1", state: "open", merged_at: null, mergeable, mergeable_state: state,
    head: { ref: "executor/t1-issue-1", sha: "abc" }, base: { ref: "main" }, html_url: "https://github.com/o/r/pull/3",
  });
  for (const [mergeable, state, conflicted] of [[false, "dirty", true], [true, "clean", false], [null, "unknown", undefined]] as const) {
    const { runner } = scripted({ "GET repos/o/r/pulls/3": pull(mergeable, state) });
    const pr = await createForge({ kind: "github", host: "github.com", path: "o/r", runner }).pullRequest(3);
    assert.equal(pr.conflicted, conflicted);
  }
});

test("GitLab: calls go through `glab api` with the project path encoded, issues by iid, and its own states", async () => {
  const { runner, calls } = scripted({
    "GET projects/me%2Fentail-fixture-tally": { id: 9, path_with_namespace: "me/entail-fixture-tally", visibility: "private", description: "d", default_branch: "main", web_url: "https://gitlab.com/me/entail-fixture-tally" },
    "GET projects/me%2Fentail-fixture-tally/issues?scope=all&per_page=100&page=1": [{ iid: 4, title: "t", description: null, state: "closed", labels: ["entail:investigate"] }],
    "GET projects/me%2Fentail-fixture-tally/merge_requests/2": { iid: 2, title: "t", description: "Closes #4", state: "merged", source_branch: "b", target_branch: "main", sha: "def", detailed_merge_status: "conflict", web_url: "u" },
  });
  const forge = createForge({ kind: "gitlab", host: "gitlab.com", path: "me/entail-fixture-tally", runner });
  assert.equal((await forge.repo())?.private, true);
  assert.deepEqual(await forge.listIssues("all"), [{ number: 4, title: "t", body: "", state: "closed", labels: ["entail:investigate"] }]);
  const mr = await forge.pullRequest(2);
  assert.equal(mr.state, "merged");
  assert.equal(mr.conflicted, true);
  assert.equal(calls.every((c) => c.command === "glab" && c.args.includes("gitlab.com")), true);
  assert.equal(forge.gitRemote().credentialHelper, "!glab auth git-credential");
});
