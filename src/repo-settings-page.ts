import { compareCiFiles, mirrorDefaultBranchHead, type CiFilesComparison } from "./ci-files.ts";
import { createForge as createForgeAdapter } from "./forge/create-forge.ts";
import { type Actor, type Forge, type ForgeSetting, MERGE_METHODS } from "./forge/forge.ts";
import { readGlobalSettings } from "./global-settings.ts";
import { MECHANICAL_CHECK_KINDS } from "./model-schemas.ts";
import { escapeHtml, renderPage, timeHtml } from "./page.ts";
import {
  MERGE_METHOD_LABELS,
  parseRepoSettingsForm,
  readRepoSettings,
  readRepoSettingsForm,
  REPO_FIELDS,
  repoSettingsOf,
  settingsChanges,
  VISION_PIN,
  type CriterionRow,
  type MechanicalCheckKind,
  type PinRow,
  type RepoSettings,
  type RepoSettingsDraft,
  type RepoSettingsErrors,
  type RepoSettingsForm,
} from "./repo-settings.ts";
import { ORIGIN_LABELS, REPOS_PATH } from "./repos-page.ts";
import { pauseForm, unenrollLink } from "./repo-switches-page.ts";
import { TOKEN_FIELD, type FormRequest, type Page, type PageRequest, type Reply } from "./server.ts";
import type { RepoRecord, SettingsVersionRecord, Store } from "./store.ts";

export const REPO_SETTINGS_PATH = "/repos/settings";

export interface RepoSettingsPageOptions {
  store: Store;
  dataDirectory: string;
  /** The forge adapter for a repo, used to resolve executor usernames on save. */
  createForge?: (setting: ForgeSetting) => Forge;
}

/** How each mechanical check kind is named to the owner. */
const CHECK_KIND_LABELS: Readonly<Record<MechanicalCheckKind, string>> = {
  check_passes: "the check passes",
  changes_path: "the PR changes a path",
  leaves_path: "the PR leaves a path alone",
};

/**
 * Each enrolled repo's settings page (spec §15, ADR-0018). It shows the repo's
 * forge and the origin of its VISION.md, fixed at enrollment, and edits every
 * other per-repo setting but the pause: generic criteria, the merge method on
 * GitHub, shadow, who counts and its executors, and pins beyond the built-in
 * VISION.md pin. The pause switch and the way to unenroll sit beside the form
 * (src/repo-switches-page.ts). An unenrolled repo's settings stay readable,
 * with no form: its records are read-only.
 *
 * Every save is a new settings version with its time and the owner's name,
 * listed in the repo's settings history. A save is not a call and changes no
 * past call; the running process reads the settings on every pass, so a save
 * takes effect from the next pass. Older versions stay readable at
 * `?version=<n>`.
 */
export function repoSettingsPage(options: RepoSettingsPageOptions): Page {
  const { store } = options;
  const createForge = options.createForge ?? ((setting: ForgeSetting) => createForgeAdapter(setting));

  return {
    path: REPO_SETTINGS_PATH,
    async get(request) {
      const repo = repoOf(store, request.url.searchParams.get(REPO_FIELDS.repo));
      if (repo === null) return noSuchRepo(request);
      const current = readRepoSettings(store, repo.id);
      if (current === null) return noSettings(request, repo);
      const asked = request.url.searchParams.get("version");
      if (asked !== null) return versionView(request, store, repo, asked);
      if (!store.isEnrolled(repo.id)) return unenrolledView(request, store, repo, current.version);
      const saved = Number(request.url.searchParams.get("saved"));
      const notice =
        Number.isSafeInteger(saved) && saved > 0 && saved === current.version.version
          ? `<p class="notice" role="status">Saved as version ${saved} by ${escapeHtml(current.version.savedBy)}. It takes effect from the next pass.</p>`
          : request.url.searchParams.has("unchanged")
            ? `<p class="notice" role="status">Nothing changed, so no new version was saved.</p>`
            : "";
      return settingsView(request, options, repo, current.version, formOf(current.settings, current.version), {}, notice, 200);
    },
    async post(request: FormRequest) {
      const repo = repoOf(store, request.form.get(REPO_FIELDS.repo));
      if (repo === null) return noSuchRepo(request);
      const current = readRepoSettings(store, repo.id);
      if (current === null) return noSettings(request, repo);
      if (!store.isEnrolled(repo.id)) return unenrolledView(request, store, repo, current.version, 409);
      const typed = readRepoSettingsForm(request.form);
      const refuse = (errors: RepoSettingsErrors, status: number, form = typed, version = current.version) =>
        settingsView(request, options, repo, version, form, errors, "", status);

      const parsed = parseRepoSettingsForm(typed, repo.forge);
      if (!parsed.ok) return refuse(parsed.errors, 400);
      const { draft } = parsed;
      const owner = readGlobalSettings(store).settings.ownerDisplayName;
      if (owner === null) {
        return refuse({ form: "Your display name is not set, and every settings version carries it. Set it in the global settings first." }, 409);
      }

      const resolved = await resolveExecutors(repo, current.settings.executors, draft.executorUsernames, createForge);
      if (!resolved.ok) return refuse({ executors: resolved.error }, 422);

      const confirmed = await confirmedAt(options, repo, current.settings, draft);
      const latest = readRepoSettings(store, repo.id);
      if (latest === null) return noSettings(request, repo);
      if (draft.basedOn !== latest.version.version) {
        return refuse(
          {
            form:
              `These settings were saved again (version ${latest.version.version}) since you opened this page, so nothing was saved. ` +
              `Your changes are kept below; check them against the version in force, then save again.`,
          },
          409,
          { ...typed, basedOn: String(latest.version.version) },
          latest.version,
        );
      }
      const next: RepoSettings = {
        ...latest.settings,
        mergeMethod: draft.mergeMethod,
        shadow: draft.shadow,
        whoCounts: draft.whoCounts,
        executors: resolved.executors,
        genericCriteria: draft.genericCriteria,
        genericCriteriaConfirmedAt: confirmed,
        pins: draft.pins,
      };
      if (settingsChanges(latest.settings, next).length === 0) {
        return { redirect: `${REPO_SETTINGS_PATH}?${REPO_FIELDS.repo}=${repo.id}&unchanged=1` };
      }
      const saved = store.saveSettings(repo.id, next, owner);
      return { redirect: `${REPO_SETTINGS_PATH}?${REPO_FIELDS.repo}=${repo.id}&saved=${saved.version}` };
    },
  };
}

/**
 * The listed executors as accounts. A username already listed keeps the
 * account it was resolved to, so a renamed account still counts by its id; a
 * new one is looked up on the repo's host. Any username the host does not
 * know refuses the save.
 */
async function resolveExecutors(
  repo: RepoRecord,
  listed: readonly Actor[],
  usernames: readonly string[],
  createForge: (setting: ForgeSetting) => Forge,
): Promise<{ ok: true; executors: Actor[] } | { ok: false; error: string }> {
  const executors: Actor[] = [];
  const unknown: string[] = [];
  let forge: Forge | null = null;
  for (const username of usernames) {
    const known = listed.find((actor) => actor.username.toLowerCase() === username.toLowerCase());
    if (known !== undefined) {
      executors.push(known);
      continue;
    }
    let actor: Actor | null;
    try {
      forge ??= createForge({ forge: repo.forge, host: repo.host, path: repo.path });
      actor = await forge.actorByUsername(username);
    } catch (error) {
      return {
        ok: false,
        error: `entail could not look up ${username} on ${repo.host}, so nothing was saved: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (actor === null) unknown.push(username);
    else if (!executors.some((e) => e.id === actor.id)) executors.push(actor);
  }
  if (unknown.length > 0) {
    return { ok: false, error: `${repo.host} has no account named ${unknown.join(", ")}, so nothing was saved.` };
  }
  return { ok: true, executors };
}

/**
 * The default-branch commit the generic criteria count as confirmed against:
 * the mirror's head when the owner changed them or confirmed them again, else
 * the commit they were already confirmed against.
 */
async function confirmedAt(
  options: RepoSettingsPageOptions,
  repo: RepoRecord,
  current: RepoSettings,
  draft: RepoSettingsDraft,
): Promise<string | null | undefined> {
  const changed = JSON.stringify(current.genericCriteria) !== JSON.stringify(draft.genericCriteria);
  if (!changed && !draft.reconfirmGenericCriteria) return current.genericCriteriaConfirmedAt;
  return (await mirrorDefaultBranchHead(options.dataDirectory, repo).catch(() => null)) ?? null;
}

/** Whether the CI files changed since the generic criteria were confirmed, or null when that cannot be told. */
async function ciFilesSinceConfirmed(options: RepoSettingsPageOptions, repo: RepoRecord, settings: RepoSettings): Promise<CiFilesComparison | null> {
  // Settings saved at enrollment were confirmed against the commit enrollment read.
  const at =
    settings.genericCriteriaConfirmedAt === undefined
      ? (options.store.latestEnrollment(repo.id)?.visionSha ?? null)
      : settings.genericCriteriaConfirmedAt;
  if (at === null) return null;
  const comparison = await compareCiFiles(options.dataDirectory, repo, at);
  return comparison !== null && comparison.changed.length > 0 ? comparison : null;
}

async function settingsView(
  request: PageRequest,
  options: RepoSettingsPageOptions,
  repo: RepoRecord,
  inForce: SettingsVersionRecord,
  form: RepoSettingsForm,
  errors: RepoSettingsErrors,
  notice: string,
  status: number,
): Promise<Reply> {
  const { store } = options;
  const settings = repoSettingsOf(inForce);
  const ciChange = await ciFilesSinceConfirmed(options, repo, settings);
  const refused =
    Object.keys(errors).length > 0
      ? `<div class="error" role="alert"><p>Nothing was saved.${errors.form ? ` ${escapeHtml(errors.form)}` : " Fix the fields marked below."}</p></div>`
      : "";

  const body = `<h1>${escapeHtml(repo.path)} settings</h1>
${notice}
<p class="muted">In force: version ${inForce.version}, saved ${timeHtml(inForce.savedAt)} by ${escapeHtml(inForce.savedBy)}.</p>
${refused}
<dl>
<dt>Forge</dt><dd>${forgeName(repo.forge)}</dd>
<dt>Host</dt><dd>${escapeHtml(repo.host)}</dd>
<dt>Path</dt><dd>${escapeHtml(repo.path)}</dd>
<dt>Project id</dt><dd>${repo.projectId}</dd>
<dt>Owner on this host</dt><dd>${escapeHtml(repo.ownerLogin)} <span class="muted">(account ${repo.ownerAccountId})</span></dd>
<dt>Enrolled</dt><dd>${timeHtml(store.latestEnrollment(repo.id)?.enrolledAt ?? repo.enrolledAt)}</dd>
<dt>Origin of the existing VISION.md</dt><dd>${escapeHtml(ORIGIN_LABELS[settings.visionOrigin] ?? settings.visionOrigin)}</dd>
<dt>Paused</dt><dd>${settings.paused ? "yes" : "no"}</dd>
</dl>
<p class="hint">The forge is fixed at enrollment, and the origin of the existing VISION.md was confirmed once, then.</p>
<form method="post" action="${REPO_SETTINGS_PATH}">
<input type="hidden" name="${TOKEN_FIELD}" value="${escapeHtml(request.server.token)}">
<input type="hidden" name="${REPO_FIELDS.repo}" value="${repo.id}">
<input type="hidden" name="${REPO_FIELDS.basedOn}" value="${escapeHtml(form.basedOn)}">
${criteriaSection(form, errors, ciChange)}
${mergeSection(repo, form, errors)}
<h2>Shadow</h2>
<div class="field">
<label class="choice"><input type="checkbox" name="${REPO_FIELDS.shadow}" value="on"${form.shadow ? " checked" : ""}> Shadow: decide tickets and run landing checks, but leave every merge to you</label>
<p class="hint">Off by default. Takes effect from the next landing check. Turning it off does not merge a PR that already got a "would merge" comment.</p>
</div>
${whoCountsSection(repo, form, errors)}
${pinsSection(form, errors)}
<p class="hint">Saving makes a new version with the time and your display name. A save is not a call and changes no past call. It takes effect from the next pass.</p>
<button type="submit">Save settings</button>
</form>
<h2>Pause</h2>
<p class="hint">${
    settings.paused
      ? "Paused: entail reads and writes nothing in this repo, and its board items are locked. Labels and ticket states are kept. On resume, entail catches up from where it stopped before the items unlock."
      : "Pausing stops entail reading and writing in this repo once its running decider and landing runs finish and their writes are posted. Labels and ticket states are kept, and its board items stay, locked."
  }</p>
${pauseForm(request, repo, settings.paused, "settings")}
<p class="hint">Or ${unenrollLink(repo, "unenroll this repo")}: entail first shows how many tickets are in flight.</p>
${historyTable(store, repo)}
<p><a href="${REPOS_PATH}">Back to the repos</a></p>`;
  return { status, html: renderPage(request, { title: `${repo.path} settings`, body }) };
}

function criteriaSection(form: RepoSettingsForm, errors: RepoSettingsErrors, ciChange: CiFilesComparison | null): string {
  const rows = [...form.criteria, blankCriterion()];
  const hint =
    ciChange === null
      ? ""
      : `<div class="notice" data-hint="ci-files-changed"><p>The CI files changed since these generic criteria were confirmed at <code>${escapeHtml(ciChange.confirmedAt.slice(0, 12))}</code>: ${ciChange.changed.map((p) => `<code>${escapeHtml(p)}</code>`).join(", ")}. You may want to review them.</p>
<label class="choice"><input type="checkbox" name="${REPO_FIELDS.reconfirm}" value="on"${form.reconfirm ? " checked" : ""}> They still fit the CI files at <code>${escapeHtml(ciChange.head.slice(0, 12))}</code></label></div>`;
  return `<h2>Generic criteria</h2>
<p class="hint">Every PR in this repo must meet them. A change applies to tickets cleared after the save; a ticket already cleared keeps the generic criteria it was cleared under. The list may be empty.</p>
${hint}
${errors.criteria ? `<p class="error">${escapeHtml(errors.criteria)}</p>` : ""}
<input type="hidden" name="${REPO_FIELDS.criteriaCount}" value="${rows.length}">
${rows.map((row, i) => criterionRow(row, i, i === rows.length - 1, errors.criterion?.[i])).join("\n")}`;
}

function criterionRow(row: CriterionRow, i: number, blank: boolean, error: string | undefined): string {
  const f = (part: Parameters<typeof REPO_FIELDS.criterion>[1]) => REPO_FIELDS.criterion(i, part);
  const id = (part: string) => `f-g${i}-${part}`;
  const invalid = error ? ` aria-invalid="true" aria-describedby="${id("error")}"` : "";
  const legend = blank ? "Add a generic criterion" : `G${i + 1}`;
  return `<fieldset class="field row" data-criterion="${i}">
<legend>${legend}</legend>
<label for="${id("sentence")}">Sentence</label>
<input type="text" id="${id("sentence")}" name="${f("sentence")}" value="${escapeHtml(row.sentence)}"${invalid}>
<label for="${id("kind")}">Mechanical check</label>
<select id="${id("kind")}" name="${f("kind")}">
${MECHANICAL_CHECK_KINDS.map((k) => `<option value="${k}"${k === (row.kind || "check_passes") ? " selected" : ""}>${escapeHtml(CHECK_KIND_LABELS[k])}</option>`).join("\n")}
</select>
<label for="${id("argument")}">Check name or path glob</label>
<input type="text" id="${id("argument")}" name="${f("argument")}" value="${escapeHtml(row.argument)}" spellcheck="false"${invalid}>
<input type="hidden" name="${f("source")}" value="${escapeHtml(row.source)}">
${blank ? "" : `<p class="hint">${row.source === "" ? "Added by you." : `Inferred from <code>${escapeHtml(row.source)}</code>.`}</p>
<label class="choice"><input type="checkbox" name="${f("remove")}" value="on"${row.remove ? " checked" : ""}> Remove</label>`}
${error ? `<p class="error" id="${id("error")}">${escapeHtml(error)}</p>` : ""}
</fieldset>`;
}

function mergeSection(repo: RepoRecord, form: RepoSettingsForm, errors: RepoSettingsErrors): string {
  if (repo.forge !== "github") {
    return `<h2>Merge method</h2>
<p>GitLab's own merge method and squash setting for the project apply.</p>`;
  }
  return `<h2>Merge method</h2>
<fieldset class="field">
<legend>Merge method</legend>
${MERGE_METHODS.map(
  (m) =>
    `<label class="choice"><input type="radio" name="${REPO_FIELDS.mergeMethod}" value="${m}"${m === form.mergeMethod ? " checked" : ""} required> ${escapeHtml(MERGE_METHOD_LABELS[m])}</label>`,
).join("\n")}
<p class="hint">Takes effect from the next merge. If the repo does not allow the method, GitHub refuses the merge and entail says so on the PR.</p>
${errors.mergeMethod ? `<p class="error">${escapeHtml(errors.mergeMethod)}</p>` : ""}
</fieldset>`;
}

function whoCountsSection(repo: RepoRecord, form: RepoSettingsForm, errors: RepoSettingsErrors): string {
  const choice = (value: string, label: string) =>
    `<label class="choice"><input type="radio" name="${REPO_FIELDS.whoCounts}" value="${value}"${form.whoCounts === value ? " checked" : ""} required> ${label}</label>`;
  const invalid = errors.executors ? ` aria-invalid="true" aria-describedby="f-executors-error"` : "";
  return `<h2>Who counts</h2>
<fieldset class="field">
<legend>Who counts as an executor</legend>
${choice("anyone", "Anyone: entail checks any PR that links a cleared issue")}
${choice("owner-and-listed", `Only you (${escapeHtml(repo.ownerLogin)}) and the executors listed below`)}
${errors.whoCounts ? `<p class="error">${escapeHtml(errors.whoCounts)}</p>` : ""}
</fieldset>
<div class="field">
<label for="f-executors">Executors</label>
<textarea id="f-executors" name="${REPO_FIELDS.executors}" rows="3" spellcheck="false"${invalid}>${escapeHtml(form.executors)}</textarea>
<p class="hint">Usernames on ${escapeHtml(repo.host)}, one per line. Each is looked up when you save and kept by its account id, so a renamed account still counts. Takes effect from the next landing check or findings comment.</p>
${errors.executors ? `<p class="error" id="f-executors-error">${escapeHtml(errors.executors)}</p>` : ""}
</div>`;
}

function pinsSection(form: RepoSettingsForm, errors: RepoSettingsErrors): string {
  const rows = [...form.pins, blankPin()];
  return `<h2>Pins</h2>
<p class="hint">Topics that always come to you, even where the vision settles them. A pin's paths and keywords also mark it as touched. Changes take effect at once; editing a pin removes the old one and adds the new one.</p>
<fieldset class="field row" data-pin="vision">
<legend>${escapeHtml(VISION_PIN.topic)}</legend>
<p>Paths: <code>${escapeHtml(VISION_PIN.paths.join(", "))}</code></p>
<p class="hint">Built in. The vision is always pinned, in every repo, and cannot be removed.</p>
</fieldset>
${errors.pins ? `<p class="error">${escapeHtml(errors.pins)}</p>` : ""}
<input type="hidden" name="${REPO_FIELDS.pinCount}" value="${rows.length}">
${rows.map((row, i) => pinRow(row, i, i === rows.length - 1, errors.pin?.[i])).join("\n")}`;
}

function pinRow(row: PinRow, i: number, blank: boolean, error: string | undefined): string {
  const f = (part: Parameters<typeof REPO_FIELDS.pin>[1]) => REPO_FIELDS.pin(i, part);
  const id = (part: string) => `f-p${i}-${part}`;
  const invalid = error ? ` aria-invalid="true" aria-describedby="${id("error")}"` : "";
  return `<fieldset class="field row" data-pin="${i}">
<legend>${blank ? "Add a pin" : `Pin ${i + 1}`}</legend>
<label for="${id("topic")}">Topic</label>
<input type="text" id="${id("topic")}" name="${f("topic")}" value="${escapeHtml(row.topic)}"${invalid}>
<label for="${id("paths")}">Paths <span class="muted">(optional, one glob per line)</span></label>
<textarea id="${id("paths")}" name="${f("paths")}" rows="2" spellcheck="false">${escapeHtml(row.paths)}</textarea>
<label for="${id("keywords")}">Keywords <span class="muted">(optional, one per line)</span></label>
<textarea id="${id("keywords")}" name="${f("keywords")}" rows="2">${escapeHtml(row.keywords)}</textarea>
${blank ? "" : `<label class="choice"><input type="checkbox" name="${f("remove")}" value="on"${row.remove ? " checked" : ""}> Remove</label>`}
${error ? `<p class="error" id="${id("error")}">${escapeHtml(error)}</p>` : ""}
</fieldset>`;
}

/** The repo's settings history, newest first, with what each save changed. */
function historyTable(store: Store, repo: RepoRecord): string {
  const history = store.settingsHistory(repo.id);
  if (history.length === 0) return "";
  const rows = history
    .map((v, i) => {
      const before = history[i + 1];
      const changes = before === undefined ? ["enrolled"] : settingsChanges(repoSettingsOf(before), repoSettingsOf(v));
      return `<tr>
<td><a href="${REPO_SETTINGS_PATH}?${REPO_FIELDS.repo}=${repo.id}&amp;version=${v.version}">Version ${v.version}</a>${i === 0 ? " (in force)" : ""}</td>
<td>${timeHtml(v.savedAt)}</td>
<td>${escapeHtml(v.savedBy)}</td>
<td>${escapeHtml(changes.join(", ") || "nothing")}</td>
</tr>`;
    })
    .join("\n");
  return `<h2>Settings history</h2>
<table>
<thead><tr><th>Version</th><th>Saved</th><th>By</th><th>Changed</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
}

/** One saved version of a repo's settings, read-only. */
function versionView(request: PageRequest, store: Store, repo: RepoRecord, asked: string): Reply {
  const number = /^\d+$/.test(asked) ? Number(asked) : NaN;
  const version = Number.isSafeInteger(number) ? store.settingsVersion(repo.id, number) : null;
  const back = `<p><a href="${REPO_SETTINGS_PATH}?${REPO_FIELDS.repo}=${repo.id}">Back to the ${escapeHtml(repo.path)} settings</a></p>`;
  if (version === null) {
    return { status: 404, html: renderPage(request, { title: `${repo.path} settings`, body: `<h1>No such settings version</h1>\n${back}` }) };
  }
  const s = repoSettingsOf(version);
  const inForce = store.latestSettings(repo.id)?.version === version.version;
  const none = `<span class="muted">none</span>`;
  const criteria =
    s.genericCriteria.length === 0
      ? none
      : `<ol>${s.genericCriteria
          .map(
            (g) =>
              `<li>${escapeHtml(g.id)}: ${escapeHtml(g.sentence)} <span class="muted">(${escapeHtml(CHECK_KIND_LABELS[g.check.kind] ?? g.check.kind)}: <code>${escapeHtml(g.check.argument)}</code>${g.source ? `; from <code>${escapeHtml(g.source)}</code>` : ""})</span></li>`,
          )
          .join("")}</ol>`;
  const executors = s.executors.length === 0 ? none : s.executors.map((e) => `${escapeHtml(e.username)} <span class="muted">(account ${e.id})</span>`).join(", ");
  const pins = `<ul><li>${escapeHtml(VISION_PIN.topic)} <span class="muted">(built in)</span></li>${s.pins
    .map(
      (p) =>
        `<li>${escapeHtml(p.topic)}${p.paths.length ? ` <span class="muted">paths:</span> ${p.paths.map((g) => `<code>${escapeHtml(g)}</code>`).join(", ")}` : ""}${p.keywords.length ? ` <span class="muted">keywords:</span> ${escapeHtml(p.keywords.join(", "))}` : ""}</li>`,
    )
    .join("")}</ul>`;
  const body = `<h1>${escapeHtml(repo.path)} settings, version ${version.version}</h1>
<p class="muted">Saved ${timeHtml(version.savedAt)} by ${escapeHtml(version.savedBy)}${inForce ? "; in force" : "; no longer in force"}.</p>
<dl>
<dt>Origin of the existing VISION.md</dt><dd>${escapeHtml(ORIGIN_LABELS[s.visionOrigin] ?? s.visionOrigin)}</dd>
<dt>Generic criteria</dt><dd>${criteria}</dd>
${repo.forge === "github" ? `<dt>Merge method</dt><dd>${s.mergeMethod ? escapeHtml(MERGE_METHOD_LABELS[s.mergeMethod]) : ""}</dd>` : ""}
<dt>Shadow</dt><dd>${s.shadow ? "on" : "off"}</dd>
<dt>Who counts</dt><dd>${s.whoCounts === "owner-and-listed" ? "the owner and listed executors" : "anyone"}</dd>
<dt>Executors</dt><dd>${executors}</dd>
<dt>Pins</dt><dd>${pins}</dd>
<dt>Paused</dt><dd>${s.paused ? "yes" : "no"}</dd>
</dl>
${back}`;
  return { status: 200, html: renderPage(request, { title: `${repo.path} settings, version ${version.version}`, body }) };
}

/** The form as the settings in force fill it. */
function formOf(settings: RepoSettings, version: SettingsVersionRecord): RepoSettingsForm {
  return {
    basedOn: String(version.version),
    mergeMethod: settings.mergeMethod ?? "",
    shadow: settings.shadow,
    whoCounts: settings.whoCounts,
    executors: settings.executors.map((e) => e.username).join("\n"),
    reconfirm: false,
    criteria: settings.genericCriteria.map((g) => ({
      sentence: g.sentence,
      kind: g.check.kind,
      argument: g.check.argument,
      source: g.source ?? "",
      remove: false,
    })),
    pins: settings.pins.map((p) => ({ topic: p.topic, paths: p.paths.join("\n"), keywords: p.keywords.join("\n"), remove: false })),
  };
}

function blankCriterion(): CriterionRow {
  return { sentence: "", kind: "check_passes", argument: "", source: "", remove: false };
}

function blankPin(): PinRow {
  return { topic: "", paths: "", keywords: "", remove: false };
}

function repoOf(store: Store, asked: string | null): RepoRecord | null {
  const id = asked !== null && /^\d+$/.test(asked) ? Number(asked) : NaN;
  return Number.isSafeInteger(id) ? store.getRepo(id) : null;
}

function noSuchRepo(request: PageRequest): Reply {
  const body = `<h1>No such repo</h1>\n<p><a href="${REPOS_PATH}">Back to the repos</a></p>`;
  return { status: 404, html: renderPage(request, { title: "Repo settings", body }) };
}

/** An unenrolled repo's settings: readable, with no form, since its records are read-only (ADR-0018). */
function unenrolledView(request: PageRequest, store: Store, repo: RepoRecord, inForce: SettingsVersionRecord, status = 200): Reply {
  const unenrollment = store.latestUnenrollment(repo.id);
  const body = `<h1>${escapeHtml(repo.path)} settings</h1>
<p class="notice" role="status" data-unenrolled="${repo.id}">This repo was unenrolled${
    unenrollment === null ? "" : ` ${timeHtml(unenrollment.unenrolledAt)} by ${escapeHtml(unenrollment.unenrolledBy)}`
  }. entail reads and writes nothing there, and its records stay, read-only. Enroll it again on the <a href="${REPOS_PATH}">Repos page</a>.</p>
<p class="muted">Last in force: version ${inForce.version}, saved ${timeHtml(inForce.savedAt)} by ${escapeHtml(inForce.savedBy)}.</p>
${historyTable(store, repo)}
<p><a href="${REPOS_PATH}">Back to the repos</a></p>`;
  return { status, html: renderPage(request, { title: `${repo.path} settings`, body }) };
}

function noSettings(request: PageRequest, repo: RepoRecord): Reply {
  const body = `<h1>${escapeHtml(repo.path)} settings</h1>\n<p class="muted">No settings saved.</p>\n<p><a href="${REPOS_PATH}">Back to the repos</a></p>`;
  return { status: 404, html: renderPage(request, { title: `${repo.path} settings`, body }) };
}

function forgeName(forge: "github" | "gitlab"): string {
  return forge === "github" ? "GitHub" : "GitLab";
}
