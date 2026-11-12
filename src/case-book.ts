import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

/** Reads every case in the book, sorted by slug. A malformed case is an error naming it. */
export async function readCaseBook(directory: string): Promise<Case[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const slugs = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name).sort();
  return Promise.all(slugs.map((slug) => readCase(join(directory, slug), slug)));
}

/**
 * Reads several books as one: a book that does not exist is empty, and a case
 * in a later book replaces a case of the same slug in an earlier one, so the
 * owner's latest call on an issue is the one that counts.
 */
export async function readCaseBooks(directories: readonly string[]): Promise<Case[]> {
  const bySlug = new Map<string, Case>();
  for (const directory of directories) {
    let book: Case[];
    try {
      book = await readCaseBook(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const past of book) bySlug.set(past.slug, past);
  }
  return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

/** The slug of the case for an issue: `owner--name-number`; GitHub owners hold no `--`, so no two issues share a slug. */
export function caseSlug(repo: string, issue: number): string {
  return `${repo.replace("/", "--")}-${issue}`.toLowerCase();
}

/**
 * Writes a case into a book, replacing any case of the same slug whole: the
 * three files are written to a fresh directory that then takes the case's place.
 */
export async function writeCase(directory: string, past: Case): Promise<string> {
  // Checks the case reads back as written before anything is replaced.
  parseCall(renderCall(past));
  const target = join(directory, past.slug);
  const staging = join(directory, `.${past.slug}.new-${process.pid}-${Date.now()}`);
  await mkdir(staging, { recursive: true, mode: 0o700 });
  await writeFile(join(staging, "issue.md"), past.issueText);
  await writeFile(join(staging, "vision.md"), past.vision);
  await writeFile(join(staging, "call.md"), renderCall(past));
  const old = join(directory, `.${past.slug}.old-${process.pid}-${Date.now()}`);
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
  const words = wordsOf(issueText);
  const scored = cases.map((past) => ({
    past,
    sameRepo: past.repo.toLowerCase() === repo.toLowerCase(),
    overlap: overlap(words, wordsOf(past.issueText)),
  }));
  scored.sort((a, b) => Number(b.sameRepo) - Number(a.sameRepo) || b.overlap - a.overlap || a.past.slug.localeCompare(b.past.slug));
  return scored.slice(0, limit).map((entry) => entry.past);
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
