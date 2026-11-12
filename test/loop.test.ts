import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { BoardEvent } from "../src/api-types.ts";
import { EventBus, watchLogs } from "../src/events.ts";
import { Loop, type PassRequest } from "../src/loop.ts";
import { noticeLine, Notifier, sendNotice } from "../src/notices.ts";
import { appendEntry } from "../src/records.ts";

function scratch(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "entail-loop-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const report = { repos: 1, judged: 0, posted: 0, failed: [] as string[] };

test("passes never overlap: a check asked during a pass waits for it, then runs for its repo alone", async () => {
  const runs: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const bus = new EventBus();
  const events: BoardEvent[] = [];
  bus.on((event) => events.push(event));
  const loop = new Loop({
    intervalMs: 60_000,
    bus,
    now: () => new Date("2026-11-12T12:00:00Z"),
    pass: async (request: PassRequest & { onChecked: (repo: string, outcome: { ok: boolean; judged: number; posted: number }) => void }) => {
      runs.push(`start ${request.only?.join(",") ?? "all"}`);
      if (request.only === undefined) await gate;
      for (const repo of request.only ?? ["acme/tally", "acme/other"]) request.onChecked(repo, { ok: true, judged: repo === "acme/tally" ? 1 : 0, posted: 0 });
      runs.push(`end ${request.only?.join(",") ?? "all"}`);
      return { ...report, judged: 1 };
    },
  });
  const full = loop.request({});
  const check = loop.check("acme/tally");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(runs, ["start all"]);
  assert.equal(loop.checking, true);
  release();
  await full;
  assert.deepEqual(await check, { repo: "acme/tally", at: "2026-11-12T12:00:00.000Z", judged: 1, posted: 0, failed: false });
  assert.deepEqual(runs, ["start all", "end all", "start acme/tally", "end acme/tally"]);
  assert.equal(loop.checkedAt("acme/tally"), "2026-11-12T12:00:00.000Z");
  assert.equal(loop.lastPassAt, "2026-11-12T12:00:00.000Z");
  assert.ok(events.some((event) => event.type === "checked" && event.repo === "acme/tally" && event.judged === 1));
  assert.equal(events.at(-1)!.type, "changed");
});

test("an act-only pass runs as soon as an owner's undo window closes", async () => {
  const requests: PassRequest[] = [];
  const loop = new Loop({
    intervalMs: 60_000,
    pass: async (request) => {
      requests.push({ ...(request.only ? { only: request.only } : {}), ...(request.actOnly ? { actOnly: true } : {}) });
      return report;
    },
  });
  loop.schedule(new Date(Date.now() + 50));
  loop.schedule(new Date(Date.now() + 5_000));
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(requests, [{ actOnly: true }], "the earlier window wins, and the later one waits its turn");
});

test("the loop passes on its interval until stopped, and a wake ends the wait early", async () => {
  let passes = 0;
  const stop = new AbortController();
  const loop = new Loop({
    intervalMs: 60_000,
    pass: async () => {
      passes++;
      if (passes === 3) stop.abort();
      return report;
    },
    afterPass: async () => {
      setTimeout(() => loop.wake(), 5);
    },
  });
  await loop.run(stop.signal);
  assert.equal(passes, 3);
});

test("a notice is one line of counts and the link, never the question, and each waiting item is announced once", async (t) => {
  const directory = scratch(t);
  const sent: { line: string; link: string }[] = [];
  let command: string | null = null;
  const notifier = new Notifier({
    dataDirectory: directory,
    command: () => command,
    link: "http://127.0.0.1:4380/#/waiting",
    send: async (_command, line, link) => {
      sent.push({ line, link });
      return { ok: true };
    },
  });
  const ask = { call: "ask" as const, repo: "acme/tally", issue: { number: 11 } };
  const no = { call: "no" as const, repo: "acme/tally", issue: { number: 14 } };
  const other = { call: "go" as const, repo: "acme/other", issue: { number: 2 } };
  assert.deepEqual(await notifier.check([ask]), { sent: false, line: null }, "no command, no notice");
  command = "true";
  assert.deepEqual(await notifier.check([ask]), { sent: false, line: null }, "an item already waiting is not announced again");
  assert.deepEqual(await notifier.check([ask, no, other]), { sent: true, line: "entail: 1 question and 2 calls to confirm waiting on you across 2 repos" });
  assert.deepEqual(sent, [{ line: "entail: 1 question and 2 calls to confirm waiting on you across 2 repos", link: "http://127.0.0.1:4380/#/waiting" }]);
  await notifier.check([ask, no, other]);
  assert.equal(sent.length, 1);
  await notifier.check([no]);
  await notifier.check([no, ask]);
  assert.equal(sent.length, 2, "an issue that waits again later is announced again");
  assert.equal(noticeLine([{ call: "ask", repo: "a/b" }]), "entail: 1 question waiting on you");
});

test("the notice command runs with the line and the link as its last two arguments, and the shipped example writes them to a file", async (t) => {
  const directory = scratch(t);
  const file = join(directory, "notices.txt");
  const script = join(directory, "notice.sh");
  writeFileSync(script, `#!/bin/sh\nprintf '%s|%s|%s\\n' "$1" "$2" "$ENTAIL_NOTICE_LINE" > '${file}'\n`);
  chmodSync(script, 0o755);
  assert.deepEqual(await sendNotice(`'${script}'`, "entail: 1 question waiting on you", "http://127.0.0.1:4380/#/waiting"), { ok: true });
  assert.equal(readFileSync(file, "utf8"), "entail: 1 question waiting on you|http://127.0.0.1:4380/#/waiting|entail: 1 question waiting on you\n");

  const example = new URL("../examples/notice-to-file.sh", import.meta.url).pathname;
  const target = join(directory, "from-example.txt");
  const result = await sendNotice(`ENTAIL_NOTICE_FILE='${target}' '${example}'`, "entail: 2 calls to confirm waiting on you", "http://127.0.0.1:4380/#/waiting");
  assert.deepEqual(result, { ok: true });
  assert.match(readFileSync(target, "utf8"), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} entail: 2 calls to confirm waiting on you http:\/\/127\.0\.0\.1:4380\/#\/waiting\n$/u);

  const failing = join(directory, "fail.sh");
  writeFileSync(failing, "#!/bin/sh\necho nope >&2\nexit 3\n");
  chmodSync(failing, 0o755);
  assert.deepEqual(await sendNotice(failing, "l", "k"), { ok: false, error: "exited 3: nope" });
});

test("the board hears a change to any repo's log, from this process or another", async (t) => {
  const directory = scratch(t);
  const bus = new EventBus();
  const stop = watchLogs(directory, bus, 20);
  t.after(stop);
  const heard = new Promise<BoardEvent>((resolve) => bus.on(resolve));
  await new Promise((resolve) => setTimeout(resolve, 50));
  appendEntry(directory, "acme/tally", { type: "enrolled", by: "Omkar", since: "2026-11-12T09:00:00.000Z", confirm: true });
  assert.deepEqual(await heard, { type: "changed" });
});
