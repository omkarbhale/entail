#!/usr/bin/env node
import { once } from "node:events";
import { join } from "node:path";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { changeSettings, createApi } from "./api.ts";
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
import { createForge } from "./forge/create-forge.ts";
import type { Forge, ForgeSetting } from "./forge/forge.ts";
import { allChecksFinished } from "./forge/forge.ts";
import { formatCall, judge, type JudgeOptions } from "./judgment.ts";
import { formatLandingCall, judgeLanding } from "./landing.ts";
import { acquireLock } from "./lock.ts";
import { forgeRemote, Mirror } from "./mirror.ts";
import { DEFAULT_EFFORT, DEFAULT_MODEL, EFFORTS, type Effort, type RunFacts } from "./model-runner.ts";
import { OperationalLog } from "./operational-log.ts";
import {
  answerCall,
  changeRepoSettings,
  checkSettingsChange,
  confirmCall,
  enroll,
  formatLog,
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
import { pinsFile } from "./pins.ts";
import { goCallOn, readLog, readSettings, sendBacksPosted, type GlobalSettings } from "./records.ts";
import { formatReplay, replay, replayLandings } from "./replay.ts";
import { mirrorReader, mirrorReaders, runPass, type PassOptions } from "./watch.ts";

/** The port the board's API is served on unless --port names another. */
export const DEFAULT_PORT = 4380;

/** How long `entail run` waits between passes unless --interval says otherwise. */
export const DEFAULT_INTERVAL_SECONDS = 60;

const USAGE = `usage:
  entail enroll <owner/repo> [--no-confirm] [--since <time>]
  entail unenroll <owner/repo>
  entail repos [--all] [--json]
  entail settings [<owner/repo>] [--confirm on|off] [--model <model>|default] [--effort <level>|default] [--owner <name>]
  entail run [--once] [--dry-run] [--interval <seconds>] [--port <n>]
  entail waiting [<owner/repo>] [--json]
  entail confirm <owner/repo>#<n>
  entail override <owner/repo>#<n> go|no|merge|send-back <reason>
  entail answer <owner/repo>#<n> go|no|merge|send-back <answer>
  entail calls [<owner/repo>] [--json]
  entail judge <owner/repo>#<n> [--model <model>] [--effort <level>] [--json]
  entail land <owner/repo>#<pr> [--issue <n>] [--model <model>] [--effort <level>] [--json]
  entail replay [--model <model>] [--effort <level>] [--cases <dir>] [--concurrency <n>] [--json]

enroll     watch a repo: entail makes the call on each issue filed or edited from now
           (or --since) on, and on each /entail mention. A repo starts in confirm mode,
           where a go or no is posted but nothing is closed or started until you confirm.
unenroll   stop watching a repo; its log is kept.
repos      the enrolled repos with confirm mode, model, effort and what waits on you.
settings   with a repo, its confirm mode, model and effort ("default" uses the one for
           every repo); without, your name on comments and the default model and effort.
run        poll every enrolled repo, make each call once per edit, post it, and serve the
           board's API on 127.0.0.1 (port ${DEFAULT_PORT} by default). Each PR that closes an
           issue entail said go on is judged at each new head once CI has finished:
           merged at that head, sent back with what needs to change, or asked about.
           --once makes one pass; --dry-run makes one pass that posts, closes, merges
           and records nothing and prints what it would do.
waiting    the questions and calls to confirm waiting on you, across repos.
confirm    confirm the latest call on an issue or PR: entail then acts on it.
override   replace the latest call on an issue (go or no) or a PR (merge or send-back)
           with your call and reason.
answer     answer the question on an issue (go or no) or a PR (merge or send-back)
           with your call and words.
calls      the log: every call with its reason, and every confirmation, override,
           answer and post, for one repo or all.
judge      make the call on one issue and print it. It posts nothing.
land       make the landing call on one PR at its head and print it, against the
           criteria of the go entail logged on the issue it closes (or --issue). It
           posts and merges nothing.
replay     run every case in the case book through its judgment (issue cases through
           the call on an issue, landing cases through the call on a PR) and print
           agreement with the owner's calls, disagreements first.

--model    the model to run (default: the setting, ${DEFAULT_MODEL} unless changed)
--effort   ${EFFORTS.join(", ")} (default: the setting, ${DEFAULT_EFFORT} unless changed)
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
      case "run":
        return await runCommand(rest);
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

/** The case book: the one entail ships with, then the owner's own, whose cases win. */
function caseBook(dataDirectory: string): Promise<Case[]> {
  return readCaseBooks([DEFAULT_CASE_BOOK, join(dataDirectory, OWNER_CASE_BOOK)]);
}

/** The landing cases of the same books. */
function landingBook(dataDirectory: string): Promise<LandingCase[]> {
  return readLandingCaseBooks([DEFAULT_CASE_BOOK, join(dataDirectory, OWNER_CASE_BOOK)]);
}

/** The owner's display name: the setting, else the GitHub account `gh` is logged in as. */
async function ownerName(dataDirectory: string): Promise<string> {
  const set = settingsIn(dataDirectory).owner;
  if (set !== null) return set;
  const actor = await createForge({ forge: "github", host: GITHUB, path: "github/docs" }).currentActor();
  if (actor === null) throw new Error("gh is not logged in, and no name is set: run gh auth login, or entail settings --owner <your name>");
  return actor.username;
}

function parse<const O extends ParseArgsOptionsConfig>(args: string[], options: O) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

/** Reads `owner/name#number`. */
export function parseIssueReference(text: string): { path: string; number: number } {
  const match = /^([\w.-]+\/[\w.-]+)#(\d+)$/u.exec(text);
  const number = Number(match?.[2]);
  if (match === null || !Number.isSafeInteger(number) || number <= 0) throw new UsageError(`not an issue reference: ${text} (expected owner/repo#number)`);
  return { path: match[1]!, number };
}

const GITHUB = "github.com";

async function openRepo(setting: ForgeSetting, dataDirectory: string): Promise<{ forge: Forge; mirror: Mirror }> {
  const forge = createForge(setting);
  const project = await forge.project();
  const mirror = await Mirror.open({
    dataDirectory,
    key: { forge: setting.forge, host: setting.host, projectId: project.id },
    remote: forgeRemote(setting.forge, setting.host, setting.path),
  });
  return { forge, mirror };
}

function oneRepo(positionals: string[], command: string): string {
  if (positionals.length !== 1) throw new UsageError(`${command} takes one repo, as owner/repo`);
  return repoName(positionals[0]!);
}

async function enrollCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { "no-confirm": { type: "boolean" }, since: { type: "string" } });
  const repo = oneRepo(positionals, "enroll");
  const since = values.since === undefined ? undefined : new Date(values.since);
  if (since !== undefined && Number.isNaN(since.getTime())) throw new UsageError(`--since is a date or time, such as 2026-11-12 or 2026-11-12T09:00:00Z, not ${values.since}`);
  const dataDirectory = ensureDataDirectory();
  // Reading the repo checks it exists and gh can see it.
  await createForge({ forge: "github", host: GITHUB, path: repo }).project();
  const state = enroll(dataDirectory, repo, await ownerName(dataDirectory), { confirm: values["no-confirm"] !== true, ...(since ? { since } : {}) });
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
        `${repo.repo}${repo.enrolled ? "" : " (not enrolled)"}: confirm mode ${repo.confirm ? "on" : "off"}, ${repo.uses.model}${own(repo.model)} at ${repo.uses.effort} effort${own(repo.effort)}; ${repo.calls} calls, ${repo.waiting} waiting on you` +
          (repo.checked > 0 ? `; you confirmed ${repo.agreed} of the ${repo.checked} calls you checked` : ""),
      );
    }
  }
  return 0;
}

async function settingsCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { confirm: { type: "string" }, model: { type: "string" }, effort: { type: "string" }, owner: { type: "string" } });
  if (positionals.length > 1) throw new UsageError("settings takes at most one repo");
  const dataDirectory = ensureDataDirectory();
  if (positionals.length === 1) {
    if (values.owner !== undefined) throw new UsageError("--owner is a setting for every repo; leave the repo out");
    const change: Record<string, unknown> = {};
    if (values.confirm !== undefined) {
      if (values.confirm !== "on" && values.confirm !== "off") throw new UsageError("--confirm is on or off");
      change.confirm = values.confirm === "on";
    }
    if (values.model !== undefined) change.model = values.model === "default" ? null : values.model;
    if (values.effort !== undefined) change.effort = values.effort === "default" ? null : values.effort;
    const repo = repoName(positionals[0]!);
    const state =
      Object.keys(change).length === 0
        ? repoViews(dataDirectory, settingsIn(dataDirectory), { all: true }).find((view) => view.repo === repo)
        : changeRepoSettings(dataDirectory, repo, await ownerName(dataDirectory), checkSettingsChange(change));
    if (state === undefined) throw new Error(`${repo} has never been enrolled`);
    const settings = settingsIn(dataDirectory);
    console.log(`${repo}: confirm mode ${state.confirm ? "on" : "off"}, model ${state.model ?? `${settings.model} (default)`}, effort ${state.effort ?? `${settings.effort} (default)`}`);
    return 0;
  }
  if (values.confirm !== undefined) throw new UsageError("--confirm is a setting of one repo: name it");
  const change: Record<string, unknown> = {};
  for (const key of ["owner", "model", "effort"] as const) if (values[key] !== undefined) change[key] = values[key];
  const settings = Object.keys(change).length === 0 ? settingsIn(dataDirectory) : changeSettings(dataDirectory, DEFAULT_MODEL, change);
  console.log(`your name on comments: ${settings.owner ?? "(not set: the GitHub account gh is logged in as)"}\ndefault model: ${settings.model}\ndefault effort: ${settings.effort}`);
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
  const forges = new Map<string, Forge>();
  const seen = new Map<string, ChangeDeduplicator>();
  const cursors = new CursorStore(dataDirectory);
  const { reader, prReader } = mirrorReaders(dataDirectory);
  const runner = new ClaudeRunner();
  const stop = new AbortController();
  const passOptions = async (): Promise<PassOptions> => ({
    dataDirectory,
    owner: await ownerName(dataDirectory),
    settings: settingsIn(dataDirectory),
    forgeFor: (repo) => {
      let forge = forges.get(repo);
      if (forge === undefined) forges.set(repo, (forge = createForge({ forge: "github", host: GITHUB, path: repo })));
      return forge;
    },
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
      console.log(`\n${report.repos} repos, ${report.judged} calls made, ${report.posted} ${dryRun ? "posts it would make" : "posts"}${report.failed.length > 0 ? `; not finished: ${report.failed.join(", ")}` : ""}`);
      return report.failed.length > 0 ? 1 : 0;
    }

    let wake: (() => void) | null = null;
    const server = createApi({
      dataDirectory,
      owner: () => ownerName(dataDirectory),
      defaultModel: DEFAULT_MODEL,
      book: () => caseBook(dataDirectory),
      wake: () => wake?.(),
    });
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    console.log(`entail is watching; the board's API is on http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : port}/api/waiting`);
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => stop.abort(new Error(`stopped by ${signal}`)));
    try {
      while (!stop.signal.aborted) {
        try {
          const report = await runPass(await passOptions());
          log.info("pass", { ...report });
        } catch (error) {
          if (stop.signal.aborted) break;
          log.error("pass-error", { error: error instanceof Error ? error.message : String(error) });
          console.error(`entail: the pass failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, interval * 1000);
          const done = () => {
            clearTimeout(timer);
            wake = null;
            resolve();
          };
          wake = done;
          stop.signal.addEventListener("abort", done, { once: true });
        });
      }
    } finally {
      server.close();
    }
    return 0;
  } finally {
    lock?.release();
  }
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
  const { positionals } = parse(args, {});
  const expected = command === "confirm" ? 1 : 3;
  if (positionals.length !== expected) {
    throw new UsageError(
      command === "confirm"
        ? "confirm takes one issue or PR, as owner/repo#n"
        : `${command} takes an issue or PR, your call (go or no on an issue, merge or send-back on a PR), and your ${command === "override" ? "reason" : "answer"} in quotes`,
    );
  }
  const reference = parseIssueReference(positionals[0]!);
  const dataDirectory = ensureDataDirectory();
  const id = latestItemOn(dataDirectory, reference.path, reference.number);
  const by = await ownerName(dataDirectory);
  const name = `${repoName(reference.path)}#${reference.number}`;
  if (command === "confirm") await confirmCall(dataDirectory, id, by);
  else if (command === "override") await overrideCall(dataDirectory, id, by, positionals[1], positionals[2]);
  else await answerCall(dataDirectory, id, by, positionals[1], positionals[2]);
  console.log(`${name}: your ${command === "confirm" ? "confirmation" : command === "override" ? "override" : "answer"} is recorded under ${by} and written to the case book; entail acts on it on its next pass.`);
  return 0;
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
  const setting: ForgeSetting = { forge: "github", host: GITHUB, path: reference.path };
  const dataDirectory = ensureDataDirectory();
  const options = withSettings(settingsIn(dataDirectory));

  const forge = createForge(setting);
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
  const forge = createForge({ forge: "github", host: GITHUB, path: reference.path });
  const pr = await forge.pullRequest(reference.number);
  const entries = readLog(dataDirectory, repo);

  let issueNumber: number;
  if (values.issue !== undefined) {
    issueNumber = Number(values.issue);
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) throw new UsageError("--issue is an issue number");
  } else {
    const linked = await forge.linkedIssues(reference.number);
    const judged = linked.find((number) => goCallOn(entries, number) !== null);
    if (judged === undefined && linked.length === 0) throw new Error(`${repo}#${reference.number} closes no issue by GitHub's link data; name one with --issue`);
    issueNumber = judged ?? linked[0]!;
  }
  const go = goCallOn(entries, issueNumber);
  let issueText: string;
  if (go !== null) issueText = go.issueText;
  else {
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
        issue: { number: issueNumber, text: issueText },
        criteria,
        vision: reading.vision,
        pins: reading.pins,
        facts: { checks: report.checks, required: report.required, files },
        diff: reading.diff,
        precedents: landingPrecedentsFor(await landingBook(dataDirectory), repo, issueText),
        sendBacks: [],
        checkout: reading.checkout,
      },
      options,
    );
    if (values.json) console.log(JSON.stringify(judgment, null, 2));
    else if (judgment.ok) {
      console.log(`${repo}#${reference.number} at ${pr.headSha}, closing #${issueNumber}: ${pr.title}`);
      console.log(go === null ? `(#${issueNumber} has no go in entail's log: judged against no criteria)\n` : `(against the criteria of call ${go.id} on #${issueNumber}; ${sendBacksPosted(entries, reference.number)} send-backs posted before)\n`);
      console.log(formatLandingCall(judgment.call));
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
  const options = withSettings(settingsIn(dataDirectory));
  const book = values.cases === undefined ? await caseBook(dataDirectory) : await readCaseBook(values.cases);
  const landings = values.cases === undefined ? await landingBook(dataDirectory) : await readLandingCaseBook(values.cases);
  if (book.length === 0 && landings.length === 0) throw new Error("the case book has no cases");

  // One mirror per repo, brought up to date once; each case is read at its own commit.
  const mirrors = new Map<string, Promise<Mirror>>();
  const mirrorOf = (repo: string): Promise<Mirror> => {
    let mirror = mirrors.get(repo);
    if (mirror === undefined) {
      mirror = openRepo({ forge: "github", host: GITHUB, path: repo }, dataDirectory).then(async ({ mirror: opened }) => {
        await opened.updateDefaultBranch();
        return opened;
      });
      mirrors.set(repo, mirror);
    }
    return mirror;
  };
  const checkoutOf = async (past: Case) => {
    const mirror = await mirrorOf(past.repo);
    if (!(await mirror.hasCommit(past.visionCommit))) throw new Error(`case ${past.slug}: ${past.repo} has no commit ${past.visionCommit} on its default branch`);
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
          ...results.map((result) => ({ kind: "issue", case: result.case.slug, owner: result.case.call, agrees: result.agrees, judgment: result.judgment })),
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

function runLine(facts: RunFacts, options: JudgeOptions): string {
  const cost = facts.estimatedCostUsd === null ? "" : `, about $${facts.estimatedCostUsd.toFixed(2)}`;
  return `${facts.model} at ${options.effort} effort, ${Math.round(facts.durationMs / 1000)} s${cost}`;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
