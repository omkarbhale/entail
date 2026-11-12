#!/usr/bin/env node
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { DEFAULT_CASE_BOOK, precedentsFor, readCaseBook, renderIssue, type Case } from "./case-book.ts";
import { ClaudeRunner } from "./claude-runner.ts";
import { ensureDataDirectory } from "./data-directory.ts";
import { createForge } from "./forge/create-forge.ts";
import type { Forge, ForgeSetting } from "./forge/forge.ts";
import { formatCall, judge, type JudgeOptions } from "./judgment.ts";
import { forgeRemote, Mirror } from "./mirror.ts";
import { DEFAULT_MODEL, EFFORTS, type Effort, type RunFacts } from "./model-runner.ts";
import { pinsFile, readPins } from "./pins.ts";
import { formatReplay, replay } from "./replay.ts";
import { readVision } from "./vision.ts";

/** The effort a run uses unless `--effort` names another. */
export const DEFAULT_EFFORT: Effort = "low";

const USAGE = `usage:
  entail judge <owner/repo>#<n> [--model <model>] [--effort <level>] [--json]
  entail replay [--model <model>] [--effort <level>] [--cases <dir>] [--concurrency <n>] [--json]

judge    makes the owner's call on one GitHub issue: go, no or ask, with the reason,
         and the criteria for go or the question for ask. It posts nothing.
replay   runs every case in the case book through the judgment and prints
         agreement with the owner's calls, disagreements first.

--model    the model to run (default ${DEFAULT_MODEL})
--effort   ${EFFORTS.join(", ")} (default ${DEFAULT_EFFORT})
--cases    the case book directory (default: the one entail ships with)

A repo's pins are read from pins/<host>/<owner>/<name>.md in entail's data
directory, one topic per line.`;

class UsageError extends Error {}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "judge":
        return await judgeCommand(rest);
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
    if (error instanceof UsageError) {
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

function runOptions(values: { model?: string | undefined; effort?: string | undefined }): JudgeOptions {
  const effort = values.effort ?? DEFAULT_EFFORT;
  if (!(EFFORTS as readonly string[]).includes(effort)) throw new UsageError(`--effort must be one of ${EFFORTS.join(", ")}`);
  return { model: values.model ?? DEFAULT_MODEL, effort: effort as Effort };
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

async function judgeCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, RUN_OPTIONS);
  if (positionals.length !== 1) throw new UsageError("judge takes one issue reference");
  const reference = parseIssueReference(positionals[0]!);
  const options = runOptions(values);
  const setting: ForgeSetting = { forge: "github", host: GITHUB, path: reference.path };
  const dataDirectory = ensureDataDirectory();

  const { forge, mirror } = await openRepo(setting, dataDirectory);
  const issue = await forge.issue(reference.number);
  if (issue === null) throw new Error(`${reference.path}#${reference.number} is not an issue`);
  const comments = await forge.comments("issue", reference.number);
  const head = await mirror.updateDefaultBranch();
  const checkout = await mirror.checkout(head.commit);
  const vision = await readVision(mirror.git, head.commit);
  const visionText = vision.status === "missing" ? null : (await mirror.git.run(["cat-file", "blob", vision.blob])).stdout.toString("utf8");
  const issueText = renderIssue({
    title: issue.title,
    body: issue.body,
    comments: comments.map((comment) => ({ author: comment.author.username, createdAt: comment.createdAt, body: comment.body })),
  });
  const book = await readCaseBook(DEFAULT_CASE_BOOK);

  const judgment = await judge(
    new ClaudeRunner(),
    {
      repo: reference.path,
      issueNumber: reference.number,
      issueText,
      vision: visionText === null ? null : { text: visionText, commit: head.commit },
      pins: await readPins(dataDirectory, setting),
      precedents: precedentsFor(book, reference.path, issueText),
      checkout: checkout.directory,
      sha: checkout.commit,
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

async function replayCommand(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { ...RUN_OPTIONS, cases: { type: "string" }, concurrency: { type: "string" } });
  if (positionals.length > 0) throw new UsageError("replay takes no arguments");
  const options = runOptions(values);
  const concurrency = values.concurrency === undefined ? 2 : Number(values.concurrency);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new UsageError("--concurrency must be a whole number of at least 1");
  const book = await readCaseBook(values.cases ?? DEFAULT_CASE_BOOK);
  if (book.length === 0) throw new Error("the case book has no cases");
  const dataDirectory = ensureDataDirectory();

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

  const results = await replay(new ClaudeRunner(), book, checkoutOf, { ...options, concurrency });
  if (values.json) {
    console.log(JSON.stringify(results.map((result) => ({ case: result.case.slug, owner: result.case.call, agrees: result.agrees, judgment: result.judgment })), null, 2));
  } else {
    console.log(formatReplay(results));
    const cost = results.reduce((sum, result) => sum + (result.judgment.facts?.estimatedCostUsd ?? 0), 0);
    console.log(`${options.model} at ${options.effort} effort, about $${cost.toFixed(2)}`);
  }
  return results.every((result) => result.agrees === true) ? 0 : 1;
}

function runLine(facts: RunFacts, options: JudgeOptions): string {
  const cost = facts.estimatedCostUsd === null ? "" : `, about $${facts.estimatedCostUsd.toFixed(2)}`;
  return `${facts.model} at ${options.effort} effort, ${Math.round(facts.durationMs / 1000)} s${cost}`;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
