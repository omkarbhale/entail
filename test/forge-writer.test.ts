import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { CommentRuleError, composeComment } from "../src/comment-rules.ts";
import { ForgeWriter, settleUnconfirmedWrites } from "../src/forge-writer.ts";
import { Store, type RepoRecord, type TicketRecord } from "../src/store.ts";
import { StateForge, type StateForgeOptions, type WriteName } from "./forge/state-forge.ts";

const OWNER = "Omkar";
const HEAD = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

interface World {
  store: Store;
  repo: RepoRecord;
  ticket: TicketRecord;
}

function world(t: TestContext): World {
  const dir = mkdtempSync(join(tmpdir(), "entail-writer-"));
  let tick = 0;
  const store = Store.openIn(dir, { now: () => new Date(Date.UTC(2026, 10, 8, 12, 0, tick++)) });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const repo = store.enrollRepo({ forge: "github", host: "github.com", projectId: 5001, path: "acme/tally", ownerAccountId: 1001, ownerLogin: "owner" });
  const ticket = store.takeIn({ repoId: repo.id, issueNumber: 2 });
  return { store, repo, ticket };
}

test("every write is an intent in the store before it is sent, and confirmed after", async (t) => {
  const { store, repo, ticket } = world(t);
  const seen: [WriteName, string[]][] = [];
  const options: StateForgeOptions = {
    beforeWrite: (write) => seen.push([write, store.unconfirmedForgeWrites().map((i) => i.kind)]),
  };
  const forge = new StateForge(options, { prs: { 4: { state: "open", headSha: HEAD, mergeCommitSha: null } } });
  const writer = new ForgeWriter(store, forge, repo, OWNER);
  const call = store.recordCall({ ticketId: ticket.id, kind: "verdict", reason: "settled by the vision" });
  const write = { ticketId: ticket.id, callId: call.id };

  const posted = await writer.comment(write, "issue", 2, composeComment(OWNER, ticket.id, "Cleared."));
  await writer.addLabel(write, 2, "entail:cleared");
  await writer.removeLabel(write, 2, "entail:cleared");
  await writer.closeIssue(write, 2, "not-planned");
  assert.deepEqual(await writer.merge(write, 4, HEAD, "squash"), { merged: true, mergeCommitSha: `merge-of-${HEAD}` });

  assert.deepEqual(seen, [
    ["comment", ["comment"]],
    ["addLabel", ["label"]],
    ["removeLabel", ["label"]],
    ["close", ["close"]],
    ["merge", ["merge"]],
  ]);
  assert.deepEqual(store.unconfirmedForgeWrites(), [], "every write was confirmed");
  assert.deepEqual(store.getCall(call.id)?.postedComments.map((c) => [c.commentId, c.commentUrl]), [[String(posted.id), posted.url]]);
  assert.equal(forge.state.closed[2], "not-planned");
  assert.equal(forge.state.prs[4]?.state, "merged");
});

test("the comment writer sends nothing that breaks the comment rules", async (t) => {
  const { store, repo, ticket } = world(t);
  const forge = new StateForge();
  const writer = new ForgeWriter(store, forge, repo, OWNER);
  const write = { ticketId: ticket.id };
  const bodies = [
    `Cleared.\n\n<!-- entail ticket ${ticket.id} -->`,
    "Speaking from Omkar's entail:\n\nCleared.",
    `Speaking from Omkar's entail:\n\n/close\n\n<!-- entail ticket ${ticket.id} -->`,
    `Speaking from James' entail:\n\nCleared.\n\n<!-- entail ticket ${ticket.id} -->`,
  ];
  for (const body of bodies) {
    await assert.rejects(writer.comment(write, "issue", 2, body), CommentRuleError, body);
  }
  await assert.rejects(writer.addLabel(write, 2, "bug"), /only its own labels/);
  assert.equal(forge.state.sends.comment, 0);
  assert.equal(forge.state.sends.addLabel, 0);
  assert.deepEqual(store.unconfirmedForgeWrites(), [], "nothing was recorded");
});

test("a refused merge is confirmed as a refusal, not retried", async (t) => {
  const { store, repo, ticket } = world(t);
  const forge = new StateForge({}, { prs: { 4: { state: "open", headSha: "moved", mergeCommitSha: null } } });
  const writer = new ForgeWriter(store, forge, repo, OWNER);
  assert.deepEqual(await writer.merge({ ticketId: ticket.id }, 4, HEAD), { merged: false, refusal: "the head moved" });
  assert.deepEqual(store.unconfirmedForgeWrites(), []);
  assert.equal(forge.state.prs[4]?.state, "open");
});

test("a comment whose answer was lost is found by its marker when asked again, not posted twice", async (t) => {
  const { store, repo, ticket } = world(t);
  let lose = true;
  const forge = new StateForge({
    afterWrite: () => {
      if (lose) {
        lose = false;
        throw new Error("the connection dropped after the forge took the comment");
      }
    },
  });
  const writer = new ForgeWriter(store, forge, repo, OWNER);
  const body = composeComment(OWNER, ticket.id, "Cleared.");
  await assert.rejects(writer.comment({ ticketId: ticket.id }, "issue", 2, body), /connection dropped/);
  assert.equal(store.unconfirmedForgeWrites().length, 1);

  const posted = await writer.comment({ ticketId: ticket.id }, "issue", 2, body);
  assert.equal(forge.state.sends.comment, 1, "the comment was posted once");
  assert.equal(posted.id, forge.state.comments["issue:2"]?.[0]?.id);
  assert.deepEqual(store.unconfirmedForgeWrites(), [], "the same intent was resumed and confirmed");
});

test("a merge whose answer was lost is found merged when asked again, not sent twice", async (t) => {
  const { store, repo, ticket } = world(t);
  let lose = true;
  const forge = new StateForge(
    {
      afterWrite: () => {
        if (lose) {
          lose = false;
          throw new Error("timed out");
        }
      },
    },
    { prs: { 4: { state: "open", headSha: HEAD, mergeCommitSha: null } } },
  );
  const writer = new ForgeWriter(store, forge, repo, OWNER);
  await assert.rejects(writer.merge({ ticketId: ticket.id }, 4, HEAD), /timed out/);
  assert.deepEqual(await writer.merge({ ticketId: ticket.id }, 4, HEAD), { merged: true, mergeCommitSha: `merge-of-${HEAD}` });
  assert.equal(forge.state.sends.merge, 1);
  assert.deepEqual(store.unconfirmedForgeWrites(), []);
});

test("a newer label write supersedes an older unconfirmed one, so settling never re-applies a stale label", async (t) => {
  const { store, repo, ticket } = world(t);
  let fail = true;
  const forge = new StateForge({
    beforeWrite: () => {
      if (fail) throw new Error("the forge could not be reached");
    },
  });
  const writer = new ForgeWriter(store, forge, repo, OWNER);
  await assert.rejects(writer.addLabel({ ticketId: ticket.id }, 2, "entail:cleared"), /could not be reached/);
  fail = false;
  await writer.addLabel({ ticketId: ticket.id }, 2, "entail:investigate");
  assert.equal(store.unconfirmedForgeWrites().length, 1, "another label's intent is left alone");
  await writer.removeLabel({ ticketId: ticket.id }, 2, "entail:cleared");
  assert.deepEqual(store.unconfirmedForgeWrites(), [], "the remove superseded the unconfirmed add");

  assert.deepEqual(await settleUnconfirmedWrites(store, () => forge), []);
  assert.deepEqual(forge.state.labels[2], ["entail:investigate"]);
});

test("settling on start posts a comment that never arrived, and records an unmerged PR without merging it", async (t) => {
  const { store, repo, ticket } = world(t);
  const comment = store.recordForgeWriteIntent({
    repoId: repo.id,
    ticketId: ticket.id,
    kind: "comment",
    target: "pr",
    number: 4,
    payload: { body: composeComment(OWNER, ticket.id, "Not merged.") },
  });
  const merge = store.recordForgeWriteIntent({
    repoId: repo.id,
    ticketId: ticket.id,
    kind: "merge",
    target: "pr",
    number: 4,
    payload: { sha: HEAD, method: null },
  });
  const forge = new StateForge({}, { prs: { 4: { state: "open", headSha: HEAD, mergeCommitSha: null } } });

  const settled = await settleUnconfirmedWrites(store, () => forge);
  assert.deepEqual(settled, [
    { intentId: comment.id, kind: "comment", settled: "not found, so posted" },
    { intentId: merge.id, kind: "merge", settled: "not merged, by the PR's state (open)" },
  ]);
  assert.equal(forge.state.sends.comment, 1);
  assert.equal(forge.state.sends.merge, 0, "a merge is never sent again without its guard");
  assert.equal(forge.state.prs[4]?.state, "open");
  assert.deepEqual(store.unconfirmedForgeWrites(), []);
});

test("settling ignores someone else's copy of entail's comment and a comment already claimed", async (t) => {
  const { store, repo, ticket } = world(t);
  const body = composeComment(OWNER, ticket.id, "Cleared.");
  const forge = new StateForge();
  const writer = new ForgeWriter(store, forge, repo, OWNER);
  // The same text posted once already, and confirmed.
  await writer.comment({ ticketId: ticket.id }, "issue", 2, body);
  // Someone else posts a copy of it.
  forge.state.comments["issue:2"]?.push({ id: 9999, body, authorId: 1002, createdAt: new Date(0).toISOString() });
  const intent = store.recordForgeWriteIntent({ repoId: repo.id, ticketId: ticket.id, kind: "comment", target: "issue", number: 2, payload: { body } });

  const [settled] = await settleUnconfirmedWrites(store, () => forge);
  assert.deepEqual(settled, { intentId: intent.id, kind: "comment", settled: "not found, so posted" });
});

test("a halted host's writes wait, and a write that fails to settle holds back its repo's later writes", async (t) => {
  const { store, repo, ticket } = world(t);
  const other = store.enrollRepo({ forge: "gitlab", host: "gitlab.example.org", projectId: 7, path: "acme/tally", ownerAccountId: 1001, ownerLogin: "owner" });
  const close = store.recordForgeWriteIntent({ repoId: repo.id, ticketId: ticket.id, kind: "close", target: "issue", number: 2, payload: { reason: "completed" } });
  const label = store.recordForgeWriteIntent({
    repoId: repo.id,
    ticketId: ticket.id,
    kind: "label",
    target: "issue",
    number: 2,
    payload: { action: "remove", label: "entail:cleared" },
  });
  const halted = store.recordForgeWriteIntent({ repoId: other.id, kind: "close", target: "issue", number: 1, payload: { reason: "completed" } });

  const failing = new StateForge({
    beforeWrite: () => {
      throw new Error("HTTP 502");
    },
  });
  const results = await settleUnconfirmedWrites(store, (r) => (r.id === repo.id ? failing : null));
  assert.equal(results.length, 1);
  assert.ok(results[0] && "error" in results[0] && results[0].intentId === close.id && /502/.test(results[0].error.message));
  assert.deepEqual(
    store.unconfirmedForgeWrites().map((i) => i.id),
    [close.id, label.id, halted.id],
  );

  const forge = new StateForge();
  const settled = await settleUnconfirmedWrites(store, () => forge);
  assert.deepEqual(
    settled.map((s) => ("settled" in s ? [s.intentId, s.settled] : [s.intentId, s.error.message])),
    [
      [close.id, "applied again"],
      [label.id, "applied again"],
      [halted.id, "applied again"],
    ],
  );
});
