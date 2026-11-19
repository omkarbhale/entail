import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  DEFAULT_DRIFT_EVERY_DAYS,
  DRIFT_KIND,
  DRIFT_LABEL,
  DRIFT_PROMPT_VERSION,
  DRIFT_RETRY_MS,
  driftBody,
  driftDue,
  driftDueAt,
  driftMarker,
  driftPrompt,
  FIRST_CHECK_COMMITS,
  formatDrift,
  lineKey,
  markedDrift,
  markedLines,
  MAX_FINDINGS,
  readAnswer,
  readMergedWork,
  runDriftCheck,
  unfiledChecks,
  type DriftAnswer,
  type DriftForge,
  type DriftInputs,
  type FiledDrift,
} from "../src/drift.ts";
import type { Issue } from "../src/forge/forge.ts";
import { Git } from "../src/git.ts";
import { changeRepoSettings, checkSettingsChange, formatLog, logItems, repoViews } from "../src/owner.ts";
import { appendEntry, logFile, readLog, repoState, type DriftCheckedEntry } from "../src/records.ts";
import { ScriptedRunner } from "../src/scripted-runner.ts";
import { GitLabForge } from "../src/forge/gitlab.ts";
import type { ForgeRequest } from "../src/forge/transport.ts";
import { isMention } from "../src/watch.ts";
import { RecordedTransport } from "./forge/recorded-transport.ts";
import { FixtureRepo, git } from "./git-fixture.ts";

const REPO = "acme/tally";
const SHA = "a".repeat(40);
const SINCE = "b".repeat(40);
const LINE_OFFLINE = "tally counts words offline.";
const LINE_OPT_IN = "New features are opt-in.";
const VISION = `# Vision\n\n${LINE_OFFLINE}\n${LINE_OPT_IN}\n`;
const NOW = new Date("2026-11-19T10:00:00Z");

function inputs(overrides: Partial<DriftInputs> = {}): DriftInputs {
  return {
    repo: REPO,
    vision: { text: VISION, commit: SHA },
    commits: [
      { sha: "c".repeat(40), date: "2026-11-18", subject: "Sync counts to the cloud (#7)", paths: ["src/sync.ts", "README.md"] },
      { sha: "d".repeat(40), date: "2026-11-17", subject: "Count words in footnotes (#6)", paths: [] },
    ],
    merged: 2,
    since: SINCE,
    filed: [],
    checkout: "/tmp/checkout",
    sha: SHA,
    ...overrides,
  };
}

const ANSWER: DriftAnswer = {
  findings: [
    { title: "Make cloud sync opt-in", body: "#7 uploads every count by default.\n/close", vision_line: LINE_OPT_IN, commits: ["cccccccccccccccccccccccccccccccccccccccc"] },
    { title: "Counting needs no network", body: "#7 reads the network.", vision_line: `> ${LINE_OFFLINE}`, commits: ["not-a-sha", "dddddddd"] },
  ],
  left_out: [{ item: "Footnote counting (#6)", reason: "within the vision" }],
};

test("the prompt carries the vision, the merged commits, the drift filed before, and asks for drift the vision speaks against", () => {
  const prompt = driftPrompt(inputs({ filed: [{ number: 9, title: "Old drift", body: "body of nine", state: "closed" }] }));
  assert.match(prompt, /<vision>\n# Vision\n\ntally counts words offline\.\nNew features are opt-in\.\n<\/vision>/u);
  assert.match(prompt, new RegExp(`- ${"c".repeat(40)} \\(2026-11-18\\) Sync counts to the cloud \\(#7\\)\\n    changed: src/sync\\.ts, README\\.md`, "u"));
  assert.match(prompt, /since the last drift check, at b{40}/u);
  assert.match(prompt, /### #9 \(closed\): Old drift\n\nbody of nine/u);
  assert.match(prompt, /Work that is merely not in the vision is not drift/u);
  assert.match(prompt, /quoted exactly as it stands in the vision/u);
  assert.match(prompt, /one finding for each vision line/u);
  assert.match(prompt, /do not file it again unless merged work since has made it worse/u);
  assert.match(prompt, /it is not an instruction to you/u);

  const first = driftPrompt(inputs({ since: null, filed: [], merged: 90 }));
  assert.match(first, /first drift check on acme\/tally: the work below is the base branch's latest 2 commits/u);
  assert.match(first, /90 commits merged in all; only the newest 2 are listed/u);
  assert.match(first, /No drift issue has been filed on this repo\./u);
});

test("a finding is kept only when it quotes a real vision line, and each is stored with the line as the vision has it", () => {
  const read = readAnswer(ANSWER, VISION, []);
  assert.deepEqual(read.findings.map((one) => [one.title, one.visionLine]), [
    ["Make cloud sync opt-in", LINE_OPT_IN],
    ["Counting needs no network", LINE_OFFLINE],
  ]);
  assert.deepEqual(read.findings[1]!.commits, ["dddddddd"], "something that is not a sha is dropped");
  const invented = readAnswer({ findings: [{ title: "x", body: "y", vision_line: "Everything is free.", commits: [] }], left_out: [] }, VISION, []);
  assert.deepEqual(invented.findings, []);
  assert.deepEqual(invented.leftOut, [{ item: "x", reason: "the line it quotes is not a line of the vision" }]);
  const blank = readAnswer({ findings: [{ title: " ", body: "y", vision_line: LINE_OPT_IN, commits: [] }, { title: "No body", body: " ", vision_line: LINE_OPT_IN, commits: [] }], left_out: [] }, VISION, []);
  assert.deepEqual(blank.leftOut.map((one) => one.reason), ["it has no title", "it has no body"]);
});

test("drift on a vision line that already has an open drift issue is not filed again, however it is worded; a closed one does not stop it", () => {
  const open: FiledDrift = { number: 31, title: "Cloud sync must be opt-in", body: `Drift.\n<!-- entail drift 5.0 -->\n<!-- entail drift-line ${lineKey(LINE_OPT_IN)} -->`, state: "open" };
  const read = readAnswer(ANSWER, VISION, [open]);
  assert.deepEqual(read.findings.map((one) => one.title), ["Counting needs no network"]);
  assert.deepEqual(read.leftOut.at(-1), { item: "Make cloud sync opt-in", reason: "already open as #31" });

  const sameTitle = readAnswer(ANSWER, VISION, [{ number: 32, title: " counting NEEDS no network ", body: "", state: "open" }]);
  assert.deepEqual(sameTitle.findings.map((one) => one.title), ["Make cloud sync opt-in"]);
  assert.deepEqual(sameTitle.leftOut.at(-1), { item: "Counting needs no network", reason: "already open as #32" });

  const closed = readAnswer(ANSWER, VISION, [{ ...open, state: "closed" }]);
  assert.equal(closed.findings.length, 2, "an owner's answer to a closed one is the model's to weigh, from the prompt");

  const twice = readAnswer({ findings: [ANSWER.findings[0]!, { ...ANSWER.findings[0]!, title: "Another way to say it" }], left_out: [] }, VISION, []);
  assert.equal(twice.findings.length, 1);
  assert.equal(twice.leftOut.at(-1)!.reason, "another finding of this check is on the same vision line");
});

test("one check files at most five findings", () => {
  const lines = Array.from({ length: 8 }, (_, i) => `Line number ${i} of the vision.`);
  const answer: DriftAnswer = { findings: lines.map((line, i) => ({ title: `T${i}`, body: "b", vision_line: line, commits: [] })), left_out: [] };
  const read = readAnswer(answer, lines.join("\n"), []);
  assert.equal(read.findings.length, MAX_FINDINGS);
  assert.deepEqual(read.leftOut.map((one) => one.item), ["T5", "T6", "T7"]);
});

test("a filed finding says whose entail found it, quotes the vision line, never starts a line with a slash, and ends with its markers", () => {
  const [first] = readAnswer(ANSWER, VISION, []).findings;
  const body = driftBody("Omkar", 77, 1, first!);
  assert.match(body, /^Found by Omkar's entail on a scheduled check of merged work against the vision, not written by Omkar\./u);
  assert.match(body, /Drifts from the vision:\n> New features are opt-in\./u);
  assert.match(body, /Merged work: `cccccccccccc`/u);
  assert.ok(body.endsWith(`${driftMarker(77, 1)}\n<!-- entail drift-line ${lineKey(LINE_OPT_IN)} -->`));
  assert.equal(isMention(body), false, "an /entail in the finding is not a mention");
  assert.ok(body.split("\n").every((line) => !/^[ \t]*\//u.test(line)));
  assert.deepEqual(markedDrift(body), ["77.1"]);
  assert.deepEqual(markedLines(body), [lineKey(LINE_OPT_IN)]);
  assert.equal(lineKey("  > New   features are OPT-in. "), lineKey(LINE_OPT_IN), "a line is known by its words, not its spacing, case or quote mark");
  assert.throws(() => driftMarker(0, 0));
});

// Reading the merged work from git.

test("the merged work is the base branch's first-parent commits since the last check, with their paths; a first check, or a lost place, reads the latest commits", async (t) => {
  const repo = new FixtureRepo(t);
  repo.write("VISION.md", VISION).commit("start");
  const counted = repo.write("src/count.ts", "1\n").commit("Count words (#1)");
  repo.write("src/sync.ts", "2\n").write("README.md", "r\n").commit("Sync counts (#2)");
  repo.checkout("-b", "side").write("src/side.ts", "3\n").commit("work on a branch");
  repo.checkout("main");
  git(repo.work, "merge", "--quiet", "--no-ff", "-m", "Merge pull request #3", "side");
  const head = repo.head();
  const mirror = new Git(`${repo.work}/.git`);

  const since = await readMergedWork(mirror, head, counted);
  assert.equal(since.since, counted);
  assert.equal(since.merged, 2);
  assert.deepEqual(since.commits.map((one) => one.subject), ["Merge pull request #3", "Sync counts (#2)"], "the branch's own commit is not listed: the merge is the one piece of merged work");
  assert.deepEqual(since.commits[0]!.paths, ["src/side.ts"], "a merge commit shows what it brought in");
  assert.deepEqual(since.commits[1]!.paths.sort(), ["README.md", "src/sync.ts"]);
  assert.match(since.commits[1]!.date, /^\d{4}-\d{2}-\d{2}$/u);
  assert.equal(since.commits[1]!.sha.length, 40);

  const fresh = await readMergedWork(mirror, head, null);
  assert.equal(fresh.since, null);
  assert.equal(fresh.commits.length, 4);
  assert.ok(fresh.commits.length <= FIRST_CHECK_COMMITS);

  const lost = await readMergedWork(mirror, head, "e".repeat(40));
  assert.equal(lost.since, null, "a last-checked commit the branch no longer holds is read as a first check");
  const rewritten = await readMergedWork(mirror, counted, head);
  assert.equal(rewritten.since, null, "a last-checked commit that is not an ancestor is read as a first check");
  const none = await readMergedWork(mirror, head, head);
  assert.deepEqual(none.commits, []);
  assert.equal(none.since, head);
});

// A whole check.

/** A forge that files issues in memory. */
class FakeForge implements DriftForge {
  readonly setting = { forge: "github", host: "github.com", path: REPO } as const;
  readonly baseBranch = null;
  readonly issues: Issue[] = [];
  readonly created: { title: string; body: string; labels: readonly string[] }[] = [];
  failAfter: number | null = null;

  async project() {
    return { forge: "github" as const, host: "github.com", id: 5001, path: REPO, defaultBranch: "main", baseBranch: "main" };
  }

  async labelledIssues(label: string) {
    return this.issues.filter((issue) => issue.labels.includes(label));
  }

  async createIssue(title: string, body: string, labels: readonly string[]) {
    if (this.failAfter !== null && this.created.length >= this.failAfter) throw new Error("GitHub is down");
    this.created.push({ title, body, labels });
    const issue = this.issue(this.issues.length + 10, title, body, [...labels]);
    this.issues.push(issue);
    return issue;
  }

  issue(number: number, title: string, body: string, labels: string[], state: "open" | "closed" = "open"): Issue {
    const at = "2026-11-18T10:00:00Z";
    return { id: 9000 + number, number, title, body, state, author: { forge: "github", host: "github.com", id: 1001, username: "omkarbhale" }, labels, createdAt: at, updatedAt: at, url: `https://github.com/${REPO}/issues/${number}` };
  }
}

function setup(t: TestContext, options: { drift?: boolean } = {}) {
  const dataDirectory = mkdtempSync(join(tmpdir(), "entail-drift-"));
  t.after(() => rmSync(dataDirectory, { recursive: true, force: true }));
  appendEntry(dataDirectory, REPO, { type: "enrolled", by: "Omkar", since: "2026-11-01T00:00:00Z", confirm: true }, new Date("2026-11-01T00:00:00Z"));
  if (options.drift !== false) appendEntry(dataDirectory, REPO, { type: "settings", by: "Omkar", drift: true }, new Date("2026-11-01T00:00:01Z"));
  const forge = new FakeForge();
  const runner = new ScriptedRunner();
  const reads: (string | null)[] = [];
  let released = 0;
  const run = (overrides: Partial<Parameters<typeof runDriftCheck>[0]> = {}) =>
    runDriftCheck({
      dataDirectory,
      repo: REPO,
      by: "Omkar",
      trigger: "schedule",
      forge,
      read: async (_repo, _forge, since) => {
        reads.push(since);
        return { checkout: "/tmp/checkout", sha: SHA, vision: { text: VISION, commit: SHA }, commits: inputs().commits, merged: 2, since, release: async () => void released++ };
      },
      runner,
      model: "claude-sonnet-5-5",
      effort: "max",
      now: () => NOW,
      ...overrides,
    });
  return { dataDirectory, forge, runner, run, reads, released: () => released };
}

test("a check files each finding as an issue labelled entail:drift, quoting the vision line, records what it left out, and releases the checkout", async (t) => {
  const { dataDirectory, forge, runner, run, released, reads } = setup(t);
  runner.script(DRIFT_KIND, REPO, { output: ANSWER, facts: { estimatedCostUsd: 0.8 } });
  const outcome = await run();
  assert.ok(outcome.ok);
  const request = runner.requests[0]!;
  assert.equal(request.kind, DRIFT_KIND);
  assert.equal(request.model, "claude-sonnet-5-5");
  assert.equal(request.effort, "max");
  assert.equal(request.promptVersion, DRIFT_PROMPT_VERSION);
  assert.equal(request.checkout, "/tmp/checkout");
  assert.match(request.prompt, /Sync counts to the cloud/u);
  assert.deepEqual(reads, [null], "the first check reads from no earlier commit");
  assert.equal(released(), 1);

  assert.deepEqual(forge.created.map((one) => [one.title, one.labels]), [
    ["Make cloud sync opt-in", [DRIFT_LABEL]],
    ["Counting needs no network", [DRIFT_LABEL]],
  ]);
  assert.match(forge.created[0]!.body, /Drifts from the vision:\n> New features are opt-in\./u);
  assert.ok(forge.created[0]!.body.includes(`<!-- entail drift ${outcome.check.id}.0 -->`));

  const log = readLog(dataDirectory, REPO);
  const check = log.find((entry): entry is DriftCheckedEntry => entry.type === "drift-checked")!;
  assert.equal(check.trigger, "schedule");
  assert.equal(check.sha, SHA);
  assert.equal(check.since, null);
  assert.equal(check.commits, 2);
  assert.equal(check.costUsd, 0.8);
  assert.equal(check.skipped, null);
  assert.deepEqual(check.leftOut, [{ item: "Footnote counting (#6)", reason: "within the vision" }]);
  assert.deepEqual(
    log.flatMap((entry) => (entry.type === "drift-filed" ? [[entry.index, entry.issue.number, entry.already]] : [])),
    [
      [0, 10, false],
      [1, 11, false],
    ],
  );
  assert.equal(unfiledChecks(log).length, 0);
  assert.ok(log.every((entry) => entry.type !== "suggested" && entry.type !== "call"), "nothing goes to the board: no call, and no question is raised");
  assert.match(formatDrift(check, outcome.filed), /1\. Make cloud sync opt-in\n {3}filed as https:\/\/github\.com\/acme\/tally\/issues\/10\n {3}drifts from the vision: > New features are opt-in\./u);
});

test("a re-run does not file a duplicate issue for drift that already has an open drift issue, even when the model words it differently or the log lost the record", async (t) => {
  const { dataDirectory, forge, runner, run } = setup(t);
  runner.script(DRIFT_KIND, REPO, { output: ANSWER });
  await run();
  assert.equal(forge.created.length, 2);

  // The next check reads the last-checked commit and the open drift issues; the model repeats itself in new words.
  runner.script(DRIFT_KIND, REPO, { output: { findings: [{ title: "Sync must be switched on by the user", body: "Still on by default.", vision_line: LINE_OPT_IN, commits: [] }], left_out: [] } });
  const second = await run({ read: async (_repo, _forge, since) => ({ checkout: "/c", sha: SHA, vision: { text: VISION, commit: SHA }, commits: inputs().commits, merged: 2, since, release: async () => {} }) });
  assert.ok(second.ok);
  assert.equal(forge.created.length, 2, "nothing new is filed");
  assert.deepEqual(second.check.findings, []);
  assert.deepEqual(second.check.leftOut.at(-1), { item: "Sync must be switched on by the user", reason: "already open as #10" });
  assert.match(runner.requests[1]!.prompt, /### #10 \(open\): Make cloud sync opt-in/u, "the open drift issues are read so the model does not report them again");
  assert.match(runner.requests[1]!.prompt, new RegExp(`since the last drift check, at ${SHA}`, "u"));

  // A finding that was recorded but whose record of filing is lost is found by its marker, not filed twice.
  const lost = readLog(dataDirectory, REPO).filter((entry) => entry.type !== "drift-filed");
  writeFileSync(logFile(dataDirectory, REPO), lost.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  assert.equal(unfiledChecks(readLog(dataDirectory, REPO)).length, 1);
  runner.script(DRIFT_KIND, REPO, { output: { findings: [], left_out: [] } });
  await run();
  assert.equal(forge.created.length, 2, "each filed once");
  const filed = readLog(dataDirectory, REPO).filter((entry) => entry.type === "drift-filed");
  assert.deepEqual(filed.map((entry) => entry.type === "drift-filed" && entry.already), [true, true]);
});

test("a check cut off while filing files only the rest on the next check, finding by its marker what went out before it was recorded", async (t) => {
  const { dataDirectory, forge, runner, run } = setup(t);
  forge.failAfter = 1;
  runner.script(DRIFT_KIND, REPO, { output: ANSWER });
  await assert.rejects(run(), /GitHub is down/u);
  assert.equal(forge.created.length, 1);
  const checkId = readLog(dataDirectory, REPO).find((entry) => entry.type === "drift-checked")!.id;

  // As if entail stopped between filing the first issue and recording it.
  const withoutRecord = readLog(dataDirectory, REPO).filter((entry) => entry.type !== "drift-filed");
  writeFileSync(logFile(dataDirectory, REPO), withoutRecord.map((entry) => JSON.stringify(entry)).join("\n") + "\n");

  forge.failAfter = null;
  runner.script(DRIFT_KIND, REPO, { output: { findings: [], left_out: [] } });
  assert.ok((await run()).ok);
  assert.deepEqual(forge.created.map((one) => one.title), ["Make cloud sync opt-in", "Counting needs no network"], "each filed once");
  const filed = readLog(dataDirectory, REPO).filter((entry) => entry.type === "drift-filed");
  assert.deepEqual(filed.map((entry) => entry.type === "drift-filed" && [entry.for, entry.index, entry.already]), [
    [checkId, 0, true],
    [checkId, 1, false],
  ]);
});

test("nothing is run when nothing merged since the last check or the repo has no VISION.md: the check is recorded as skipped, with why", async (t) => {
  const { dataDirectory, runner, run } = setup(t);
  const quiet = await run({ read: async (_repo, _forge, since) => ({ checkout: "/c", sha: SHA, vision: { text: VISION, commit: SHA }, commits: [], merged: 0, since: since ?? SINCE, release: async () => {} }) });
  assert.ok(quiet.ok);
  assert.equal(quiet.check.skipped, "nothing has merged since the last check");
  assert.equal(quiet.check.model, null);
  assert.equal(runner.requests.length, 0, "no model run is made");
  const bare = await run({ read: async (_repo, _forge, since) => ({ checkout: "/c", sha: SHA, vision: null, commits: inputs().commits, merged: 2, since, release: async () => {} }) });
  assert.ok(bare.ok);
  assert.match(bare.check.skipped ?? "", /no VISION\.md/u);
  assert.equal(runner.requests.length, 0);
  assert.equal(driftDue(readLog(dataDirectory, REPO), new Date(NOW.getTime() + 60_000)), false, "a skipped check counts: the schedule moves on");
  assert.match(formatDrift(quiet.check, []), /^Nothing checked: nothing has merged since the last check\.$/u);
});

test("a check that gives no answer, or stops before one, is recorded with why, files nothing and is tried again sooner than usual", async (t) => {
  const { dataDirectory, forge, runner, run, released } = setup(t);
  runner.script(DRIFT_KIND, REPO, { failure: { kind: "timeout", message: "the run was ended after 20 minutes" } });
  const outcome = await run();
  assert.equal(outcome.ok, false);
  assert.equal(forge.created.length, 0);
  const failed = readLog(dataDirectory, REPO).at(-1)!;
  assert.equal(failed.type, "drift-failed");
  assert.match(failed.type === "drift-failed" ? failed.reason : "", /\(timeout\): the run was ended after 20 minutes/u);
  assert.equal(released(), 1);
  assert.equal(driftDueAt(readLog(dataDirectory, REPO))!.getTime(), NOW.getTime() + DRIFT_RETRY_MS);

  const broke = await run({
    read: async () => {
      throw new Error("git: the mirror is gone");
    },
  });
  assert.equal(broke.ok, false);
  assert.match(broke.ok ? "" : broke.failed.reason, /stopped before it answered: git: the mirror is gone/u);
  assert.equal(repoViews(dataDirectory, { owner: null, model: "m", effort: "high" }, { all: true })[0]!.driftCheck?.last?.state, "failed");
});

// The setting and the schedule.

test("whether the check runs and how often is a per-repo setting, off until turned on, checked as the board and the CLI send it, and logged under the owner's name", (t) => {
  const { dataDirectory } = setup(t, { drift: false });
  assert.equal(repoState(REPO, readLog(dataDirectory, REPO)).drift, false);
  assert.equal(repoViews(dataDirectory, { owner: null, model: "m", effort: "high" })[0]!.driftCheck, null, "off, and never run: nothing to show");
  assert.deepEqual(checkSettingsChange({ drift: true, driftEveryDays: 3 }), { drift: true, driftEveryDays: 3 });
  assert.deepEqual(checkSettingsChange({ driftEveryDays: null }), { driftEveryDays: null });
  for (const bad of [{ drift: "yes" }, { driftEveryDays: 0 }, { driftEveryDays: 1.5 }, { driftEveryDays: "7" }, { driftEveryDays: 366 }, { driftEveryDays: -1 }]) {
    assert.throws(() => checkSettingsChange(bad), /drift/u, JSON.stringify(bad));
  }
  const state = changeRepoSettings(dataDirectory, REPO, "Omkar", { drift: true, driftEveryDays: 3 }, NOW);
  assert.equal(state.drift, true);
  assert.equal(state.driftEveryDays, 3);
  assert.equal(changeRepoSettings(dataDirectory, REPO, "Omkar", { drift: true, driftEveryDays: 3 }, NOW).drift, true);
  assert.equal(readLog(dataDirectory, REPO).filter((entry) => entry.type === "settings").length, 1, "a change to what it already is is not logged");
  assert.equal(changeRepoSettings(dataDirectory, REPO, "Omkar", { driftEveryDays: null }, NOW).driftEveryDays, null);
  assert.equal(changeRepoSettings(dataDirectory, REPO, "Omkar", { drift: false }, NOW).drift, false);
  const text = formatLog(logItems(dataDirectory, []), { repoColumn: true });
  assert.match(text, /Omkar set drift check on, drift check every 3 days/u);
  assert.match(text, /Omkar set drift check every the default 7 days/u);
  assert.match(text, /Omkar set drift check off/u);
});

test("a check is due at once when first turned on, then every interval after the last attempt; off, or not enrolled, it is never due", (t) => {
  const { dataDirectory } = setup(t);
  const entries = () => readLog(dataDirectory, REPO);
  assert.equal(driftDue(entries(), NOW), true, "never run: due now");
  const day = 24 * 60 * 60 * 1000;
  appendEntry(dataDirectory, REPO, { type: "drift-checked", trigger: "schedule", sha: SHA, since: null, commits: 1, visionCommit: SHA, findings: [], leftOut: [], skipped: null, model: "m", effort: "low", promptVersion: "x", costUsd: null }, NOW);
  assert.equal(driftDueAt(entries())!.getTime(), NOW.getTime() + DEFAULT_DRIFT_EVERY_DAYS * day);
  assert.equal(driftDue(entries(), new Date(NOW.getTime() + 6 * day)), false);
  assert.equal(driftDue(entries(), new Date(NOW.getTime() + 7 * day)), true);
  changeRepoSettings(dataDirectory, REPO, "Omkar", { driftEveryDays: 2 }, NOW);
  assert.equal(driftDue(entries(), new Date(NOW.getTime() + 2 * day)), true, "the repo's own interval applies to the last check");
  assert.equal(repoViews(dataDirectory, { owner: null, model: "m", effort: "high" })[0]!.driftCheck!.nextAt, new Date(NOW.getTime() + 2 * day).toISOString());
  changeRepoSettings(dataDirectory, REPO, "Omkar", { drift: false }, NOW);
  assert.equal(driftDueAt(entries()), null);
  assert.equal(driftDue(entries(), new Date(NOW.getTime() + 99 * day)), false);
  changeRepoSettings(dataDirectory, REPO, "Omkar", { drift: true }, NOW);
  appendEntry(dataDirectory, REPO, { type: "unenrolled", by: "Omkar" }, NOW);
  assert.equal(driftDueAt(entries()), null, "an unenrolled repo is not checked");
});

test("a check on a GitLab project reads its drift issues and files its findings through the GitLab adapter the same way", async (t) => {
  const host = "gitlab.example.org";
  const project = "projects/acme%2Ftally";
  const order = "order_by=created_at&sort=asc&per_page=100";
  const at = "2026-11-18T10:00:00Z";
  const gitlabIssue = (iid: number, title: string, extra: Record<string, unknown> = {}) => ({
    id: 9000 + iid, iid, title, description: "", state: "opened", author: { id: 7, username: "owner" }, labels: [], user_notes_count: 0, created_at: at, updated_at: at, web_url: `https://${host}/acme/tally/-/issues/${iid}`, ...extra,
  });
  const page = (body: unknown[]) => ({ status: 200, headers: { "X-Next-Page": "" }, body });
  const openDrift = gitlabIssue(2, "Counting needs no network", { labels: ["entail:drift"], description: `<!-- entail drift-line ${lineKey(LINE_OFFLINE)} -->` });
  const labelled = { request: { method: "GET" as const, path: `${project}/issues?state=all&labels=entail%3Adrift&${order}` }, response: page([openDrift]) };
  const label = { request: { method: "GET" as const, path: `${project}/labels/entail%3Adrift` }, response: { status: 200, body: { name: "entail:drift" } } };
  const transport = new RecordedTransport({
    host,
    exchanges: [
      labelled,
      labelled,
      label,
      { request: { method: "POST", path: `${project}/issues` }, response: { status: 201, body: gitlabIssue(11, "Make cloud sync opt-in", { labels: ["entail:drift"] }) } },
    ],
  });
  t.after(() => transport.assertDone());
  const sentBodies: unknown[] = [];
  const seam = {
    request: (request: ForgeRequest) => {
      if (request.method !== "POST") return transport.request(request);
      sentBodies.push(request.body);
      return transport.request({ ...request, body: undefined });
    },
  };
  const { dataDirectory, runner, run } = setup(t);
  runner.script(DRIFT_KIND, REPO, { output: ANSWER });
  const outcome = await run({ forge: new GitLabForge({ forge: "gitlab", host, path: "acme/tally" }, seam) });
  assert.ok(outcome.ok);
  assert.match(runner.requests[0]!.prompt, /### #2 \(open\): Counting needs no network/u);
  assert.deepEqual(outcome.check.findings.map((one) => one.title), ["Make cloud sync opt-in"], "drift already open on a vision line is not filed again");
  assert.deepEqual(outcome.check.leftOut.at(-1), { item: "Counting needs no network", reason: "already open as #2" });
  assert.deepEqual(outcome.filed.map((one) => one.issue.url), [`https://${host}/acme/tally/-/issues/11`]);
  const sent = sentBodies as { title: string; description: string; labels: string }[];
  assert.deepEqual(sent.map((one) => [one.title, one.labels]), [["Make cloud sync opt-in", "entail:drift"]]);
  assert.ok(sent[0]!.description.includes(`<!-- entail drift ${outcome.check.id}.0 -->`));
  assert.equal(readLog(dataDirectory, REPO).filter((entry) => entry.type === "drift-filed").length, 1);
});
