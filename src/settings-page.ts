import {
  DEFAULT_GLOBAL_SETTINGS,
  FIELDS,
  LIMITS,
  NOTICE_CONNECTORS,
  parseSettingsForm,
  readGlobalSettings,
  settingsOf,
  type GlobalSettings,
  type SettingsErrors,
} from "./global-settings.ts";
import { escapeHtml, renderPage, timeHtml } from "./page.ts";
import { TOKEN_FIELD, type FormRequest, type Page, type PageRequest, type Reply } from "./server.ts";
import type { GlobalSettingsVersionRecord, Store } from "./store.ts";

export const SETTINGS_PATH = "/settings";

type Key = keyof GlobalSettings;
/** What each field shows: the saved value, or what the owner typed when a save was refused. */
type FormValues = Record<Key, string>;

/** Each setting as spec §15 lists it: its label, its default and when a change takes effect. */
const ROWS: readonly { key: Key; label: string; default: string; takesEffect: string }[] = [
  { key: "ownerDisplayName", label: "Owner's display name", default: "none", takesEffect: "from the next comment or answer" },
  { key: "recordsRemote", label: "Records repo remote", default: "none", takesEffect: "from the next records push" },
  { key: "noticeConnector", label: "Notice connector", default: DEFAULT_GLOBAL_SETTINGS.noticeConnector, takesEffect: "from the next notice" },
  { key: "model", label: "Model", default: DEFAULT_GLOBAL_SETTINGS.model, takesEffect: "from the next model run" },
  { key: "modelRunLimit", label: "Model-run limit", default: String(DEFAULT_GLOBAL_SETTINGS.modelRunLimit), takesEffect: "from the next pass" },
  { key: "pollIntervalSeconds", label: "Poll interval (seconds)", default: String(DEFAULT_GLOBAL_SETTINGS.pollIntervalSeconds), takesEffect: "from the next pass" },
  { key: "boardPort", label: "Board port", default: String(DEFAULT_GLOBAL_SETTINGS.boardPort), takesEffect: "from the next start" },
];

/**
 * The global settings page (spec §15, ADR-0018). It shows and saves every
 * entail-wide setting. Each save is a new version recorded with its time and
 * the owner's name; a save is not a call. Older versions stay readable at
 * `?version=<n>`.
 */
export function globalSettingsPage(store: Store): Page {
  return {
    path: SETTINGS_PATH,
    nav: "Settings",
    get(request) {
      const asked = request.url.searchParams.get("version");
      if (asked !== null) return versionView(store, request, asked);
      const saved = Number(request.url.searchParams.get("saved"));
      const { settings, version } = readGlobalSettings(store);
      const notice = Number.isSafeInteger(saved) && saved > 0 && saved === version?.version ? savedNotice(version) : "";
      return settingsView(store, request, valuesOf(settings), {}, notice, 200);
    },
    post(request: FormRequest) {
      const parsed = parseSettingsForm(request.form);
      if (!parsed.ok) {
        const typed = Object.fromEntries(ROWS.map(({ key }) => [key, request.form.get(FIELDS[key]) ?? ""])) as FormValues;
        return settingsView(store, request, typed, parsed.errors, "", 400);
      }
      const saved = store.saveGlobalSettings(parsed.settings, parsed.settings.ownerDisplayName!);
      return { redirect: `${SETTINGS_PATH}?saved=${saved.version}` };
    },
  };
}

function settingsView(
  store: Store,
  request: PageRequest,
  values: FormValues,
  errors: SettingsErrors,
  notice: string,
  status: number,
): Reply {
  const { settings: current, version } = readGlobalSettings(store);
  const standing: string[] = [];
  if (current.ownerDisplayName === null) {
    standing.push(`<p class="notice">Your display name is not set. Enrolling a repo waits until it is set.</p>`);
  }
  if (current.recordsRemote === null) {
    standing.push(`<p class="notice">Records repo: no remote set. Records stay on this machine only.</p>`);
  }
  if (current.boardPort !== request.server.port) {
    standing.push(
      `<p class="notice">entail is listening on port ${request.server.port} until its next start, then on port ${current.boardPort}.</p>`,
    );
  }
  const refused = Object.keys(errors).length > 0 ? `<p class="error" role="alert">Nothing was saved. Fix the fields marked below.</p>` : "";
  const versionLine =
    version === null
      ? `<p class="muted">No settings saved yet; the defaults are in force.</p>`
      : `<p class="muted">In force: version ${version.version}, saved ${timeHtml(version.savedAt)} by ${escapeHtml(version.savedBy)}.</p>`;

  const body = `<h1>Global settings</h1>
${notice}
${standing.join("\n")}
${versionLine}
${refused}
<form method="post" action="${SETTINGS_PATH}">
<input type="hidden" name="${TOKEN_FIELD}" value="${escapeHtml(request.server.token)}">
${ROWS.map((row) => field(row, values[row.key], errors[row.key])).join("\n")}
<p class="hint">Saving makes a new version with the time and your display name. A save is not a call.</p>
<button type="submit">Save settings</button>
</form>
${historyTable(store.globalSettingsHistory())}`;
  return { status, html: renderPage(request, { title: "Global settings", body }) };
}

function field(row: (typeof ROWS)[number], value: string, error: string | undefined): string {
  const name = FIELDS[row.key];
  const id = `f-${name}`;
  const invalid = error ? ` aria-invalid="true" aria-describedby="${id}-error"` : "";
  let control: string;
  switch (row.key) {
    case "noticeConnector":
      control = `<select id="${id}" name="${name}"${invalid}>
${NOTICE_CONNECTORS.map((c) => `<option value="${c}"${c === value ? " selected" : ""}>${c}</option>`).join("\n")}
</select>`;
      break;
    case "modelRunLimit":
    case "pollIntervalSeconds":
    case "boardPort": {
      const range = LIMITS[row.key];
      control = `<input type="number" id="${id}" name="${name}" value="${escapeHtml(value)}" min="${range.min}" max="${range.max}" step="1" required${invalid}>`;
      break;
    }
    case "ownerDisplayName":
      control = `<input type="text" id="${id}" name="${name}" value="${escapeHtml(value)}" maxlength="${LIMITS.displayNameLength}" required${invalid}>`;
      break;
    case "recordsRemote":
      control = `<input type="text" id="${id}" name="${name}" value="${escapeHtml(value)}" maxlength="${LIMITS.recordsRemoteLength}" placeholder="no remote set" spellcheck="false"${invalid}>`;
      break;
    case "model":
      control = `<input type="text" id="${id}" name="${name}" value="${escapeHtml(value)}" required spellcheck="false"${invalid}>`;
      break;
  }
  return `<div class="field">
<label for="${id}">${escapeHtml(row.label)}</label>
${control}
<p class="hint">Default: ${escapeHtml(row.default)}. Takes effect ${escapeHtml(row.takesEffect)}.</p>
${error ? `<p class="error" id="${id}-error">${escapeHtml(error)}</p>` : ""}
</div>`;
}

function historyTable(history: readonly GlobalSettingsVersionRecord[]): string {
  if (history.length === 0) return "";
  const rows = history
    .map(
      (v, i) => `<tr>
<td><a href="${SETTINGS_PATH}?version=${v.version}">Version ${v.version}</a>${i === 0 ? " (in force)" : ""}</td>
<td>${timeHtml(v.savedAt)}</td>
<td>${escapeHtml(v.savedBy)}</td>
</tr>`,
    )
    .join("\n");
  return `<h2>Settings history</h2>
<table>
<thead><tr><th>Version</th><th>Saved</th><th>By</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
}

/** One saved version, read-only. */
function versionView(store: Store, request: PageRequest, asked: string): Reply {
  const number = /^\d+$/.test(asked) ? Number(asked) : NaN;
  const version = Number.isSafeInteger(number) ? store.globalSettingsVersion(number) : null;
  if (version === null) {
    const body = `<h1>No such settings version</h1>\n<p><a href="${SETTINGS_PATH}">Back to the global settings</a></p>`;
    return { status: 404, html: renderPage(request, { title: "Global settings", body }) };
  }
  const settings = settingsOf(version);
  const inForce = store.latestGlobalSettings()?.version === version.version;
  const values = valuesOf(settings);
  const body = `<h1>Global settings, version ${version.version}</h1>
<p class="muted">Saved ${timeHtml(version.savedAt)} by ${escapeHtml(version.savedBy)}${inForce ? "; in force" : "; no longer in force"}.</p>
<dl>
${ROWS.map(
  ({ key, label }) =>
    `<dt>${escapeHtml(label)}</dt><dd>${values[key] === "" ? `<span class="muted">${key === "recordsRemote" ? "no remote set" : "not set"}</span>` : escapeHtml(values[key])}</dd>`,
).join("\n")}
</dl>
<p><a href="${SETTINGS_PATH}">Back to the global settings</a></p>`;
  return { status: 200, html: renderPage(request, { title: `Global settings, version ${version.version}`, body }) };
}

function savedNotice(version: GlobalSettingsVersionRecord): string {
  return `<p class="notice" role="status">Saved as version ${version.version} by ${escapeHtml(version.savedBy)}.</p>`;
}

function valuesOf(settings: GlobalSettings): FormValues {
  return {
    ownerDisplayName: settings.ownerDisplayName ?? "",
    recordsRemote: settings.recordsRemote ?? "",
    noticeConnector: settings.noticeConnector,
    model: settings.model,
    modelRunLimit: String(settings.modelRunLimit),
    pollIntervalSeconds: String(settings.pollIntervalSeconds),
    boardPort: String(settings.boardPort),
  };
}
