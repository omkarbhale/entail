// Writes a demo data directory for the board screenshots: one enrolled public
// repo (omkarbhale/entail) with a few calls on its public issues and one PR,
// in the log format src/records.ts reads. Nothing private: no tokens, no
// emails, no other repos. Usage: node docs/screenshots/demo-data.mjs <dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) throw new Error("usage: demo-data.mjs <data directory>");
const repo = "omkarbhale/entail";
const issues = `https://github.com/${repo}/issues`;
const owner = "Omkar";
const commit = "910e89c".padEnd(40, "0");
const vision = {
  commit,
  text: "# Vision\n\n`entail` exists so that an owner can own the vision of a product while implementation and decisions happen automatically.\n",
};
const now = Date.now();
const hoursAgo = (h) => new Date(now - h * 3600_000).toISOString();
let next = 1000;
const lines = [];
const add = (at, entry) => {
  const full = { id: ++next, at, ...entry };
  lines.push(JSON.stringify(full));
  return full;
};
const call = (at, issue, body, verdict, confirm = true) =>
  add(at, {
    type: "call",
    issue: { number: issue.number, title: issue.title, url: `${issues}/${issue.number}`, author: "omkarbhale", createdAt: issue.createdAt ?? at },
    trigger: "new",
    mentions: [],
    content: `demo-${issue.number}`,
    issueText: `# ${issue.title}\n\n${body}\n`,
    vision,
    sha: commit,
    call: verdict,
    confirm,
    owner: null,
    model: "claude-opus-5-5",
    effort: "high",
    promptVersion: "issue-call-2",
    costUsd: 0.31,
  });
const acted = (at, entry, label) =>
  add(at, {
    type: "acted",
    for: entry.id,
    issue: entry.issue.number,
    comment: { id: entry.id * 7, url: `${entry.issue.url}#issuecomment-${entry.id * 7}` },
    closed: false,
    ...(label ? { label: { label, already: false, removed: [] } } : {}),
  });
const go = (reason, visionLines, criteria) => ({ call: "go", reason, restsOn: { visionLines, cases: [] }, criteria });

add(hoursAgo(72), { type: "enrolled", by: owner, since: hoursAgo(72), confirm: true });

// The log: calls the owner already confirmed.
const c203 = call(
  hoursAgo(30),
  { number: 203, title: "Entail should require PR to link to its issue as acceptance criteria" },
  "entail follows a PR only when GitHub lists the issue under the PR's Development section, so an agent that does not link it is never picked up.",
  go(
    "Saying it in every go's criteria costs nothing and keeps agents' PRs from being missed.",
    ["It owns one thing: the product call on each ticket and each PR, made as the owner would make it, and the call on when to ask the owner instead."],
    [{ source: "reading", criterion: "Every go's criteria end with one asking for the PR to link the issue.", basis: "The issue asks for it in the criteria agents read." }],
  ),
);
acted(hoursAgo(30), c203);
const ok203 = add(hoursAgo(29), { type: "confirmed", by: owner, call: c203.id });
acted(hoursAgo(29), { ...c203, id: ok203.id }, "entail:go");

const c205 = call(
  hoursAgo(26),
  { number: 205, title: "Entail's readme reads like a documentation instead of readme" },
  "The README holds every command and flag; a reader wants what entail is and how to start.",
  go(
    "A short README with the reference moved to a guide serves both readers.",
    [],
    [
      { source: "reading", criterion: "The README says what entail is and how to start in one screen.", basis: "The issue." },
      { source: "edge", criterion: "Nothing the README held is lost: it moves to docs/guide.md.", basis: "Readers rely on the reference." },
    ],
  ),
);
acted(hoursAgo(26), c205);
const ok205 = add(hoursAgo(25), { type: "confirmed", by: owner, call: c205.id });
acted(hoursAgo(25), { ...c205, id: ok205.id }, "entail:go");

// Waiting: a go on an issue to confirm.
const c214 = call(
  hoursAgo(3),
  { number: 214, title: "Re-check open calls when VISION.md changes" },
  "When VISION.md changes, calls entail already made may no longer be the ones the owner would make: a ticket cleared under the old vision may now be a no, and a closed one may now be a go.",
  go(
    "The vision asks for exactly this: a vision change flags in-flight work that relied on the old text.",
    ["Every \"the vision settles this\" cites the passage relied on, and a vision change flags in-flight work that relied on the old text."],
    [
      { source: "vision", criterion: "A change to VISION.md on the default branch re-checks the open issues entail has called.", basis: "a vision change flags in-flight work that relied on the old text." },
      { source: "reading", criterion: "Only a call the change moves is posted again; the others are left alone.", basis: "The issue asks to leave unchanged calls alone." },
    ],
  ),
);
acted(hoursAgo(3), c214);

// Waiting: a PR to merge, on an issue entail said go on.
const c200 = call(
  hoursAgo(20),
  { number: 200, title: "Entail should handle linked issues" },
  "Issues that block on each other, and so on. entail probably shouldn't give acceptance criteria to tickets whose prerequisites haven't been met.",
  go(
    "The owner answered go: an issue blocked by open issues waits with no call until they close.",
    [],
    [
      { source: "answer", criterion: "An issue with open blockers gets no call until its blockers close.", basis: "The owner's answer on the board." },
      { source: "edge", criterion: "When the last blocker closes, the issue is judged on the next pass.", basis: "Nothing waits forever." },
    ],
  ),
);
acted(hoursAgo(20), c200);
const ok200 = add(hoursAgo(19), { type: "confirmed", by: owner, call: c200.id });
acted(hoursAgo(19), { ...c200, id: ok200.id }, "entail:go");
const pr = { number: 209, title: "feat(watch): hold blocked issues until their blockers close", url: `https://github.com/${repo}/pull/209`, author: "omkarbhale" };
add(hoursAgo(5), { type: "followed", pr, issue: 200 });
const landing = add(hoursAgo(2), {
  type: "landing",
  pr,
  issue: { number: 200, title: "Entail should handle linked issues", url: `${issues}/200` },
  issueCall: c200.id,
  issueText: "# Entail should handle linked issues\n",
  prText: `# ${pr.title}\n\nCloses #200\n`,
  head: "a".repeat(40),
  base: commit,
  vision,
  criteria: c200.call.criteria,
  facts: {
    checks: [{ name: "test", status: "passed", reported: true, url: null }],
    required: [],
    files: [
      { path: "src/watch.ts", status: "modified", previousPath: null, additions: 64, deletions: 9 },
      { path: "test/watch.test.ts", status: "modified", previousPath: null, additions: 118, deletions: 0 },
      { path: "docs/guide.md", status: "modified", previousPath: null, additions: 3, deletions: 0 },
    ],
  },
  touched: { vision: false, pins: [] },
  call: {
    call: "merge",
    reason: "It holds a blocked issue with no call and judges it once its blockers close, as the owner answered.",
    restsOn: { visionLines: [], cases: [] },
    solves: { solved: true, evidence: "src/watch.ts skips an issue whose blockers are open; the tests cover the hold and the release." },
    criteria: [
      { criterion: "An issue with open blockers gets no call until its blockers close.", met: true, evidence: "src/watch.ts and its test 'a blocked issue waits with no call'." },
      { criterion: "When the last blocker closes, the issue is judged on the next pass.", met: true, evidence: "test/watch.test.ts: 'judged once the blocker closes'." },
    ],
    beyond: [{ change: "A line in docs/guide.md on blocked issues.", sort: "needed", why: "The guide documents every behaviour." }],
    needsToChange: [],
    productCall: false,
    question: null,
    guard: null,
  },
  sendBacks: 0,
  cancel: false,
  confirm: true,
  model: "claude-opus-5-5",
  effort: "high",
  promptVersion: "pr-call-1",
  costUsd: 0.58,
});
add(hoursAgo(2), {
  type: "pr-acted",
  for: landing.id,
  pr: 209,
  comment: { id: landing.id * 7, url: `${pr.url}#issuecomment-${landing.id * 7}` },
  merged: null,
  refused: null,
  sentBack: false,
  closed: false,
});

mkdirSync(join(dir, "log", "github.com", "omkarbhale"), { recursive: true });
writeFileSync(join(dir, "log", "github.com", "omkarbhale", "entail.jsonl"), `${lines.join("\n")}\n`);
writeFileSync(join(dir, "settings.json"), `${JSON.stringify({ owner, model: "claude-opus-5-5", effort: "high" }, null, 2)}\n`);
