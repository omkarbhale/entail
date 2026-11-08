import { type Actor, type ForgeKind, MERGE_METHODS, type MergeMethod } from "./forge/forge.ts";
import { MECHANICAL_CHECK_KINDS } from "./model-schemas.ts";
import type { SettingsVersionRecord, Store, VisionOrigin } from "./store.ts";

/**
 * Who counts as an executor in a repo (ADR-0013): anyone, or only the owner
 * plus the executors listed for it.
 */
export type WhoCounts = "anyone" | "owner-and-listed";

export type MechanicalCheckKind = (typeof MECHANICAL_CHECK_KINDS)[number];

/**
 * A mechanical check from the closed list (spec §7, ADR-0005): a path glob for
 * `changes_path` and `leaves_path`, a check name for `check_passes`.
 */
export interface MechanicalCheck {
  kind: MechanicalCheckKind;
  argument: string;
}

/**
 * One generic criterion, which every PR in the repo must meet (ADR-0014). Its
 * id is G1…Gn in list order, renumbered on each save; a ticket freezes the
 * list it was cleared under, ids included.
 */
export interface GenericCriterion {
  id: string;
  sentence: string;
  /** Usually "the check `<name>` passes". */
  check: MechanicalCheck;
  /** The file entail inferred it from, or null for a row the owner added. */
  source: string | null;
}

/**
 * A topic the owner wants brought to them always (ADR-0018). A pin is known by
 * its topic sentence, which is unique in a repo: editing any part of a pin
 * removes the old pin and adds a new one.
 */
export interface Pin {
  topic: string;
  /** Path globs that also mark the pin as touched; may be empty. */
  paths: string[];
  /** Keywords that also mark the pin as touched; may be empty. */
  keywords: string[];
}

/** The pin every repo has, which is not stored and cannot be removed: the vision itself. */
export const VISION_PIN = Object.freeze({
  topic: "The product's vision, VISION.md",
  paths: Object.freeze(["VISION.md"]),
  keywords: Object.freeze([] as string[]),
});

/**
 * One enrolled repo's settings, kept in entail's records as versions, never in
 * the repo (spec §15, ADR-0018). The forge itself (`forge`, `host`, `path`) is
 * fixed at enrollment and kept on the repo's record, not here.
 */
export interface RepoSettings {
  /** The origin the owner confirmed for the VISION.md that existed at enrollment (ADR-0004). */
  visionOrigin: VisionOrigin;
  /** GitHub's merge method; null on GitLab, where the project's own merge method applies. */
  mergeMethod: MergeMethod | null;
  /** The confirmed generic criteria G1…Gn, which may be empty. */
  genericCriteria: GenericCriterion[];
  /**
   * The default-branch commit the generic criteria were last confirmed
   * against, so a later change to its CI files can be hinted at. Absent on the
   * settings enrollment saved: those were confirmed against the commit whose
   * VISION.md enrollment read.
   */
  genericCriteriaConfirmedAt?: string | null;
  /** Off by default: when on, entail decides and checks but does not merge. */
  shadow: boolean;
  whoCounts: WhoCounts;
  /**
   * The executors counted when only the owner and listed executors count,
   * resolved to numeric ids when saved. Kept when who counts is anyone, so
   * switching back restores them.
   */
  executors: Actor[];
  /** The pins beyond the built-in VISION.md pin, which is never listed and cannot be removed. */
  pins: Pin[];
  paused: boolean;
}

/** The origin preselected for the existing VISION.md, because a vision is first written with /vision (ADR-0018). */
export const PRESELECTED_VISION_ORIGIN: VisionOrigin = "agent-proposed-owner-approved";

/**
 * The settings a repo is enrolled with: the owner's confirmed origin and
 * merge method, an empty generic criteria list, and the defaults: shadow off,
 * who counts set to anyone, and no pins beyond VISION.md (ADR-0018).
 */
export function enrollmentSettings(visionOrigin: VisionOrigin, mergeMethod: MergeMethod | null): RepoSettings {
  return {
    visionOrigin,
    mergeMethod,
    genericCriteria: [],
    shadow: false,
    whoCounts: "anyone",
    executors: [],
    pins: [],
    paused: false,
  };
}

/**
 * The merge method preselected on GitHub (ADR-0018): the one allowed method,
 * or squash if several are allowed, else the first allowed of merge commit and
 * rebase. When GitHub did not say which are allowed, squash.
 */
export function preselectedMergeMethod(allowed: readonly MergeMethod[]): MergeMethod {
  if (allowed.length === 1) return allowed[0]!;
  if (allowed.length === 0 || allowed.includes("squash")) return "squash";
  return (["merge", "rebase"] as const).find((method) => allowed.includes(method))!;
}

/** How each merge method is named to the owner. */
export const MERGE_METHOD_LABELS: Readonly<Record<MergeMethod, string>> = {
  squash: "Squash and merge",
  merge: "Merge commit",
  rebase: "Rebase and merge",
};

export function isMergeMethod(value: string): value is MergeMethod {
  return (MERGE_METHODS as readonly string[]).includes(value);
}

/** A repo's settings in force: its latest saved version. */
export interface CurrentRepoSettings {
  settings: RepoSettings;
  version: SettingsVersionRecord;
}

/**
 * Reads a repo's settings from the store, or null when it has none. It reads
 * the store every time and caches nothing, so a save takes effect from the
 * next pass (spec §15, ADR-0017).
 */
export function readRepoSettings(store: Store, repoId: number): CurrentRepoSettings | null {
  const version = store.latestSettings(repoId);
  return version === null ? null : { settings: repoSettingsOf(version), version };
}

/** A saved version's settings, with the enrollment defaults for anything it does not hold. */
export function repoSettingsOf(version: SettingsVersionRecord): RepoSettings {
  const saved = typeof version.settings === "object" && version.settings !== null ? (version.settings as Partial<RepoSettings>) : {};
  return { ...enrollmentSettings(PRESELECTED_VISION_ORIGIN, null), ...saved };
}

/** The repo settings form's field names. Rows of generic criteria and pins carry their index. */
export const REPO_FIELDS = {
  repo: "repo",
  basedOn: "based_on",
  mergeMethod: "merge_method",
  shadow: "shadow",
  whoCounts: "who_counts",
  executors: "executors",
  reconfirm: "reconfirm_generic_criteria",
  criteriaCount: "g_count",
  criterion: (i: number, part: "sentence" | "kind" | "argument" | "source" | "remove") => `g${i}_${part}`,
  pinCount: "p_count",
  pin: (i: number, part: "topic" | "paths" | "keywords" | "remove") => `p${i}_${part}`,
} as const;

export const REPO_LIMITS = {
  genericCriteria: 20,
  pins: 50,
  executors: 50,
  sentenceLength: 500,
  argumentLength: 200,
  pathsPerPin: 20,
  keywordsPerPin: 20,
  keywordLength: 100,
  /** The most rows a form may say it holds; rows past the limits above are refused, not read. */
  formRows: 100,
} as const;

/** One row of the form as the owner left it, kept to show the form again when a save is refused. */
export interface CriterionRow {
  sentence: string;
  kind: string;
  argument: string;
  source: string;
  remove: boolean;
}

export interface PinRow {
  topic: string;
  paths: string;
  keywords: string;
  remove: boolean;
}

/** Everything the owner submitted, as typed. */
export interface RepoSettingsForm {
  basedOn: string;
  mergeMethod: string;
  shadow: boolean;
  whoCounts: string;
  executors: string;
  reconfirm: boolean;
  criteria: CriterionRow[];
  pins: PinRow[];
}

/** The settings the owner asked for, before executor usernames are resolved to accounts. */
export interface RepoSettingsDraft {
  basedOn: number;
  mergeMethod: MergeMethod | null;
  shadow: boolean;
  whoCounts: WhoCounts;
  /** Usernames as listed, deduplicated ignoring case, in the order given. */
  executorUsernames: string[];
  reconfirmGenericCriteria: boolean;
  genericCriteria: GenericCriterion[];
  pins: Pin[];
}

/** Why a save was refused: one message per field, and per row for criteria and pins. */
export interface RepoSettingsErrors {
  form?: string;
  mergeMethod?: string;
  whoCounts?: string;
  executors?: string;
  criteria?: string;
  criterion?: Record<number, string>;
  pins?: string;
  pin?: Record<number, string>;
}

export type ParsedRepoSettings = { ok: true; draft: RepoSettingsDraft } | { ok: false; errors: RepoSettingsErrors };

/** Reads the submitted form as typed, without judging it. */
export function readRepoSettingsForm(form: URLSearchParams): RepoSettingsForm {
  const get = (name: string) => form.get(name) ?? "";
  const count = (name: string) => {
    const n = /^\d{1,3}$/.test(get(name)) ? Number(get(name)) : 0;
    return Math.min(n, REPO_LIMITS.formRows);
  };
  const criteria: CriterionRow[] = [];
  for (let i = 0; i < count(REPO_FIELDS.criteriaCount); i++) {
    const f = (part: Parameters<typeof REPO_FIELDS.criterion>[1]) => get(REPO_FIELDS.criterion(i, part));
    criteria.push({ sentence: f("sentence"), kind: f("kind"), argument: f("argument"), source: f("source"), remove: f("remove") !== "" });
  }
  const pins: PinRow[] = [];
  for (let i = 0; i < count(REPO_FIELDS.pinCount); i++) {
    const f = (part: Parameters<typeof REPO_FIELDS.pin>[1]) => get(REPO_FIELDS.pin(i, part));
    pins.push({ topic: f("topic"), paths: f("paths"), keywords: f("keywords"), remove: f("remove") !== "" });
  }
  return {
    basedOn: get(REPO_FIELDS.basedOn),
    mergeMethod: get(REPO_FIELDS.mergeMethod),
    shadow: get(REPO_FIELDS.shadow) !== "",
    whoCounts: get(REPO_FIELDS.whoCounts),
    executors: get(REPO_FIELDS.executors),
    reconfirm: get(REPO_FIELDS.reconfirm) !== "",
    criteria,
    pins,
  };
}

// Control characters would break the one-line criteria, pins and comments these are posted in.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Judges a submitted repo settings form. Every setting must be valid; nothing
 * is saved otherwise. Rows left blank are dropped, and rows marked for removal
 * are removed. Executor usernames are only checked for form here: resolving
 * them to accounts needs the forge.
 */
export function parseRepoSettingsForm(typed: RepoSettingsForm, forge: ForgeKind): ParsedRepoSettings {
  const errors: RepoSettingsErrors = {};

  const basedOn = /^\d+$/.test(typed.basedOn) ? Number(typed.basedOn) : NaN;
  if (!Number.isSafeInteger(basedOn) || basedOn < 1) errors.form = "This form does not say which settings version it was opened on. Reload the page.";

  let mergeMethod: MergeMethod | null = null;
  if (forge === "github") {
    if (isMergeMethod(typed.mergeMethod)) mergeMethod = typed.mergeMethod;
    else errors.mergeMethod = "Pick the merge method.";
  }

  let whoCounts: WhoCounts = "anyone";
  if (typed.whoCounts === "anyone" || typed.whoCounts === "owner-and-listed") whoCounts = typed.whoCounts;
  else errors.whoCounts = "Pick who counts as an executor.";

  const executorUsernames: string[] = [];
  const badNames: string[] = [];
  for (const raw of typed.executors.split(/[\s,]+/)) {
    const name = raw.replace(/^@/, "");
    if (name === "") continue;
    if (!/^[A-Za-z0-9_.\-\[\]]{1,255}$/.test(name)) badNames.push(raw);
    else if (!executorUsernames.some((seen) => seen.toLowerCase() === name.toLowerCase())) executorUsernames.push(name);
  }
  if (badNames.length > 0) errors.executors = `These are not usernames: ${badNames.join(", ")}.`;
  else if (executorUsernames.length > REPO_LIMITS.executors) errors.executors = `List at most ${REPO_LIMITS.executors} executors.`;

  const genericCriteria: GenericCriterion[] = [];
  const criterionErrors: Record<number, string> = {};
  typed.criteria.forEach((row, i) => {
    const sentence = row.sentence.trim();
    const argument = row.argument.trim();
    if (row.remove || (sentence === "" && argument === "")) return;
    const why = criterionProblem(sentence, row.kind, argument);
    if (why) {
      criterionErrors[i] = why;
      return;
    }
    const source = row.source.trim();
    genericCriteria.push({
      id: `G${genericCriteria.length + 1}`,
      sentence,
      check: { kind: row.kind as MechanicalCheckKind, argument },
      source: source === "" || CONTROL.test(source) || source.length > REPO_LIMITS.argumentLength ? null : source,
    });
  });
  if (Object.keys(criterionErrors).length > 0) errors.criterion = criterionErrors;
  else if (genericCriteria.length > REPO_LIMITS.genericCriteria) errors.criteria = `Keep at most ${REPO_LIMITS.genericCriteria} generic criteria.`;

  const pins: Pin[] = [];
  const pinErrors: Record<number, string> = {};
  typed.pins.forEach((row, i) => {
    const topic = row.topic.trim();
    const paths = lines(row.paths);
    const keywords = lines(row.keywords);
    if (row.remove || (topic === "" && paths.length === 0 && keywords.length === 0)) return;
    const why = pinProblem(topic, paths, keywords, pins);
    if (why) pinErrors[i] = why;
    else pins.push({ topic, paths: unique(paths), keywords: unique(keywords) });
  });
  if (Object.keys(pinErrors).length > 0) errors.pin = pinErrors;
  else if (pins.length > REPO_LIMITS.pins) errors.pins = `Keep at most ${REPO_LIMITS.pins} pins.`;

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    draft: {
      basedOn,
      mergeMethod,
      shadow: typed.shadow,
      whoCounts,
      executorUsernames,
      reconfirmGenericCriteria: typed.reconfirm,
      genericCriteria,
      pins,
    },
  };
}

function criterionProblem(sentence: string, kind: string, argument: string): string | null {
  if (sentence === "") return "Write the criterion as one sentence.";
  if (CONTROL.test(sentence) || sentence.length > REPO_LIMITS.sentenceLength) {
    return `Write the criterion on one line of at most ${REPO_LIMITS.sentenceLength} characters.`;
  }
  // It is posted in comments, where a line starting with `/` would read as a command.
  if (sentence.startsWith("/")) return "A criterion cannot start with /.";
  if (!(MECHANICAL_CHECK_KINDS as readonly string[]).includes(kind)) return "Pick the kind of mechanical check.";
  if (argument === "") return kind === "check_passes" ? "Name the check that must pass." : "Give the path glob.";
  if (CONTROL.test(argument) || argument.length > REPO_LIMITS.argumentLength) {
    return `Keep the check's argument to one line of at most ${REPO_LIMITS.argumentLength} characters.`;
  }
  if (kind !== "check_passes") return globProblem(argument);
  return null;
}

function pinProblem(topic: string, paths: string[], keywords: string[], earlier: readonly Pin[]): string | null {
  if (topic === "") return "Write the pin's topic as one sentence.";
  if (CONTROL.test(topic) || topic.length > REPO_LIMITS.sentenceLength) {
    return `Write the topic on one line of at most ${REPO_LIMITS.sentenceLength} characters.`;
  }
  const same = (a: string) => a.toLowerCase() === topic.toLowerCase();
  if (same(VISION_PIN.topic)) return "VISION.md is always pinned; give this pin another topic.";
  if (earlier.some((pin) => same(pin.topic))) return "Another pin has this topic; a pin is known by its topic, so make each one different.";
  if (paths.length > REPO_LIMITS.pathsPerPin) return `Give at most ${REPO_LIMITS.pathsPerPin} paths.`;
  for (const path of paths) {
    const why = globProblem(path);
    if (why) return why;
  }
  if (keywords.length > REPO_LIMITS.keywordsPerPin) return `Give at most ${REPO_LIMITS.keywordsPerPin} keywords.`;
  if (keywords.some((k) => CONTROL.test(k) || k.length > REPO_LIMITS.keywordLength)) {
    return `Keep each keyword to at most ${REPO_LIMITS.keywordLength} characters.`;
  }
  return null;
}

/** Why a path glob cannot be used, or null when it can. Globs are relative to the repo's root. */
function globProblem(glob: string): string | null {
  if (CONTROL.test(glob) || glob.length > REPO_LIMITS.argumentLength) return `Keep each path glob to one line of at most ${REPO_LIMITS.argumentLength} characters.`;
  if (glob.startsWith("/") || /^[A-Za-z]:/.test(glob) || glob.includes("\\")) return `Write ${glob} relative to the repo's root, with forward slashes.`;
  if (glob.split("/").includes("..")) return `${glob} leaves the repo; write it relative to the repo's root.`;
  return null;
}

/** The non-blank lines of a text area, trimmed. */
function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

/** A description of each setting a save changed, in the order the page shows them; empty when nothing changed. */
export function settingsChanges(before: RepoSettings, after: RepoSettings): string[] {
  const changes: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(before.genericCriteria, after.genericCriteria)) changes.push("generic criteria");
  else if ((before.genericCriteriaConfirmedAt ?? null) !== (after.genericCriteriaConfirmedAt ?? null)) changes.push("generic criteria confirmed again");
  if (before.mergeMethod !== after.mergeMethod) changes.push("merge method");
  if (before.shadow !== after.shadow) changes.push(after.shadow ? "shadow on" : "shadow off");
  if (before.whoCounts !== after.whoCounts) changes.push("who counts");
  const ids = (actors: Actor[]) => actors.map((a) => a.id);
  if (!same(ids(before.executors), ids(after.executors))) changes.push("executors");
  const topics = (pins: Pin[]) => new Set(pins.map((p) => JSON.stringify(p)));
  const was = topics(before.pins);
  const now = topics(after.pins);
  const added = [...now].filter((p) => !was.has(p)).length;
  const removed = [...was].filter((p) => !now.has(p)).length;
  if (added > 0) changes.push(`${added} ${added === 1 ? "pin" : "pins"} added`);
  if (removed > 0) changes.push(`${removed} ${removed === 1 ? "pin" : "pins"} removed`);
  if (before.paused !== after.paused) changes.push(after.paused ? "paused" : "resumed");
  if (before.visionOrigin !== after.visionOrigin) changes.push("origin of the existing VISION.md");
  return changes;
}
