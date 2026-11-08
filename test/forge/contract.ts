import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { ChangeDeduplicator } from "../../src/changes.ts";
import { CursorStore } from "../../src/cursors.ts";
import {
  type Actor,
  allChecksFinished,
  allChecksPassed,
  type Change,
  type Check,
  type Forge,
  ForgeLoggedOutError,
  type ForgeSetting,
  projectKey,
  type PullRequest,
  RateLimitedError,
  type RequiredCheck,
  requiredChecksReported,
  sameActor,
} from "../../src/forge/forge.ts";
import type { Transport } from "../../src/forge/transport.ts";
import { RecordedTransport, type Recording } from "./recorded-transport.ts";

/**
 * The recorded scenarios every adapter answers. Each adapter records them in
 * its own forge's wire format, playing out the same world described below, and
 * must give the same forge-neutral answers.
 */
export type Scenario =
  | "actor"
  | "user-lookup"
  | "logged-out"
  | "project"
  | "changes"
  | "rate-limited"
  | "comment"
  | "label"
  | "close"
  | "merge"
  | "merge-refused"
  | "settle-reads"
  | "pull-requests"
  | "linked"
  | "checks"
  | "checks-not-reported"
  | "recent-checks"
  | "transferred-in"
  | "issue";

export interface ForgeContractSubject {
  name: string;
  setting: ForgeSetting;
  recording(scenario: Scenario): Recording;
  createForge(setting: ForgeSetting, transport: Transport): Forge;
  /**
   * What the forge requires before merging into `main`, as it reports it at
   * PR #4's head in the checks scenarios: the forges state this differently,
   * GitHub as required checks and GitLab as its pipeline (ADR-0015).
   */
  required(reported: boolean): RequiredCheck[];
}

/*
 * The world the recordings play out, on repo `setting.path`:
 *
 * - The CLI is logged in as `owner`, user id 1001. `reporter` is user id 1002.
 * - User lookup: `executor` is user id 1003, and no account is named `nobody-here`.
 * - The project's id is 5001 and its default branch is `main`.
 * - At first: issue #1 (id 9001) by owner, and issue #2 (id 9002) by reporter,
 *   with an `/entail` comment (id 7001) on it by owner. A pull request and a
 *   comment on it are also there, and are not issues or issue comments.
 * - Two polls with nothing changed.
 * - Then reporter edits issue #2's title, it is labelled `entail:deciding`, and
 *   owner, having renamed the account to `owner-renamed`, opens issue #3 (id 9003).
 * - Rate limited: the forge refuses reads until 2026-11-08T12:00:00Z.
 *
 * The writes, on the same repo, as owner:
 *
 * - Comment: entail's comment for ticket 42 on issue #2 (comment id 8001), and
 *   one on PR #4 (comment id 8002).
 * - Label: `entail:cleared` is missing from the repo when it is first added
 *   to issue #2, and is there when it is added to issue #3. It is then
 *   removed from issue #2, and `entail:investigate`, which issue #2 does not
 *   carry, is removed too.
 * - Close: issue #7 is closed as not planned, and issue #2 as completed.
 * - Merge: PR #4 is merged at its head (HEAD below) by squashing, making MERGE_COMMIT.
 * - Merge refused: PR #5's head moved away from the pinned sha, and PR #6 is a draft.
 * - Settle reads: issue #2 carries the `/entail` comment then entail's comment
 *   8001 (with a system note between them on GitLab), PR #4 carries entail's
 *   comment 8002, PR #4 is merged and PR #5 is open.
 * - Issue read: issue #2 as at first; #4 is PR #4's number on GitHub and no
 *   issue's on GitLab, and no issue is #404.
 * PRs, in the same world:
 *
 * - PR #4 (id 8004) by reporter, "Read standard input", from `stdin` into
 *   `main` at head HEAD4, closes issue #1 by the forge's link data. Owner
 *   comments on it (id 7002). Later its description is edited and reporter
 *   posts an evidence comment (id 7004). Read live, it is mergeable.
 * - PR #5 (id 8005) by owner closes issue #1 but targets `develop`; it is a
 *   draft with conflicts.
 * - PR #6 only mentions issue #1 in its text; the forge does not link it.
 * - PR #7 (id 8007) was merged.
 * - A PR in another repo also closes issue #1.
 * - Checks at HEAD4: `test` passed, `docs` skipped, `coverage` neutral or
 *   allowed to fail, `lint` failed, `build` running and `deploy` passed. The
 *   criteria name `test` and `e2e`, and `e2e` has not reported.
 * - At HEAD4B nothing has reported for the PR.
 * - On `main`, commit C2 (newest) passed `test`; C1 failed `test` and passed `lint`.
 *
 * Transferred in: owner opened issue #3 here, and it was renamed since (on
 * GitLab, a system note says so). Issue #8 was opened in `acme/other` and
 * transferred (moved, on GitLab) into this repo.
 */
const HEAD = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MERGE_COMMIT = "9fceb02d0ae598e95dc970b74767f19372d61af8";
const ISSUE_COMMENT = "Speaking from Owner's entail:\n\nCleared.\n\n<!-- entail ticket 42 -->";
const PR_COMMENT = "Speaking from Owner's entail:\n\nNot merged at `4b825dc`.\n\n<!-- entail ticket 42 -->";
const OWNER = { id: 1001, username: "owner" };
const REPORTER = { id: 1002, username: "reporter" };
const HEAD4 = "4f1c0c3e9b2a7d6e5f4a3b2c1d0e9f8a7b6c5d4e";
const HEAD4B = "b7e2d1c0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4";
const C1 = "1c1c1c1c2d2d2d2d3e3e3e3e4f4f4f4f50505050";
const C2 = "2c2c2c2c3d3d3d3d4e4e4e4e5f5f5f5f60606060";
const EVIDENCE = "## entail evidence\n\nC1: ran `printf 'a b' | tally` — printed 2";

/** Runs the forge contract suite against one adapter on its recorded responses. */
export function forgeContract(subject: ForgeContractSubject): void {
  const { setting } = subject;
  const actor = (who: { id: number; username: string }): Actor => ({
    forge: setting.forge,
    host: setting.host,
    ...who,
  });

  function forgeFor(t: TestContext, scenario: Scenario): Forge {
    const transport = new RecordedTransport(subject.recording(scenario));
    t.after(() => transport.assertDone());
    return subject.createForge(setting, transport);
  }

  describe(`the Forge contract on ${subject.name}`, () => {
    test("the logged-in actor is the forge, host and numeric user id, with the username for display", async (t) => {
      const forge = forgeFor(t, "actor");
      assert.deepEqual(await forge.currentActor(), actor(OWNER));
    });

    test("a username resolves to its numeric user id, and an unknown username to nothing", async (t) => {
      const forge = forgeFor(t, "user-lookup");
      assert.deepEqual(await forge.actorByUsername("executor"), actor({ id: 1003, username: "executor" }));
      assert.equal(await forge.actorByUsername("nobody-here"), null);
    });

    test("a CLI that reports no login gives no actor, and reads fail as logged out", async (t) => {
      const forge = forgeFor(t, "logged-out");
      assert.equal(await forge.currentActor(), null);
      await assert.rejects(forge.changesSince(null), (error: unknown) => {
        return error instanceof ForgeLoggedOutError && error.host === setting.host;
      });
    });

    test("an issue transferred in from another repo is told apart from one opened here", async (t) => {
      const forge = forgeFor(t, "transferred-in");
      assert.equal(await forge.transferredIn(3), false, "opened here");
      assert.equal(await forge.transferredIn(8), true, "transferred in");
    });

    test("one issue is read live, and a number with no issue, or a PR's, reads as none", async (t) => {
      const forge = forgeFor(t, "issue");
      const issue = await forge.issue(2);
      assert.ok(issue !== null);
      assert.equal(issue.number, 2);
      assert.equal(issue.id, 9002);
      assert.equal(issue.title, "Word counts are sometimes one too high");
      assert.equal(issue.state, "open");
      assert.ok(sameActor(issue.author, { forge: setting.forge, host: setting.host, id: 1002, username: "reporter" }));
      assert.equal(await forge.issue(4), null, "PR #4 is no issue");
      assert.equal(await forge.issue(404), null, "no issue #404");
    });

    test("the project is known by its numeric id, with its default branch", async (t) => {
      const forge = forgeFor(t, "project");
      const project = await forge.project();
      assert.deepEqual(project, {
        forge: setting.forge,
        host: setting.host,
        id: 5001,
        path: setting.path,
        defaultBranch: "main",
      });
      assert.equal(projectKey(project), `${setting.forge}:${setting.host}:5001`);
    });

    test("what changed since a cursor, deduplicated by kind, id and update time", async (t) => {
      const forge = forgeFor(t, "changes");
      const dataDirectory = mkdtempSync(join(tmpdir(), "entail-contract-"));
      t.after(() => rmSync(dataDirectory, { recursive: true, force: true }));
      const key = projectKey({ forge: setting.forge, host: setting.host, id: 5001 });
      const deduplicator = new ChangeDeduplicator();

      // Each poll starts from the cursor kept as operational state, as a restart would.
      async function poll(): Promise<Change[]> {
        const cursors = new CursorStore(dataDirectory);
        const batch = await forge.changesSince(cursors.get(key));
        cursors.set(key, batch.cursor);
        return deduplicator.fresh(batch.changes);
      }

      const first = await poll();
      assert.deepEqual(first.map(summary).sort(), [
        "issue 9001 2026-11-01T10:00:00.000Z",
        "issue 9002 2026-11-01T11:00:00.000Z",
        "issue-comment 7001 2026-11-01T11:05:00.000Z",
        "pull-request 8004 2026-11-01T10:45:00.000Z",
        "pull-request-comment 7002 2026-11-01T10:45:00.000Z",
      ]);
      const issue1 = issueOf(first, 9001);
      assert.deepEqual(withoutUrl(issue1), {
        id: 9001,
        number: 1,
        title: "Read from standard input when no file is given",
        body: "tally should count standard input when it is given no file.",
        state: "open",
        author: actor(OWNER),
        labels: [],
        createdAt: "2026-11-01T10:00:00.000Z",
        updatedAt: "2026-11-01T10:00:00.000Z",
      });
      assert.ok(issue1.url.startsWith(`https://${setting.host}/`), "the issue's URL is on its host");
      assert.deepEqual(withoutUrl(issueOf(first, 9002)).author, actor(REPORTER));
      const comment = first.find((change) => change.kind === "issue-comment");
      assert.ok(comment?.kind === "issue-comment");
      assert.deepEqual(
        { ...comment.comment, url: undefined },
        {
          id: 7001,
          issueNumber: 2,
          body: "/entail",
          author: actor(OWNER),
          createdAt: "2026-11-01T11:05:00.000Z",
          updatedAt: "2026-11-01T11:05:00.000Z",
          url: undefined,
        },
      );

      const pull = pullRequestOf(first, 8004);
      assert.deepEqual(withoutUrl(pull), {
        id: 8004,
        number: 4,
        title: "Read standard input",
        body: "Closes #1",
        state: "open",
        draft: false,
        mergeable: null,
        conflicts: null,
        headSha: HEAD4,
        baseBranch: "main",
        author: actor(REPORTER),
        createdAt: "2026-11-01T10:30:00.000Z",
        updatedAt: "2026-11-01T10:45:00.000Z",
      });
      assert.ok(pull.url.startsWith(`https://${setting.host}/`), "the PR's URL is on its host");
      const pullComment = first.find((change) => change.kind === "pull-request-comment");
      assert.ok(pullComment?.kind === "pull-request-comment");
      assert.deepEqual(withoutUrl(pullComment.comment), {
        id: 7002,
        pullRequestNumber: 4,
        body: "Looks good.",
        author: actor(OWNER),
        createdAt: "2026-11-01T10:45:00.000Z",
        updatedAt: "2026-11-01T10:45:00.000Z",
      });

      assert.deepEqual(await poll(), [], "nothing changed, so nothing is reported");
      assert.deepEqual(await poll(), [], "still nothing changed");

      const later = await poll();
      assert.deepEqual(later.map(summary).sort(), [
        "issue 9002 2026-11-02T09:00:00.000Z",
        "issue 9003 2026-11-02T09:30:00.000Z",
        "pull-request 8004 2026-11-02T09:20:00.000Z",
        "pull-request-comment 7004 2026-11-02T09:20:00.000Z",
      ]);
      assert.equal(
        pullRequestOf(later, 8004).body,
        "Closes #1\n\nReads standard input when no file is given.",
        "an edited description reports the PR again",
      );
      const evidence = later.find((change) => change.kind === "pull-request-comment");
      assert.ok(evidence?.kind === "pull-request-comment");
      assert.equal(evidence.comment.body, EVIDENCE);
      assert.deepEqual(evidence.comment.author, actor(REPORTER));
      const edited = issueOf(later, 9002);
      assert.equal(edited.title, "Word counts are one too high after a leading space");
      assert.deepEqual(edited.labels, ["entail:deciding"]);

      const opened = issueOf(later, 9003);
      assert.equal(opened.author.username, "owner-renamed", "the username is kept for display");
      assert.ok(sameActor(opened.author, actor(OWNER)), "a renamed account is still the same actor");
      assert.ok(!sameActor(edited.author, actor(OWNER)), "another account is not the owner");
    });

    test("a comment is posted on an issue or a PR exactly as given, and known by its id and URL", async (t) => {
      const forge = forgeFor(t, "comment");
      const onIssue = await forge.postComment("issue", 2, ISSUE_COMMENT);
      assert.equal(onIssue.id, 8001);
      assert.ok(onIssue.url.startsWith(`https://${setting.host}/acme/tally/`) && onIssue.url.includes("8001"), onIssue.url);
      const onPr = await forge.postComment("pr", 4, PR_COMMENT);
      assert.equal(onPr.id, 8002);
      assert.ok(onPr.url.startsWith(`https://${setting.host}/acme/tally/`) && onPr.url.includes("8002"), onPr.url);
    });

    test("an entail: label is created on first use, added, and removed even when absent", async (t) => {
      const forge = forgeFor(t, "label");
      await forge.addLabel(2, "entail:cleared");
      await forge.addLabel(3, "entail:cleared");
      await forge.removeLabel(2, "entail:cleared");
      await forge.removeLabel(2, "entail:investigate");
      await assert.rejects(forge.addLabel(2, "bug"), /only its own labels/);
      await assert.rejects(forge.removeLabel(2, "entail:"), /only its own labels/);
    });

    test("an issue is closed, as not planned where asked", async (t) => {
      const forge = forgeFor(t, "close");
      await forge.closeIssue(7, "not-planned");
      await forge.closeIssue(2, "completed");
    });

    test("a PR is merged pinned to its sha, without bypassing rules or auto-merge", async (t) => {
      const forge = forgeFor(t, "merge");
      assert.deepEqual(await forge.merge(4, HEAD, "squash"), { merged: true, mergeCommitSha: MERGE_COMMIT });
    });

    test("any outcome other than merged is a refusal, with the forge's reason", async (t) => {
      const forge = forgeFor(t, "merge-refused");
      const moved = await forge.merge(5, HEAD);
      assert.ok(!moved.merged && /HEAD|modified/i.test(moved.refusal), JSON.stringify(moved));
      const draft = await forge.merge(6, HEAD);
      assert.ok(!draft.merged && draft.refusal.length > 0, JSON.stringify(draft));
    });

    test("comments and a PR's state are read to settle unconfirmed writes", async (t) => {
      const forge = forgeFor(t, "settle-reads");
      const onIssue = await forge.comments("issue", 2);
      assert.deepEqual(
        onIssue.map(({ url: _url, ...comment }) => comment),
        [
          { id: 7001, body: "/entail", author: actor(OWNER), createdAt: "2026-11-01T11:05:00.000Z" },
          { id: 8001, body: ISSUE_COMMENT, author: actor(OWNER), createdAt: "2026-11-08T10:00:00.000Z" },
        ],
      );
      assert.ok(onIssue.every((c) => c.url.startsWith(`https://${setting.host}/`)));
      assert.deepEqual(
        (await forge.comments("pr", 4)).map((c) => [c.id, c.body]),
        [[8002, PR_COMMENT]],
      );
      assert.deepEqual(await forge.pullRequestState(4), { state: "merged", headSha: HEAD, mergeCommitSha: MERGE_COMMIT });
      assert.deepEqual(await forge.pullRequestState(5), { state: "open", headSha: HEAD, mergeCommitSha: null });
    });

    test("the forge supplies its own word for a PR in comments", () => {
      const forge = subject.createForge(setting, new RecordedTransport({ host: setting.host, exchanges: [] }));
      assert.equal(forge.wording.pullRequest, setting.forge === "gitlab" ? "merge request" : "pull request");
    });

    test("a PR is read live with its state, and its comments with their authors, oldest first", async (t) => {
      const forge = forgeFor(t, "pull-requests");
      const open = await forge.pullRequest(4);
      assert.deepEqual(withoutUrl(open), {
        id: 8004,
        number: 4,
        title: "Read standard input",
        body: "Closes #1\n\nReads standard input when no file is given.",
        state: "open",
        draft: false,
        mergeable: true,
        conflicts: false,
        headSha: HEAD4,
        baseBranch: "main",
        author: actor(REPORTER),
        createdAt: "2026-11-01T10:30:00.000Z",
        updatedAt: "2026-11-02T09:20:00.000Z",
      });

      const draft = await forge.pullRequest(5);
      assert.deepEqual(
        { state: draft.state, draft: draft.draft, mergeable: draft.mergeable, conflicts: draft.conflicts, base: draft.baseBranch },
        { state: "open", draft: true, mergeable: false, conflicts: true, base: "develop" },
      );
      assert.deepEqual(draft.author, actor(OWNER));

      const merged = await forge.pullRequest(7);
      assert.equal(merged.state, "merged");

      const comments = await forge.pullRequestComments(4);
      assert.deepEqual(
        comments.map((comment) => ({ ...withoutUrl(comment) })),
        [
          {
            id: 7002,
            pullRequestNumber: 4,
            body: "Looks good.",
            author: actor(OWNER),
            createdAt: "2026-11-01T10:45:00.000Z",
            updatedAt: "2026-11-01T10:45:00.000Z",
          },
          {
            id: 7004,
            pullRequestNumber: 4,
            body: EVIDENCE,
            author: actor(REPORTER),
            createdAt: "2026-11-02T09:20:00.000Z",
            updatedAt: "2026-11-02T09:20:00.000Z",
          },
        ],
        "only comments by people, with the PR's author told apart by id",
      );
      for (const comment of comments) assert.ok(comment.url.startsWith(`https://${setting.host}/`), "a comment's URL is on its host");
    });

    test("a ticket's PRs come from the forge's linked-issue data, into the default branch only", async (t) => {
      const forge = forgeFor(t, "linked");
      const linked = await forge.linkedPullRequests(1);
      assert.deepEqual(
        linked.map((pull) => pull.number),
        [4],
        "not the PR into develop, the PR in another repo, or the PR that only mentions the issue",
      );
      assert.equal(linked[0]?.mergeable, true, "each linked PR is read live");

      assert.deepEqual(await forge.linkedIssues(4), [1]);
      assert.deepEqual(await forge.linkedIssues(5), [], "a PR into a branch other than the default links no ticket");
      assert.deepEqual(await forge.linkedIssues(6), [], "text that mentions the issue is not a link");
    });

    test("checks at a sha, with what the forge requires and a named check that has not reported", async (t) => {
      const forge = forgeFor(t, "checks");
      const report = await forge.checks(4, HEAD4, ["test", "e2e"]);
      assert.equal(report.sha, HEAD4);
      assert.deepEqual(report.checks.map(statusOf), [
        "build pending",
        "coverage passed",
        "deploy passed",
        "docs passed",
        "e2e pending (not reported)",
        "lint failed",
        "test passed",
      ]);
      for (const check of report.checks.filter((c) => c.reported)) {
        assert.ok(check.url?.startsWith("https://"), `${check.name} links to its result`);
      }
      assert.deepEqual(report.required, subject.required(true));
      assert.equal(allChecksFinished(report), false, "a running check and an unreported named one are pending");
      assert.equal(allChecksPassed(report), false);
      assert.equal(requiredChecksReported(report), subject.required(true).every((r) => r.reported));
    });

    test("with nothing reported a named check is pending, and with none named every check has finished", async (t) => {
      const forge = forgeFor(t, "checks-not-reported");
      const named = await forge.checks(4, HEAD4B, ["test"]);
      assert.deepEqual(named.checks, [{ name: "test", status: "pending", reported: false, url: null }]);
      assert.equal(allChecksFinished(named), false);
      assert.deepEqual(named.required, subject.required(false));
      assert.equal(requiredChecksReported(named), false);

      const unnamed = await forge.checks(4, HEAD4B, []);
      assert.deepEqual(unnamed.checks, []);
      assert.equal(allChecksFinished(unnamed), true, "with no named checks and no checks at all, every check has finished");
      assert.equal(requiredChecksReported(unnamed), false);
    });

    test("the checks that reported on recent default-branch commits", async (t) => {
      const forge = forgeFor(t, "recent-checks");
      const recent = await forge.recentDefaultBranchChecks(2);
      assert.deepEqual(
        recent.map((commit) => ({ sha: commit.sha, checks: commit.checks.map(statusOf) })),
        [
          { sha: C2, checks: ["test passed"] },
          { sha: C1, checks: ["lint passed", "test failed"] },
        ],
      );
    });

    test("a rate-limited read is surfaced with its reset time", async (t) => {
      const forge = forgeFor(t, "rate-limited");
      await assert.rejects(forge.changesSince(null), (error: unknown) => {
        return (
          error instanceof RateLimitedError &&
          error.host === setting.host &&
          error.resetAt.toISOString() === "2026-11-08T12:00:00.000Z"
        );
      });
    });
  });
}

function summary(change: Change): string {
  return `${change.kind} ${change.id} ${change.updatedAt}`;
}

function statusOf(check: Check): string {
  return `${check.name} ${check.status}${check.reported ? "" : " (not reported)"}`;
}

function pullRequestOf(changes: Change[], id: number): PullRequest {
  const change = changes.find((c) => c.kind === "pull-request" && c.id === id);
  assert.ok(change?.kind === "pull-request", `PR ${id} is reported`);
  return change.pullRequest;
}

function issueOf(changes: Change[], id: number) {
  const change = changes.find((c) => c.kind === "issue" && c.id === id);
  assert.ok(change?.kind === "issue", `issue ${id} is reported`);
  return change.issue;
}

function withoutUrl<T extends { url: string }>(value: T): Omit<T, "url"> {
  const { url: _url, ...rest } = value;
  return rest;
}
