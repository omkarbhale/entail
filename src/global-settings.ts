import type { GlobalSettingsVersionRecord, Store } from "./store.ts";

/** The notice connectors MVP-1 has, picked by name (spec §13). */
export const NOTICE_CONNECTORS = ["desktop", "file"] as const;
export type NoticeConnectorName = (typeof NOTICE_CONNECTORS)[number];

/**
 * entail's global settings, the only entail-wide settings in MVP-1
 * (spec §15, ADR-0018). They are kept and versioned like repo settings.
 */
export interface GlobalSettings {
  /** No default: the attribution line and every answer carry it, so enrolling waits until it is set. */
  ownerDisplayName: string | null;
  /** None by default; "no remote set" is shown on the settings page. */
  recordsRemote: string | null;
  noticeConnector: NoticeConnectorName;
  /** One model for every model run. */
  model: string;
  /** At most this many model runs at once across all repos. */
  modelRunLimit: number;
  pollIntervalSeconds: number;
  /** Takes effect on the next start, because a running server keeps the port its links were posted with. */
  boardPort: number;
}

export const DEFAULT_GLOBAL_SETTINGS: Readonly<GlobalSettings> = Object.freeze({
  ownerDisplayName: null,
  recordsRemote: null,
  noticeConnector: "desktop",
  model: "claude-opus-5-5",
  modelRunLimit: 2,
  pollIntervalSeconds: 60,
  boardPort: 7419,
});

export const LIMITS = {
  displayNameLength: 100,
  recordsRemoteLength: 500,
  modelRunLimit: { min: 1, max: 16 },
  pollIntervalSeconds: { min: 10, max: 3600 },
  boardPort: { min: 1024, max: 65535 },
} as const;

/** The global settings in force: the latest saved version, or the defaults before the first save. */
export interface CurrentGlobalSettings {
  settings: GlobalSettings;
  /** The version in force, or null while nothing has been saved. */
  version: GlobalSettingsVersionRecord | null;
}

/**
 * Reads the global settings from the store. It reads the store every time and
 * caches nothing, so each pass sees a save within one pass (spec §1). The
 * board port is the exception: the running server keeps the port it started
 * with, and a saved port takes effect on the next start.
 */
export function readGlobalSettings(store: Store): CurrentGlobalSettings {
  const version = store.latestGlobalSettings();
  return { settings: settingsOf(version), version };
}

/** A saved version's settings, with defaults for anything it does not hold. */
export function settingsOf(version: GlobalSettingsVersionRecord | null): GlobalSettings {
  const saved = version !== null && typeof version.settings === "object" && version.settings !== null ? version.settings : {};
  return { ...DEFAULT_GLOBAL_SETTINGS, ...(saved as Partial<GlobalSettings>) };
}

/** The form's field names, one per setting. */
export const FIELDS = {
  ownerDisplayName: "owner_display_name",
  recordsRemote: "records_remote",
  noticeConnector: "notice_connector",
  model: "model",
  modelRunLimit: "model_run_limit",
  pollIntervalSeconds: "poll_interval_seconds",
  boardPort: "board_port",
} as const satisfies Record<keyof GlobalSettings, string>;

export type SettingsErrors = Partial<Record<keyof GlobalSettings, string>>;

export type ParsedSettings = { ok: true; settings: GlobalSettings } | { ok: false; errors: SettingsErrors };

// Control characters would break the one-line attribution and comments the name is posted in.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,99}$/;

/** Reads a submitted global settings form. Every setting must be present and valid; nothing is saved otherwise. */
export function parseSettingsForm(form: URLSearchParams): ParsedSettings {
  const errors: SettingsErrors = {};
  const field = (key: keyof GlobalSettings) => (form.get(FIELDS[key]) ?? "").trim();

  const ownerDisplayName = field("ownerDisplayName");
  if (ownerDisplayName === "") {
    errors.ownerDisplayName = "Enter the name your answers and entail's comments will carry.";
  } else if (CONTROL.test(ownerDisplayName) || ownerDisplayName.length > LIMITS.displayNameLength) {
    errors.ownerDisplayName = `Use one line of at most ${LIMITS.displayNameLength} characters.`;
  }

  const remote = field("recordsRemote");
  const recordsRemote = remote === "" ? null : remote;
  if (recordsRemote !== null) {
    const why = remoteProblem(recordsRemote);
    if (why) errors.recordsRemote = why;
  }

  const connector = field("noticeConnector");
  if (!(NOTICE_CONNECTORS as readonly string[]).includes(connector)) {
    errors.noticeConnector = `Pick one of ${NOTICE_CONNECTORS.join(", ")}.`;
  }

  const model = field("model");
  if (!MODEL.test(model)) errors.model = "Enter a model name such as claude-opus-5-5.";

  const modelRunLimit = integer(field("modelRunLimit"), LIMITS.modelRunLimit, errors, "modelRunLimit");
  const pollIntervalSeconds = integer(field("pollIntervalSeconds"), LIMITS.pollIntervalSeconds, errors, "pollIntervalSeconds");
  const boardPort = integer(field("boardPort"), LIMITS.boardPort, errors, "boardPort");

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    settings: {
      ownerDisplayName,
      recordsRemote,
      noticeConnector: connector as NoticeConnectorName,
      model,
      modelRunLimit,
      pollIntervalSeconds,
      boardPort,
    },
  };
}

function integer(
  text: string,
  range: { min: number; max: number },
  errors: SettingsErrors,
  key: keyof GlobalSettings,
): number {
  const value = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(value) || value < range.min || value > range.max) {
    errors[key] = `Enter a whole number from ${range.min} to ${range.max}.`;
  }
  return value;
}

/** Why a records repo remote cannot be saved, or null when it can. */
function remoteProblem(remote: string): string | null {
  if (remote.length > LIMITS.recordsRemoteLength || /\s/.test(remote) || CONTROL.test(remote)) {
    return "Enter one git remote URL with no spaces.";
  }
  if (remote.startsWith("-")) return "A remote cannot start with a dash.";
  // entail never holds a credential (ADR-0015); the owner's git authenticates the push.
  if (URL.canParse(remote) && new URL(remote).password !== "") {
    return "Leave the password or token out of the URL; entail pushes with your own git credentials.";
  }
  return null;
}
