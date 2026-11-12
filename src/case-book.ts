import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChangedFile, Check, RequiredCheck } from "./forge/forge.ts";

/**
 * The case book: real issues and the call the owner actually made on each.
 * It is precedent for the judgment and the test of it: `entail replay` runs
 * every case through the judgment and compares the answer with the owner's.
 *
 * Each case is a directory `cases/<slug>/` holding:
 *
 * - `issue.md`: the issue as it stood when the call was made (title, body and
 *   the comments that existed then), as {@link renderIssue} writes it;
 * - `vision.md`: VISION.md at the commit the call was made against, empty
 *   when the repo had none;
 * - `call.md`: the owner's call, its one-line reason and where that reason
 *   comes from, the date, and the vision commit, as front matter and a body.
 *
 * A landing case, the owner's call on a PR, is told apart by `kind: landing`
 * in its call.md, and holds two more files (see {@link LandingCase}). Each
 * kind is read on its own: {@link readCaseBooks} reads the issue cases and
 * {@link readLandingCaseBooks} the landing cases.
 */

/** The case book that ships with entail, next to `src/` and `dist/`. */
export const DEFAULT_CASE_BOOK = fileURLToPath(new URL("../cases", import.meta.url));

/**
 * Where the owner's calls made on the board are written, inside entail's data
 * directory: the owner's own case book, read next to the one entail ships with.
 */
export const OWNER_CASE_BOOK = "cases";

/** The calls an owner makes on an issue. */
export const OWNER_CALLS = ["go", "no"] as const;

export type OwnerCall = (typeof OWNER_CALLS)[number];

export interface Case {
  slug: string;
  /** The repo the issue is in, as `owner/name`. */
  repo: string;
  issue: number;
  /** issue.md as written. */
  issueText: string;
  /** vision.md as written; empty when the repo had no vision. */
  vision: string;
  /** The commit the vision was read at. */
  visionCommit: string;
  call: OwnerCall;
  /** The one-line reason for the call. */
  reason: string;
  /**
   * Where the reason comes from: the owner's own words, or what it was read
   * from when the owner wrote none, so no one else's words read as the owner's.
   */
  reasonFrom: string;
  /** The day the call was made, `YYYY-MM-DD`. */
  date: string;
  /** Anything call.md holds after the reason, such as the owner's words quoted. */
  notes: string;
}

/** An issue as the judgment reads it. */
export interface IssueText {
  title: string;
  body: string;
  comments: { author: string; createdAt: string; body: string }[];
}

/** An issue as markdown: what issue.md holds and what the judgment's prompt quotes. */
export function renderIssue(issue: IssueText): string {
  const parts = [`# ${issue.title.trim()}`, issue.body.trim() === "" ? "(no description)" : issue.body.trim()];
  if (issue.comments.length > 0) {
    parts.push("## Comments");
    for (const comment of issue.comments) {
      parts.push(`**${comment.author}**, ${comment.createdAt}:\n\n${comment.body.trim()}`);
    }
  }
  return `${parts.join("\n\n")}\n`;
}

/** The title of an issue.md: its first `# ` heading. */
export function issueTitle(issueText: string): string {
  return /^# (.*)$/mu.exec(issueText)?.[1]?.trim() ?? "(untitled)";
}

/** Reads every issue case in the book, sorted by slug. A malformed case is an error naming it. */
export async function readCaseBook(directory: string): Promise<Case[]> {
  const cases = await Promise.all((await caseSlugs(directory)).map((slug) => readAnyCase(join(directory, slug), slug)));
  return cases.filter((past): past is Case => !("kind" in past));
}

/** Reads every landing case in the book, sorted by slug. A malformed case is an error naming it. */
export async function readLandingCaseBook(directory: string): Promise<LandingCase[]> {
  const cases = await Promise.all((await caseSlugs(directory)).map((slug) => readAnyCase(join(directory, slug), slug)));
  return cases.filter((past): past is LandingCase => "kind" in past);
}

async function caseSlugs(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name).sort();
}

async function readAnyCase(directory: string, slug: string): Promise<Case | LandingCase> {
  const call = await readFile(join(directory, "call.md"), "utf8");
  return isLandingCall(call) ? readLandingCase(directory, slug) : readCase(directory, slug);
}

/**
 * Reads several books as one: a book that does not exist is empty, and a case
 * in a later book replaces a case of the same slug in an earlier one, so the
 * owner's latest call on an issue is the one that counts.
 */
export async function readCaseBooks(directories: readonly string[]): Promise<Case[]> {
  return mergeBooks(directories, readCaseBook);
}

/** Reads several books' landing cases as one, the way {@link readCaseBooks} reads their issue cases. */
export async function readLandingCaseBooks(directories: readonly string[]): Promise<LandingCase[]> {
  return mergeBooks(directories, readLandingCaseBook);
}

async function mergeBooks<C extends { slug: string }>(directories: readonly string[], read: (directory: string) => Promise<C[]>): Promise<C[]> {
  const bySlug = new Map<string, C>();
  for (const directory of directories) {
    let book: C[];
    try {
      book = await read(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const past of book) bySlug.set(past.slug, past);
  }
  return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

/** The slug of the case for an issue: `owner-name-number`. */
export function caseSlug(repo: string, issue: number): string {
  return `${repo.replace("/", "-")}-${issue}`.toLowerCase();
}

/**
 * Writes a case into a book, replacing any case of the same slug whole: the
 * three files are written to a fresh directory that then takes the case's place.
 */
export async function writeCase(directory: string, past: Case): Promise<string> {
  // Checks the case reads back as written before anything is replaced.
  parseCall(renderCall(past));
  return replaceCaseDirectory(directory, past.slug, { "issue.md": past.issueText, "vision.md": past.vision, "call.md": renderCall(past) });
}

/** Writes a case's files to a fresh directory that then takes the place of the case's directory. */
async function replaceCaseDirectory(directory: string, slug: string, files: Record<string, string>): Promise<string> {
  const target = join(directory, slug);
  const staging = join(directory, `.${slug}.new-${process.pid}-${Date.now()}`);
  await mkdir(staging, { recursive: true, mode: 0o700 });
  for (const [name, text] of Object.entries(files)) await writeFile(join(staging, name), text);
  const old = join(directory, `.${slug}.old-${process.pid}-${Date.now()}`);
  try {
    await rename(target, old);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rename(staging, target);
  await rm(old, { recursive: true, force: true });
  return target;
}

async function readCase(directory: string, slug: string): Promise<Case> {
  const [issueText, vision, call] = await Promise.all(
    ["issue.md", "vision.md", "call.md"].map((name) => readFile(join(directory, name), "utf8")),
  );
  try {
    return { slug, issueText: issueText!, vision: vision!, ...parseCall(call!) };
  } catch (error) {
    throw new Error(`case ${slug}: ${(error as Error).message}`);
  }
}

/** Parses call.md: front matter of `key: value` lines, then the reason, then any notes. */
export function parseCall(text: string): Omit<Case, "slug" | "issueText" | "vision"> {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(text.replace(/\r\n/gu, "\n"));
  if (match === null) throw new Error("call.md has no front matter");
  const fields = new Map<string, string>();
  for (const line of match[1]!.split("\n")) {
    const field = /^([a-z-]+):\s*(.*)$/u.exec(line);
    if (field) fields.set(field[1]!, field[2]!.trim());
  }
  const need = (key: string): string => {
    const value = fields.get(key);
    if (value === undefined || value === "") throw new Error(`call.md has no ${key}`);
    return value;
  };
  const call = need("call");
  if (!(OWNER_CALLS as readonly string[]).includes(call)) throw new Error(`call.md's call is ${call}, not go or no`);
  const issue = Number(need("issue"));
  if (!Number.isSafeInteger(issue) || issue <= 0) throw new Error(`call.md's issue is not an issue number`);
  const [reason = "", ...rest] = match[2]!.trim().split(/\n\s*\n/u);
  if (reason.trim() === "") throw new Error("call.md has no reason");
  return {
    repo: need("repo"),
    issue,
    call: call as OwnerCall,
    date: need("date"),
    visionCommit: need("vision-commit"),
    reasonFrom: need("reason-from"),
    reason: reason.trim(),
    notes: rest.join("\n\n").trim(),
  };
}

/** Writes call.md for a case: the inverse of {@link parseCall}. */
export function renderCall(call: Omit<Case, "slug" | "issueText" | "vision">): string {
  const front = [
    `repo: ${call.repo}`,
    `issue: ${call.issue}`,
    `call: ${call.call}`,
    `date: ${call.date}`,
    `vision-commit: ${call.visionCommit}`,
    `reason-from: ${call.reasonFrom}`,
  ];
  const body = [call.reason, ...(call.notes === "" ? [] : [call.notes])];
  return `---\n${front.join("\n")}\n---\n\n${body.join("\n\n")}\n`;
}

/** How many past cases go into a prompt at most. */
export const PRECEDENT_LIMIT = 8;

/**
 * The past cases most relevant to an issue, most relevant first. While the
 * book is small every case goes in; past {@link PRECEDENT_LIMIT} the cases of
 * the same repo that share the most words with the issue are chosen, then
 * other repos' by the same measure. The model decides what a precedent
 * means; this only keeps the prompt to a readable size.
 */
export function precedentsFor(cases: readonly Case[], repo: string, issueText: string, limit = PRECEDENT_LIMIT): Case[] {
  return rankByRelevance(cases, repo, issueText).slice(0, limit);
}

function rankByRelevance<C extends { slug: string; repo: string; issueText: string }>(cases: readonly C[], repo: string, issueText: string): C[] {
  const words = wordsOf(issueText);
  const scored = cases.map((past) => ({
    past,
    sameRepo: past.repo.toLowerCase() === repo.toLowerCase(),
    overlap: overlap(words, wordsOf(past.issueText)),
  }));
  scored.sort((a, b) => Number(b.sameRepo) - Number(a.sameRepo) || b.overlap - a.overlap || a.past.slug.localeCompare(b.past.slug));
  return scored.map((entry) => entry.past);
}

function wordsOf(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z][a-z0-9-]{3,}/gu) ?? []);
}

/** Jaccard similarity of two word sets. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / (a.size + b.size - shared);
}

// Landing cases: the owner's calls on PRs.

/** The calls an owner makes on a PR. */
export const LANDING_CALLS = ["merge", "send-back"] as const;

export type LandingOwnerCall = (typeof LANDING_CALLS)[number];

/** A criterion a PR was judged against: the criterion entail set at intake, and its basis when known. */
export interface LandingCriterion {
  criterion: string;
  basis: string;
}

/** What entail reads about a PR from the forge, never from the PR's description. */
export interface ForgeFacts {
  /** The checks at the judged head, one per name. */
  checks: Check[];
  /** What the forge requires before merging, and whether each has reported at the head. */
  required: RequiredCheck[];
  /** Every file the PR changes, as the forge lists them. */
  files: ChangedFile[];
}

/**
 * A landing case: a real PR and the owner's call on it, merge or send back.
 * Its directory `cases/<slug>/` holds:
 *
 * - `issue.md`: the issue the PR closes, as {@link renderIssue} writes it;
 * - `vision.md`: VISION.md on the default branch the PR was judged against;
 * - `criteria.md`: the criteria entail set for the issue at intake, one
 *   `- ` item each, with an indented `Basis:` line when one is known;
 * - `pr.md`: the PR's title and description as its author wrote them;
 * - `facts.json`: the checks and changed files read from the forge at the head;
 * - `call.md`: front matter with `kind: landing`, the repo, issue, PR, the
 *   judged head and the base it was diffed against, the owner's call, the
 *   date, the vision commit and where the reason comes from; then the reason
 *   and any notes. The diff is read again from git at the head and base.
 */
export interface LandingCase {
  kind: "landing";
  slug: string;
  repo: string;
  issue: number;
  pr: number;
  /** The PR's head commit the call was made at. */
  head: string;
  /** The default branch's commit the PR was diffed against. */
  base: string;
  issueText: string;
  vision: string;
  visionCommit: string;
  criteria: LandingCriterion[];
  /** pr.md as written. */
  prText: string;
  facts: ForgeFacts;
  call: LandingOwnerCall;
  reason: string;
  reasonFrom: string;
  date: string;
  notes: string;
}

/** The slug of the landing case for a PR: `owner-name-pr-number`. */
export function landingCaseSlug(repo: string, pr: number): string {
  return `${repo.replace("/", "-")}-pr-${pr}`.toLowerCase();
}

/** A PR as pr.md holds it and the landing judgment quotes it: the author's title and description. */
export function renderPullRequest(pr: { title: string; body: string }): string {
  return `# ${pr.title.trim()}\n\n${pr.body.trim() === "" ? "(no description)" : pr.body.trim()}\n`;
}

/** criteria.md: one `- ` item per criterion, its basis indented under it. */
export function renderCriteria(criteria: readonly LandingCriterion[]): string {
  if (criteria.length === 0) return "(no criteria beyond solving the issue)\n";
  return `${criteria.map((c) => `- ${oneLineOf(c.criterion)}${c.basis.trim() === "" ? "" : `\n  Basis: ${oneLineOf(c.basis)}`}`).join("\n")}\n`;
}

/** Parses criteria.md: the inverse of {@link renderCriteria}. */
export function parseCriteria(text: string): LandingCriterion[] {
  const criteria: LandingCriterion[] = [];
  for (const line of text.replace(/\r\n/gu, "\n").split("\n")) {
    const item = /^- (.*)$/u.exec(line);
    if (item) {
      criteria.push({ criterion: item[1]!.trim(), basis: "" });
      continue;
    }
    const basis = /^\s+Basis:\s*(.*)$/u.exec(line);
    if (basis && criteria.length > 0) criteria[criteria.length - 1]!.basis = basis[1]!.trim();
  }
  return criteria;
}

function oneLineOf(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function isLandingCall(text: string): boolean {
  const front = /^---\n([\s\S]*?)\n---\n/u.exec(text.replace(/\r\n/gu, "\n"));
  return front !== null && /^kind:\s*landing\s*$/mu.test(front[1]!);
}

async function readLandingCase(directory: string, slug: string): Promise<LandingCase> {
  const [issueText, vision, criteria, prText, facts, call] = await Promise.all(
    ["issue.md", "vision.md", "criteria.md", "pr.md", "facts.json", "call.md"].map((name) => readFile(join(directory, name), "utf8")),
  );
  try {
    return {
      kind: "landing",
      slug,
      issueText: issueText!,
      vision: vision!,
      criteria: parseCriteria(criteria!),
      prText: prText!,
      facts: parseFacts(facts!),
      ...parseLandingCall(call!),
    };
  } catch (error) {
    throw new Error(`case ${slug}: ${(error as Error).message}`);
  }
}

function parseFacts(text: string): ForgeFacts {
  const value: unknown = JSON.parse(text);
  const facts = value as Partial<ForgeFacts> | null;
  if (facts === null || typeof facts !== "object" || !Array.isArray(facts.checks) || !Array.isArray(facts.required) || !Array.isArray(facts.files)) {
    throw new Error("facts.json holds no checks, required checks and files");
  }
  return { checks: facts.checks, required: facts.required, files: facts.files };
}

type LandingCallFields = Omit<LandingCase, "kind" | "slug" | "issueText" | "vision" | "criteria" | "prText" | "facts">;

/** Parses a landing case's call.md. */
export function parseLandingCall(text: string): LandingCallFields {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(text.replace(/\r\n/gu, "\n"));
  if (match === null) throw new Error("call.md has no front matter");
  const fields = new Map<string, string>();
  for (const line of match[1]!.split("\n")) {
    const field = /^([a-z-]+):\s*(.*)$/u.exec(line);
    if (field) fields.set(field[1]!, field[2]!.trim());
  }
  const need = (key: string): string => {
    const value = fields.get(key);
    if (value === undefined || value === "") throw new Error(`call.md has no ${key}`);
    return value;
  };
  const number = (key: string): number => {
    const value = Number(need(key));
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`call.md's ${key} is not a number`);
    return value;
  };
  const call = need("call");
  if (!(LANDING_CALLS as readonly string[]).includes(call)) throw new Error(`call.md's call is ${call}, not merge or send-back`);
  const [reason = "", ...rest] = match[2]!.trim().split(/\n\s*\n/u);
  if (reason.trim() === "") throw new Error("call.md has no reason");
  return {
    repo: need("repo"),
    issue: number("issue"),
    pr: number("pr"),
    head: need("head"),
    base: need("base"),
    call: call as LandingOwnerCall,
    date: need("date"),
    visionCommit: need("vision-commit"),
    reasonFrom: need("reason-from"),
    reason: reason.trim(),
    notes: rest.join("\n\n").trim(),
  };
}

/** Writes a landing case's call.md: the inverse of {@link parseLandingCall}. */
export function renderLandingCall(call: LandingCallFields): string {
  const front = [
    "kind: landing",
    `repo: ${call.repo}`,
    `issue: ${call.issue}`,
    `pr: ${call.pr}`,
    `head: ${call.head}`,
    `base: ${call.base}`,
    `call: ${call.call}`,
    `date: ${call.date}`,
    `vision-commit: ${call.visionCommit}`,
    `reason-from: ${call.reasonFrom}`,
  ];
  const body = [call.reason, ...(call.notes === "" ? [] : [call.notes])];
  return `---\n${front.join("\n")}\n---\n\n${body.join("\n\n")}\n`;
}

/** Writes a landing case into a book, replacing any case of the same slug whole, as {@link writeCase} does. */
export async function writeLandingCase(directory: string, past: LandingCase): Promise<string> {
  parseLandingCall(renderLandingCall(past));
  return replaceCaseDirectory(directory, past.slug, {
    "issue.md": past.issueText,
    "vision.md": past.vision,
    "criteria.md": renderCriteria(past.criteria),
    "pr.md": past.prText,
    "facts.json": `${JSON.stringify(past.facts, null, 2)}\n`,
    "call.md": renderLandingCall(past),
  });
}

/**
 * The landing cases most relevant to a PR, most relevant first, chosen the
 * way {@link precedentsFor} chooses issue cases: every case while the book is
 * small, else the same repo's that share the most words with the issue.
 */
export function landingPrecedentsFor(cases: readonly LandingCase[], repo: string, issueText: string, limit = PRECEDENT_LIMIT): LandingCase[] {
  return rankByRelevance(cases, repo, issueText).slice(0, limit);
}
