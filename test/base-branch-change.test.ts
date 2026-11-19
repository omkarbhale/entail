import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createForge } from "../src/forge/create-forge.ts";
import { JUDGMENT_KIND, type Verdict } from "../src/judgment.ts";
import { changeRepoSettings, confirmCall, formatLog, logItems, waitingItems } from "../src/owner.ts";
import { readLog, repoState, type BaseBranchSeenEntry, type Entry, type LandingEntry } from "../src/records.ts";
import { repoSetting } from "../src/repo-ref.ts";
import { forgesByBaseBranch, type RepoReader } from "../src/watch.ts";
import { harness, landingAnswer, OWNER, REPO, SHA, verdict, VISION, type Harness } from "./watch-fixture.ts";

/**
 * Changing a repo's base branch after it was enrolled: set, changed to
 * another branch, and unset back to the forge's default branch. The forge is
 * made again for the new branch the way `entail run` makes it, and the reader
 * reads each branch's own VISION.md.
 */

const DEVELOP_VISION = "# Vision\n\ntally counts words offline.\ntally never adds a second output format.\n";
const COMMITS: Record<string, string> = { main: SHA, develop: "d".repeat(40), release: "e".repeat(40) };
const VISIONS: Record<string, string> = { main: VISION, develop: DEVELOP_VISION, release: DEVELOP_VISION };
const HEAD4 = "4".repeat(40);
const HEAD5 = "5".repeat(40);
const CRITERION = "Words from standard input count toward the same total.";

const byType = <T extends Entry["type"]>(h: Harness, type: T) => readLog(h.dataDirectory, REPO).filter((entry): entry is Extract<Entry, { type: T }> => entry.type === type);

/** A harness whose passes make the forge from the repo's log and read the base branch's own VISION.md. */
function changeable(t: TestContext, options: { confirm?: boolean } = {}) {
  const h = harness(t, { confirm: options.confirm ?? false });
  const made: (string | null)[] = [];
  const forgeFor = forgesByBaseBranch(h.dataDirectory, (_repo, baseBranch) => {
    made.push(baseBranch);
    h.forge.baseBranch = baseBranch;
    return h.forge;
  });
  const reader: RepoReader = async (_repo, forge) => {
    const branch = forge.baseBranch ?? "main";
    return { checkout: `/checkouts/${branch}`, sha: COMMITS[branch]!, vision: { text: VISIONS[branch]!, commit: COMMITS[branch]! }, pins: [] };
  };
  const pass = (overrides: Parameters<Harness["pass"]>[0] = {}) => h.pass({ forgeFor, reader, ...overrides });
  const setBase = (baseBranch: string | null) => changeRepoSettings(h.dataDirectory, REPO, OWNER, { baseBranch });
  return { h, made, pass, setBase };
}

function scriptRecheck(h: Harness, issue: number, answer: Verdict): void {
  h.runner.script(JUDGMENT_KIND, `${REPO}#${issue}`, { output: { ...answer, vision_change: "" }, facts: { estimatedCostUsd: 0.06 } });
}

test("a base branch set, changed and unset later switches the vision of record, and a differing vision re-checks the open issues exactly once", async (t) => {
  const { h, made, pass, setBase } = changeable(t);
  h.forge.file(12, "Count words in footnotes");
  h.script(12, verdict());
  await pass();
  assert.equal(byType(h, "call")[0]!.sha, COMMITS.main);

  // Set to develop, whose VISION.md says something else: one re-check against develop's vision.
  setBase("develop");
  scriptRecheck(h, 12, verdict({ reason: "Footnotes are words; develop's vision is about output formats." }));
  await pass();
  assert.deepEqual(made, [null, "develop"], "the forge is made again for the new branch");
  assert.deepEqual(byType(h, "vision-seen").map((seen) => [seen.commit, seen.text]), [[COMMITS.develop, DEVELOP_VISION]]);
  assert.deepEqual(repoState(REPO, readLog(h.dataDirectory, REPO)).vision?.text, DEVELOP_VISION, "develop's VISION.md is the vision of record");
  assert.equal(byType(h, "rechecked").length, 1);
  assert.match(h.runner.requests.at(-1)!.prompt, /<added>\n\+ tally never adds a second output format\.\n<\/added>/u, "re-checked against develop's vision");

  // Nothing changed since: no second re-check.
  const runs = h.runner.requests.length;
  await pass();
  assert.equal(h.runner.requests.length, runs);
  assert.equal(byType(h, "rechecked").length, 1);

  // An issue filed while develop is the base branch is called under develop's vision.
  h.forge.file(13, "Count words in captions");
  h.script(13, verdict());
  await pass();
  assert.equal(byType(h, "call").at(-1)!.vision?.text, DEVELOP_VISION);
  const runsWith13 = h.runner.requests.length;

  // Changed to release, whose VISION.md reads the same: no re-check.
  setBase("release");
  await pass();
  assert.equal(h.runner.requests.length, runsWith13);
  assert.equal(byType(h, "vision-seen").length, 1);

  // Unset: back to the forge's default branch and its vision. #13, called under develop's, is re-checked once;
  // #12 was called under main's own vision, so there is nothing to re-check on it.
  setBase(null);
  scriptRecheck(h, 13, verdict());
  await pass();
  await pass();
  assert.deepEqual(
    byType(h, "rechecked").map((entry) => entry.issue),
    [12, 13],
  );
  assert.ok(runs < runsWith13);
  assert.deepEqual(byType(h, "vision-seen").map((seen) => seen.text), [DEVELOP_VISION, VISION]);
  assert.deepEqual(made, [null, "develop", "release", null]);
  assert.deepEqual(
    byType(h, "base-branch-seen").map((seen: BaseBranchSeenEntry) => seen.branch),
    ["develop", "release", "main"],
  );

  // Every change is logged under the owner's name.
  const log = formatLog(logItems(h.dataDirectory, []), { repoColumn: false });
  assert.match(log, /Omkar set base branch develop/u);
  assert.match(log, /Omkar set base branch release/u);
  assert.match(log, /Omkar set base branch the default \(GitHub's\)/u);
  assert.match(log, /now working against develop; no open pull request into it to pick up/u);
});

test("after the base branch changes, PRs followed into the old one are followed and merged no more, and those already open into the new one are picked up", async (t) => {
  const { h, pass, setBase } = changeable(t, { confirm: true });
  h.forge.file(1, "Read standard input", "tally only reads files.");
  h.script(1, verdict({ criteria: [{ source: "reading", criterion: CRITERION, basis: "One total is what users see." }] }));
  await pass();
  await confirmCall(h.dataDirectory, byType(h, "call")[0]!.id, OWNER);
  await pass();

  // #4 into main is judged merge and waits for the owner; #5 into develop is not followed while main is the base branch.
  h.forge.openPull(4, "Read standard input", { head: HEAD4, closes: [1], base: "main" });
  h.forge.openPull(5, "Read standard input on develop", { head: HEAD5, closes: [1], base: "develop" });
  h.forge.report(HEAD4, ["test", "passed"]);
  h.forge.report(HEAD5, ["test", "passed"]);
  const met = landingAnswer({ criteria: [{ criterion: CRITERION, met: true, evidence: "src/count.ts adds stdin to the total." }] });
  h.scriptLanding(4, met);
  await pass();
  assert.deepEqual(byType(h, "followed").map((entry) => entry.pr.number), [4]);
  assert.equal(waitingItems(h.dataDirectory, []).filter((item) => item.kind === "pr").length, 1);

  // The owner confirms #4's merge, then moves the base branch to develop before entail acts on it.
  const [waiting] = waitingItems(h.dataDirectory, []).filter((item) => item.kind === "pr");
  await confirmCall(h.dataDirectory, waiting!.id, OWNER);
  setBase("develop");
  // The pass that acts on the owner's action as its window closes reads nothing new: the merge itself refuses a PR into another branch.
  await pass({ actOnly: true });
  assert.deepEqual(h.forge.merges, [], "#4 merges into main, no longer the base branch, so it is not merged");
  assert.ok(h.forge.posted.some((post) => post.issue === 4 && /entail did not merge it at `4{40}`: it merges into `main`, not the base branch `develop`\./u.test(post.body)), "the refusal is posted on #4");

  h.scriptLanding(5, met);
  // develop's VISION.md differs, so the go on #1 is re-checked against it once; it holds.
  scriptRecheck(h, 1, verdict({ criteria: [{ source: "reading", criterion: CRITERION, basis: "One total is what users see." }] }));
  await pass();
  assert.deepEqual(
    byType(h, "unfollowed").map((entry) => [entry.pr, entry.state, entry.base]),
    [[4, "open", "main"]],
  );
  assert.deepEqual(byType(h, "base-branch-seen").map((entry) => [entry.branch, entry.picked]), [["develop", [5]]]);
  assert.deepEqual(
    byType(h, "followed").map((entry) => [entry.pr.number, entry.issue]),
    [
      [4, 1],
      [5, 1],
    ],
    "#5, open into develop before the change, is picked up with its issue",
  );
  assert.deepEqual(byType(h, "landing").map((entry: LandingEntry) => entry.pr.number), [4, 5]);
  assert.deepEqual(waitingItems(h.dataDirectory, []).filter((item) => item.kind === "pr").map((item) => item.pr!.number), [5], "#4's call left the board");
  assert.match(formatLog(logItems(h.dataDirectory, []), { repoColumn: false }), /stopped following the PR: it merges into main, not the base branch/u);

  // Unset again: #5, into develop, is followed no more, and nothing new opened into main is left to pick up.
  setBase(null);
  await pass();
  assert.deepEqual(byType(h, "unfollowed").map((entry) => [entry.pr, entry.state, entry.base]), [
    [4, "open", "main"],
    [5, "open", "develop"],
  ]);
  assert.deepEqual(byType(h, "base-branch-seen").map((entry) => [entry.branch, entry.picked]), [
    ["develop", [5]],
    ["main", [4]],
  ]);
  assert.deepEqual(h.forge.merges, []);
});

test("a repo whose base branch was never set reads no PR list and records no base change, as before", async (t) => {
  const { h, made, pass } = changeable(t);
  h.forge.openPull(9, "Untouched since enrollment", { head: HEAD4, closes: [], base: "main" });
  await pass();
  await pass();
  assert.deepEqual(made, [null]);
  assert.deepEqual(byType(h, "base-branch-seen"), []);
  assert.deepEqual(
    byType(h, "followed").map((entry) => entry.pr.number),
    [9],
    "followed only because it changed since enrollment, as any PR is",
  );
});

test("a base branch set and unset again before any pass changes nothing", async (t) => {
  const { h, pass, setBase } = changeable(t);
  setBase("develop");
  setBase(null);
  await pass();
  assert.deepEqual(byType(h, "base-branch-seen"), []);
  assert.deepEqual(byType(h, "vision-seen"), []);
});

test("head-branch matching follows the base branch as it changes, with the real GitHub adapter made again each time", async (t) => {
  const { h, setBase } = changeable(t);
  const repository = (baseRefName: string) => ({ data: { repository: { databaseId: 5001, defaultBranchRef: { name: "main" }, pullRequest: { baseRefName, closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
  const pull = { id: 8007, number: 7, title: "Count captions", body: "Closes #12", state: "open", draft: false, head: { ref: "12-captions", sha: HEAD4 }, base: { ref: "develop", sha: HEAD5 }, user: { login: "reporter", id: 2002 }, created_at: "2026-11-12T10:00:00Z", updated_at: "2026-11-12T10:00:00Z", html_url: "https://github.com/acme/tally/pull/7" };
  const issue = { id: 9012, number: 12, title: "Count words in captions", body: null, state: "open", user: { login: "owner", id: 1001 }, labels: [], created_at: "2026-11-12T09:00:00Z", updated_at: "2026-11-12T09:00:00Z", html_url: "https://github.com/acme/tally/issues/12" };
  const responses: unknown[] = [repository("develop"), repository("develop"), pull, issue, repository("develop")];
  const transport = {
    async request() {
      assert.ok(responses.length > 0, "an unexpected request");
      return { status: 200, headers: {}, body: JSON.stringify(responses.shift()) };
    },
  };
  t.after(() => assert.deepEqual(responses, [], "every response was asked for"));
  const forgeFor = forgesByBaseBranch(h.dataDirectory, (repo, baseBranch) => createForge(repoSetting(repo), transport, baseBranch));

  assert.deepEqual(await forgeFor(REPO).linkedIssues(7), [], "no base branch set: a PR into develop links nothing, as before");
  setBase("develop");
  assert.equal(forgeFor(REPO).baseBranch, "develop");
  assert.deepEqual(await forgeFor(REPO).linkedIssues(7), [12], "develop is the base branch now: its head branch names #12, and its text is never read");
  setBase("release");
  assert.deepEqual(await forgeFor(REPO).linkedIssues(7), [], "release is the base branch now: a PR into develop links nothing");
});
