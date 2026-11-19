import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ForgeLoggedOutError, ForgeRequestError } from "../../src/forge/forge.ts";
import { GitHubForge } from "../../src/forge/github.ts";
import type { ForgeRequest, ForgeResponse, Transport } from "../../src/forge/transport.ts";
import { type Exchange, RecordedTransport } from "./recorded-transport.ts";

const HOST = "ghe.example.com";
const SETTING = { forge: "github", host: HOST, path: "acme/tally" } as const;
const SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MERGE_COMMIT = "9fceb02d0ae598e95dc970b74767f19372d61af8";

function forgeOn(t: TestContext, exchanges: Exchange[]): GitHubForge {
  const transport = new RecordedTransport({ host: HOST, exchanges });
  t.after(() => transport.assertDone());
  return new GitHubForge(SETTING, transport, { mergePollIntervalMs: 0 });
}

const pull = (number: number, over: Record<string, unknown> = {}): Exchange => ({
  request: { method: "GET", path: `repos/acme/tally/pulls/${number}` },
  response: { status: 200, body: { number, state: "open", draft: false, mergeable: true, mergeable_state: "clean", ...over } },
});
const repoMethods = (squash: boolean, merge: boolean, rebase: boolean): Exchange => ({
  request: { method: "GET", path: "repos/acme/tally" },
  response: { status: 200, body: { id: 5001, allow_squash_merge: squash, allow_merge_commit: merge, allow_rebase_merge: rebase } },
});
const put = (body: Record<string, unknown>, status: number, answer: unknown): Exchange => ({
  request: { method: "PUT", path: "repos/acme/tally/pulls/4/merge", body },
  response: { status, body: answer },
});

test("a GitHub Enterprise Server is read for its version, and a host that reports none is not one", async (t) => {
  const forge = forgeOn(t, [{ request: { method: "GET", path: "meta" }, response: { status: 200, body: { installed_version: "3.17.2", verifiable_password_authentication: true } } }]);
  assert.deepEqual(await forge.instance(), { version: "3.17.2", unsupported: null });

  const notOne = forgeOn(t, [{ request: { method: "GET", path: "meta" }, response: { status: 200, body: { verifiable_password_authentication: true } } }]);
  const answer = await notOne.instance();
  assert.equal(answer.version, null);
  assert.match(answer.unsupported ?? "", /ghe\.example\.com does not report a GitHub Enterprise Server version/u);

  const dotCom = new GitHubForge({ ...SETTING, host: "github.com" }, new RecordedTransport({ host: "github.com", exchanges: [] }));
  assert.deepEqual(await dotCom.instance(), { version: null, unsupported: null }, "github.com is asked nothing");
});

test("a server that has no merge-async is merged with the merge endpoint, pinned to the sha, and its answer is read at once", async (t) => {
  const forge = forgeOn(t, [pull(4), put({ sha: SHA, merge_method: "squash" }, 200, { sha: MERGE_COMMIT, merged: true, message: "Pull Request successfully merged" })]);
  assert.deepEqual(await forge.merge(4, SHA, "squash"), { merged: true, mergeCommitSha: MERGE_COMMIT });
});

test("with no method given, a repo that allows merge commits is merged as the endpoint does, and one that does not, by the first method it allows", async (t) => {
  const merged = { sha: MERGE_COMMIT, merged: true, message: "ok" };
  const allowsMerge = forgeOn(t, [pull(4), repoMethods(true, true, true), put({ sha: SHA }, 200, merged)]);
  assert.deepEqual(await allowsMerge.merge(4, SHA), { merged: true, mergeCommitSha: MERGE_COMMIT });

  const squashOnly = forgeOn(t, [pull(4), repoMethods(true, false, false), put({ sha: SHA, merge_method: "squash" }, 200, merged)]);
  assert.deepEqual(await squashOnly.merge(4, SHA), { merged: true, mergeCommitSha: MERGE_COMMIT });

  const rebaseOnly = forgeOn(t, [pull(4), repoMethods(false, false, true), put({ sha: SHA, merge_method: "rebase" }, 200, merged)]);
  assert.deepEqual(await rebaseOnly.merge(4, SHA), { merged: true, mergeCommitSha: MERGE_COMMIT });

  const unsaid = forgeOn(t, [pull(4), { request: { method: "GET", path: "repos/acme/tally" }, response: { status: 200, body: { id: 5001 } } }, put({ sha: SHA }, 200, merged)]);
  assert.deepEqual(await unsaid.merge(4, SHA), { merged: true, mergeCommitSha: MERGE_COMMIT }, "a repo that reports no methods is asked with none");
});

test("a draft, or a PR the base branch's rules block, is refused before the merge is asked for, so no rule is bypassed", async (t) => {
  const draft = await forgeOn(t, [pull(4, { draft: true })]).merge(4, SHA, "squash");
  assert.ok(!draft.merged && /draft/u.test(draft.refusal), JSON.stringify(draft));
  const blocked = await forgeOn(t, [pull(4, { mergeable_state: "blocked" })]).merge(4, SHA, "squash");
  assert.ok(!blocked.merged && /rules/u.test(blocked.refusal), JSON.stringify(blocked));
});

test("the merge endpoint's refusals are the forge's reason, and a server error is thrown, not taken for a refusal", async (t) => {
  const moved = await forgeOn(t, [pull(4), put({ sha: SHA, merge_method: "squash" }, 409, { message: "Head branch was modified. Review and try the merge again." })]).merge(4, SHA, "squash");
  assert.ok(!moved.merged && /HTTP 409.*Head branch was modified/u.test(moved.refusal), JSON.stringify(moved));
  const notMergeable = await forgeOn(t, [pull(4), put({ sha: SHA, merge_method: "squash" }, 405, { message: "Pull Request is not mergeable" })]).merge(4, SHA, "squash");
  assert.ok(!notMergeable.merged && /HTTP 405.*not mergeable/u.test(notMergeable.refusal), JSON.stringify(notMergeable));
  const notMerged = await forgeOn(t, [pull(4), put({ sha: SHA, merge_method: "squash" }, 200, { merged: false, message: "Merge conflict" })]).merge(4, SHA, "squash");
  assert.ok(!notMerged.merged && /Merge conflict/u.test(notMerged.refusal), JSON.stringify(notMerged));
  await assert.rejects(forgeOn(t, [pull(4), put({ sha: SHA, merge_method: "squash" }, 502, { message: "Bad gateway" })]).merge(4, SHA, "squash"), ForgeRequestError);
});

test("github.com is still merged through merge-async", async (t) => {
  const transport = new RecordedTransport({
    host: "github.com",
    exchanges: [
      {
        request: { method: "PUT", path: "repos/acme/tally/pulls/4/merge-async", body: { sha: SHA, merge_action: "direct_merge", bypass_rules: false, merge_method: "squash" } },
        response: { status: 202, body: { status: "merged", details: { sha: MERGE_COMMIT } } },
      },
    ],
  });
  t.after(() => transport.assertDone());
  const forge = new GitHubForge({ ...SETTING, host: "github.com" }, transport);
  assert.deepEqual(await forge.merge(4, SHA, "squash"), { merged: true, mergeCommitSha: MERGE_COMMIT });
});

test("a page's next link on a GitHub Enterprise Server drops the /api/v3 that gh adds itself", async (t) => {
  const forge = forgeOn(t, [
    {
      request: { method: "GET", path: "repos/acme/tally/issues?state=open&per_page=100" },
      response: { status: 200, headers: { Link: `<https://${HOST}/api/v3/repositories/5001/issues?state=open&per_page=100&page=2>; rel="next"` }, body: [{ number: 1 }] },
    },
    { request: { method: "GET", path: "repositories/5001/issues?state=open&per_page=100&page=2" }, response: { status: 200, body: [{ number: 2 }] } },
  ]);
  assert.deepEqual(await forge.openIssueNumbers(), [1, 2]);
});

test("a logged-out gh on a GitHub Enterprise Server is told which host to log in to", async (t) => {
  const forge = forgeOn(t, [{ request: { method: "GET", path: "repos/acme/tally" }, response: { status: 401, body: { message: "Requires authentication" } } }]);
  await assert.rejects(forge.project(), (error: unknown) => error instanceof ForgeLoggedOutError && /gh auth login --hostname ghe\.example\.com/u.test(error.message));
});

/**
 * A transport that answers each GraphQL query by what it asks for, so a
 * fallback's queries need not be spelled out whole, and every other request
 * from the recorded exchanges in order.
 */
class GraphqlTransport implements Transport {
  readonly #answers: { ask: RegExp; answer: unknown }[];
  readonly #rest: Exchange[];

  constructor(answers: { ask: RegExp; answer: unknown }[], rest: Exchange[]) {
    this.#answers = [...answers];
    this.#rest = [...rest];
  }

  async request(request: ForgeRequest): Promise<ForgeResponse> {
    if (request.path === "graphql") {
      const next = this.#answers.shift();
      assert.ok(next, "an unexpected GraphQL query");
      assert.match(String((request.body as { query: string }).query), next.ask);
      return { status: 200, headers: {}, body: JSON.stringify(next.answer) };
    }
    const next = this.#rest.shift();
    assert.ok(next?.response, `an unexpected request: ${request.method} ${request.path}`);
    assert.deepEqual({ method: request.method, path: request.path }, { method: next.request.method, path: next.request.path });
    return { status: next.response.status, headers: {}, body: JSON.stringify(next.response.body) };
  }

  assertDone(): void {
    assert.deepEqual([this.#answers.length, this.#rest.length], [0, 0], "every answer was asked for");
  }
}

function graphqlForge(t: TestContext, answers: { ask: RegExp; answer: unknown }[], rest: Exchange[] = [], host = HOST): GitHubForge {
  const transport = new GraphqlTransport(answers, rest);
  t.after(() => transport.assertDone());
  return new GitHubForge({ ...SETTING, host }, transport, { mergePollIntervalMs: 0 });
}

const schemaError = (field: string, type = "Issue") => ({ errors: [{ message: `Field '${field}' doesn't exist on type '${type}'`, type: "undefinedField" }] });

test("a server with no closedByPullRequestsReferences finds an issue's PRs from the PRs that mention it, keeping those whose closing references name it", async (t) => {
  const forge = graphqlForge(
    t,
    [
      { ask: /closedByPullRequestsReferences/u, answer: schemaError("closedByPullRequestsReferences") },
      {
        ask: /CROSS_REFERENCED_EVENT/u,
        answer: {
          data: {
            repository: {
              databaseId: 5001,
              issue: {
                timelineItems: {
                  nodes: [
                    { source: { number: 4, repository: { databaseId: 5001 } } },
                    { source: { number: 6, repository: { databaseId: 5001 } } },
                    { source: { number: 12, repository: { databaseId: 6001 } } },
                    { source: {} },
                    { subject: { number: 4, repository: { databaseId: 5001 } } },
                    {},
                  ],
                  pageInfo: { hasNextPage: false, endCursor: "x" },
                },
              },
            },
          },
        },
      },
      { ask: /closingIssuesReferences/u, answer: closing(4, "main", [1]) },
      { ask: /closingIssuesReferences/u, answer: closing(6, "main", []) },
    ],
    [{ request: { method: "GET", path: "repos/acme/tally/pulls/4" }, response: { status: 200, body: openPull(4) } }],
  );
  assert.deepEqual((await forge.linkedPullRequests(1)).map((pr) => pr.number), [4], "not the PR that only mentions the issue, nor one in another repo");
});

test("the fallback keeps only PRs into the base branch, and other schema errors still throw", async (t) => {
  const intoDevelop = graphqlForge(t, [
    { ask: /closedByPullRequestsReferences/u, answer: schemaError("closedByPullRequestsReferences") },
    { ask: /CROSS_REFERENCED_EVENT/u, answer: mentions([5]) },
    { ask: /closingIssuesReferences/u, answer: closing(5, "develop", [1]) },
  ]);
  assert.deepEqual(await intoDevelop.linkedPullRequests(1), []);

  const other = graphqlForge(t, [{ ask: /closedByPullRequestsReferences/u, answer: { errors: [{ message: "Something else went wrong" }] } }]);
  await assert.rejects(other.linkedPullRequests(1), /Something else went wrong/u);
});

test("github.com does not fall back: a schema error there is an error", async (t) => {
  const forge = graphqlForge(t, [{ ask: /closedByPullRequestsReferences/u, answer: schemaError("closedByPullRequestsReferences") }], [], "github.com");
  await assert.rejects(forge.linkedPullRequests(1), ForgeRequestError);
});

test("a server whose issues have no blockedBy keeps no such links, so only the text names blockers", async (t) => {
  const forge = graphqlForge(t, [{ ask: /blockedBy/u, answer: schemaError("blockedBy") }]);
  assert.equal(await forge.blockedBy(1), null);
});

function closing(number: number, base: string, issues: number[]) {
  return {
    data: {
      repository: {
        databaseId: 5001,
        defaultBranchRef: { name: "main" },
        pullRequest: {
          baseRefName: base,
          closingIssuesReferences: { nodes: issues.map((n) => ({ number: n, repository: { databaseId: 5001 } })), pageInfo: { hasNextPage: false, endCursor: "x" } },
        },
      },
    },
  };
}

function mentions(numbers: number[]) {
  return {
    data: {
      repository: {
        databaseId: 5001,
        issue: { timelineItems: { nodes: numbers.map((n) => ({ source: { number: n, repository: { databaseId: 5001 } } })), pageInfo: { hasNextPage: false, endCursor: "x" } } },
      },
    },
  };
}

function openPull(number: number) {
  return {
    id: 8000 + number,
    number,
    title: "Read standard input",
    body: "Closes #1",
    state: "open",
    draft: false,
    user: { login: "reporter", id: 1002 },
    head: { ref: "stdin", sha: "4f1c0c3e9b2a7d6e5f4a3b2c1d0e9f8a7b6c5d4e" },
    base: { ref: "main" },
    created_at: "2026-11-01T10:30:00Z",
    updated_at: "2026-11-02T09:20:00Z",
    html_url: `https://${HOST}/acme/tally/pull/${number}`,
    mergeable: true,
    mergeable_state: "clean",
  };
}
