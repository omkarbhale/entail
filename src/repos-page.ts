import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Enroller, type EnrollmentReview, type Refusal, type StatedForge } from "./enrollment.ts";
import { MERGE_METHODS, type MergeMethod } from "./forge/forge.ts";
import { Git } from "./git.ts";
import { readGlobalSettings } from "./global-settings.ts";
import { mirrorPaths } from "./mirror.ts";
import { escapeHtml, renderPage, timeHtml } from "./page.ts";
import { isMergeMethod, MERGE_METHOD_LABELS, PRESELECTED_VISION_ORIGIN, type RepoSettings } from "./repo-settings.ts";
import { TOKEN_FIELD, type FormRequest, type Page, type PageRequest, type Reply } from "./server.ts";
import { SETTINGS_PATH } from "./settings-page.ts";
import type { RepoRecord, SettingsVersionRecord, Store, VisionOrigin } from "./store.ts";
import { VISION_ORIGINS } from "./store-schema.ts";
import { readVision } from "./vision.ts";

export const REPOS_PATH = "/repos";
export const CHECK_PATH = "/repos/check";
export const ENROLL_PATH = "/repos/enroll";
export const REPO_SETTINGS_PATH = "/repos/settings";

/** The enrollment form's field names. */
export const ENROLL_FIELDS = {
  forge: "forge",
  host: "host",
  path: "path",
  review: "review",
  visionOrigin: "vision_origin",
  mergeMethod: "merge_method",
} as const;

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
        return reviewView(request, result.review, holdReview(result.review), PRESELECTED_VISION_ORIGIN, result.review.preselectedMergeMethod, null, 200);
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
        const errors: string[] = [];
        if (!(VISION_ORIGINS as readonly string[]).includes(origin)) errors.push("Pick the origin of the existing VISION.md.");
        if (offered !== null && !(isMergeMethod(method) && offered.includes(method))) errors.push("Pick the merge method.");
        if (errors.length > 0) {
          return reviewView(
            request,
            review,
            id!,
            (VISION_ORIGINS as readonly string[]).includes(origin) ? (origin as VisionOrigin) : PRESELECTED_VISION_ORIGIN,
            isMergeMethod(method) ? method : review.preselectedMergeMethod,
            errors,
            400,
          );
        }
        pending.delete(id!);
        const result = await enroller.confirm(review, {
          visionOrigin: origin as VisionOrigin,
          mergeMethod: offered === null ? null : (method as MergeMethod),
        });
        if (!result.ok) return reposView(request, options, statedFrom(review), result.refusals, null, 422);
        return { redirect: `${REPOS_PATH}?enrolled=${result.repo.id}` };
      },
    },
    {
      path: REPO_SETTINGS_PATH,
      get(request) {
        return repoSettingsView(request, store);
      },
    },
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
      const settings = repoSettingsOf(store.latestSettings(repo.id));
      const paused = settings?.paused === true;
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
<p class="hint">entail checks the repo through your own <code>gh</code> or <code>glab</code> login and shows what it found before anything is enrolled.</p>
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

function reviewView(
  request: PageRequest,
  review: EnrollmentReview,
  reviewId: string,
  origin: VisionOrigin,
  mergeMethod: MergeMethod | null,
  errors: readonly string[] | null,
  status: number,
): Reply {
  const { setting, project, owner } = review;
  const offered = offeredMergeMethods(review);
  const warnings = review.warnings.map((w) => `<p class="notice" role="status">${codeHtml(w)}</p>`).join("\n");
  const refused =
    errors === null || errors.length === 0
      ? ""
      : `<div class="error" role="alert"><p>Nothing was enrolled.</p><ul>${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul></div>`;

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
<input type="hidden" name="${TOKEN_FIELD}" value="${escapeHtml(request.server.token)}">
<input type="hidden" name="${ENROLL_FIELDS.review}" value="${escapeHtml(reviewId)}">
${originField}
${mergeField}
<h2>Generic criteria</h2>
<p class="muted">None. The list starts empty.</p>
<h2>Defaults</h2>
<ul>
<li>Shadow: off</li>
<li>Who counts as an executor: anyone</li>
<li>Pins: VISION.md only, which is always pinned</li>
</ul>
<p>Issues already open are not taken in. Pull any of them in with an <code>/entail</code> comment.</p>
<button type="submit">Enroll</button> <a href="${REPOS_PATH}">Cancel</a>
</form>`;
  return { status, html: renderPage(request, { title: `Enroll ${setting.path}`, body }) };
}

/** A repo's settings in force and their history, read-only. */
function repoSettingsView(request: PageRequest, store: Store): Reply {
  const asked = request.url.searchParams.get("repo") ?? "";
  const id = /^\d+$/.test(asked) ? Number(asked) : NaN;
  const repo = Number.isSafeInteger(id) ? store.getRepo(id) : null;
  if (repo === null) {
    const body = `<h1>No such repo</h1>\n<p><a href="${REPOS_PATH}">Back to the repos</a></p>`;
    return { status: 404, html: renderPage(request, { title: "Repo settings", body }) };
  }
  const version = store.latestSettings(repo.id);
  const settings = repoSettingsOf(version);
  const yesNo = (on: boolean | undefined) => (on ? "on" : "off");
  const listed = (items: unknown[] | undefined, none: string) =>
    items === undefined || items.length === 0 ? `<span class="muted">${none}</span>` : String(items.length);
  const history = store.settingsHistory(repo.id);
  const body = `<h1>${escapeHtml(repo.path)} settings</h1>
${
  version === null
    ? `<p class="muted">No settings saved.</p>`
    : `<p class="muted">In force: version ${version.version}, saved ${timeHtml(version.savedAt)} by ${escapeHtml(version.savedBy)}.</p>`
}
<dl>
<dt>Forge</dt><dd>${forgeName(repo.forge)}</dd>
<dt>Host</dt><dd>${escapeHtml(repo.host)}</dd>
<dt>Path</dt><dd>${escapeHtml(repo.path)}</dd>
<dt>Project id</dt><dd>${repo.projectId}</dd>
<dt>Owner on this host</dt><dd>${escapeHtml(repo.ownerLogin)} <span class="muted">(account ${repo.ownerAccountId})</span></dd>
<dt>Enrolled</dt><dd>${timeHtml(repo.enrolledAt)}</dd>
<dt>Origin of the existing VISION.md</dt><dd>${settings?.visionOrigin ? escapeHtml(ORIGIN_LABELS[settings.visionOrigin] ?? settings.visionOrigin) : ""}</dd>
${repo.forge === "github" ? `<dt>Merge method</dt><dd>${settings?.mergeMethod ? escapeHtml(MERGE_METHOD_LABELS[settings.mergeMethod]) : ""}</dd>` : ""}
<dt>Generic criteria</dt><dd>${listed(settings?.genericCriteria, "none")}</dd>
<dt>Shadow</dt><dd>${yesNo(settings?.shadow)}</dd>
<dt>Who counts</dt><dd>${settings?.whoCounts === "owner-and-listed" ? "the owner and listed executors" : "anyone"}</dd>
<dt>Pins</dt><dd>VISION.md${settings?.pins?.length ? `, and ${settings.pins.length} more` : ""}</dd>
<dt>Paused</dt><dd>${settings?.paused ? "yes" : "no"}</dd>
</dl>
${
  history.length === 0
    ? ""
    : `<h2>Settings history</h2>
<table>
<thead><tr><th>Version</th><th>Saved</th><th>By</th></tr></thead>
<tbody>
${history.map((v) => `<tr><td>Version ${v.version}</td><td>${timeHtml(v.savedAt)}</td><td>${escapeHtml(v.savedBy)}</td></tr>`).join("\n")}
</tbody>
</table>`
}
<p><a href="${REPOS_PATH}">Back to the repos</a></p>`;
  return { status: 200, html: renderPage(request, { title: `${repo.path} settings`, body }) };
}

/** The merge methods the owner picks from on GitHub: those allowed, or all when GitHub did not say; null on GitLab. */
function offeredMergeMethods(review: EnrollmentReview): readonly MergeMethod[] | null {
  if (review.mergeMethods === null) return null;
  return review.mergeMethods.length === 0 ? MERGE_METHODS : review.mergeMethods;
}

function repoSettingsOf(version: SettingsVersionRecord | null): Partial<RepoSettings> | null {
  return version !== null && typeof version.settings === "object" && version.settings !== null
    ? (version.settings as Partial<RepoSettings>)
    : null;
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
