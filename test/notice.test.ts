import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { DEFAULT_GLOBAL_SETTINGS, readGlobalSettings } from "../src/global-settings.ts";
import {
  desktopCommand,
  desktopMethodFor,
  DesktopNoticeConnector,
  FileNoticeConnector,
  InvalidNoticeError,
  isWsl,
  makeNotice,
  NOTICES_FILE,
  Notifier,
  toastScript,
  type DesktopCommand,
  type Notice,
  type NoticeConnector,
} from "../src/notice.ts";
import { OPERATIONAL_LOG_FILE, OperationalLog } from "../src/operational-log.ts";
import { Store } from "../src/store.ts";

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "entail-notice-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const boardItem = (): Notice =>
  makeNotice({
    kind: "board-item",
    text: "An item is waiting on the board.",
    repo: "acme/tally",
    link: "http://127.0.0.1:7419/board/items/12",
  });

const health = (): Notice =>
  makeNotice({ kind: "health", text: "gh is logged out for github.com.", link: "http://127.0.0.1:7419/repos" });

function lines(path: string): unknown[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

// The notice's shape

test("a notice keeps only its kind, one line of text, the repo and a link", () => {
  const input = {
    kind: "board-item" as const,
    text: "  An item is waiting on the board.  ",
    repo: "acme/tally",
    link: "http://127.0.0.1:7419/board/items/12",
    question: "Should exports include archived rows?",
    issueText: "Please add archived rows to the export.",
  };
  const notice = makeNotice(input);

  assert.deepEqual(Object.keys(notice).sort(), ["kind", "link", "repo", "text"]);
  assert.equal(notice.text, "An item is waiting on the board.");
  assert.ok(Object.isFrozen(notice));
  assert.doesNotMatch(JSON.stringify(notice), /archived/);
});

test("a health notice may have no repo, and a board-item notice must name one", () => {
  assert.equal(health().repo, null);
  assert.throws(
    () => makeNotice({ kind: "board-item", text: "x", repo: undefined as unknown as string, link: "http://127.0.0.1/" }),
    InvalidNoticeError,
  );
});

test("a notice's text is one short line, so no question or issue body fits in it", () => {
  const link = "http://127.0.0.1:7419/repos";
  for (const text of ["", "   ", "first line\nsecond line", "a\rb", "a\u2028b", "x".repeat(201)]) {
    assert.throws(() => makeNotice({ kind: "health", text, link }), InvalidNoticeError, JSON.stringify(text));
  }
  assert.equal(makeNotice({ kind: "health", text: "x".repeat(200), link }).text.length, 200);
});

test("a notice's link is an http or https URL and its kind is board-item or health", () => {
  for (const link of ["", "/repos", "javascript:alert(1)", "file:///etc/passwd"]) {
    assert.throws(() => makeNotice({ kind: "health", text: "x", link }), InvalidNoticeError, link);
  }
  assert.throws(
    () => makeNotice({ kind: "question" as "health", text: "x", link: "http://127.0.0.1/" }),
    InvalidNoticeError,
  );
});

// The file connector

test("the file connector appends exactly one JSON line per notice to notices.jsonl", async (t) => {
  const dir = tempDir(t);
  const connector = new FileNoticeConnector(dir, { now: () => new Date(Date.UTC(2026, 10, 8, 9, 40)) });
  assert.equal(connector.path, join(dir, NOTICES_FILE));

  await connector.send(boardItem());
  await connector.send(health());
  await connector.send(boardItem());

  const written = readFileSync(connector.path, "utf8");
  assert.ok(written.endsWith("\n"));
  assert.deepEqual(lines(connector.path), [
    {
      time: "2026-11-08T09:40:00.000Z",
      kind: "board-item",
      text: "An item is waiting on the board.",
      repo: "acme/tally",
      link: "http://127.0.0.1:7419/board/items/12",
    },
    {
      time: "2026-11-08T09:40:00.000Z",
      kind: "health",
      text: "gh is logged out for github.com.",
      repo: null,
      link: "http://127.0.0.1:7419/repos",
    },
    {
      time: "2026-11-08T09:40:00.000Z",
      kind: "board-item",
      text: "An item is waiting on the board.",
      repo: "acme/tally",
      link: "http://127.0.0.1:7419/board/items/12",
    },
  ]);
});

test("the file connector rejects when it cannot append", async (t) => {
  const connector = new FileNoticeConnector(join(tempDir(t), "missing"));
  await assert.rejects(connector.send(boardItem()));
});

// The desktop connector

test("WSL is detected from the kernel release", () => {
  assert.ok(isWsl("6.6.87.2-microsoft-standard-WSL2"));
  assert.ok(isWsl("4.4.0-19041-Microsoft"));
  assert.ok(!isWsl("6.8.0-45-generic"));
  assert.ok(!isWsl("23.6.0"));
});

test("desktop picks notify-send on Linux, osascript on macOS and a powershell.exe toast on WSL", () => {
  assert.equal(desktopMethodFor({ platform: "linux", kernelRelease: "6.8.0-45-generic" }), "notify-send");
  assert.equal(desktopMethodFor({ platform: "darwin", kernelRelease: "23.6.0" }), "osascript");
  assert.equal(desktopMethodFor({ platform: "linux", kernelRelease: "6.6.87.2-microsoft-standard-WSL2" }), "powershell");
  assert.throws(() => desktopMethodFor({ platform: "win32", kernelRelease: "10.0.22631" }));

  const ran: DesktopCommand[] = [];
  const run = async (command: DesktopCommand) => void ran.push(command);
  const platforms = [
    { platform: "linux", kernelRelease: "6.8.0-45-generic" },
    { platform: "darwin", kernelRelease: "23.6.0" },
    { platform: "linux", kernelRelease: "5.15.167.4-microsoft-standard-WSL2" },
  ] as const;
  for (const platform of platforms) {
    void new DesktopNoticeConnector({ platform, run }).send(boardItem());
  }
  assert.deepEqual(
    ran.map((command) => command.file),
    ["notify-send", "osascript", "powershell.exe"],
  );
});

test("notify-send gets the title and body as arguments after --", () => {
  const command = desktopCommand("notify-send", boardItem());
  assert.deepEqual(command, {
    file: "notify-send",
    args: [
      "--app-name=entail",
      "--",
      "entail: acme/tally",
      "An item is waiting on the board.\nhttp://127.0.0.1:7419/board/items/12",
    ],
  });
  assert.equal(desktopCommand("notify-send", health()).args[2], "entail");
});

test("osascript gets the text as arguments, never inside its script", () => {
  const notice = makeNotice({
    kind: "board-item",
    text: `say "hi" & do shell script "id"`,
    repo: "acme/tally",
    link: "http://127.0.0.1:7419/board/items/12",
  });
  const command = desktopCommand("osascript", notice);
  assert.equal(command.file, "osascript");
  const script = command.args.filter((_, i) => command.args[i - 1] === "-e");
  assert.deepEqual(script, ["on run argv", "display notification (item 2 of argv) with title (item 1 of argv)", "end run"]);
  assert.deepEqual(command.args.slice(-2), ["entail: acme/tally", `${notice.text}\n${notice.link}`]);
});

test("the WSL toast carries its text only as base64, so no text can break out of the script", () => {
  const notice = makeNotice({
    kind: "board-item",
    text: `'); Remove-Item C:\\ -Recurse; ('<toast>’`,
    repo: "acme/tally",
    link: "http://127.0.0.1:7419/board/items/12",
  });
  const command = desktopCommand("powershell", notice);
  assert.equal(command.file, "powershell.exe");
  assert.deepEqual(command.args.slice(0, -1), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);

  const script = Buffer.from(command.args.at(-1)!, "base64").toString("utf16le");
  assert.equal(script, toastScript(notice));
  assert.doesNotMatch(script, /Remove-Item/);
  const decoded = [...script.matchAll(/Decode '([A-Za-z0-9+/=]*)'/g)].map((m) => Buffer.from(m[1]!, "base64").toString("utf8"));
  assert.deepEqual(decoded, ["entail: acme/tally", notice.text, notice.link, notice.link]);
});

test("the desktop connector rejects when its command fails", async () => {
  const connector = new DesktopNoticeConnector({
    platform: { platform: "linux", kernelRelease: "6.8.0-45-generic" },
    run: async () => {
      throw new Error("notify-send failed: spawn notify-send ENOENT");
    },
  });
  await assert.rejects(connector.send(health()), /ENOENT/);
});

// The notifier

function recording(name: "desktop" | "file", fail = false): NoticeConnector & { sent: Notice[] } {
  const sent: Notice[] = [];
  return {
    name,
    sent,
    async send(notice) {
      if (fail) throw new Error(`${name} could not hand the notice over`);
      sent.push(notice);
    },
  };
}

test("the connector is the one the global settings name, from the next notice", async (t) => {
  const dir = tempDir(t);
  const store = Store.openIn(dir);
  t.after(() => store.close());
  const log = new OperationalLog(dir, { echo: null });
  const desktop = recording("desktop");
  const notifier = new Notifier({
    connectorName: () => readGlobalSettings(store).settings.noticeConnector,
    connectors: { desktop },
    dataDirectory: dir,
    log,
  });

  assert.equal(await notifier.notify(boardItem()), true, "desktop is the default");
  assert.equal(desktop.sent.length, 1);

  store.saveGlobalSettings({ ...DEFAULT_GLOBAL_SETTINGS, ownerDisplayName: "Ada", noticeConnector: "file" }, "Ada");
  assert.equal(await notifier.notify(boardItem()), true);
  assert.equal(await notifier.notify(health()), true);
  assert.equal(desktop.sent.length, 1, "nothing more went to the desktop");
  assert.equal(lines(join(dir, NOTICES_FILE)).length, 2, "the real file connector took the next notices");

  store.saveGlobalSettings({ ...DEFAULT_GLOBAL_SETTINGS, ownerDisplayName: "Ada", noticeConnector: "desktop" }, "Ada");
  await notifier.notify(health());
  assert.equal(desktop.sent.length, 2);
  assert.equal(lines(join(dir, NOTICES_FILE)).length, 2);
});

test("a failed send is logged, recorded as the last notice failed, never retried, and never thrown", async (t) => {
  const dir = tempDir(t);
  const log = new OperationalLog(dir, { echo: null });
  let attempts = 0;
  const failing: NoticeConnector = {
    name: "desktop",
    async send() {
      attempts++;
      throw new Error("powershell.exe failed: toast refused");
    },
  };
  const notifier = new Notifier({
    connectorName: () => "desktop",
    connectors: { desktop: failing },
    dataDirectory: dir,
    log,
    now: () => new Date(Date.UTC(2026, 10, 8, 9, 40)),
  });

  assert.equal(notifier.lastFailure, null);
  assert.equal(await notifier.notify(boardItem()), false);
  assert.equal(attempts, 1, "one attempt per notice");
  assert.deepEqual(notifier.lastFailure, {
    at: new Date(Date.UTC(2026, 10, 8, 9, 40)),
    connector: "desktop",
    kind: "board-item",
    error: "powershell.exe failed: toast refused",
  });

  const logged = lines(join(dir, OPERATIONAL_LOG_FILE)) as Record<string, unknown>[];
  assert.equal(logged.length, 1);
  assert.equal(logged[0]!.event, "notice-failed");
  assert.equal(logged[0]!.level, "warn");
  assert.equal(logged[0]!.connector, "desktop");
  assert.equal(logged[0]!.kind, "board-item");
  assert.equal(logged[0]!.repo, "acme/tally");
  assert.equal(logged[0]!.error, "powershell.exe failed: toast refused");
});

test("the next notice handed over clears the last notice failed", async (t) => {
  const dir = tempDir(t);
  let fail = true;
  const notifier = new Notifier({
    connectorName: () => "desktop",
    connectors: {
      desktop: {
        name: "desktop",
        async send() {
          if (fail) throw new Error("refused");
        },
      },
    },
    dataDirectory: dir,
    log: new OperationalLog(dir, { echo: null }),
  });
  await notifier.notify(health());
  assert.notEqual(notifier.lastFailure, null);
  fail = false;
  assert.equal(await notifier.notify(health()), true);
  assert.equal(notifier.lastFailure, null);
});

test("a notice blocks nothing even when the settings or the log cannot be read or written", async (t) => {
  const dir = tempDir(t);
  const brokenLog = new OperationalLog(join(dir, "missing"), { echo: null });
  const notifier = new Notifier({
    connectorName: () => {
      throw new Error("store closed");
    },
    dataDirectory: dir,
    log: brokenLog,
  });
  assert.equal(await notifier.notify(boardItem()), false);
  assert.equal(notifier.lastFailure?.connector, null);
  assert.equal(notifier.lastFailure?.error, "store closed");
  assert.ok(!existsSync(join(dir, NOTICES_FILE)));
});
