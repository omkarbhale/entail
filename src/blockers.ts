import type { Blocker, Forge, Issue, IssueRef } from "./forge/forge.ts";
import { repoSetting } from "./repo-ref.ts";

/**
 * The issues an issue waits on. An issue is blocked while any issue it names
 * as a blocker is open: entail makes no call on it, so it gets no criteria
 * and no work starts, until none is open.
 *
 * Blockers come from two places: the issue's own text ("blocked by #12",
 * "depends on acme/core#4", case-insensitive, in its title or body), and the
 * forge's own blocking links where it has them (GitHub's issue dependencies).
 * Whether each blocker is open is always read from the forge, never from the
 * text.
 */

/**
 * A list of issue references after "blocked by" or "depends on": `#12`,
 * `acme/core#4` or, on GitLab, `group/subgroup/project#4`, joined by commas,
 * "and" or "&".
 */
const REF = String.raw`(?:[\w.-]+(?:\/[\w.-]+)+)?#\d+`;
const BLOCKER_PHRASE = new RegExp(String.raw`\b(?:blocked\s+by|depends\s+on)\s*:?\s+(${REF}(?:\s*(?:,|&|\band\b)\s*${REF})*)`, "giu");
const ONE_REF = /(?:([\w.-]+(?:\/[\w.-]+)+))?#(\d+)/gu;

/**
 * The blockers an issue's text names, in the order named, each once. A bare
 * `#N` is an issue of the issue's own repo, `path`; a full `owner/name#N` may
 * name another repo on the same host. Code, fenced or inline, is not read,
 * and an issue never blocks itself.
 */
export function textBlockers(issue: Pick<Issue, "title" | "body" | "number">, path: string): IssueRef[] {
  const text = `${issue.title}\n${issue.body}`.replace(/```[\s\S]*?(?:```|$)/gu, " ").replace(/`[^`\n]*`/gu, " ");
  const refs: IssueRef[] = [];
  for (const phrase of text.matchAll(BLOCKER_PHRASE)) {
    for (const ref of phrase[1]!.matchAll(ONE_REF)) {
      const found: IssueRef = { path: ref[1] ?? path, number: Number(ref[2]) };
      if (!Number.isSafeInteger(found.number) || found.number <= 0) continue;
      if (sameRef(found, { path, number: issue.number })) continue;
      if (!refs.some((seen) => sameRef(seen, found))) refs.push(found);
    }
  }
  return refs;
}

/** Whether two references name the same issue. Repo paths compare without case, as the forge does. */
export function sameRef(a: IssueRef, b: IssueRef): boolean {
  return a.number === b.number && a.path.toLowerCase() === b.path.toLowerCase();
}

/** What reading an issue's blockers found. */
export interface BlockerReading {
  /** Every blocker named in the text or linked on the forge that the forge knows, with its state. */
  blockers: Blocker[];
  /** Whether the forge's own blocking links were read; false when the forge has none here, so only the text counted. */
  forgeLinks: boolean;
}

/**
 * Reads an issue's blockers and whether each is open: the forge's own links,
 * then each one the text names that the links did not. A named issue the
 * forge does not know, such as a typo'd number, blocks nothing.
 */
export async function readBlockers(forge: Pick<Forge, "setting" | "blockedBy" | "issueState">, issue: Pick<Issue, "title" | "body" | "number">): Promise<BlockerReading> {
  const linked = await forge.blockedBy(issue.number);
  const blockers: Blocker[] = [...(linked ?? [])].filter((blocker) => !sameRef(blocker, { path: forge.setting.path, number: issue.number }));
  for (const ref of textBlockers(issue, forge.setting.path)) {
    if (blockers.some((blocker) => sameRef(blocker, ref))) continue;
    const state = await forge.issueState(ref.path, ref.number);
    if (state !== null) blockers.push({ ...ref, state });
  }
  return { blockers, forgeLinks: linked !== null };
}

/** The open blockers among `blockers`, as references. */
export function openBlockers(blockers: readonly Blocker[]): IssueRef[] {
  return blockers.filter((blocker) => blocker.state === "open").map(({ path, number }) => ({ path, number }));
}

/** Whether two sets of blockers are the same issues, in any order. */
export function sameBlockers(a: readonly IssueRef[], b: readonly IssueRef[]): boolean {
  return a.length === b.length && a.every((ref) => b.some((other) => sameRef(ref, other)));
}

/**
 * A blocker as a comment or the log names it: `#12` in the issue's own repo,
 * `owner/name#12` in another. `repo` is the issue's repo as entail names it,
 * `owner/name`, `gitlab:group/name` or `gitlab://host/group/name`.
 */
export function refText(ref: IssueRef, repo: string): string {
  return ref.path.toLowerCase() === pathOf(repo).toLowerCase() ? `#${ref.number}` : `${ref.path}#${ref.number}`;
}

/** A repo's path on its forge: `gitlab:group/name` and `gitlab://host/group/name` are `group/name` there. */
function pathOf(repo: string): string {
  try {
    return repoSetting(repo).path;
  } catch {
    return repo;
  }
}

/** Blockers as a list in words: "#3", "#3 and #4", "#3, #4 and #5". */
export function refsText(refs: readonly IssueRef[], repo: string): string {
  const texts = refs.map((ref) => refText(ref, repo));
  return texts.length <= 1 ? (texts[0] ?? "") : `${texts.slice(0, -1).join(", ")} and ${texts.at(-1)}`;
}
