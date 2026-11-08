import { execFile } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { release } from "node:os";
import { join } from "node:path";
import type { NoticeConnectorName } from "./global-settings.ts";
import type { OperationalLog } from "./operational-log.ts";

/** What a notice is about: a board item raised, or a halt the owner must fix (spec §13, §16). */
export const NOTICE_KINDS = ["board-item", "health"] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** A notice's text is one short line entail writes itself. */
export const NOTICE_TEXT_LIMIT = 200;

declare const noticeBrand: unique symbol;

/**
 * A notice tells the owner that something is waiting, and nothing more
 * (spec §13, ADR-0017, ADR-0019). It carries only its kind, one line of text,
 * the repo when there is one, and a link: the board item for `board-item`,
 * the Repos page for `health`.
 *
 * It has no field for question text or issue text, so nothing a reporter
 * wrote reaches the owner's desktop, and it takes no answer. Only
 * {@link makeNotice} makes one: it keeps these four fields and nothing else,
 * holds the text to one short line, and freezes the result.
 */
export type Notice = {
  readonly kind: NoticeKind;
  readonly text: string;
  readonly repo: string | null;
  readonly link: string;
} & { readonly [noticeBrand]: true };

export type NoticeInput =
  | { kind: "board-item"; text: string; repo: string; link: string }
  | { kind: "health"; text: string; repo?: string | null; link: string };

export class InvalidNoticeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidNoticeError";
  }
}

const LINE_BREAK_OR_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Makes a {@link Notice}, throwing {@link InvalidNoticeError} when the input does not fit its shape. */
export function makeNotice(input: NoticeInput): Notice {
  const { kind } = input;
  if (!(NOTICE_KINDS as readonly string[]).includes(kind)) {
    throw new InvalidNoticeError(`A notice's kind is one of ${NOTICE_KINDS.join(", ")}.`);
  }
  const text = oneLine(input.text, "text", NOTICE_TEXT_LIMIT);
  const repo = input.repo === undefined || input.repo === null ? null : oneLine(input.repo, "repo", NOTICE_TEXT_LIMIT);
  if (kind === "board-item" && repo === null) {
    throw new InvalidNoticeError("A board-item notice names its repo.");
  }
  const link = oneLine(input.link, "link", 2048);
  if (!URL.canParse(link) || !["http:", "https:"].includes(new URL(link).protocol)) {
    throw new InvalidNoticeError("A notice's link is an http or https URL.");
  }
  return Object.freeze({ kind, text, repo, link }) as Notice;
}

function oneLine(value: unknown, field: string, limit: number): string {
  if (typeof value !== "string") throw new InvalidNoticeError(`A notice's ${field} is a string.`);
  const trimmed = value.trim();
  if (trimmed === "") throw new InvalidNoticeError(`A notice's ${field} is not empty.`);
  if (LINE_BREAK_OR_CONTROL.test(trimmed)) throw new InvalidNoticeError(`A notice's ${field} is one line.`);
  if (trimmed.length > limit) throw new InvalidNoticeError(`A notice's ${field} is at most ${limit} characters.`);
  return trimmed;
}

/**
 * How a notice reaches the owner. `send` resolves once the notice was handed
 * over and rejects otherwise (spec §13). A later channel is a new connector
 * behind this interface.
 */
export interface NoticeConnector {
  readonly name: NoticeConnectorName;
  send(notice: Notice): Promise<void>;
}

/** The notice's four fields as a plain object, the only part of it a connector passes on. */
function fieldsOf(notice: Notice): { kind: NoticeKind; text: string; repo: string | null; link: string } {
  return { kind: notice.kind, text: notice.text, repo: notice.repo, link: notice.link };
}

export const NOTICES_FILE = "notices.jsonl";

/**
 * The `file` connector: appends each notice as one JSON line to
 * `notices.jsonl` in the data directory. The acceptance test selects it on
 * the global settings page and counts its lines (spec §13, §19).
 */
export class FileNoticeConnector implements NoticeConnector {
  readonly name = "file";
  readonly path: string;
  readonly #now: () => Date;

  constructor(dataDirectory: string, options: { now?: () => Date } = {}) {
    this.path = join(dataDirectory, NOTICES_FILE);
    this.#now = options.now ?? (() => new Date());
  }

  async send(notice: Notice): Promise<void> {
    // One write per line, so a line is never split by another writer's append.
    const line = `${JSON.stringify({ time: this.#now().toISOString(), ...fieldsOf(notice) })}\n`;
    await appendFile(this.path, line, { mode: 0o600 });
  }
}

/** The program a desktop notice goes through on this machine. */
export type DesktopMethod = "notify-send" | "osascript" | "powershell";

export interface DesktopPlatform {
  platform: NodeJS.Platform;
  /** The kernel release, as `uname -r` prints it. */
  kernelRelease: string;
}

/**
 * WSL's kernel names itself in its release, such as
 * `6.6.87.2-microsoft-standard-WSL2` or, on WSL 1, `4.4.0-19041-Microsoft`.
 */
export function isWsl(kernelRelease: string): boolean {
  return /microsoft|wsl/i.test(kernelRelease);
}

/**
 * Linux uses `notify-send`; macOS uses `osascript`; WSL uses a Windows toast
 * through `powershell.exe`, because the owner's desktop there is Windows and
 * `notify-send` usually reaches nothing (ADR-0017).
 */
export function desktopMethodFor({ platform, kernelRelease }: DesktopPlatform): DesktopMethod {
  if (platform === "darwin") return "osascript";
  if (platform === "linux") return isWsl(kernelRelease) ? "powershell" : "notify-send";
  throw new Error(`entail has no desktop notice for ${platform}`);
}

/** One program run that hands a notice to the desktop. */
export interface DesktopCommand {
  file: string;
  args: string[];
}

/** The notice's title: entail, and the repo when there is one. */
function titleOf(notice: Notice): string {
  return notice.repo === null ? "entail" : `entail: ${notice.repo}`;
}

/** The notice's body: its line of text, then its link. */
function bodyOf(notice: Notice): string {
  return `${notice.text}\n${notice.link}`;
}

/**
 * The PowerShell AppUserModelID Windows shows toasts under. An unregistered
 * id shows nothing, and registering one would need an install step.
 */
const POWERSHELL_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

/**
 * The toast script. Each value goes in as base64 of its UTF-8 bytes, so no
 * notice text can end a string literal, and is placed with `CreateTextNode`
 * and `SetAttribute`, so none is read as XML. Clicking the toast opens the link.
 */
export function toastScript(notice: Notice): string {
  const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");
  return [
    "$ErrorActionPreference = 'Stop'",
    "function Decode([string]$s) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)) }",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
    "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$xml.LoadXml('<toast activationType="protocol"><visual><binding template="ToastGeneric"><text/><text/><text/></binding></visual></toast>')`,
    "$lines = $xml.GetElementsByTagName('text')",
    `$lines.Item(0).AppendChild($xml.CreateTextNode((Decode '${b64(titleOf(notice))}'))) | Out-Null`,
    `$lines.Item(1).AppendChild($xml.CreateTextNode((Decode '${b64(notice.text)}'))) | Out-Null`,
    `$lines.Item(2).AppendChild($xml.CreateTextNode((Decode '${b64(notice.link)}'))) | Out-Null`,
    `$xml.DocumentElement.SetAttribute('launch', (Decode '${b64(notice.link)}'))`,
    "$toast = New-Object Windows.UI.Notifications.ToastNotification $xml",
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${POWERSHELL_APP_ID}').Show($toast)`,
  ].join("\n");
}

/** The command that shows a notice by the given method. No notice text is ever parsed as code. */
export function desktopCommand(method: DesktopMethod, notice: Notice): DesktopCommand {
  switch (method) {
    case "notify-send":
      // `--` ends the options, so a title starting with a dash is still a title.
      return { file: "notify-send", args: ["--app-name=entail", "--", titleOf(notice), bodyOf(notice)] };
    case "osascript":
      // The text goes in as the script's arguments, never into the script itself.
      return {
        file: "osascript",
        args: [
          "-e",
          "on run argv",
          "-e",
          "display notification (item 2 of argv) with title (item 1 of argv)",
          "-e",
          "end run",
          titleOf(notice),
          bodyOf(notice),
        ],
      };
    case "powershell": {
      const encoded = Buffer.from(toastScript(notice), "utf16le").toString("base64");
      return {
        file: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      };
    }
  }
}

/** Runs a desktop command, rejecting when it cannot start, times out or exits non-zero. */
export type CommandRunner = (command: DesktopCommand, timeoutMs: number) => Promise<void>;

/** At most this much of a failed command's output goes into its error. */
const OUTPUT_KEPT = 2000;

export const runCommand: CommandRunner = (command, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(command.file, command.args, { timeout: timeoutMs, windowsHide: true }, (error, _stdout, stderr) => {
      if (error === null) return resolve();
      const output = String(stderr ?? "").trim().slice(-OUTPUT_KEPT);
      reject(new Error(output === "" ? `${command.file} failed: ${error.message}` : `${command.file} failed: ${output}`));
    });
  });

export const DESKTOP_TIMEOUT_MS = 30_000;

export interface DesktopNoticeConnectorOptions {
  /** This machine's platform and kernel release; the running machine's by default. */
  platform?: DesktopPlatform;
  run?: CommandRunner;
  timeoutMs?: number;
}

/**
 * The `desktop` connector, the default: a desktop notice on the machine
 * running entail (spec §13, ADR-0017). `send` resolves once the program
 * that shows it has exited cleanly.
 */
export class DesktopNoticeConnector implements NoticeConnector {
  readonly name = "desktop";
  readonly method: DesktopMethod;
  readonly #run: CommandRunner;
  readonly #timeoutMs: number;

  constructor(options: DesktopNoticeConnectorOptions = {}) {
    this.method = desktopMethodFor(options.platform ?? { platform: process.platform, kernelRelease: release() });
    this.#run = options.run ?? runCommand;
    this.#timeoutMs = options.timeoutMs ?? DESKTOP_TIMEOUT_MS;
  }

  async send(notice: Notice): Promise<void> {
    await this.#run(desktopCommand(this.method, notice), this.#timeoutMs);
  }
}

/** The "last notice failed" warning's condition (spec §16, ADR-0019). */
export interface NoticeFailure {
  /** When the failed notice was attempted. */
  at: Date;
  /** The connector it went through, or null when the settings naming one could not be read. */
  connector: NoticeConnectorName | null;
  kind: NoticeKind;
  error: string;
}

export interface NotifierOptions {
  /** The connector the global settings name, read again for every notice. */
  connectorName: () => NoticeConnectorName;
  /** The connectors by name; made on first use when left out. */
  connectors?: Partial<Record<NoticeConnectorName, NoticeConnector>>;
  dataDirectory: string;
  log: OperationalLog;
  now?: () => Date;
}

/**
 * Sends each notice through the connector the global settings name at that
 * moment, so a changed setting takes effect from the next notice (spec §15).
 *
 * entail makes one attempt per notice. A failure is logged to the operational
 * log, recorded as the "last notice failed" condition, and blocks nothing:
 * there is no retry, because the issue comment and the board already show the
 * item (spec §13). The next notice that is handed over clears the condition.
 */
export class Notifier {
  readonly #connectorName: () => NoticeConnectorName;
  readonly #connectors: Partial<Record<NoticeConnectorName, NoticeConnector>>;
  readonly #dataDirectory: string;
  readonly #log: OperationalLog;
  readonly #now: () => Date;
  #lastFailure: NoticeFailure | null = null;

  constructor(options: NotifierOptions) {
    this.#connectorName = options.connectorName;
    this.#connectors = { ...options.connectors };
    this.#dataDirectory = options.dataDirectory;
    this.#log = options.log;
    this.#now = options.now ?? (() => new Date());
  }

  /** The "last notice failed" condition, or null when the last notice was handed over or none was sent. */
  get lastFailure(): NoticeFailure | null {
    return this.#lastFailure;
  }

  /** Sends one notice. It never throws, and resolves true when the notice was handed over. */
  async notify(notice: Notice): Promise<boolean> {
    const at = this.#now();
    let name: NoticeConnectorName | null = null;
    try {
      name = this.#connectorName();
      await this.#connector(name).send(notice);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#lastFailure = { at, connector: name, kind: notice.kind, error: message };
      // Only the kind and repo are logged: the line itself stays with the notice.
      this.#quietly(() =>
        this.#log.warn("notice-failed", { connector: name, kind: notice.kind, repo: notice.repo, error: message }),
      );
      return false;
    }
    this.#lastFailure = null;
    return true;
  }

  #connector(name: NoticeConnectorName): NoticeConnector {
    const existing = this.#connectors[name];
    if (existing) return existing;
    let made: NoticeConnector;
    switch (name) {
      case "desktop":
        made = new DesktopNoticeConnector();
        break;
      case "file":
        made = new FileNoticeConnector(this.#dataDirectory);
        break;
      default:
        throw new Error(`no notice connector is named ${String(name)}`);
    }
    this.#connectors[name] = made;
    return made;
  }

  /** A notice blocks nothing, so even a log that cannot be written does not reach the caller. */
  #quietly(write: () => void): void {
    try {
      write();
    } catch {
      // The failure is still recorded as the condition.
    }
  }
}
