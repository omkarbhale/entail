#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { homedir, release } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import type { FailingView } from "./api-types.ts";
import { backupView, BOARD_DIRECTORY, changeSettings, createApi } from "./api.ts";
import { backUp, checkRemote, restore, shownRemote, type BackupOutcome } from "./backup.ts";
import {
  DEFAULT_CASE_BOOK,
  landingPrecedentsFor,
  OWNER_CASE_BOOK,
  precedentsFor,
  readCaseBook,
  readCaseBooks,
  readLandingCaseBook,
  readLandingCaseBooks,
  renderIssue,
  renderPullRequest,
  type Case,
  type LandingCase,
} from "./case-book.ts";
import { ChangeDeduplicator } from "./changes.ts";
import { ClaudeRunner } from "./claude-runner.ts";
import { CursorStore } from "./cursors.ts";
import { ensureDataDirectory } from "./data-directory.ts";
import { EventBus, watchLogs } from "./events.ts";
import { createForge } from "./forge/create-forge.ts";
import type { Forge, ForgeSetting } from "./forge/forge.ts";
import { allChecksFinished, ForgeUntrustedCertificateError } from "./forge/forge.ts";
import { gitCaCertificate, TRUST_CLI, untrustedCertificateMessage } from "./forge/trust.ts";
import { Health } from "./health.ts";
import { formatCall, judge, type JudgeOptions } from "./judgment.ts";
import { formatLandingCall, judgeLanding } from "./landing.ts";
import { acquireLock, commandLineOf, holderIsRunning, readLock } from "./lock.ts";
import { Loop } from "./loop.ts";
import { forgeRemote, Mirror } from "./mirror.ts";
import { DEFAULT_EFFORT, DEFAULT_MODEL, EFFORTS, REPLAY_EFFORT, type Effort, type RunFacts } from "./model-runner.ts";
import { Notifier } from "./notices.ts";
import { OperationalLog } from "./operational-log.ts";
import {
  answerCall,
  changeRepoSettings,
  checkSettingsChange,
  confirmCall,
  enroll,
  formatLog,
  findItem,
  formatWaiting,
  latestItemOn,
  logItems,
  overrideCall,
  OwnerError,
  repoName,
  repoViews,
  unenroll,
  waitingItems,
} from "./owner.ts";
import { parsePins, pinsFile } from "./pins.ts";
import { clearedGoOn, goCallOn, heldActions, loggedRepos, readLog, readSettings, repoState, sendBacksPosted, visionGrowth, type GlobalSettings } from "./records.ts";
import { formatReplay, replay, replayLandings } from "./replay.ts";
import { forgeHost, forgeTitle, isRepo, repoSetting } from "./repo-ref.ts";
import { installService, isWsl, machineServiceSystem, serviceStatus, uninstallService, type ServiceInputs } from "./service.ts";
import { fileUnfiled, formatSuggestions, runSuggestions, SUGGEST_TIMEOUT_MS, SuggestionRuns } from "./suggest.ts";
import { machineUpdate, update } from "./update.ts";
import { forgesByBaseBranch, mirrorReader, mirrorReaders, runPass, type PassOptions } from "./watch.ts";

/** The port the board and its API are served on unless --port names another. */
export const DEFAULT_PORT = 4380;

/** How long `entail run` waits between passes unless --interval says otherwise. */
export const DEFAULT_INTERVAL_SECONDS = 60;

const USAGE = `usage:
  entail enroll <owner/repo> [--no-confirm] [--since <time>]
  entail unenroll <owner/repo>
  entail repos [--all] [--json]
  entail settings [<owner/repo>] [--confirm on|off] [--model <model>|default] [--effort <level>|default] [--base <branch>|default] [--pin <topic>]... [--unpin <topic>]... [--criterion <text>... |none] [--owner <name>] [--notice <command>|none] [--start <command>|none] [--backup <git remote url>|none]
  entail backup status
  entail restore <git remote url>
  entail run [--once] [--dry-run] [--interval <seconds>] [--port <n>]
  entail service install|uninstall|status
  entail update [--port <n>]
  entail status [--port <n>]
  entail open [--port <n>]
  entail waiting [<owner/repo>] [--json]
  entail confirm <owner/repo>#<n>
  entail override <owner/repo>#<n> go|plan|no|merge|send-back <reason>
  entail answer <owner/repo>#<n> go|plan|no|merge|send-back <answer> [--accept <parts>]
  entail calls [<owner/repo>] [--json]
  entail judge <owner/repo>#<n> [--model <model>] [--effort <level>] [--json]
  entail land <owner/repo>#<pr> [--issue <n>] [--model <model>] [--effort <level>] [--json]
  entail replay [--model <model>] [--effort <level>] [--cases <dir>] [--concurrency <n>] [--json]
  entail suggest <owner/repo> [--model <model>] [--effort <level>] [--json]

enroll     watch a repo: entail makes the call on each issue filed or edited from now
           (or --since) on, and on each /entail mention. A repo starts in confirm mode,
           where a go or no is posted but nothing is closed or started until you confirm.
           A repo is owner/repo on GitHub, through gh (on a GitHub Enterprise Server,
           github://host/owner/repo, or github: before its pasted address, with gh
           logged in to that host: gh auth login --hostname host), or gitlab:group/repo on GitLab
           (gitlab.com, subgroups included), through glab; a project on a self-hosted
           GitLab is gitlab://host/group/repo, or gitlab: before its pasted address, with
           glab logged in to that host (glab auth login --hostname host).
unenroll   stop watching a repo; its log is kept.
repos      the enrolled repos with confirm mode, model, effort and what waits on you.
settings   with a repo, its confirm mode, model and effort ("default" uses the one for
           every repo), and its base branch: the branch entail reads the repo and its
           vision on, follows and merges PRs into and diffs them against ("default" is
           the forge's default branch), and its pins: --pin adds a topic and --unpin takes one
           out of the repo's pins file, each logged with your name, and the pins are listed
           ("anything touching a pinned topic comes to you"; the file also takes hand edits);
           without, your name on comments, the default model and effort, the
           notice command entail runs with one line and a link when something starts
           waiting on you, and the start command entail runs when a go acts, with the
           issue, the reason and the criteria as JSON on its standard input (see examples/
           in entail's checkout; "none" sets neither), and the git remote entail backs its
           records up to ("none", the default, backs nothing up).
backup     status: the backup remote, when it last took a push, and whether backup is
           stuck because the remote moved on. After each pass entail commits its log, your
           case book, the settings and the pins in its data directory and pushes them there
           with your own git; a remote that has moved on is never merged or overwritten.
restore    on a new machine, before entail has run there: clone a backup remote into the
           empty data directory, bringing back the log, case book, settings and pins. It
           refuses a data directory that holds anything.
run        poll every enrolled repo, make each call once per edit, post it, and serve the
           board on http://127.0.0.1:${DEFAULT_PORT}/ (--port names another). Each PR that closes
           an issue entail said go on is judged at each new head once CI has finished:
           merged at that head, sent back with what needs to change, or asked about.
           --once makes one pass; --dry-run makes one pass that posts, closes, merges
           and records nothing and prints what it would do.
service    install: run \`entail run\` as a per-user service that starts at login and again
           after a crash (a systemd user unit on Linux, a launchd agent on macOS; on
           Windows a Task Scheduler task, which starts at login but not after a crash);
           uninstall: stop and remove it; status: whether it is installed and running.
update     run from entail's checkout: pull its branch (fast-forward only), npm ci and build,
           then restart the entail running from it on the new code. It first takes no new
           work and lets the work in flight finish, so no call or start is cut off partway.
           A service is restarted; entail run by hand is stopped, for you to start again.
           It refuses an uncommitted change and a copy running from anywhere else.
status     whether entail is running, each enrolled repo with its confirm mode and when
           it was last checked, what waits on you, and the board's address.
open       open the board in your browser.
waiting    the questions and calls to confirm waiting on you, across repos.
confirm    confirm the latest call on an issue or PR: entail then acts on it.
override   replace the latest call on an issue (go, plan or no) or a PR (merge or
           send-back) with your call and reason. plan is a go for planning: your start
           command gets the handoff with scope "plan", to write the plan and file the
           smaller tickets; go alone is a go to implement.
answer     answer the question on an issue (go, plan or no) or a PR (merge or send-back)
           with your call and words. On an issue that lists several suggestions, --accept
           1,3 takes only those parts of it (counted from 1, as waiting lists them): the
           call is no, and entail files one new issue for each part you accept and closes
           the issue with links to them and the parts turned down.
calls      the log: every call with its reason, and every confirmation, override,
           answer and post, for one repo or all.
judge      make the call on one issue and print it. It posts nothing.
land       make the landing call on one PR at its head and print it, against the
           criteria of the go entail logged on the issue it closes (or --issue), or
           on the vision alone when it closes none. It posts and merges nothing.
replay     run every case in the case book through its judgment (issue cases through
           the call on an issue, landing cases through the call on a PR) and print
           agreement with the owner's calls, disagreements first; a go agrees only
           when its criteria name what its case says they must.
suggest    suggest work for an enrolled repo from its vision and the product as it stands
           (the board's Suggest work does the same): file each suggestion as an issue
           labelled entail:suggested, which then gets the usual call like any issue, and
           print what it considered and left out. A run may take up to ${SUGGEST_TIMEOUT_MS / 60_000} minutes.

--model    the model to run (default: the setting, ${DEFAULT_MODEL} unless changed)
--effort   ${EFFORTS.join(", ")} (default: the setting, ${DEFAULT_EFFORT} unless changed; for
           replay, ${REPLAY_EFFORT})
--cases    the case book directory (default: the one entail ships with and yours)

Your confirmations, overrides and answers are written as cases to cases/ in entail's
data directory, next to the case book entail ships with. A repo's pins are read from
pins/<host>/<owner>/<name>.md there, one topic per line.`;

class UsageError extends Error {}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "enroll":
        return await enrollCommand(rest);
      case "unenroll":
        return await unenrollCommand(rest);
      case "repos":
        return reposCommand(rest);
      case "settings":
        return await settingsCommand(rest);
      case "backup":
        return await backupCommand(rest);
      case "restore":
        return await restoreCommand(rest);
      case "run":
        return await runCommand(rest);
      case "service":
        return await serviceCommand(rest);
      case "update":
        return await updateCommand(rest);
      case "status":
        return await statusCommand(rest);
      case "open":
        return await openCommand(rest);
      case "waiting":
        return await waitingCommand(rest);
      case "confirm":
      case "override":
      case "answer":
        return await ownerCommand(command, rest);
      case "calls":
        return await callsCommand(rest);
      case "judge":
        return await judgeCommand(rest);
      case "land":
        return await landCommand(rest);
      case "replay":
        return await replayCommand(rest);
      case "suggest":
        return await suggestCommand(rest);
      case undefined:
      case "help":
      case "--help":
      case "-h":
        console.log(USAGE);
        return command === undefined ? 2 : 0;
      default:
        throw new UsageError(`unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError || (error instanceof OwnerError && error.status === 400)) {
      console.error(`entail: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    console.error(`entail: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const RUN_OPTIONS = {
  model: { type: "string" },
  effort: { type: "string" },
  json: { type: "boolean" },
} as const;

/** Checks --model and --effort; what they leave out comes from the settings, read only once the flags are known to be good. */
function runOptions(values: { model?: string | undefined; effort?: string | undefined }): (settings: GlobalSettings) => JudgeOptions {
  if (values.effort !== undefined && !(EFFORTS as readonly string[]).includes(values.effort)) throw new UsageError(`--effort must be one of ${EFFORTS.join(", ")}`);
  return (settings) => ({ model: values.model ?? settings.model, effort: (values.effort as Effort | undefined) ?? settings.effort });
}

function settingsIn(dataDirectory: string): GlobalSettings {
  return readSettings(dataDirectory, { model: DEFAULT_MODEL });
}

/** The base branch the owner set for a repo, from its log; null for the forge's default branch. */
function baseBranchOf(dataDirectory: string, repo: string): string | null {
  return repoState(repo, readLog(dataDirectory, repo)).baseBranch;
}

/** The forge adapter for a repo, working against the base branch its log sets now. */
function repoForge(dataDirectory: string, repo: string): Forge {
  return createForge(repoSetting(repo), undefined, baseBranchOf(dataDirectory, repo));
}

/** The case book: the one entail ships with, then the owner's own, whose cases win. */
function caseBook(dataDirectory: string): Promise<Case[]> {
  return readCaseBooks([DEFAULT_CASE_BOOK, join(dataDirectory, OWNER_CASE_BOOK)]);
}

/** The landing cases of the same books. */
function landingBook(dataDirectory: string): Promise<LandingCase[]> {
  return readLandingCaseBooks([DEFAULT_CASE_BOOK, join(dataDirectory, OWNER_CASE_BOOK)]);
}

/**
 * The owner's display name: the setting, else the GitHub account `gh` is
 * logged in as, else, for an owner without `gh`, the GitLab account `glab` is
 * logged in as on gitlab.com, then on each self-hosted GitLab host with a
 * repo that has a log, then on the host of `repo`, the repo being enrolled. An
 * owner whose `gh` is logged in only to a GitHub Enterprise Server is asked on
 * each such host the same way, after github.com.
 */
async function ownerName(dataDirectory: string, repo?: string): Promise<string> {
  const set = settingsIn(dataDirectory).owner;
  if (set !== null) return set;
  let github: unknown = null;
  try {
    const actor = await createForge(repoSetting("github/docs")).currentActor();
    if (actor !== null) return actor.username;
  } catch (error) {
    github = error;
  }
  for (const host of enterpriseHosts(dataDirectory, repo)) {
    const enterprise = await createForge({ forge: "github", host, path: "github/docs" })
      .currentActor()
      .catch(() => null);
    if (enterprise !== null) return enterprise.username;
  }
  for (const host of gitlabHosts(dataDirectory, repo)) {
    const gitlab = await createForge({ forge: "gitlab", host, path: "gitlab-org/gitlab" })
      .currentActor()
      .catch(() => null);
    if (gitlab !== null) return gitlab.username;
  }
  if (github !== null) throw github;
  throw new Error("neither gh nor glab is logged in, and no name is set: run gh auth login (or glab auth login; either takes --hostname for a self-hosted host), or entail settings --owner <your name>");
}

/** The GitHub Enterprise Server hosts to ask `gh` about: those of the repos with a log, and of `repo`. */
function enterpriseHosts(dataDirectory: string, repo?: string): string[] {
  const hosts = new Set<string>();
  for (const name of [...loggedRepos(dataDirectory), ...(repo === undefined ? [] : [repo])]) {
    const setting = repoSetting(name);
    if (setting.forge === "github" && setting.host !== forgeHost("github")) hosts.add(setting.host);
  }
  return [...hosts];
}

/** The GitLab hosts to ask `glab` about, gitlab.com first: those of the repos with a log, and of `repo`. */
function gitlabHosts(dataDirectory: string, repo?: string): string[] {
  const hosts = new Set([forgeHost("gitlab")]);
  for (const name of [...loggedRepos(dataDirectory), ...(repo === undefined ? [] : [repo])]) {
    const setting = repoSetting(name);
    if (setting.forge === "gitlab") hosts.add(setting.host);
  }
  return [...hosts];
}

function parse<const O extends ParseArgsOptionsConfig>(args: string[], options: O) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

/** Reads `owner/name#number`, `github://host/owner/name#number` on a GitHub Enterprise Server, or `gitlab:group/name#number` or `gitlab://host/group/name#number` on GitLab. `path` is the repo's name. */
export function parseIssueReference(text: string): { path: string; number: number } {
  const match = /^([^#\s]+)#(\d+)$/u.exec(text);
  const number = Number(match?.[2]);
  if (match === null || !isRepo(match[1]!) || !Number.isSafeInteger(number) || number <= 0) {
    throw new UsageError(`not an issue reference: ${text} (expected owner/repo#number, github://host/owner/repo#number, gitlab:group/repo#number, or gitlab://host/group/repo#number)`);
  }
  return { path: match[1]!, number };
}

async function openRepo(repo: string, dataDirectory: string): Promise<{ forge: Forge; mirror: Mirror }> {
  const setting = repoSetting(repo);
  const forge = repoForge(dataDirectory, repo);
  const project = await forge.project();
  const mirror = await Mirror.open({
    dataDirectory,
    key: { forge: setting.forge, host: setting.host, projectId: project.id },
    remote: forgeRemote(setting.forge, setting.host, setting.path),
  });
  return { forge, mirror };
}

function oneRepo(positionals: string[], command: string): string {
  if (positionals.length !== 1) throw new UsageError(`${command} takes one repo, as owner/repo, github://host/owner/repo, gitlab:group/repo or gitlab://host/group/repo`);
  return repoName(positionals[0]!);
}

async function enrollCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { "no-confirm": { type: "boolean" }, since: { type: "string" } });
  const repo = oneRepo(positionals, "enroll");
  const since = values.since === undefined ? undefined : new Date(values.since);
  if (since !== undefined && Number.isNaN(since.getTime())) throw new UsageError(`--since is a date or time, such as 2026-11-12 or 2026-11-12T09:00:00Z, not ${values.since}`);
  const dataDirectory = ensureDataDirectory();
  // Reading the repo checks it exists and the forge's CLI can see it, and that
  // entail serves its forge's version, as a self-hosted GitLab's may not be.
  const forge = createForge(repoSetting(repo));
  let unsupported: string | null;
  try {
    await forge.project();
    ({ unsupported } = await forge.instance());
  } catch (error) {
    if (!(error instanceof ForgeUntrustedCertificateError)) throw error;
    // Name the CA certificate file git already trusts for the host, so the steps can be followed as they stand.
    const file = error.cli === TRUST_CLI ? await gitCaCertificate(error.host) : null;
    throw new Error(untrustedCertificateMessage(error.host, error.cli, error.detail, file));
  }
  if (unsupported !== null) throw new Error(`${repo} cannot be enrolled: ${unsupported}`);
  const state = enroll(dataDirectory, repo, await ownerName(dataDirectory, repo), { confirm: values["no-confirm"] !== true, ...(since ? { since } : {}) });
  console.log(`${repo} is enrolled: entail judges issues filed from ${state.since} on, and each /entail mention. Confirm mode is ${state.confirm ? "on" : "off"}.`);
  return 0;
}

async function unenrollCommand(args: string[]): Promise<number> {
  const { positionals } = parse(args, {});
  const repo = oneRepo(positionals, "unenroll");
  const dataDirectory = ensureDataDirectory();
  unenroll(dataDirectory, repo, await ownerName(dataDirectory));
  console.log(`${repo} is no longer watched; its log is kept.`);
  return 0;
}

function reposCommand(args: string[]): number {
  const { values, positionals } = parse(args, { all: { type: "boolean" }, json: { type: "boolean" } });
  if (positionals.length > 0) throw new UsageError("repos takes no arguments");
  const dataDirectory = ensureDataDirectory();
  const repos = repoViews(dataDirectory, settingsIn(dataDirectory), { all: values.all === true });
  if (values.json) console.log(JSON.stringify(repos, null, 2));
  else if (repos.length === 0) console.log("No repo is enrolled. Enroll one with: entail enroll owner/repo");
  else {
    for (const repo of repos) {
      const own = (value: string | null) => (value === null ? " (default)" : "");
      console.log(
        `${repo.repo}${repo.enrolled ? "" : " (not enrolled)"}: confirm mode ${repo.confirm ? "on" : "off"}, ${repo.uses.model}${own(repo.model)} at ${repo.uses.effort} effort${own(repo.effort)}${repo.baseBranch === null ? "" : `, base branch ${repo.baseBranch}`}${repo.genericCriteria.length === 0 ? "" : `, ${repo.genericCriteria.length} generic criteri${repo.genericCriteria.length === 1 ? "on" : "a"}`}; ${repo.calls} calls, ${repo.waiting} waiting on you` +
          (repo.checked > 0 ? `; you confirmed ${repo.agreed} of the ${repo.checked} calls you checked` : ""),
      );
    }
  }
  return 0;
}

function readPinsSync(file: string): string[] {
  try {
    return parsePins(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

async function settingsCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    confirm: { type: "string" },
    model: { type: "string" },
    effort: { type: "string" },
    base: { type: "string" },
    pin: { type: "string", multiple: true },
    unpin: { type: "string", multiple: true },
    criterion: { type: "string", multiple: true },
    owner: { type: "string" },
    notice: { type: "string" },
    start: { type: "string" },
    backup: { type: "string" },
  });
  if (positionals.length > 1) throw new UsageError("settings takes at most one repo");
  const dataDirectory = ensureDataDirectory();
  if (positionals.length === 1) {
    if (values.owner !== undefined || values.notice !== undefined || values.start !== undefined || values.backup !== undefined) {
      throw new UsageError("--owner, --notice, --start and --backup are settings for every repo; leave the repo out");
    }
    const change: Record<string, unknown> = {};
    if (values.confirm !== undefined) {
      if (values.confirm !== "on" && values.confirm !== "off") throw new UsageError("--confirm is on or off");
      change.confirm = values.confirm === "on";
    }
    if (values.model !== undefined) change.model = values.model === "default" ? null : values.model;
    if (values.effort !== undefined) change.effort = values.effort === "default" ? null : values.effort;
    if (values.base !== undefined) change.baseBranch = values.base === "default" ? null : values.base;
    if (values.criterion !== undefined) {
      if (values.criterion.includes("none") && values.criterion.length > 1) throw new UsageError("--criterion none clears the generic criteria; it cannot be given beside others");
      change.genericCriteria = values.criterion.length === 1 && values.criterion[0] === "none" ? [] : values.criterion;
    }
    const repo = repoName(positionals[0]!);
    // Each pin is a change of its own, so each is logged on its own.
    const pins = [...(values.unpin ?? []).map((unpin) => ({ unpin })), ...(values.pin ?? []).map((pin) => ({ pin }))];
    for (const one of pins) checkSettingsChange(one);
    const by = Object.keys(change).length + pins.length === 0 ? "" : await ownerName(dataDirectory);
    let changed = Object.keys(change).length === 0 ? undefined : changeRepoSettings(dataDirectory, repo, by, checkSettingsChange(change));
    for (const one of pins) changed = changeRepoSettings(dataDirectory, repo, by, checkSettingsChange(one));
    const state = changed ?? repoViews(dataDirectory, settingsIn(dataDirectory), { all: true }).find((view) => view.repo === repo);
    if (state === undefined) throw new Error(`${repo} has never been enrolled`);
    const settings = settingsIn(dataDirectory);
    console.log(
      `${repo}: confirm mode ${state.confirm ? "on" : "off"}, model ${state.model ?? `${settings.model} (default)`}, effort ${state.effort ?? `${settings.effort} (default)`}, base branch ${state.baseBranch ?? `${forgeTitle(repo)}'s default branch (default)`}, ${
        state.genericCriteria.length === 0 ? "no generic criteria" : `generic criteria: ${state.genericCriteria.map((text) => `"${text}"`).join("; ")}`
      }`,
    );
    const pinned = readPinsSync(pinsFile(dataDirectory, repoSetting(repo)));
    if (pinned.length > 0) console.log(`pins: ${pinned.join("; ")}`);
    return 0;
  }
  if (values.confirm !== undefined) throw new UsageError("--confirm is a setting of one repo: name it");
  if (values.pin !== undefined || values.unpin !== undefined) throw new UsageError("--pin and --unpin are for one repo: name it");
  if (values.base !== undefined) throw new UsageError("--base is a setting of one repo: name it");
  if (values.criterion !== undefined) throw new UsageError("--criterion is a setting of one repo: name it");
  const change: Record<string, unknown> = {};
  for (const key of ["owner", "model", "effort"] as const) if (values[key] !== undefined) change[key] = values[key];
  if (values.notice !== undefined) change.notice = values.notice === "none" ? null : values.notice;
  if (values.start !== undefined) change.start = values.start === "none" ? null : values.start;
  if (values.backup !== undefined) {
    if (values.backup !== "none" && checkRemote(values.backup) === null) throw new UsageError("--backup is a git remote URL, or none");
    change.backup = values.backup === "none" ? null : values.backup;
  }
  const settings = Object.keys(change).length === 0 ? settingsIn(dataDirectory) : changeSettings(dataDirectory, DEFAULT_MODEL, change);
  console.log(
    `your name on comments: ${settings.owner ?? "(not set: the GitHub account gh is logged in as, else the GitLab account glab is)"}\ndefault model: ${settings.model}\ndefault effort: ${settings.effort}\nnotices: ${settings.notice ?? "none"}\nstart work with: ${settings.start ?? "none"}\nbackup: ${settings.backup ? shownRemote(settings.backup) : "none"}`,
  );
  if (values.backup !== undefined && settings.backup) {
    const holder = readLock(dataDirectory);
    if (holder !== null && holderIsRunning(holder)) {
      console.log("The running entail backs up to it after its next pass: entail backup status shows how it went.");
    } else {
      console.log(backupOutcomeLine(await backUp(dataDirectory, settings.backup, { log: new OperationalLog(dataDirectory, { echo: null }) }), settings.backup));
    }
  }
  return 0;
}

/** One backup's outcome, for the owner. */
function backupOutcomeLine(outcome: BackupOutcome, remote: string): string {
  switch (outcome.kind) {
    case "off":
      return "Backup is off.";
    case "unchanged":
      return `Backed up: ${shownRemote(remote)} already has every record.`;
    case "pushed":
      return `Backed up the records to ${shownRemote(remote)} (${outcome.commit.slice(0, 12)}).`;
    case "stuck":
      return `Backup is stuck: ${outcome.reason}.`;
    case "failed":
      return `Backup did not go through: ${outcome.reason}. entail tries again after its next pass.`;
  }
}

/** Where the backup stands, in one line: off, when the remote last took a push, or why it did not. */
function backupLine(dataDirectory: string, settings: GlobalSettings, now: Date): string {
  const view = backupView(dataDirectory, settings.backup ?? null);
  if (view.remote === null) return "Backup: none (entail settings --backup <git remote url> turns it on).";
  const pushed = view.pushedAt === null ? "has not taken a push yet" : `last took a push ${ago(view.pushedAt, now)}`;
  if (view.problem === null) return `Backup: ${view.remote}, ${pushed}.`;
  return `Backup: ${view.remote}, ${pushed}; ${view.problem.kind === "stuck" ? "stuck" : "failing"} since ${ago(view.problem.since, now)}: ${view.problem.reason}.`;
}

async function backupCommand(args: string[]): Promise<number> {
  const { positionals } = parse(args, {});
  if (positionals.length !== 1 || positionals[0] !== "status") throw new UsageError("backup takes status");
  const dataDirectory = ensureDataDirectory();
  const settings = settingsIn(dataDirectory);
  console.log(backupLine(dataDirectory, settings, new Date()));
  return backupView(dataDirectory, settings.backup ?? null).problem?.kind === "stuck" ? 1 : 0;
}

async function restoreCommand(args: string[]): Promise<number> {
  const { positionals } = parse(args, {});
  if (positionals.length !== 1) throw new UsageError("restore takes one git remote URL");
  const remote = checkRemote(positionals[0]!);
  if (remote === null) throw new UsageError("restore takes a git remote URL");
  const dataDirectory = ensureDataDirectory();
  const report = await restore(dataDirectory, remote);
  const entries = report.repos.reduce((sum, repo) => sum + repo.entries, 0);
  console.log(`Restored entail's records from ${shownRemote(remote)} into ${dataDirectory}, as of ${report.committedAt} (${report.commit.slice(0, 12)}):`);
  console.log(`  the log of ${report.repos.length} repo${report.repos.length === 1 ? "" : "s"}, ${entries} entr${entries === 1 ? "y" : "ies"}${report.repos.length === 0 ? "" : `: ${report.repos.map((repo) => `${repo.repo} (${repo.entries})`).join(", ")}`}`);
  console.log(`  ${report.cases} case${report.cases === 1 ? "" : "s"} in your case book`);
  console.log(`  pins for ${report.pins} repo${report.pins === 1 ? "" : "s"}`);
  console.log(`  ${report.settings ? "the settings" : "no settings (the defaults apply)"}`);
  const restoredBackup = settingsIn(dataDirectory).backup ?? null;
  if (restoredBackup !== null) changeSettings(dataDirectory, DEFAULT_MODEL, { backup: null });
  console.log(
    restoredBackup === null
      ? "Backup is off here: entail settings --backup <git remote url> turns it on."
      : "Backup is off here, so this copy will not push to the remote until you run entail settings --backup <git remote url>: one machine writes, a restored one only restores.",
  );
  return 0;
}

async function runCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { once: { type: "boolean" }, "dry-run": { type: "boolean" }, interval: { type: "string" }, port: { type: "string" } });
  if (positionals.length > 0) throw new UsageError("run takes no arguments");
  const interval = values.interval === undefined ? DEFAULT_INTERVAL_SECONDS : Number(values.interval);
  if (!Number.isFinite(interval) || interval < 5) throw new UsageError("--interval is a number of seconds, at least 5");
  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new UsageError("--port is a port number");
  const dryRun = values["dry-run"] === true;
  const single = dryRun || values.once === true;
  const dataDirectory = ensureDataDirectory();
  const lock = dryRun ? null : acquireLock(dataDirectory);
  const log = new OperationalLog(dataDirectory, { echo: null });
  if (lock?.takeover) log.warn("unexpected-stop", { previous: lock.takeover.previous });
  const forges = forgesByBaseBranch(dataDirectory, (repo, baseBranch) => createForge(repoSetting(repo), undefined, baseBranch));
  const seen = new Map<string, ChangeDeduplicator>();
  const cursors = new CursorStore(dataDirectory);
  const { reader, prReader, suggestReader } = mirrorReaders(dataDirectory);
  const runner = new ClaudeRunner();
  const stop = new AbortController();
  const passOptions = async (): Promise<PassOptions> => ({
    dataDirectory,
    owner: await ownerName(dataDirectory),
    settings: settingsIn(dataDirectory),
    forgeFor: forges,
    reader,
    prReader,
    runner,
    cursors,
    seen,
    book: () => caseBook(dataDirectory),
    landingBook: () => landingBook(dataDirectory),
    log: dryRun ? null : log,
    dryRun,
    print: (text) => console.log(text),
    signal: stop.signal,
  });

  try {
    if (single) {
      if (dryRun) console.log("dry run: nothing is posted, closed, merged or recorded\n");
      const report = await runPass(await passOptions());
      if (!dryRun) {
        const backup = settingsIn(dataDirectory).backup ?? null;
        const outcome = await backUp(dataDirectory, backup, { log });
        if (backup !== null && outcome.kind !== "unchanged") console.log(backupOutcomeLine(outcome, backup));
      }
      console.log(`\n${report.repos} repos, ${report.judged} calls made, ${report.posted} ${dryRun ? "posts it would make" : "posts"}${report.failed.length > 0 ? `; not finished: ${report.failed.join(", ")}` : ""}`);
      return report.failed.length > 0 ? 1 : 0;
    }

    const bus = new EventBus();
    const stopWatching = watchLogs(dataDirectory, bus);
    let boardUrl = `http://127.0.0.1:${port}/`;
    const notifier = new Notifier({
      dataDirectory,
      command: () => settingsIn(dataDirectory).notice ?? null,
      get link() {
        return `${boardUrl}#/waiting`;
      },
      onResult: (result) => (result.ok ? log.info("notice", { line: result.line }) : log.warn("notice-failed", { line: result.line, error: result.error })),
    });
    const health = new Health();
    const suggestRunner = new ClaudeRunner({ timeoutMs: SUGGEST_TIMEOUT_MS });
    const forgeOf = (repo: string) => repoForge(dataDirectory, repo);
    const suggestions = new SuggestionRuns({
      events: bus,
      log,
      run: async (repo, choice, signal) =>
        runSuggestions({
          dataDirectory,
          repo,
          by: await ownerName(dataDirectory),
          forge: forgeOf(repo),
          read: suggestReader,
          runner: suggestRunner,
          book: () => caseBook(dataDirectory),
          ...choice,
          signal,
          log,
        }),
      resume: (repo) => fileUnfiled(dataDirectory, repo, forgeOf(repo)),
    });
    // What a run recorded but did not file before entail stopped is filed now.
    for (const view of repoViews(dataDirectory, settingsIn(dataDirectory))) suggestions.resume(view.repo);
    const loop = new Loop({
      intervalMs: interval * 1000,
      bus,
      pass: async (request) => {
        const report = await runPass({
          ...(await passOptions()),
          ...(request.only ? { only: request.only } : {}),
          ...(request.actOnly ? { actOnly: true } : {}),
          onChecked: (repo, outcome) => {
            health.checked(repo, outcome.failure, new Date().toISOString());
            request.onChecked(repo, outcome);
          },
        });
        log.info("pass", { ...report, ...(request.only ? { only: request.only } : {}), ...(request.actOnly ? { actOnly: true } : {}) });
        return report;
      },
      nextDue: () => nextDue(dataDirectory),
      afterPass: async () => {
        await notifier.check(waitingItems(dataDirectory, await caseBook(dataDirectory)));
        await notifier.health(health.repos(), new Date());
        await notifier.stalled(repoViews(dataDirectory, settingsIn(dataDirectory)).flatMap((view) => view.stalled.map((stalled) => ({ repo: view.repo, stalled }))));
        await notifier.grown(loggedRepos(dataDirectory).flatMap((repo) => visionGrowth(readLog(dataDirectory, repo)).map((grown) => ({ repo, grown }))));
        // Last, so a push that waits on the network never holds up a notice.
        await backUp(dataDirectory, settingsIn(dataDirectory).backup ?? null, { log });
      },
      onError: (error) => {
        log.error("pass-error", { error: error instanceof Error ? error.message : String(error) });
        console.error(`entail: the pass failed: ${error instanceof Error ? error.message : String(error)}`);
      },
    });
    const server = createApi({
      dataDirectory,
      owner: (repo) => ownerName(dataDirectory, repo),
      defaultModel: DEFAULT_MODEL,
      book: () => caseBook(dataDirectory),
      loop,
      health,
      events: bus,
      suggestions,
      forgeFor: (repo) => repoForge(dataDirectory, repo),
      get url() {
        return boardUrl;
      },
      cli: fileURLToPath(import.meta.url),
    });
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    boardUrl = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : port}/`;
    console.log(`entail is watching; the board is at ${boardUrl}${BOARD_DIRECTORY === null ? " (not built: run npm run build; the API is at /api/)" : ""}`);
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => stop.abort(new Error(`stopped by ${signal}`)));
    try {
      await loop.run(stop.signal);
    } finally {
      suggestions.stop(stop.signal.reason);
      await suggestions.settled();
      stopWatching();
      server.closeAllConnections();
      server.close();
    }
    return 0;
  } finally {
    lock?.release();
  }
}

/** This machine, as the service sees it: the Node binary and the entail script running now. */
function serviceInputs(): ServiceInputs {
  return { platform: process.platform, env: process.env, home: homedir(), uid: process.getuid?.() ?? 0, node: process.execPath, cli: fileURLToPath(import.meta.url) };
}

async function serviceCommand(args: string[]): Promise<number> {
  const { positionals } = parse(args, {});
  const [action, ...extra] = positionals;
  if (extra.length > 0 || (action !== "install" && action !== "uninstall" && action !== "status")) throw new UsageError("service takes install, uninstall or status");
  const inputs = serviceInputs();
  const system = machineServiceSystem(inputs);
  if (action === "install") {
    const { definition, replaced } = await installService(inputs, system);
    const restarts = definition.manager === "task-scheduler" ? "; after a crash, log in again or run entail service install again" : ", and again after a crash";
    console.log(`${replaced ? "Replaced" : "Installed"} the entail service (${definition.manager}, ${definition.path}): it runs entail run now, at every login${restarts}.`);
    console.log(`The board: http://127.0.0.1:${DEFAULT_PORT}/ (entail open). Where it stands: entail status.`);
    return 0;
  }
  if (action === "uninstall") {
    const { definition, removed } = uninstallService(inputs, system);
    console.log(removed ? `Stopped and removed the entail service (${definition.path}).` : `The entail service is not installed (${definition.path}).`);
    return 0;
  }
  const status = serviceStatus(inputs, system);
  console.log(serviceLine(status));
  return status.installed && !status.active ? 1 : 0;
}

async function updateCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { port: { type: "string" } });
  if (positionals.length > 0) throw new UsageError("update takes no arguments");
  const url = `http://127.0.0.1:${portOption(values.port)}/`;
  const inputs = serviceInputs();
  const interrupted = new AbortController();
  const onInterrupt = () => interrupted.abort();
  process.once("SIGINT", onInterrupt);
  try {
    await update({ checkout: process.cwd(), url, inputs, system: machineServiceSystem(inputs), machine: machineUpdate(url, commandLineOf), print: (line) => console.log(line), signal: interrupted.signal });
    return 0;
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}

function serviceLine(status: ReturnType<typeof serviceStatus>): string {
  const { definition, installed, active, enabled, running } = status;
  if (!installed) return `The entail service is not installed${running ? `; entail is running by hand (pid ${running.pid})` : ""}. Install it with: entail service install`;
  const logs = { systemd: "journalctl --user -u entail", launchd: "launchctl print gui/$(id -u)/entail", "task-scheduler": "schtasks /Query /TN entail /V /FO LIST" }[definition.manager];
  return `The entail service is installed (${definition.manager}, ${definition.path}), ${enabled ? "starts at login" : "does not start at login"}, and is ${active ? `running${running ? ` (pid ${running.pid}, since ${running.startedAt})` : ""}` : `not running: see ${logs}`}.`;
}

function portOption(value: string | undefined): number {
  const port = value === undefined ? DEFAULT_PORT : Number(value);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) throw new UsageError("--port is a port number");
  return port;
}

/** What the running copy's API says: when each repo was last checked and whether it is failing, or null when it cannot be reached. */
async function readRunning(url: string): Promise<{ checkedAt: Map<string, string | null>; failing: Map<string, FailingView | null> } | null> {
  try {
    const response = await fetch(`${url}api/repos`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return null;
    const body = (await response.json()) as { repos?: { repo: string; checkedAt: string | null; failing?: FailingView | null }[] };
    const repos = body.repos ?? [];
    return { checkedAt: new Map(repos.map((repo) => [repo.repo, repo.checkedAt])), failing: new Map(repos.map((repo) => [repo.repo, repo.failing ?? null])) };
  } catch {
    return null;
  }
}

function ago(iso: string, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `on ${iso.slice(0, 16).replace("T", " ")}`;
}

async function statusCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { port: { type: "string" } });
  if (positionals.length > 0) throw new UsageError("status takes no arguments");
  const url = `http://127.0.0.1:${portOption(values.port)}/`;
  const dataDirectory = ensureDataDirectory();
  const holder = readLock(dataDirectory);
  const running = holder !== null && holderIsRunning(holder) ? holder : null;
  let service: ReturnType<typeof serviceStatus> | null = null;
  try {
    const inputs = serviceInputs();
    service = serviceStatus(inputs, machineServiceSystem(inputs));
  } catch {
    // No service manager here: the status says only whether entail runs.
  }
  const live = running === null ? null : await readRunning(url);
  const how = service?.active ? "as the service" : "by hand";
  console.log(
    running === null
      ? `entail is not running.${service?.installed ? " The service is installed but not running: entail service status." : " Start it with: entail service install (or entail run)."}`
      : `entail is running ${how} (pid ${running.pid}, since ${running.startedAt.slice(0, 16).replace("T", " ")} UTC)${service?.installed && service.enabled ? " and starts at login" : ""}.`,
  );
  console.log(running === null ? `The board is at ${url} while it runs.` : live === null ? `The board does not answer at ${url} (another --port?).` : `The board: ${url}`);

  const settings = settingsIn(dataDirectory);
  const repos = repoViews(dataDirectory, settings);
  const now = new Date();
  console.log("");
  if (repos.length === 0) console.log("No repo is enrolled. Enroll one with: entail enroll owner/repo");
  const width = Math.max(0, ...repos.map((repo) => repo.repo.length));
  for (const repo of repos) {
    const checked = live?.checkedAt.get(repo.repo) ?? null;
    const failing = live?.failing.get(repo.repo) ?? null;
    console.log(
      `${repo.repo.padEnd(width)}  confirm ${repo.confirm ? "on " : "off"}  ${checked === null ? (running === null ? "not checked: entail is not running" : "not checked yet") : `checked ${ago(checked, now)}`}${failing === null ? "" : `, failing since ${ago(failing.since, now)}: ${failing.reason}`}  ${repo.waiting} waiting${repo.blocked.length > 0 ? `, ${repo.blocked.length} held` : ""}`,
    );
    if (repo.cannotLabel !== null) console.log(`${" ".repeat(width)}  entail cannot label issues here: ${repo.cannotLabel}. Calls still post and close.`);
  }
  for (const repo of repos) for (const stalled of repo.stalled) console.log(`${repo.repo.padEnd(width)}  stalled: ${stalled.line}`);
  for (const repo of repos) {
    if (repo.blocked.length === 0) continue;
    console.log(`${repo.repo.padEnd(width)}  ${repo.blocked.length} held on open blockers: ${repo.blocked.map((held) => `#${held.issue} (blocked by ${held.blockers.join(", ")})`).join("; ")}`);
  }
  const waiting = waitingItems(dataDirectory, await caseBook(dataDirectory));
  const questions = waiting.filter((item) => item.call === "ask").length;
  console.log(
    `\n${waiting.length === 0 ? "Nothing waits on you." : `Waiting on you: ${[questions > 0 ? `${questions} question${questions === 1 ? "" : "s"}` : "", waiting.length - questions > 0 ? `${waiting.length - questions} call${waiting.length - questions === 1 ? "" : "s"} to confirm` : ""].filter((part) => part !== "").join(" and ")}${running === null ? "" : ` at ${url}#/waiting`}.`}`,
  );
  console.log(`Notices: ${settings.notice ?? "none"}. Start work with: ${settings.start ?? "none"}.`);
  console.log(backupLine(dataDirectory, settings, now));
  return 0;
}

async function openCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { port: { type: "string" } });
  if (positionals.length > 0) throw new UsageError("open takes no arguments");
  const url = `http://127.0.0.1:${portOption(values.port)}/`;
  const holder = readLock(ensureDataDirectory());
  if (holder === null || !holderIsRunning(holder)) {
    console.error(`entail: entail is not running, so the board at ${url} is not there. Start it with: entail service install (or entail run)`);
    return 1;
  }
  const opened = await openInBrowser(url);
  console.log(opened ? `Opened the board: ${url}` : `The board is at ${url} (no browser opener found here: open it yourself).`);
  return 0;
}

/** Opens a URL with the platform's opener: `open` on macOS, `xdg-open` on Linux, on WSL `wslview`, `xdg-open` or Windows' `explorer.exe`, and on Windows the URL handler `rundll32` calls. */
async function openInBrowser(url: string): Promise<boolean> {
  if (process.platform === "win32") return openWith("rundll32", ["url.dll,FileProtocolHandler", url]);
  const openers = process.platform === "darwin" ? ["open"] : isWsl(release()) ? ["wslview", "xdg-open", "explorer.exe"] : ["xdg-open"];
  for (const opener of openers) {
    if (await openWith(opener, [url])) return true;
  }
  return false;
}

/** Starts an opener and leaves it running; false when it could not be started. */
async function openWith(opener: string, args: string[]): Promise<boolean> {
  const child = spawn(opener, args, { stdio: "ignore", detached: true });
  const started = await new Promise<boolean>((resolve) => {
    child.once("spawn", () => resolve(true));
    child.once("error", () => resolve(false));
  });
  if (started) child.unref();
  return started;
}

async function waitingCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { json: { type: "boolean" } });
  if (positionals.length > 1) throw new UsageError("waiting takes at most one repo");
  const dataDirectory = ensureDataDirectory();
  const items = waitingItems(dataDirectory, await caseBook(dataDirectory), positionals[0] === undefined ? undefined : repoName(positionals[0]));
  console.log(values.json ? JSON.stringify(items, null, 2) : formatWaiting(items));
  return 0;
}

async function ownerCommand(command: "confirm" | "override" | "answer", args: string[]): Promise<number> {
  const { positionals, values } = parse(args, { accept: { type: "string" } });
  if (values.accept !== undefined && command !== "answer") throw new UsageError("--accept belongs to answer");
  const accept = values.accept === undefined ? undefined : acceptedParts(values.accept);
  const expected = command === "confirm" ? 1 : 3;
  if (positionals.length !== expected) {
    throw new UsageError(
      command === "confirm"
        ? "confirm takes one issue or PR, as owner/repo#n"
        : `${command} takes an issue or PR, your call (go, plan or no on an issue, merge or send-back on a PR), and your ${command === "override" ? "reason" : "answer"} in quotes`,
    );
  }
  const reference = parseIssueReference(positionals[0]!);
  const dataDirectory = ensureDataDirectory();
  const id = latestItemOn(dataDirectory, reference.path, reference.number);
  const by = await ownerName(dataDirectory);
  const name = `${repoName(reference.path)}#${reference.number}`;
  const onPullRequest = findItem(dataDirectory, id).entry.type === "landing";
  if (command === "confirm") await confirmCall(dataDirectory, id, by);
  else if (command === "override") await overrideCall(dataDirectory, id, by, positionals[1], positionals[2]);
  else await answerCall(dataDirectory, id, by, positionals[1], positionals[2], new Date(), accept === undefined ? {} : { accept });
  console.log(`${name}: your ${command === "confirm" ? "confirmation" : command === "override" ? "override" : "answer"} is recorded under ${by}; entail writes it to the case book and acts on the ${onPullRequest ? "PR" : "issue"} on its next pass.`);
  return 0;
}

/** `--accept 1,3`: the parts of an issue, counted from 1 as `entail waiting` lists them, as positions from 0. */
function acceptedParts(text: string): number[] {
  const numbers = text.split(",").map((part) => (/^\s*\d+\s*$/u.test(part) ? Number(part) - 1 : NaN));
  if (numbers.some((number) => !Number.isSafeInteger(number) || number < 0)) throw new UsageError("--accept takes the numbers of the parts to take, counted from 1, such as 1,3");
  return numbers;
}

async function callsCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { json: { type: "boolean" } });
  if (positionals.length > 1) throw new UsageError("calls takes at most one repo");
  const repo = positionals[0] === undefined ? undefined : repoName(positionals[0]);
  const dataDirectory = ensureDataDirectory();
  const items = logItems(dataDirectory, await caseBook(dataDirectory), repo);
  console.log(values.json ? JSON.stringify(items, null, 2) : formatLog(items, { repoColumn: repo === undefined }));
  return 0;
}

async function judgeCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, RUN_OPTIONS);
  if (positionals.length !== 1) throw new UsageError("judge takes one issue reference");
  const reference = parseIssueReference(positionals[0]!);
  const withSettings = runOptions(values);
  const setting: ForgeSetting = repoSetting(reference.path);
  const dataDirectory = ensureDataDirectory();
  const options = withSettings(settingsIn(dataDirectory));

  const forge = repoForge(dataDirectory, repoName(reference.path));
  const issue = await forge.issue(reference.number);
  if (issue === null) throw new Error(`${reference.path}#${reference.number} is not an issue`);
  const comments = await forge.comments("issue", reference.number);
  const reading = await mirrorReader(dataDirectory)(reference.path, forge);
  const issueText = renderIssue({
    title: issue.title,
    body: issue.body,
    comments: comments.map((comment) => ({ author: comment.author.username, createdAt: comment.createdAt, body: comment.body })),
  });
  const book = await caseBook(dataDirectory);

  const judgment = await judge(
    new ClaudeRunner(),
    {
      repo: reference.path,
      issueNumber: reference.number,
      issueText,
      vision: reading.vision,
      pins: reading.pins,
      precedents: precedentsFor(book, reference.path, issueText),
      checkout: reading.checkout,
      sha: reading.sha,
    },
    options,
  );
  if (values.json) {
    console.log(JSON.stringify(judgment, null, 2));
  } else if (judgment.ok) {
    console.log(`${reference.path}#${reference.number}: ${issue.title}\n`);
    console.log(formatCall(judgment.call));
    console.log(`\n${runLine(judgment.facts, options)}; pins from ${pinsFile(dataDirectory, setting)}`);
  } else {
    console.error(`entail: the run gave no call (${judgment.failure.kind}): ${judgment.failure.message}`);
  }
  return judgment.ok ? 0 : 1;
}

async function landCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { ...RUN_OPTIONS, issue: { type: "string" } });
  if (positionals.length !== 1) throw new UsageError("land takes one PR reference");
  const reference = parseIssueReference(positionals[0]!);
  const withSettings = runOptions(values);
  const dataDirectory = ensureDataDirectory();
  const options = withSettings(settingsIn(dataDirectory));
  const repo = repoName(reference.path);
  const forge = repoForge(dataDirectory, repo);
  const pr = await forge.pullRequest(reference.number);
  const entries = readLog(dataDirectory, repo);

  // A PR with no cleared go behind it by the forge's link data, and naming no issue with --issue, is judged on the vision alone.
  let issueNumber: number | null;
  if (values.issue !== undefined) {
    issueNumber = Number(values.issue);
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) throw new UsageError("--issue is an issue number");
  } else {
    const linked = await forge.linkedIssues(reference.number);
    issueNumber = linked.find((number) => clearedGoOn(entries, number) !== null) ?? null;
  }
  const go = issueNumber === null ? null : goCallOn(entries, issueNumber);
  let issueText = "";
  if (go !== null) issueText = go.issueText;
  else if (issueNumber !== null) {
    const issue = await forge.issue(issueNumber);
    if (issue === null) throw new Error(`${repo}#${issueNumber} is not an issue`);
    const comments = await forge.comments("issue", issueNumber);
    issueText = renderIssue({ title: issue.title, body: issue.body, comments: comments.map((c) => ({ author: c.author.username, createdAt: c.createdAt, body: c.body })) });
  }
  const criteria = go === null || go.call.call === "no" ? [] : go.call.criteria;

  const report = await forge.checks(reference.number, pr.headSha, []);
  if (!allChecksFinished(report)) console.error(`entail: CI has not finished at ${pr.headSha}; judging what has reported so far`);
  const files = await forge.pullRequestFiles(reference.number);
  const reading = await mirrorReaders(dataDirectory).prReader(repo, forge, reference.number, pr.headSha);
  try {
    const judgment = await judgeLanding(
      new ClaudeRunner(),
      {
        repo,
        pr: { number: reference.number, text: renderPullRequest(pr) },
        head: pr.headSha,
        base: reading.base,
        issue: issueNumber === null ? null : { number: issueNumber, text: issueText },
        criteria,
        generic: repoState(repo, entries).genericCriteria,
        vision: reading.vision,
        pins: reading.pins,
        facts: { checks: report.checks, required: report.required, files },
        diff: reading.diff,
        precedents: landingPrecedentsFor(await landingBook(dataDirectory), repo, issueNumber === null ? renderPullRequest(pr) : issueText),
        sendBacks: [],
        checkout: reading.checkout,
      },
      options,
    );
    if (values.json) console.log(JSON.stringify(judgment, null, 2));
    else if (judgment.ok) {
      if (issueNumber === null) {
        console.log(`${repo}#${reference.number} at ${pr.headSha}, with no issue behind it: ${pr.title}`);
        console.log(`(no cleared go behind it by ${forgeTitle(repo)}'s link data: judged on the vision alone)\n`);
      } else {
        console.log(`${repo}#${reference.number} at ${pr.headSha}, closing #${issueNumber}: ${pr.title}`);
        console.log(go === null ? `(#${issueNumber} has no go in entail's log: judged against no criteria)\n` : `(against the criteria of call ${go.id} on #${issueNumber}; ${sendBacksPosted(entries, reference.number)} send-backs posted before)\n`);
      }
      console.log(formatLandingCall(judgment.call, issueNumber === null));
      console.log(`\n${runLine(judgment.facts, options)}`);
    } else {
      console.error(`entail: the run gave no call (${judgment.failure.kind}): ${judgment.failure.message}`);
    }
    return judgment.ok ? 0 : 1;
  } finally {
    await reading.release();
  }
}

async function replayCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { ...RUN_OPTIONS, cases: { type: "string" }, concurrency: { type: "string" } });
  if (positionals.length > 0) throw new UsageError("replay takes no arguments");
  const withSettings = runOptions(values);
  const concurrency = values.concurrency === undefined ? 2 : Number(values.concurrency);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new UsageError("--concurrency must be a whole number of at least 1");
  const dataDirectory = ensureDataDirectory();
  const options = withSettings({ ...settingsIn(dataDirectory), effort: REPLAY_EFFORT });
  const book = values.cases === undefined ? await caseBook(dataDirectory) : await readCaseBook(values.cases);
  const landings = values.cases === undefined ? await landingBook(dataDirectory) : await readLandingCaseBook(values.cases);
  if (book.length === 0 && landings.length === 0) throw new Error("the case book has no cases");

  // One mirror per repo, brought up to date once; each case is read at its own commit. With a base branch set, the
  // default branch is fetched too, since cases judged before the base branch was set were read on it.
  const mirrors = new Map<string, Promise<Mirror>>();
  const mirrorOf = (repo: string): Promise<Mirror> => {
    let mirror = mirrors.get(repo);
    if (mirror === undefined) {
      mirror = openRepo(repo, dataDirectory).then(async ({ mirror: opened, forge }) => {
        if (forge.baseBranch !== null) await opened.updateBranch(null);
        await opened.updateBranch(forge.baseBranch);
        return opened;
      });
      mirrors.set(repo, mirror);
    }
    return mirror;
  };
  const checkoutOf = async (past: Case) => {
    const mirror = await mirrorOf(past.repo);
    if (!(await mirror.hasCommit(past.visionCommit))) throw new Error(`case ${past.slug}: ${past.repo} has no commit ${past.visionCommit} on its base branch`);
    return mirror.checkout(past.visionCommit);
  };

  // A landing case is read at its PR's head, fetched from the forge's PR ref, and diffed against its base.
  const readingOf = async (past: LandingCase) => {
    const mirror = await mirrorOf(past.repo);
    await mirror.fetchPullRequestHead(past.pr, past.head);
    if (!(await mirror.hasCommit(past.head))) throw new Error(`case ${past.slug}: ${past.repo} has no commit ${past.head} for PR #${past.pr}`);
    if (!(await mirror.hasCommit(past.base))) throw new Error(`case ${past.slug}: ${past.repo} has no commit ${past.base}`);
    const diff = await mirror.pullRequestDiff(past.base, past.head);
    const checkout = await mirror.checkout(past.head);
    return { checkout: checkout.directory, diff };
  };

  const runner = new ClaudeRunner();
  const results = await replay(runner, book, checkoutOf, { ...options, concurrency });
  const landed = await replayLandings(runner, landings, readingOf, { ...options, concurrency });
  if (values.json) {
    console.log(
      JSON.stringify(
        [
          ...results.map((result) => ({ kind: "issue", case: result.case.slug, owner: result.case.call, agrees: result.agrees, missing: result.missing, judgment: result.judgment })),
          ...landed.map((result) => ({ kind: "landing", case: result.case.slug, owner: result.case.call, agrees: result.agrees, judgment: result.judgment })),
        ],
        null,
        2,
      ),
    );
  } else {
    console.log(formatReplay(results, landed));
    const cost = [...results, ...landed].reduce((sum, result) => sum + (result.judgment.facts?.estimatedCostUsd ?? 0), 0);
    console.log(`${options.model} at ${options.effort} effort, about $${cost.toFixed(2)}`);
  }
  return [...results, ...landed].every((result) => result.agrees === true) ? 0 : 1;
}

async function suggestCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, RUN_OPTIONS);
  const repo = oneRepo(positionals, "suggest");
  if (values.effort !== undefined && !(EFFORTS as readonly string[]).includes(values.effort)) throw new UsageError(`--effort must be one of ${EFFORTS.join(", ")}`);
  const dataDirectory = ensureDataDirectory();
  const view = repoViews(dataDirectory, settingsIn(dataDirectory)).find((one) => one.repo === repo);
  if (view === undefined) throw new Error(`${repo} is not enrolled: enroll it first with entail enroll ${repo}`);
  const choice = { model: values.model ?? view.uses.model, effort: (values.effort as Effort | undefined) ?? view.uses.effort };
  if (!values.json) console.error(`Suggesting work for ${repo} with ${choice.model} at ${choice.effort} effort; this can take a while on a big product...`);
  const outcome = await runSuggestions({
    dataDirectory,
    repo,
    by: await ownerName(dataDirectory),
    forge: repoForge(dataDirectory, repo),
    read: mirrorReaders(dataDirectory).suggestReader,
    runner: new ClaudeRunner({ timeoutMs: SUGGEST_TIMEOUT_MS }),
    book: () => caseBook(dataDirectory),
    ...choice,
  });
  if (values.json) console.log(JSON.stringify(outcome, null, 2));
  else if (outcome.ok) {
    console.log(formatSuggestions(outcome.run, outcome.filed));
    console.log(`\n${runLine(outcome.facts, choice)}; each filed issue gets entail's usual call on its next pass`);
  } else console.error(`entail: ${outcome.failed.reason}`);
  return outcome.ok ? 0 : 1;
}

/** When the earliest owner's action still in its undo window comes due, across the enrolled repos. */
function nextDue(dataDirectory: string): Date | null {
  const now = new Date();
  let due: number | null = null;
  for (const repo of loggedRepos(dataDirectory)) {
    for (const action of heldActions(readLog(dataDirectory, repo), now)) {
      const at = Date.parse(action.holdUntil!);
      if (due === null || at < due) due = at;
    }
  }
  return due === null ? null : new Date(due);
}

function runLine(facts: RunFacts, options: JudgeOptions): string {
  const cost = facts.estimatedCostUsd === null ? "" : `, about $${facts.estimatedCostUsd.toFixed(2)}`;
  return `${facts.model} at ${options.effort} effort, ${Math.round(facts.durationMs / 1000)} s${cost}`;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
