import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { DEFAULT_GLOBAL_SETTINGS, FIELDS, parseSettingsForm, readGlobalSettings, type GlobalSettings } from "../src/global-settings.ts";
import { startServer, TOKEN_FIELD, type LocalServer } from "../src/server.ts";
import { globalSettingsPage, SETTINGS_PATH } from "../src/settings-page.ts";
import type { RemoteCheck } from "../src/records-remote.ts";
import { RECORDS_PUSH_FILE, type RecordsPushState } from "../src/records-repo.ts";
import { Store } from "../src/store.ts";
import { postForm, send } from "./http-client.ts";

interface Served {
  dir: string;
  store: Store;
  server: LocalServer;
  /** The remotes the page checked as they were set. */
  checked: string[];
}

/**
 * Serves the page over a fresh data directory. Remotes are checked by a stub
 * that cannot check any of them, unless the test says otherwise.
 */
async function serveSettings(
  t: TestContext,
  options: { check?: (remote: string) => RemoteCheck; showPushes?: boolean } = {},
): Promise<Served> {
  const dir = mkdtempSync(join(tmpdir(), "entail-settings-"));
  let tick = 0;
  const store = Store.openIn(dir, { now: () => new Date(Date.UTC(2026, 10, 8, 12, tick++, 0)) });
  const checked: string[] = [];
  const checkRemote = async (remote: string) => {
    checked.push(remote);
    return options.check?.(remote) ?? { kind: "unchecked" as const };
  };
  const server = await startServer({ port: 0, pages: [globalSettingsPage(store, { checkRemote, dataDirectory: options.showPushes ? dir : undefined })] });
  t.after(async () => {
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, server, checked };
}

/** A complete form, as the page's own fields would submit it. */
function formOf(settings: GlobalSettings, token: string): Record<string, string> {
  return {
    [TOKEN_FIELD]: token,
    [FIELDS.ownerDisplayName]: settings.ownerDisplayName ?? "",
    [FIELDS.recordsRemote]: settings.recordsRemote ?? "",
    [FIELDS.noticeConnector]: settings.noticeConnector,
    [FIELDS.model]: settings.model,
    [FIELDS.modelRunLimit]: String(settings.modelRunLimit),
    [FIELDS.pollIntervalSeconds]: String(settings.pollIntervalSeconds),
    [FIELDS.boardPort]: String(settings.boardPort),
  };
}

/** The value of one named input on a page. */
function inputValue(html: string, name: string): string | undefined {
  const tag = html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0];
  return tag?.match(/value="([^"]*)"/)?.[1];
}

test("the global settings page shows every setting with its default before anything is saved", async (t) => {
  const { server } = await serveSettings(t);
  const page = await send(server.info.port, { path: SETTINGS_PATH });
  assert.equal(page.status, 200);
  const html = page.body;

  assert.equal(inputValue(html, FIELDS.ownerDisplayName), "", "the display name has no default");
  assert.match(html, /display name is not set\. Enrolling a repo waits until it is set/);
  assert.equal(inputValue(html, FIELDS.recordsRemote), "");
  assert.match(html, /no remote set/);
  assert.match(html, /<option value="desktop" selected>desktop<\/option>/);
  assert.match(html, /<option value="file">file<\/option>/);
  assert.equal(inputValue(html, FIELDS.model), "claude-opus-5-5");
  assert.equal(inputValue(html, FIELDS.modelRunLimit), "2");
  assert.equal(inputValue(html, FIELDS.pollIntervalSeconds), "60");
  assert.equal(inputValue(html, FIELDS.boardPort), "7419");
  for (const takesEffect of [
    "from the next comment or answer",
    "from the next records push",
    "from the next notice",
    "from the next model run",
    "from the next pass",
    "from the next start",
  ]) {
    assert.ok(html.includes(takesEffect), takesEffect);
  }
  assert.equal(inputValue(html, TOKEN_FIELD), server.info.token, "the form carries the per-start token");
  assert.match(html, /No settings saved yet; the defaults are in force/);
  assert.match(html, /<header class="site">/);
});

test("each save is a new version with its time and the owner's name, and older versions stay readable", async (t) => {
  const { store, server } = await serveSettings(t);
  const { port, token } = server.info;

  const first: GlobalSettings = { ...DEFAULT_GLOBAL_SETTINGS, ownerDisplayName: "Ada Lovelace", noticeConnector: "file" };
  const saved = await postForm(port, SETTINGS_PATH, formOf(first, token));
  assert.equal(saved.status, 303);
  assert.equal(saved.headers.location, `${SETTINGS_PATH}?saved=1`);

  const second: GlobalSettings = {
    ownerDisplayName: "Ada",
    recordsRemote: "git@github.com:ada/entail-records.git",
    noticeConnector: "desktop",
    model: "claude-sonnet-5-5",
    modelRunLimit: 3,
    pollIntervalSeconds: 120,
    boardPort: 7420,
  };
  assert.equal((await postForm(port, SETTINGS_PATH, formOf(second, token))).status, 303);
  // Saving the same values again is still a new version.
  assert.equal((await postForm(port, SETTINGS_PATH, formOf(second, token))).status, 303);

  const history = store.globalSettingsHistory();
  assert.deepEqual(history.map((v) => v.version), [3, 2, 1]);
  assert.deepEqual(history.map((v) => v.savedBy), ["Ada", "Ada", "Ada Lovelace"]);
  assert.ok(history.every((v) => /^\d{4}-\d\d-\d\dT/.test(v.savedAt)));
  assert.deepEqual(store.globalSettingsVersion(1)?.settings, first);
  assert.deepEqual(readGlobalSettings(store).settings, second);

  const page = await send(port, { path: `${SETTINGS_PATH}?saved=3` });
  assert.match(page.body, /Saved as version 3 by Ada\./);
  assert.equal(inputValue(page.body, FIELDS.recordsRemote), "git@github.com:ada/entail-records.git");
  assert.doesNotMatch(page.body, /no remote set\. Records/);
  assert.match(page.body, /<option value="desktop" selected>/);
  assert.match(page.body, /Settings history/);
  assert.match(page.body, /<a href="\/settings\?version=1">Version 1<\/a>/);
  assert.match(page.body, /2026-11-08 12:00 UTC/);

  const old = await send(port, { path: `${SETTINGS_PATH}?version=1` });
  assert.equal(old.status, 200);
  assert.match(old.body, /Global settings, version 1/);
  assert.match(old.body, /by Ada Lovelace; no longer in force/);
  assert.match(old.body, /<dt>Notice connector<\/dt><dd>file<\/dd>/);
  assert.match(old.body, /<dt>Records repo remote<\/dt><dd><span class="muted">no remote set<\/span><\/dd>/);
  assert.equal((await send(port, { path: `${SETTINGS_PATH}?version=9` })).status, 404);
  assert.equal((await send(port, { path: `${SETTINGS_PATH}?version=abc` })).status, 404);
});

test("a save with an invalid setting saves nothing and keeps what was typed", async (t) => {
  const { store, server } = await serveSettings(t);
  const { port, token } = server.info;
  const form = formOf({ ...DEFAULT_GLOBAL_SETTINGS, ownerDisplayName: "Ada" }, token);

  const refused = await postForm(port, SETTINGS_PATH, { ...form, [FIELDS.boardPort]: "80", [FIELDS.model]: "<script>" });
  assert.equal(refused.status, 400);
  assert.match(refused.body, /Nothing was saved/);
  assert.match(refused.body, /from 1024 to 65535/);
  assert.equal(inputValue(refused.body, FIELDS.boardPort), "80");
  assert.equal(inputValue(refused.body, FIELDS.model), "&lt;script&gt;", "what was typed comes back escaped");
  assert.equal(inputValue(refused.body, TOKEN_FIELD), token);

  const unnamed = await postForm(port, SETTINGS_PATH, { ...form, [FIELDS.ownerDisplayName]: "  " });
  assert.equal(unnamed.status, 400, "every save carries the owner's name");
  assert.equal(store.latestGlobalSettings(), null);
});

test("the form is checked setting by setting", () => {
  const valid = formOf({ ...DEFAULT_GLOBAL_SETTINGS, ownerDisplayName: " Ada " }, "t");
  const parsed = parseSettingsForm(new URLSearchParams(valid));
  assert.deepEqual(parsed, { ok: true, settings: { ...DEFAULT_GLOBAL_SETTINGS, ownerDisplayName: "Ada" } });

  const refusedBy = (changes: Record<string, string>) => {
    const result = parseSettingsForm(new URLSearchParams({ ...valid, ...changes }));
    return result.ok ? [] : Object.keys(result.errors);
  };
  assert.deepEqual(refusedBy({ [FIELDS.ownerDisplayName]: "" }), ["ownerDisplayName"]);
  assert.deepEqual(refusedBy({ [FIELDS.ownerDisplayName]: "Ada\nLovelace" }), ["ownerDisplayName"]);
  assert.deepEqual(refusedBy({ [FIELDS.ownerDisplayName]: "a".repeat(101) }), ["ownerDisplayName"]);
  assert.deepEqual(refusedBy({ [FIELDS.recordsRemote]: "https://ada:ghp_secret@github.com/ada/records.git" }), ["recordsRemote"]);
  assert.deepEqual(refusedBy({ [FIELDS.recordsRemote]: "two words" }), ["recordsRemote"]);
  assert.deepEqual(refusedBy({ [FIELDS.recordsRemote]: "--upload-pack=x" }), ["recordsRemote"]);
  assert.deepEqual(refusedBy({ [FIELDS.noticeConnector]: "email" }), ["noticeConnector"]);
  assert.deepEqual(refusedBy({ [FIELDS.model]: "" }), ["model"]);
  assert.deepEqual(refusedBy({ [FIELDS.modelRunLimit]: "0" }), ["modelRunLimit"]);
  assert.deepEqual(refusedBy({ [FIELDS.modelRunLimit]: "1.5" }), ["modelRunLimit"]);
  assert.deepEqual(refusedBy({ [FIELDS.pollIntervalSeconds]: "5" }), ["pollIntervalSeconds"]);
  assert.deepEqual(refusedBy({ [FIELDS.boardPort]: "65536" }), ["boardPort"]);
  assert.deepEqual(refusedBy({ [FIELDS.boardPort]: "" }), ["boardPort"]);

  const remote = parseSettingsForm(new URLSearchParams({ ...valid, [FIELDS.recordsRemote]: "https://github.com/ada/records.git" }));
  assert.ok(remote.ok && remote.settings.recordsRemote === "https://github.com/ada/records.git");
});

test("settings are read afresh from the store each time, so a save is seen at once", async (t) => {
  const { store, server } = await serveSettings(t);
  assert.deepEqual(readGlobalSettings(store), { settings: DEFAULT_GLOBAL_SETTINGS, version: null });
  const form = formOf({ ...DEFAULT_GLOBAL_SETTINGS, ownerDisplayName: "Ada", model: "claude-sonnet-5-5", pollIntervalSeconds: 30 }, server.info.token);
  await postForm(server.info.port, SETTINGS_PATH, form);
  const { settings, version } = readGlobalSettings(store);
  assert.equal(settings.model, "claude-sonnet-5-5");
  assert.equal(settings.pollIntervalSeconds, 30);
  assert.equal(version?.version, 1);
});

test("a saved port is shown as taking effect on the next start", async (t) => {
  const { server } = await serveSettings(t);
  const { port, token } = server.info;
  await postForm(port, SETTINGS_PATH, formOf({ ...DEFAULT_GLOBAL_SETTINGS, ownerDisplayName: "Ada", boardPort: 7500 }, token));
  const page = await send(port, { path: SETTINGS_PATH });
  assert.match(page.body, new RegExp(`listening on port ${port} until its next start, then on port 7500`));
});

const ADA: GlobalSettings = { ...DEFAULT_GLOBAL_SETTINGS, ownerDisplayName: "Ada" };

test("setting a remote entail can verify is public is refused with the reason, and nothing is saved", async (t) => {
  const reason = "github.com/ada/records is public, and your records hold your private notes and model outputs.";
  const { store, server, checked } = await serveSettings(t, { check: () => ({ kind: "public", reason }) });
  const remote = "https://github.com/ada/records.git";
  const refused = await postForm(server.info.port, SETTINGS_PATH, formOf({ ...ADA, recordsRemote: remote }, server.info.token));
  assert.equal(refused.status, 400);
  assert.deepEqual(checked, [remote]);
  assert.match(refused.body, /Nothing was saved/);
  assert.match(refused.body, /github\.com\/ada\/records is public, and your records hold your private notes and model outputs\./);
  assert.equal(inputValue(refused.body, FIELDS.recordsRemote), remote, "the typed remote stays in the field");
  assert.equal(store.latestGlobalSettings(), null);
});

test("a remote entail cannot check, or verifies is not public, is accepted; only a changed remote is checked", async (t) => {
  const { store, server, checked } = await serveSettings(t, {
    check: (remote) => (remote.includes("github") ? { kind: "not-public" } : { kind: "unchecked" }),
  });
  const post = (settings: GlobalSettings) => postForm(server.info.port, SETTINGS_PATH, formOf(settings, server.info.token));
  assert.equal((await post({ ...ADA, recordsRemote: "git@git.example.org:records.git" })).status, 303);
  assert.equal(readGlobalSettings(store).settings.recordsRemote, "git@git.example.org:records.git");
  assert.equal((await post({ ...ADA, recordsRemote: "git@git.example.org:records.git", modelRunLimit: 3 })).status, 303);
  assert.deepEqual(checked, ["git@git.example.org:records.git"], "saving other settings does not check the remote again");
  assert.equal((await post({ ...ADA, recordsRemote: "git@github.com:ada/records.git" })).status, 303);
  assert.equal(readGlobalSettings(store).settings.recordsRemote, "git@github.com:ada/records.git");
  assert.equal((await post(ADA)).status, 303, "clearing the remote");
  assert.equal(checked.length, 2, "no remote, nothing to check");
});

test("a remote on this machine is saved with a note that it does not survive losing the machine", async (t) => {
  const { server } = await serveSettings(t, { check: (remote) => ({ kind: "local", note: remote }) });
  const saved = await postForm(server.info.port, SETTINGS_PATH, formOf({ ...ADA, recordsRemote: "/srv/backups/records.git" }, server.info.token));
  assert.equal(saved.status, 303);
  const page = await send(server.info.port, { path: SETTINGS_PATH });
  assert.match(page.body, /Records repo: This remote is on this machine, so your records do not survive losing it\./);
  assert.doesNotMatch(page.body, /no remote set\. Records/);
});

test("the page shows when the records repo last pushed, and the last failure since", async (t) => {
  const { dir, server, store } = await serveSettings(t, { showPushes: true });
  const shown = async () => (await send(server.info.port, { path: SETTINGS_PATH })).body;
  assert.match(await shown(), /Records repo: no remote set\./);
  assert.match(await shown(), /Records repo: commits stay on this machine\./);

  store.saveGlobalSettings({ ...ADA, recordsRemote: "git@git.example.org:records.git" }, "Ada");
  assert.match(await shown(), /Records repo: no push has succeeded yet\./);

  const state: RecordsPushState = {
    lastSuccess: { at: "2026-11-09T08:00:00.000Z", remote: "git@git.example.org:records.git", commit: "e".repeat(40) },
    lastFailure: { at: "2026-11-09T09:00:00.000Z", remote: "git@git.example.org:records.git", error: "git push failed: Connection refused" },
  };
  writeFileSync(join(dir, RECORDS_PUSH_FILE), JSON.stringify(state));
  const html = await shown();
  assert.match(html, /Records repo: last pushed <time datetime="2026-11-09T08:00:00.000Z">2026-11-09 08:00 UTC<\/time> to <code>git@git\.example\.org:records\.git<\/code>\./);
  assert.match(html, /The last push, <time[^>]*>2026-11-09 09:00 UTC<\/time> to <code>[^<]+<\/code>, failed: git push failed: Connection refused/);
});

test("without the data directory, the page shows no push line", async (t) => {
  const { server } = await serveSettings(t);
  assert.doesNotMatch((await send(server.info.port, { path: SETTINGS_PATH })).body, /id="records-push"/);
});
