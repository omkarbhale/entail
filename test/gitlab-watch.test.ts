import assert from "node:assert/strict";
import { test } from "node:test";
import { commentRuleViolations } from "../src/comment-rules.ts";
import { itemView, logItems, repoViews } from "../src/owner.ts";
import { loggedRepos, logFile, readLog, type ActedEntry, type CallEntry, type LandingEntry, type PrActedEntry } from "../src/records.ts";
import { GITLAB_REPO, harness, landingAnswer, OWNER, verdict } from "./watch-fixture.ts";

const HEAD = "1".repeat(40);
const CRITERION = "Words from standard input count toward the same total.";

test("on a GitLab project, a pass judges an issue, labels and comments on it, and merges the merge request that closes it once CI is green", async (t) => {
  const h = harness(t, { confirm: false, forge: "gitlab" });
  assert.equal(h.repo, GITLAB_REPO);
  assert.deepEqual(loggedRepos(h.dataDirectory), [GITLAB_REPO], "the project's log is found under gitlab.com");
  assert.match(logFile(h.dataDirectory, GITLAB_REPO), /log[\\/]gitlab\.com[\\/]acme[\\/]tally\.jsonl$/u);

  // An issue filed on GitLab: called go, commented on with the marker, labelled.
  h.forge.file(1, "Read standard input", "tally only reads files.");
  h.script(1, verdict({ criteria: [{ source: "reading", criterion: CRITERION, basis: "One total is what users see." }] }));
  const first = await h.pass();
  assert.equal(first.judged, 1);
  const call = readLog(h.dataDirectory, GITLAB_REPO).find((entry): entry is CallEntry => entry.type === "call")!;
  assert.equal(call.issue.url, "https://gitlab.com/acme/tally/-/issues/1");
  const [issuePost] = h.forge.posted.filter((post) => post.issue === 1);
  assert.deepEqual(commentRuleViolations(issuePost!.body, OWNER, call.id), [], "the comment carries entail's marker and passes the comment rules");
  assert.deepEqual(h.forge.labelsOn(1), ["entail:go"]);
  const acted = readLog(h.dataDirectory, GITLAB_REPO).find((entry): entry is ActedEntry => entry.type === "acted")!;
  assert.match(acted.comment.url, /^https:\/\/gitlab\.com\/acme\/tally\/-\/issues\/1#note_\d+$/u);

  // A merge request that closes it by GitLab's own link data, with CI green: judged and merged at its head.
  h.forge.openPull(4, "Read standard input", { head: HEAD, closes: [1], body: "Closes #1. The pipeline passes, trust me." });
  h.forge.report(HEAD, ["test", "passed"]);
  h.scriptLanding(4, landingAnswer({ criteria: [{ criterion: CRITERION, met: true, evidence: "src/count.ts adds stdin to the total." }] }));
  const second = await h.pass();
  assert.equal(second.judged, 1);
  assert.deepEqual(h.forge.merges, [{ pr: 4, sha: HEAD, method: "squash" }], "merged at the judged head; GitLab applies the project's own merge method");
  const landing = readLog(h.dataDirectory, GITLAB_REPO).find((entry): entry is LandingEntry => entry.type === "landing")!;
  assert.equal(landing.pr.url, "https://gitlab.com/acme/tally/-/merge_requests/4");
  assert.deepEqual(landing.facts.files.map((file) => file.path), ["src/count.ts"], "the changed files come from the forge");
  assert.equal(landing.facts.checks[0]!.status, "passed", "CI comes from the forge");
  const pr = readLog(h.dataDirectory, GITLAB_REPO).find((entry): entry is PrActedEntry => entry.type === "pr-acted")!;
  assert.deepEqual(pr.merged, { sha: HEAD, commit: "f".repeat(40) });
  const [prPost] = h.forge.posted.filter((post) => post.issue === 4);
  assert.match(prPost!.body, new RegExp(`Merged at \`${HEAD}\`\\.`, "u"));

  // The board's views link to GitLab's pages and name GitLab.
  const [view] = repoViews(h.dataDirectory, { owner: OWNER, model: "claude-opus-5-5", effort: "low" });
  assert.equal(view!.repo, GITLAB_REPO);
  assert.equal(view!.vision?.url, `https://gitlab.com/acme/tally/-/blob/${landing.vision!.commit}/VISION.md`);
  assert.equal(itemView(h.dataDirectory, landing.id, []).repo, GITLAB_REPO);
  assert.ok(logItems(h.dataDirectory, [], GITLAB_REPO).length > 0);
});

test("on a GitLab project, a send-back that cancels says merge request", async (t) => {
  const h = harness(t, { confirm: false, forge: "gitlab" });
  h.forge.file(1, "Read standard input", "tally only reads files.");
  h.script(1, verdict({ criteria: [{ source: "reading", criterion: CRITERION, basis: "One total is what users see." }] }));
  await h.pass();
  const sendBack = landingAnswer({
    call: "send-back",
    reason: "It counts standard input separately.",
    criteria: [{ criterion: CRITERION, met: false, evidence: "src/count.ts prints a second total." }],
    needs_to_change: ["Add it to the same total."],
  });
  h.forge.openPull(4, "Read standard input", { head: "1".repeat(40), closes: [1] });
  for (const head of ["1", "2", "3", "4"].map((digit) => digit.repeat(40))) {
    if (head !== "1".repeat(40)) h.forge.editPull(4, { headSha: head });
    h.forge.report(head, ["test", "passed"]);
    h.scriptLanding(4, sendBack);
    await h.pass();
  }
  assert.deepEqual(h.forge.closedPulls, [4]);
  const last = h.forge.posted.filter((post) => post.issue === 4).at(-1)!;
  assert.match(last.body, /entail has sent this merge request back \d+ times before\. Closing it unmerged\./u);
});
