import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { evidenceBasis, listedIds } from "./comments.ts";
import { branchFor, CLEARED_LABEL, INVESTIGATE_LABEL, ScriptedExecutor, Workspace } from "./executor.ts";
import { FakeForge } from "./fake-forge.ts";
import type { TicketId } from "./fixture.ts";
import type { HarnessEvent } from "./reset.ts";
import { resetFixture } from "./reset.ts";
import { git } from "./tree.ts";

const CRITERIA = `### Vision check

> Errors go to standard error, and tally then exits with a non-zero status.

### What happens next

- **C1** — A missing file is reported on standard error instead of a stack trace. (source: vision line)
- **C2** — tally exits with a non-zero status when a file is missing. (source: vision line)

Generic criteria:

- **G1** — The CI job \`test\` passes.

Cleared because it is settled by the vision. Report evidence in your PR under \`entail evidence\`, one entry per id.`;

const QUESTIONS = `### What happens next

Q1. Can the overcount be reproduced, and on what input?
Q2. What in the code causes it?

Report findings on this issue under \`entail findings\`, one entry per question id.`;

interface World {
  forge: FakeForge;
  executor: ScriptedExecutor;
  events: HarnessEvent[];
  issue(id: TicketId): number;
}

async function world(t: TestContext): Promise<World> {
  const forge = new FakeForge();
  const work = mkdtempSync(join(tmpdir(), "entail-executor-"));
  t.after(() => [forge.remote, work].forEach((d) => rmSync(d, { recursive: true, force: true })));
  const reset = await resetFixture(forge);
  const events: HarnessEvent[] = [];
  const executor = new ScriptedExecutor({ forge, workspace: new Workspace(forge, work), log: (e) => events.push(e) });
  return { forge, executor, events, issue: (id) => reset.issues.find((i) => i.id === id)!.number };
}

function label(forge: FakeForge, number: number, name: string): void {
  forge.issues.find((i) => i.number === number)!.labels.push(name);
}

/** Pushes a commit to the remote's default branch, as a merge of other work would. */
function advanceMain(t: TestContext, forge: FakeForge, path: string, text: string): void {
  const work = mkdtempSync(join(tmpdir(), "entail-merge-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  git(work, ["clone", "--quiet", forge.remote, "."]);
  writeFileSync(join(work, path), text);
  git(work, ["add", "--all"]);
  git(work, ["-c", "user.name=x", "-c", "user.email=x@example.com", "commit", "--quiet", "-m", "other work"]);
  git(work, ["push", "--quiet", "origin", "HEAD:main"]);
}

test("a cleared issue gets its prepared PR, linked with the closing keyword and carrying evidence per id", async (t) => {
  const { forge, executor, events, issue } = await world(t);
  const t2 = issue("T2");
  label(forge, t2, CLEARED_LABEL);
  forge.entailComment("issue", t2, CRITERIA);

  await executor.pass();

  assert.equal(forge.prs.length, 1);
  const pr = forge.prs[0]!;
  assert.equal(pr.branch, branchFor("T2", t2));
  assert.equal(pr.base, "main");
  assert.match(pr.body, new RegExp(`^Closes #${t2}\\n`));
  assert.match(pr.body, /^## entail evidence$/m);
  const entries = pr.body.split("\n").filter((line) => /^[CG]\d+: /.test(line));
  assert.deepEqual(
    entries.map((e) => e.slice(0, 2)),
    ["C1", "C2", "G1"],
  );
  for (const entry of entries) assert.match(entry, /^[CG]\d+: .+ — all \d+ tests pass$/);
  assert.match(entries[0]!, /standard error/, "the evidence for C1 is the facts about errors");
  assert.equal(forge.ref(pr.branch), pr.headSha);
  assert.deepEqual(evidenceBasis(pr.body), { criteriaCommentId: forge.issueComments.get(t2)![0]!.id, headSha: pr.headSha });
  assert.deepEqual(events.map((e) => e.event), ["pr-opened"]);

  await executor.pass();
  assert.equal(forge.prs.length, 1, "one PR per issue");
  assert.deepEqual(forge.prComments.get(pr.number) ?? [], [], "evidence already in the description is not repeated");
});

test("the executor reacts only to entail's labels and only to tickets it has prepared work for", async (t) => {
  const { forge, executor, events, issue } = await world(t);
  forge.entailComment("issue", issue("T5"), CRITERIA);
  label(forge, issue("T6"), "entail:something-else");
  label(forge, issue("T8"), CLEARED_LABEL);
  forge.entailComment("issue", issue("T8"), CRITERIA);
  label(forge, issue("T3"), CLEARED_LABEL);

  await executor.pass();
  await executor.pass();

  assert.equal(forge.prs.length, 0);
  assert.deepEqual(
    events.map((e) => [e.event, e.ticket ?? e.issue]),
    [
      ["waiting-for-criteria", "T3"],
      ["no-prepared-change", issue("T8")],
    ],
  );
});

test("an investigated issue gets the prepared findings once, one entry per question id", async (t) => {
  const { forge, executor, issue } = await world(t);
  const t11 = issue("T11");
  label(forge, t11, INVESTIGATE_LABEL);
  forge.entailComment("issue", t11, QUESTIONS);

  await executor.pass();
  await executor.pass();

  const posted = forge.issueComments.get(t11)!.slice(1);
  assert.equal(posted.length, 1);
  assert.match(posted[0]!.body, /^## entail findings\n/);
  assert.deepEqual(
    listedIds(posted[0]!.body, "Q").map((q) => q.id),
    ["Q1", "Q2"],
  );
  assert.match(posted[0]!.body, /Q1: .*a leading space counts as a word/);
});

test("T1: the first PR fails, and the fix is pushed after entail's landing comment on the failing head", async (t) => {
  const { forge, executor, events, issue } = await world(t);
  const t1 = issue("T1");
  label(forge, t1, CLEARED_LABEL);
  forge.entailComment("issue", t1, CRITERIA);

  await executor.pass();
  const pr = forge.prs[0]!;
  const failing = pr.headSha;
  assert.match(pr.body, /— 1 of \d+ tests fail$/m, "the evidence reports the failing tests honestly");

  await executor.pass();
  assert.equal(forge.ref(pr.branch), failing, "nothing is pushed before entail comments");

  forge.entailComment("pr", pr.number, `C1 met, G1 not met: the check \`test\` failed.\n\nThis PR will not be merged at \`${failing.slice(0, 7)}\`.`);
  await executor.pass();
  const fixed = forge.ref(pr.branch)!;
  assert.notEqual(fixed, failing);
  assert.equal(git(forge.remote, ["rev-parse", `${fixed}^`]).trim(), failing, "the fix is a new commit on the same PR");

  await executor.pass();
  const evidence = forge.prComments.get(pr.number)!.at(-1)!;
  assert.equal(evidenceBasis(evidence.body)?.headSha, fixed);
  assert.match(evidence.body, /^C1: .* — all \d+ tests pass$/m);

  await executor.pass();
  assert.deepEqual(
    events.map((e) => e.event),
    ["pr-opened", "fix-pushed", "evidence-posted"],
  );
});

test("a PR in conflict is rebuilt on the default branch, and new criteria get new evidence", async (t) => {
  const { forge, executor, events, issue } = await world(t);
  const t2 = issue("T2");
  label(forge, t2, CLEARED_LABEL);
  forge.entailComment("issue", t2, CRITERIA);
  await executor.pass();
  const pr = forge.prs[0]!;

  advanceMain(t, forge, "NOTES.md", "other work merged\n");
  forge.conflicted.add(pr.number);
  await executor.pass();
  const rebuilt = forge.ref(pr.branch)!;
  assert.equal(git(forge.remote, ["rev-parse", `${rebuilt}^`]).trim(), forge.ref("main"), "rebuilt on the new default branch");

  forge.conflicted.delete(pr.number);
  await executor.pass();
  assert.equal(evidenceBasis(forge.prComments.get(pr.number)!.at(-1)!.body)?.headSha, rebuilt);

  const newer = forge.entailComment("issue", t2, `Replaces the earlier intake comment.\n\n${CRITERIA}`);
  await executor.pass();
  assert.equal(evidenceBasis(forge.prComments.get(pr.number)!.at(-1)!.body)?.criteriaCommentId, newer.id);
  assert.deepEqual(
    events.map((e) => e.event),
    ["pr-opened", "pr-rebuilt", "evidence-posted", "evidence-posted"],
  );
});
