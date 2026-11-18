import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { createApi } from "../src/api.ts";
import { FAILING_NOTICE_AFTER_MS, Health } from "../src/health.ts";
import { JUDGMENT_KIND } from "../src/judgment.ts";
import { Notifier, type NoticeResult } from "../src/notices.ts";
import { repoViews } from "../src/owner.ts";
import { harness, landingAnswer, OWNER, REPO, verdict, type Harness } from "./watch-fixture.ts";

/**
 * A running copy in miniature: each pass feeds the health of each repo it
 * checked, and the notifier is asked after each pass, as `entail run` does.
 */
function running(t: TestContext, h: Harness = harness(t)) {
  let clock = Date.parse("2026-11-12T12:00:00Z");
  const sent: string[] = [];
  const health = new Health();
  const notifier = (send: (line: string) => NoticeResult = () => ({ ok: true })) =>
    new Notifier({
      dataDirectory: h.dataDirectory,
      command: () => "notify",
      link: "http://127.0.0.1:4380/#/waiting",
      send: async (_command, line) => {
        const result = send(line);
        if (result.ok) sent.push(line);
        return result;
      },
    });
  let current = notifier();
  const pass = async () => {
    const now = () => new Date(clock);
    await h.pass({ now, onChecked: (repo, outcome) => health.checked(repo, outcome.failure, now().toISOString()) });
    await current.health(health.repos(), now());
    await current.stalled(repoViews(h.dataDirectory, { owner: OWNER, model: "m", effort: "low" }).flatMap((view) => view.stalled.map((stalled) => ({ repo: view.repo, stalled }))));
  };
  return {
    h,
    sent,
    health,
    pass,
    advance: (ms: number) => (clock += ms),
    restart: (send?: (line: string) => NoticeResult) => (current = notifier(send)),
  };
}

const FIVE_MINUTES = 5 * 60_000;

test("a repo failing then recovering sends exactly one failure notice and one recovery notice", async (t) => {
  const r = running(t);
  r.h.forge.file(12, "Count words in footnotes");
  r.h.forge.down = true;
  for (let n = 0; n < 6; n++) {
    await r.pass();
    r.advance(FIVE_MINUTES);
  }
  assert.deepEqual(r.sent, [`entail: ${REPO} has been failing for 10 minutes: the pass: the forge is down`]);
  assert.equal(r.health.failing(REPO)!.checks, 6);

  // A restart keeps what was told: the failure is not told again.
  r.restart();
  await r.pass();
  assert.equal(r.sent.length, 1);

  r.h.forge.down = false;
  r.h.script(12, verdict());
  await r.pass();
  r.advance(FIVE_MINUTES);
  await r.pass();
  assert.deepEqual(r.sent, [`entail: ${REPO} has been failing for 10 minutes: the pass: the forge is down`, `entail: ${REPO} is working again`]);
  assert.equal(r.health.failing(REPO), null);
});

test("one failed pass followed by a good one sends no notice", async (t) => {
  const r = running(t);
  r.h.forge.file(12, "Count words in footnotes");
  r.h.script(12, "fail", verdict());
  await r.pass();
  assert.equal(r.health.failing(REPO)!.last.step, "judging #12");
  r.advance(FAILING_NOTICE_AFTER_MS - 1);
  await r.pass();
  assert.deepEqual(r.sent, []);
  assert.equal(r.health.failing(REPO), null);
  assert.notEqual(r.health.okAt(REPO), null);
});

test("a usage limit says when it resets, and a notice the command did not deliver is tried again", async (t) => {
  const r = running(t);
  r.h.forge.file(12, "Count words in footnotes");
  const limit = { failure: { kind: "usage-limit" as const, message: "the usage limit was reached", resetAt: new Date("2026-11-12T15:00:00Z") } };
  r.h.runner.script(JUDGMENT_KIND, `${REPO}#12`, limit, limit, limit, limit);
  r.restart(() => ({ ok: false, error: "exited 1" }));
  await r.pass();
  r.advance(FAILING_NOTICE_AFTER_MS);
  await r.pass();
  assert.deepEqual(r.sent, [], "the command failed, so nothing reached the owner");
  r.restart();
  r.advance(FIVE_MINUTES);
  await r.pass();
  await r.pass();
  assert.deepEqual(r.sent, [`entail: ${REPO} has been failing for 15 minutes: judging #12: usage-limit: the usage limit was reached; it resets at 2026-11-12 15:00 UTC`]);
});

test("the API says which repos are failing, since when and why, until one works again", async (t) => {
  const health = new Health();
  const since = new Date(Date.now() - 12 * 60_000).toISOString();
  const h = harness(t);
  health.checked(REPO, { at: since, step: "the pass", message: "gh: not logged in" }, since);
  health.checked(REPO, { at: new Date().toISOString(), step: "the pass", message: "gh: not logged in" }, new Date().toISOString());
  const server = createApi({
    dataDirectory: h.dataDirectory,
    owner: async () => "Omkar",
    defaultModel: "claude-opus-5-5",
    book: async () => [],
    board: null,
    health,
    loop: { check: async () => ({ repo: "", at: "", judged: 0, posted: 0, failed: true }), schedule: () => {}, wake: () => {}, checkedAt: () => since, lastPassAt: since, checking: false },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const status = (await (await fetch(`${base}/api/status`)).json()) as { failing: { repo: string; failing: Record<string, unknown> }[] };
  assert.equal(status.failing.length, 1);
  const { repo, failing } = status.failing[0]!;
  assert.deepEqual([repo, failing.since, failing.step, failing.message, failing.resetAt, failing.reason], [REPO, since, "the pass", "gh: not logged in", null, "the pass: gh: not logged in"]);
  const repos = (await (await fetch(`${base}/api/repos`)).json()) as { repos: { repo: string; failing: { reason: string } | null }[] };
  assert.equal(repos.repos[0]!.failing!.reason, "the pass: gh: not logged in");

  health.checked(REPO, undefined, new Date().toISOString());
  assert.deepEqual(((await (await fetch(`${base}/api/status`)).json()) as { failing: unknown[] }).failing, []);
});

test("a landing judgment that gives no call three times at one head is stalled: told once, neither failing nor recovered, and shown in the views", async (t) => {
  const r = running(t, harness(t, { confirm: false }));
  r.h.forge.file(1, "Read standard input", "tally only reads files.");
  r.h.script(1, verdict({ criteria: [{ source: "reading", criterion: "Words from standard input count.", basis: "One total." }] }));
  await r.pass();
  const head = "1".repeat(40);
  r.h.forge.openPull(4, "Read standard input", { head, closes: [1] });
  r.h.forge.report(head, ["test", "passed"]);
  r.h.scriptLanding(4, "fail", "fail", "fail", landingAnswer());
  for (let n = 0; n < 6; n++) {
    await r.pass();
    r.advance(FAILING_NOTICE_AFTER_MS);
  }
  assert.equal(r.h.runner.requests.filter((request) => request.kind === "pr-call").length, 3);
  assert.equal(r.health.failing(REPO), null);
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0]!, new RegExp(`^entail: ${REPO} stalled: PR #4 judged 3 times without an answer: .+; judged again on the next push$`, "u"));

  const [view] = repoViews(r.h.dataDirectory, { owner: OWNER, model: "m", effort: "low" });
  assert.equal(view!.stalled.length, 1);
  assert.equal(view!.stalled[0]!.attempts, 3);
  assert.equal(`entail: ${REPO} stalled: ${view!.stalled[0]!.line}`, r.sent[0]);

  r.restart();
  await r.pass();
  assert.equal(r.sent.length, 1, "a restart does not tell it again");

  r.h.forge.editPull(4, { headSha: "2".repeat(40) });
  r.h.forge.report("2".repeat(40), ["test", "passed"]);
  await r.pass();
  assert.deepEqual(repoViews(r.h.dataDirectory, { owner: OWNER, model: "m", effort: "low" })[0]!.stalled, []);
});
