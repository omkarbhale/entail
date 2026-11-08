import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Enroller, type EnrollmentReview, type Refusal, type StatedForge } from "./enrollment.ts";
import { MERGE_METHODS, type Forge, type ForgeSetting, type MergeMethod } from "./forge/forge.ts";
import {
  describeCheck,
  type GenericCriterionRow,
  type MechanicalCheckKind,
  normalizeRow,
  rowProblems,
  unseenCheck,
} from "./generic-criteria.ts";
import { Git } from "./git.ts";
import { readGlobalSettings } from "./global-settings.ts";
import { mirrorPaths } from "./mirror.ts";
import { MECHANICAL_CHECK_KINDS } from "./model-schemas.ts";
import { escapeHtml, renderPage, timeHtml } from "./page.ts";
import { isMergeMethod, MERGE_METHOD_LABELS, PRESELECTED_VISION_ORIGIN, readRepoSettings } from "./repo-settings.ts";
import { REPO_SETTINGS_PATH, repoSettingsPage } from "./repo-settings-page.ts";
import { TOKEN_FIELD, type FormRequest, type Page, type PageRequest, type Reply } from "./server.ts";
import { SETTINGS_PATH } from "./settings-page.ts";
import type { RepoRecord, Store, VisionOrigin } from "./store.ts";
import { VISION_ORIGINS } from "./store-schema.ts";
import { readVision } from "./vision.ts";

export const REPOS_PATH = "/repos";
export const CHECK_PATH = "/repos/check";
export const ENROLL_PATH = "/repos/enroll";
export { REPO_SETTINGS_PATH };

/** The enrollment form's field names. */
export const ENROLL_FIELDS = {
  forge: "forge",
  host: "host",
  path: "path",
  review: "review",
  visionOrigin: "vision_origin",
  mergeMethod: "merge_method",
  /** Which button was pressed: {@link ENROLL_ACTIONS}. */
  action: "action",
  /** How many generic criteria rows the form holds. */
  criteriaCount: "gc_count",
  /** A check name whose warning the owner has been shown; one field per name. */
  warnedCheck: "gc_warned",
} as const;

/** The buttons of the review screen: enroll, or show the review again with one more empty row. */
export const ENROLL_ACTIONS = { enroll: "enroll", addRow: "add-row" } as const;

/** The field of one part of the generic criteria row at `index` (from 0). */
export function criterionField(index: number, part: "sentence" | "check_kind" | "check_argument" | "source" | "remove"): string {
  return `gc_${index}_${part}`;
}

/** How each mechanical check kind is offered on the review screen. */
const CHECK_KIND_LABELS: Readonly<Record<MechanicalCheckKind, string>> = {
  check_passes: "A named check passes",
  changes_path: "The PR changes a path",
  leaves_path: "The PR leaves a path alone",
};

/** At most this many generic criteria rows are read from one form. */
const MAX_CRITERIA_ROWS = 100;

/** A repo's state on the Repos page (spec §15). A paused repo is the owner's setting; no vision is a halt. */
export type RepoState = "active" | "pausing" | "paused" | "no vision";

/**
 * What the running process knows about a repo beyond its records. The pass
 * and the pause supply these; until they do, a repo has not been polled and
 * a pause takes effect at once.
 */
export interface RepoActivity {
  /** Whether a paused repo still has decider or landing runs finishing, or their writes to post. */
  pausing?(repo: RepoRecord): boolean;
  /** The time of the repo's last successful poll, as ISO, or null when it has not been polled. */
  lastSuccessfulPoll?(repo: RepoRecord): string | null;
}

export interface ReposPageOptions {
  store: Store;
  enroller: Enroller;
  dataDirectory: string;
  activity?: RepoActivity;
  now?: () => Date;
  /** The forge adapter for an enrolled repo, which its settings page uses to resolve executor usernames. */
  createForge?: (setting: ForgeSetting) => Forge;
}

/** Why nothing was enrolled: a refusal, or a review that is no longer open. */
type Problem = Pick<Refusal, "message"> & { reason?: Refusal["reason"] };

/** How long a checked repo waits for the owner to confirm its review screen. */
export const REVIEW_TTL_MS = 60 * 60_000;
const MAX_PENDING_REVIEWS = 50;

/** How each origin is named to the owner (ADR-0004). */
export const ORIGIN_LABELS: Readonly<Record<VisionOrigin, string>> = {
  "owner-stated": "Stated by the owner",
  "agent-proposed-owner-approved": "Proposed by an agent and approved by the owner",
  "automatic-owner-notified": "Added automatically, with the owner notified",
};

/**
 * The Repos page and the enrollment flow (spec §15, ADR-0018). The page lists
 * every enrolled repo with its forge, state, last successful poll and a link
 * to its settings, and holds the enrollment form. Enrolling is two steps: the
 * stated repo is checked and its review screen shown, then the owner confirms
 * it. Enrolling is unavailable until the owner's display name is set.
 */
export function reposPages(options: ReposPageOptions): Page[] {
  const { store, enroller } = options;
  const now = options.now ?? (() => new Date());
  const pending = new Map<string, { review: EnrollmentReview; expiresAt: number }>();

  const takeReview = (id: string | null): EnrollmentReview | null => {
    const time = now().getTime();
    for (const [key, entry] of pending) if (entry.expiresAt <= time) pending.delete(key);
    return id === null ? null : (pending.get(id)?.review ?? null);
  };
  const holdReview = (review: EnrollmentReview): string => {
    takeReview(null);
    while (pending.size >= MAX_PENDING_REVIEWS) pending.delete(pending.keys().next().value!);
    const id = randomBytes(16).toString("base64url");
    pending.set(id, { review, expiresAt: now().getTime() + REVIEW_TTL_MS });
    return id;
  };

  return [
    {
      path: REPOS_PATH,
      nav: "Repos",
      async get(request) {
        const enrolled = Number(request.url.searchParams.get("enrolled"));
        const just = Number.isSafeInteger(enrolled) && enrolled > 0 ? store.getRepo(enrolled) : null;
        return reposView(request, options, emptyStated(), [], just, 200);
      },
    },
    {
      path: CHECK_PATH,
      async post(request: FormRequest) {
        const stated = statedOf(request.form);
        const result = await enroller.check(stated);
        if (!result.ok) return reposView(request, options, stated, result.refusals, null, 422);
        const { review } = result;
        return reviewView(request, review, holdReview(review), {
          origin: PRESELECTED_VISION_ORIGIN,
          mergeMethod: review.preselectedMergeMethod,
          criteria: review.genericCriteria.proposal.rows,
          errors: null,
          status: 200,
        });
      },
    },
    {
      path: ENROLL_PATH,
      async post(request: FormRequest) {
        const id = request.form.get(ENROLL_FIELDS.review);
        const review = takeReview(id);
        if (review === null) {
          const expired = { message: "This review is no longer open, because it expired or entail restarted. Check the repo again." };
          return reposView(request, options, emptyStated(), [expired], null, 410);
        }
        const origin = request.form.get(ENROLL_FIELDS.visionOrigin) ?? "";
        const method = request.form.get(ENROLL_FIELDS.mergeMethod) ?? "";
        const offered = offeredMergeMethods(review);
        const criteria = criteriaOf(request.form);
        const shown = {
          origin: (VISION_ORIGINS as readonly string[]).includes(origin) ? (origin as VisionOrigin) : PRESELECTED_VISION_ORIGIN,
          mergeMethod: isMergeMethod(method) ? method : review.preselectedMergeMethod,
          criteria,
        };
        if (request.form.get(ENROLL_FIELDS.action) === ENROLL_ACTIONS.addRow) {
          return reviewView(request, review, id!, { ...shown, blankRows: 1, errors: null, status: 200 });
        }
        const errors: string[] = [];
        if (!(VISION_ORIGINS as readonly string[]).includes(origin)) errors.push("Pick the origin of the existing VISION.md.");
        if (offered !== null && !(isMergeMethod(method) && offered.includes(method))) errors.push("Pick the merge method.");
        criteria.forEach((row, index) => {
          for (const problem of rowProblems(row)) errors.push(`Generic criterion G${index + 1}: ${problem}`);
        });
        if (errors.length > 0) return reviewView(request, review, id!, { ...shown, errors, status: 400 });
        // A check the owner named after the screen was shown has not been warned about yet.
        const warned = new Set(request.form.getAll(ENROLL_FIELDS.warnedCheck));
        const unwarned = criteria
          .map((row) => unseenCheck(row, review.genericCriteria.seenChecks))
          .filter((name) => name !== null && !warned.has(name));
        if (unwarned.length > 0) {
          return reviewView(request, review, id!, {
            ...shown,
            errors: null,
            notice: "A generic criterion names a check that has not reported on the default branch's recent commits. Read its warning, then enroll again to keep it.",
            status: 200,
          });
        }
        pending.delete(id!);
        const result = await enroller.confirm(review, {
          visionOrigin: origin as VisionOrigin,
          mergeMethod: offered === null ? null : (method as MergeMethod),
          genericCriteria: criteria,
        });
        if (!result.ok) return reposView(request, options, statedFrom(review), result.refusals, null, 422);
        return { redirect: `${REPOS_PATH}?enrolled=${result.repo.id}` };
      },
    },
    repoSettingsPage({ store, dataDirectory: options.dataDirectory, createForge: options.createForge }),
  ];
}

/** The state shown for a repo: the owner's pause first, then a vanished vision, else active. */
export function repoState(paused: boolean, pausing: boolean, visionPresent: boolean | null): RepoState {
  if (paused) return pausing ? "pausing" : "paused";
  if (visionPresent === false) return "no vision";
  return "active";
}

/**
 * Whether the repo's mirror holds a VISION.md with vision lines on its
 * default branch, as last fetched; null when the mirror has nothing to read.
 */
export async function mirrorVisionPresent(dataDirectory: string, repo: RepoRecord): Promise<boolean | null> {
  const { mirror } = mirrorPaths(dataDirectory, { forge: repo.forge, host: repo.host, projectId: repo.projectId });
  if (!existsSync(join(mirror, "HEAD"))) return null;
  try {
    return (await readVision(new Git(mirror), "HEAD")).status === "present";
  } catch {
    return null;
  }
}

async function reposView(
  request: PageRequest,
  options: ReposPageOptions,
  stated: StatedForge,
  refusals: readonly Problem[],
  justEnrolled: RepoRecord | null,
  status: number,
): Promise<Reply> {
  const { store } = options;
  const repos = store.listRepos();
  const rows = await Promise.all(
    repos.map(async (repo) => {
      const paused = readRepoSettings(store, repo.id)?.settings.paused === true;
      const state = repoState(
        paused,
        paused && (options.activity?.pausing?.(repo) ?? false),
        await mirrorVisionPresent(options.dataDirectory, repo),
      );
      const poll = options.activity?.lastSuccessfulPoll?.(repo) ?? null;
      return `<tr>
<td>${escapeHtml(repo.path)}<br><span class="muted">${escapeHtml(repo.host)}</span></td>
<td>${forgeName(repo.forge)}</td>
<td><span class="state" data-state="${escapeHtml(state)}">${escapeHtml(state)}</span></td>
<td>${poll === null ? `<span class="muted">not yet polled</span>` : timeHtml(poll)}</td>
<td><a href="${REPO_SETTINGS_PATH}?repo=${repo.id}">Settings</a></td>
</tr>`;
    }),
  );
  const list =
    repos.length === 0
      ? `<p class="muted">No repo is enrolled yet.</p>`
      : `<table>
<thead><tr><th>Repo</th><th>Forge</th><th>State</th><th>Last successful poll</th><th></th></tr></thead>
<tbody>
${rows.join("\n")}
</tbody>
</table>`;

  const enrolledNotice =
    justEnrolled === null
      ? ""
      : `<p class="notice" role="status">Enrolled ${escapeHtml(justEnrolled.path)} on ${escapeHtml(justEnrolled.host)}. ` +
        `Issues you open there from now on are taken in; pull in an issue that was already open with an <code>/entail</code> comment.</p>`;
  const refused =
    refusals.length === 0
      ? ""
      : `<div class="error" role="alert"><p>Nothing was enrolled.</p>
<ul>
${refusals.map((r) => `<li${r.reason ? ` data-reason="${escapeHtml(r.reason)}"` : ""}>${codeHtml(r.message)}</li>`).join("\n")}
</ul></div>`;

  const named = readGlobalSettings(store).settings.ownerDisplayName !== null;
  const form = named
    ? `<form method="post" action="${CHECK_PATH}">
<input type="hidden" name="${TOKEN_FIELD}" value="${escapeHtml(request.server.token)}">
<div class="field">
<label for="f-forge">Forge</label>
<select id="f-forge" name="${ENROLL_FIELDS.forge}" required>
${(["github", "gitlab"] as const).map((f) => `<option value="${f}"${stated.forge === f ? " selected" : ""}>${f}</option>`).join("\n")}
</select>
</div>
<div class="field">
<label for="f-host">Host</label>
<input type="text" id="f-host" name="${ENROLL_FIELDS.host}" value="${escapeHtml(stated.host)}" placeholder="github.com" required spellcheck="false">
<p class="hint">github.com, gitlab.com, or your own GitLab's host name.</p>
</div>
<div class="field">
<label for="f-path">Path</label>
<input type="text" id="f-path" name="${ENROLL_FIELDS.path}" value="${escapeHtml(stated.path)}" placeholder="owner/name" required spellcheck="false">
</div>
<p class="hint">entail checks the repo through your own <code>gh</code> or <code>glab</code> login and shows what it found before anything is enrolled. Checking ends with one model run that proposes the repo's generic criteria, so it can take a few minutes.</p>
<button type="submit">Check the repo</button>
</form>`
    : `<p class="notice">Enrolling waits until your display name is set: every comment and answer carries it. <a href="${SETTINGS_PATH}">Set it in the global settings</a>.</p>`;

  const body = `<h1>Repos</h1>
${enrolledNotice}
${list}
<h2>Enroll a repo</h2>
${refused}
${form}
<p class="muted"><a href="${SETTINGS_PATH}">Global settings</a></p>`;
  return { status, html: renderPage(request, { title: "Repos", body }) };
}

interface ReviewState {
  origin: VisionOrigin;
  mergeMethod: MergeMethod | null;
  /** The generic criteria rows as the owner left them, or as proposed. */
  criteria: readonly GenericCriterionRow[];
  /** Empty rows to show after them, for the owner to add one; one by default. */
  blankRows?: number;
  errors: readonly string[] | null;
  /** A note shown above the form, such as asking to enroll again after a warning. */
  notice?: string;
  status: number;
}

function reviewView(request: PageRequest, review: EnrollmentReview, reviewId: string, state: ReviewState): Reply {
  const { setting, project, owner } = review;
  const { origin, mergeMethod, errors } = state;
  const offered = offeredMergeMethods(review);
  const warnings = review.warnings.map((w) => `<p class="notice" role="status">${codeHtml(w)}</p>`).join("\n");
  const refused =
    errors === null || errors.length === 0
      ? ""
      : `<div class="error" role="alert"><p>Nothing was enrolled.</p><ul>${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul></div>`;
  const notice = state.notice === undefined ? "" : `<p class="notice" role="status">${escapeHtml(state.notice)}</p>`;

  const originField = `<fieldset class="field">
<legend>Origin of the existing VISION.md</legend>
${VISION_ORIGINS.map(
  (o) =>
    `<label class="choice"><input type="radio" name="${ENROLL_FIELDS.visionOrigin}" value="${o}"${o === origin ? " checked" : ""} required> ${escapeHtml(ORIGIN_LABELS[o])}</label>`,
).join("\n")}
<p class="hint">Recorded for each of its ${review.visionLines.length} vision ${review.visionLines.length === 1 ? "line" : "lines"}. Lines added later take the origin their commit's <code>Vision-Origin</code> trailer names.</p>
</fieldset>`;

  const mergeField =
    offered === null
      ? `<p><strong>Merge method:</strong> GitLab's own merge method and squash setting for the project apply.</p>`
      : `<fieldset class="field">
<legend>Merge method</legend>
${offered
  .map(
    (m) =>
      `<label class="choice"><input type="radio" name="${ENROLL_FIELDS.mergeMethod}" value="${m}"${m === mergeMethod ? " checked" : ""} required> ${escapeHtml(MERGE_METHOD_LABELS[m])}</label>`,
  )
  .join("\n")}
<p class="hint">${
          review.mergeMethods!.length === 0
            ? "GitHub did not say which merge methods this repo allows, so every method is offered."
            : review.mergeMethods!.length === 1
              ? "The only method this repo allows."
              : "The methods this repo allows."
        }</p>
</fieldset>`;

  const body = `<h1>Review and enroll ${escapeHtml(setting.path)}</h1>
${refused}
${notice}
${warnings}
<dl>
<dt>Forge</dt><dd>${forgeName(setting.forge)}</dd>
<dt>Host</dt><dd>${escapeHtml(setting.host)}</dd>
<dt>Path</dt><dd>${escapeHtml(setting.path)}</dd>
<dt>Project id</dt><dd>${project.id}</dd>
<dt>Owner on this host</dt><dd>${escapeHtml(owner.username)} <span class="muted">(account ${owner.id})</span></dd>
<dt>VISION.md</dt><dd>on <code>${escapeHtml(review.defaultBranch)}</code> at <code>${escapeHtml(review.visionSha.slice(0, 12))}</code></dd>
</dl>
<form method="post" action="${ENROLL_PATH}">
<button type="submit" name="${ENROLL_FIELDS.action}" value="${ENROLL_ACTIONS.enroll}" tabindex="-1" aria-hidden="true" style="position:absolute;left:-10000px">Enroll</button>
<input type="hidden" name="${TOKEN_FIELD}" value="${escapeHtml(request.server.token)}">
<input type="hidden" name="${ENROLL_FIELDS.review}" value="${escapeHtml(reviewId)}">
${originField}
${mergeField}
${genericCriteriaSection(review, state.criteria, state.blankRows ?? 1)}
<h2>Defaults</h2>
<ul>
<li>Shadow: off</li>
<li>Who counts as an executor: anyone</li>
<li>Pins: VISION.md only, which is always pinned</li>
</ul>
<p>Issues already open are not taken in. Pull any of them in with an <code>/entail</code> comment.</p>
<button type="submit" name="${ENROLL_FIELDS.action}" value="${ENROLL_ACTIONS.enroll}">Enroll</button> <a href="${REPOS_PATH}">Cancel</a>
</form>`;
  return { status: state.status, html: renderPage(request, { title: `Enroll ${setting.path}`, body }) };
}

/**
 * The generic criteria rows G1…Gn of the review screen (spec §15 step 4):
 * each with its sentence, its mechanical check and the file it was inferred
 * from, editable and removable, then empty rows to add one. A row naming a
 * check that has not reported on recent default-branch commits is warned about.
 */
function genericCriteriaSection(review: EnrollmentReview, rows: readonly GenericCriterionRow[], blankRows: number): string {
  const { proposal, seenChecks, seenChecksProblem } = review.genericCriteria;
  const intro =
    proposal.failure !== null
      ? `<p class="notice" role="status">entail could not propose generic criteria: ${escapeHtml(proposal.failure.message)} (${escapeHtml(proposal.failure.kind)}). The list starts empty: add rows yourself, or leave it empty.</p>`
      : proposal.rows.length === 0
        ? `<p class="muted">entail found nothing in the CI files and build scripts that every PR must meet, so it proposes none. Add rows yourself, or leave the list empty.</p>`
        : `<p class="hint">Proposed from the repo's CI files and build scripts. Edit, remove or add rows; the list may be empty.</p>`;
  const seen =
    seenChecks === null
      ? `<p class="notice" role="status">entail could not read which checks reported on the default branch's recent commits: ${escapeHtml(seenChecksProblem ?? "")}. A check a criterion names cannot be confirmed.</p>`
      : seenChecks.length === 0
        ? `<p class="hint">No check reported on the default branch's recent commits.</p>`
        : `<p class="hint">Checks that reported on the default branch's recent commits: ${seenChecks.map((name) => `<code>${escapeHtml(name)}</code>`).join(", ")}.</p>`;

  const warned = new Set<string>();
  const rowHtml = (row: GenericCriterionRow | null, index: number): string => {
    const unseen = row === null ? null : unseenCheck(row, seenChecks);
    if (unseen !== null) warned.add(unseen);
    const kind = row?.check?.kind ?? "";
    const legend = row === null ? "New row" : `G${index + 1}`;
    const source =
      row === null
        ? ""
        : row.sourceFile === null
          ? `<p class="hint">Added by you.</p>`
          : `<p class="hint">Inferred from <code>${escapeHtml(row.sourceFile)}</code>.</p>
<input type="hidden" name="${criterionField(index, "source")}" value="${escapeHtml(row.sourceFile)}">`;
    const warning =
      unseen === null
        ? ""
        : `<p class="notice" role="status" data-warning="unseen-check">${
            seenChecks === null
              ? `entail could not confirm that the check <code>${escapeHtml(unseen)}</code> reports on the default branch.`
              : `The check <code>${escapeHtml(unseen)}</code> has not reported on the default branch's recent commits.`
          } A check that never reports stays pending, so no PR could merge while this criterion names it.</p>`;
    return `<fieldset class="field criterion">
<legend>${legend}</legend>
<label for="${criterionField(index, "sentence")}">Sentence</label>
<input type="text" id="${criterionField(index, "sentence")}" name="${criterionField(index, "sentence")}" value="${escapeHtml(row?.sentence ?? "")}" spellcheck="true">
<label for="${criterionField(index, "check_kind")}">Mechanical check</label>
<select id="${criterionField(index, "check_kind")}" name="${criterionField(index, "check_kind")}">
<option value=""${kind === "" ? " selected" : ""}>None</option>
${MECHANICAL_CHECK_KINDS.map((k) => `<option value="${k}"${kind === k ? " selected" : ""}>${escapeHtml(CHECK_KIND_LABELS[k])}</option>`).join("\n")}
</select>
<label for="${criterionField(index, "check_argument")}">Check name or path glob</label>
<input type="text" id="${criterionField(index, "check_argument")}" name="${criterionField(index, "check_argument")}" value="${escapeHtml(row?.check?.argument ?? "")}" spellcheck="false">
${row === null ? "" : `<p class="hint">Mechanical check: ${codeHtml(describeCheck(row.check))}.</p>`}
${source}
${warning}
${row === null ? "" : `<label class="choice"><input type="checkbox" name="${criterionField(index, "remove")}" value="1"> Remove this row</label>`}
</fieldset>`;
  };
  const shown = [...rows.map((row, index) => rowHtml(row, index)), ...Array.from({ length: blankRows }, (_, i) => rowHtml(null, rows.length + i))];

  return `<h2>Generic criteria</h2>
${intro}
${seen}
<input type="hidden" name="${ENROLL_FIELDS.criteriaCount}" value="${rows.length + blankRows}">
${[...warned].map((name) => `<input type="hidden" name="${ENROLL_FIELDS.warnedCheck}" value="${escapeHtml(name)}">`).join("\n")}
${shown.join("\n")}
<p class="hint">An empty row is left out. Every PR must meet each generic criterion besides its ticket's own criteria, and the forge's checks must all pass whatever the list holds.</p>
<button type="submit" name="${ENROLL_FIELDS.action}" value="${ENROLL_ACTIONS.addRow}">Add a row</button>`;
}

/**
 * The generic criteria rows as posted, in order: without the rows marked
 * for removal and the empty ones.
 */
function criteriaOf(form: URLSearchParams): GenericCriterionRow[] {
  const count = Math.min(Number.parseInt(form.get(ENROLL_FIELDS.criteriaCount) ?? "0", 10) || 0, MAX_CRITERIA_ROWS);
  const rows: GenericCriterionRow[] = [];
  for (let index = 0; index < count; index++) {
    if (form.get(criterionField(index, "remove")) !== null) continue;
    const kind = form.get(criterionField(index, "check_kind")) ?? "";
    const row = normalizeRow({
      sentence: form.get(criterionField(index, "sentence")) ?? "",
      check:
        (MECHANICAL_CHECK_KINDS as readonly string[]).includes(kind)
          ? { kind: kind as MechanicalCheckKind, argument: form.get(criterionField(index, "check_argument")) ?? "" }
          : null,
      sourceFile: form.get(criterionField(index, "source")),
    });
    // A row with nothing typed is an unused empty row.
    if (row.sentence === "" && (row.check === null || row.check.argument === "") && row.sourceFile === null) continue;
    rows.push(row);
  }
  return rows;
}

/** The merge methods the owner picks from on GitHub: those allowed, or all when GitHub did not say; null on GitLab. */
function offeredMergeMethods(review: EnrollmentReview): readonly MergeMethod[] | null {
  if (review.mergeMethods === null) return null;
  return review.mergeMethods.length === 0 ? MERGE_METHODS : review.mergeMethods;
}

function statedOf(form: URLSearchParams): StatedForge {
  return {
    forge: form.get(ENROLL_FIELDS.forge) ?? "",
    host: form.get(ENROLL_FIELDS.host) ?? "",
    path: form.get(ENROLL_FIELDS.path) ?? "",
  };
}

function statedFrom(review: EnrollmentReview): StatedForge {
  return { ...review.setting };
}

function emptyStated(): StatedForge {
  return { forge: "github", host: "", path: "" };
}

function forgeName(forge: "github" | "gitlab"): string {
  return forge === "github" ? "GitHub" : "GitLab";
}

/** Escapes a message and shows its `backticked` parts as code. */
function codeHtml(message: string): string {
  return escapeHtml(message).replace(/`([^`]+)`/g, "<code>$1</code>");
}
