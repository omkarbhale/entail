import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { CI_FILE_PATHS } from "../src/ci-files.ts";
import { Mirror } from "../src/mirror.ts";
import { readRepoSettings, REPO_FIELDS, type RepoSettings, VISION_PIN } from "../src/repo-settings.ts";
import { REPO_SETTINGS_PATH } from "../src/repo-settings-page.ts";
import { reposPages } from "../src/repos-page.ts";
import { startServer, TOKEN_FIELD, type LocalServer } from "../src/server.ts";
import type { RepoRecord } from "../src/store.ts";
import { enrollmentSetup, type EnrollmentSetup, FakeForge } from "./enrollment-fixture.ts";
import { postForm, send } from "./http-client.ts";

interface Served extends EnrollmentSetup {
  server: LocalServer;
  enrolled: RepoRecord;
}

/** A repo enrolled through the fixture, served with its settings page. */
async function serveEnrolled(
  t: TestContext,
  options: Parameters<typeof enrollmentSetup>[1] = {},
  duringLookup: () => void = () => {},
): Promise<Served> {
  const setup = enrollmentSetup(t, options);
  const forge = options.forge ?? "github";
  const host = forge === "github" ? "github.com" : "gitlab.example.org";
  const checked = await setup.enroller.check({ forge, host, path: "acme/tally" });
  assert.ok(checked.ok);
  const confirmed = await setup.enroller.confirm(checked.review, {
    visionOrigin: "agent-proposed-owner-approved",
    mergeMethod: forge === "github" ? "squash" : null,
  });
  assert.ok(confirmed.ok);
  const pages = reposPages({ store: setup.store, enroller: setup.enroller, dataDirectory: setup.dataDirectory, createForge: (setting) =>
      new (class extends FakeForge {
        override async actorByUsername(username: string) {
          const actor = await super.actorByUsername(username);
          duringLookup();
          return actor;
        }
      })(setting, setup.world),
  });
  const server = await startServer({ port: 0, pages });
  t.after(() => server.close());
  return { ...setup, server, enrolled: confirmed.repo };
}

function page(served: Served, query = "") {
  return send(served.server.info.port, { path: `${REPO_SETTINGS_PATH}?repo=${served.enrolled.id}${query}` });
}

/** The form exactly as the page fills it, as a browser would submit it unchanged. */
function formFrom(html: string): Record<string, string> {
  const form = html.slice(html.indexOf(`<form method="post" action="${REPO_SETTINGS_PATH}">`), html.indexOf("</form>"));
  const fields: Record<string, string> = {};
  for (const [tag] of form.matchAll(/<input[^>]*>/g)) {
    const name = tag.match(/name="([^"]*)"/)?.[1];
    if (name === undefined) continue;
    const type = tag.match(/type="([^"]*)"/)?.[1];
    if ((type === "radio" || type === "checkbox") && !/ checked/.test(tag)) continue;
    fields[name] = unescape(tag.match(/value="([^"]*)"/)?.[1] ?? "");
  }
  for (const [, name, value] of form.matchAll(/<textarea[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/textarea>/g)) fields[name!] = unescape(value!);
  for (const [, name, options] of form.matchAll(/<select[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/select>/g)) {
    fields[name!] = options!.match(/<option value="([^"]*)" selected>/)?.[1] ?? "";
  }
  return fields;
}

function unescape(text: string): string {
  return text.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

/** Opens the settings page, applies `change` to its form, and posts it. */
async function save(served: Served, change: (form: Record<string, string>) => void) {
  const form = formFrom((await page(served)).body);
  change(form);
  return postForm(served.server.info.port, REPO_SETTINGS_PATH, form);
}

function settingsOf(served: Served): RepoSettings {
  return readRepoSettings(served.store, served.enrolled.id)!.settings;
}

test("the settings page edits every per-repo setting but the forge, the origin and the pause", async (t) => {
  const served = await serveEnrolled(t);
  const shown = await page(served);
  assert.equal(shown.status, 200);
  const form = formFrom(shown.body);
  assert.equal(form[TOKEN_FIELD], served.server.info.token);
  assert.equal(form[REPO_FIELDS.basedOn], "1");
  assert.equal(form[REPO_FIELDS.mergeMethod], "squash");
  assert.equal(form[REPO_FIELDS.shadow], undefined, "shadow is off");
  assert.equal(form[REPO_FIELDS.whoCounts], "anyone");
  assert.equal(form[REPO_FIELDS.executors], "");
  assert.equal(form[REPO_FIELDS.criteriaCount], "1", "one blank row to add a generic criterion");
  assert.equal(form[REPO_FIELDS.pinCount], "1", "one blank row to add a pin");
  assert.match(shown.body, /<dt>Forge<\/dt><dd>GitHub<\/dd>/);
  assert.match(shown.body, /<dt>Origin of the existing VISION\.md<\/dt><dd>Proposed by an agent and approved by the owner<\/dd>/);
  assert.equal(form.forge, undefined, "the forge is not a form field");
  assert.equal(form.vision_origin, undefined, "nor the origin");
  assert.match(shown.body, /data-pin="vision"[\s\S]*cannot be removed/);
  assert.match(shown.body, /In force: version 1, saved .* by Ada\./);
});

test("on GitLab there is no merge method to set", async (t) => {
  const served = await serveEnrolled(t, { forge: "gitlab" });
  const shown = await page(served);
  assert.doesNotMatch(shown.body, /name="merge_method"/);
  assert.match(shown.body, /GitLab's own merge method and squash setting for the project apply/);
  const saved = await save(served, (form) => (form[REPO_FIELDS.shadow] = "on"));
  assert.equal(saved.status, 303);
  assert.equal(settingsOf(served).mergeMethod, null);
  assert.equal(settingsOf(served).shadow, true);
});

test("a save makes a new version with its time and the owner's name, listed in the history, and changes no past version", async (t) => {
  const served = await serveEnrolled(t);
  const first = served.store.latestSettings(served.enrolled.id)!;
  const saved = await save(served, (form) => {
    form[REPO_FIELDS.mergeMethod] = "rebase";
    form[REPO_FIELDS.shadow] = "on";
    form[REPO_FIELDS.criterion(0, "sentence")] = "The test suite passes.";
    form[REPO_FIELDS.criterion(0, "kind")] = "check_passes";
    form[REPO_FIELDS.criterion(0, "argument")] = "test";
    form[REPO_FIELDS.pin(0, "topic")] = "Anything about pricing.";
    form[REPO_FIELDS.pin(0, "paths")] = "src/pricing/**\nbilling.md";
    form[REPO_FIELDS.pin(0, "keywords")] = "price\nplan";
  });
  assert.equal(saved.status, 303);
  assert.equal(saved.headers.location, `${REPO_SETTINGS_PATH}?repo=${served.enrolled.id}&saved=2`);

  const history = served.store.settingsHistory(served.enrolled.id);
  assert.deepEqual(history.map((v) => [v.version, v.savedBy]), [[2, "Ada"], [1, "Ada"]]);
  assert.deepEqual(served.store.settingsVersion(served.enrolled.id, 1), first, "the first version is unchanged");
  const settings = settingsOf(served);
  assert.equal(settings.mergeMethod, "rebase");
  assert.equal(settings.shadow, true);
  assert.deepEqual(settings.genericCriteria, [
    { id: "G1", sentence: "The test suite passes.", check: { kind: "check_passes", argument: "test" }, source: null },
  ]);
  assert.deepEqual(settings.pins, [{ topic: "Anything about pricing.", paths: ["src/pricing/**", "billing.md"], keywords: ["price", "plan"] }]);
  assert.equal(settings.visionOrigin, "agent-proposed-owner-approved", "the origin is kept");
  assert.equal(settings.paused, false, "the pause is kept");

  const shown = await page(served, "&saved=2");
  assert.match(shown.body, /Saved as version 2 by Ada\. It takes effect from the next pass\./);
  assert.match(shown.body, /Version 2<\/a> \(in force\)<\/td>\n<td><time datetime="[^"]+">[^<]+<\/time><\/td>\n<td>Ada<\/td>\n<td>generic criteria, merge method, shadow on, 1 pin added<\/td>/);
  assert.match(shown.body, /Version 1<\/a><\/td>\n<td><time[^>]*>[^<]+<\/time><\/td>\n<td>Ada<\/td>\n<td>enrolled<\/td>/);
  const old = await page(served, "&version=1");
  assert.equal(old.status, 200);
  assert.match(old.body, /no longer in force/);
  assert.match(old.body, /<dt>Shadow<\/dt><dd>off<\/dd>/);
  assert.equal((await page(served, "&version=9")).status, 404);
});

test("a save is not a call and leaves every past call on the version it used", async (t) => {
  const served = await serveEnrolled(t);
  const ticket = served.store.takeIn({ repoId: served.enrolled.id, issueNumber: 7 });
  const v1 = served.store.latestSettings(served.enrolled.id)!;
  const call = served.store.recordCall({ ticketId: ticket.id, kind: "verdict", reason: "settled", inputs: { settingsVersionId: v1.id } });
  assert.equal((await save(served, (form) => (form[REPO_FIELDS.shadow] = "on"))).status, 303);
  assert.deepEqual(served.store.callsForTicket(ticket.id), [call]);
  assert.equal(served.store.getTicket(ticket.id)!.state, ticket.state);
});

test("settings are read again on every read, so a save takes effect from the next pass", async (t) => {
  const served = await serveEnrolled(t);
  const before = readRepoSettings(served.store, served.enrolled.id)!;
  await save(served, (form) => (form[REPO_FIELDS.shadow] = "on"));
  const after = readRepoSettings(served.store, served.enrolled.id)!;
  assert.equal(before.settings.shadow, false);
  assert.equal(after.settings.shadow, true);
  assert.equal(after.version.version, before.version.version + 1);
});

test("submitting the form unchanged saves no new version", async (t) => {
  const served = await serveEnrolled(t);
  const saved = await save(served, () => {});
  assert.equal(saved.status, 303);
  assert.match(saved.headers.location as string, /unchanged=1/);
  assert.equal(served.store.settingsHistory(served.enrolled.id).length, 1);
  assert.match((await page(served, "&unchanged=1")).body, /Nothing changed, so no new version was saved\./);
});

test("executor usernames are resolved to numeric ids on save", async (t) => {
  const served = await serveEnrolled(t);
  const saved = await save(served, (form) => {
    form[REPO_FIELDS.whoCounts] = "owner-and-listed";
    form[REPO_FIELDS.executors] = "executor\n@second-executor, Executor";
  });
  assert.equal(saved.status, 303);
  const settings = settingsOf(served);
  assert.equal(settings.whoCounts, "owner-and-listed");
  assert.deepEqual(settings.executors, [
    { forge: "github", host: "github.com", id: 1003, username: "executor" },
    { forge: "github", host: "github.com", id: 1004, username: "second-executor" },
  ]);
  const shown = formFrom((await page(served)).body);
  assert.equal(shown[REPO_FIELDS.executors], "executor\nsecond-executor");
});

test("an unknown executor username refuses the whole save", async (t) => {
  const served = await serveEnrolled(t);
  const refused = await save(served, (form) => {
    form[REPO_FIELDS.whoCounts] = "owner-and-listed";
    form[REPO_FIELDS.executors] = "executor\nnobody-here";
    form[REPO_FIELDS.shadow] = "on";
  });
  assert.equal(refused.status, 422);
  assert.match(refused.body, /Nothing was saved/);
  assert.match(refused.body, /github\.com has no account named nobody-here, so nothing was saved\./);
  assert.match(refused.body, /executor\nnobody-here<\/textarea>/, "what was typed is kept");
  assert.equal(served.store.settingsHistory(served.enrolled.id).length, 1);
  assert.equal(settingsOf(served).shadow, false);
});

test("a username the forge cannot look up right now refuses the save rather than dropping it", async (t) => {
  const served = await serveEnrolled(t);
  served.world.users = new Error("the CLI for github.com is not logged in");
  const refused = await save(served, (form) => (form[REPO_FIELDS.executors] = "executor"));
  assert.equal(refused.status, 422);
  assert.match(refused.body, /entail could not look up executor on github\.com, so nothing was saved: the CLI for github\.com is not logged in/);
  assert.equal(served.store.settingsHistory(served.enrolled.id).length, 1);
});

test("a listed executor keeps its account id without a new lookup, so a renamed account still counts", async (t) => {
  const served = await serveEnrolled(t);
  await save(served, (form) => {
    form[REPO_FIELDS.whoCounts] = "owner-and-listed";
    form[REPO_FIELDS.executors] = "executor";
  });
  // The account is renamed; its old name no longer resolves.
  served.world.users = { "executor-renamed": 1003 };
  const saved = await save(served, (form) => (form[REPO_FIELDS.shadow] = "on"));
  assert.equal(saved.status, 303);
  assert.deepEqual(settingsOf(served).executors, [{ forge: "github", host: "github.com", id: 1003, username: "executor" }]);
});

test("the VISION.md pin is always present and cannot be removed or taken by another pin", async (t) => {
  const served = await serveEnrolled(t);
  await save(served, (form) => (form[REPO_FIELDS.pin(0, "topic")] = "Pricing."));
  const withPin = await page(served);
  assert.match(withPin.body, /data-pin="vision"/);
  assert.doesNotMatch(withPin.body.slice(withPin.body.indexOf('data-pin="vision"'), withPin.body.indexOf('data-pin="0"')), /name="[^"]*remove"/, "the built-in pin has no remove box");
  assert.equal((await save(served, (form) => (form[REPO_FIELDS.pin(0, "remove")] = "on"))).status, 303);
  assert.deepEqual(settingsOf(served).pins, []);
  assert.match((await page(served)).body, /data-pin="vision"/, "VISION.md is still pinned");
  assert.match((await page(served, "&version=3")).body, new RegExp(`<li>${VISION_PIN.topic.replace("'", "&#39;").replace(".", "\\.")} <span class="muted">\\(built in\\)`));

  const refused = await save(served, (form) => (form[REPO_FIELDS.pin(0, "topic")] = VISION_PIN.topic.toUpperCase()));
  assert.equal(refused.status, 400);
  assert.match(refused.body, /VISION\.md is always pinned; give this pin another topic\./);
});

test("generic criteria and pins are checked, and nothing is saved when one is wrong", async (t) => {
  const served = await serveEnrolled(t);
  const cases: [string, (form: Record<string, string>) => void, RegExp][] = [
    ["no check", (f) => (f[REPO_FIELDS.criterion(0, "sentence")] = "Lint passes."), /Name the check that must pass\./],
    ["no sentence", (f) => (f[REPO_FIELDS.criterion(0, "argument")] = "lint"), /Write the criterion as one sentence\./],
    [
      "a command",
      (f) => {
        f[REPO_FIELDS.criterion(0, "sentence")] = "/entail lint passes";
        f[REPO_FIELDS.criterion(0, "argument")] = "lint";
      },
      /A criterion cannot start with \/\./,
    ],
    [
      "an unknown kind",
      (f) => {
        f[REPO_FIELDS.criterion(0, "sentence")] = "Signed off.";
        f[REPO_FIELDS.criterion(0, "kind")] = "reviewer_approves";
        f[REPO_FIELDS.criterion(0, "argument")] = "owner";
      },
      /Pick the kind of mechanical check\./,
    ],
    [
      "a path outside the repo",
      (f) => {
        f[REPO_FIELDS.criterion(0, "sentence")] = "Docs stay.";
        f[REPO_FIELDS.criterion(0, "kind")] = "leaves_path";
        f[REPO_FIELDS.criterion(0, "argument")] = "../docs/**";
      },
      /leaves the repo/,
    ],
    ["an absolute pin path", (f) => Object.assign(f, { [REPO_FIELDS.pin(0, "topic")]: "Pricing.", [REPO_FIELDS.pin(0, "paths")]: "/etc/x" }), /relative to the repo&#39;s root/],
    ["a pin with paths and no topic", (f) => (f[REPO_FIELDS.pin(0, "paths")] = "src/**"), /Write the pin&#39;s topic as one sentence\./],
    ["no merge method", (f) => delete f[REPO_FIELDS.mergeMethod], /Pick the merge method\./],
    ["no who counts", (f) => delete f[REPO_FIELDS.whoCounts], /Pick who counts as an executor\./],
    ["not a username", (f) => (f[REPO_FIELDS.executors] = "exe<cutor"), /These are not usernames: exe&lt;cutor\./],
  ];
  for (const [what, change, message] of cases) {
    const refused = await save(served, change);
    assert.equal(refused.status, 400, what);
    assert.match(refused.body, /Nothing was saved\. Fix the fields marked below\./, what);
    assert.match(refused.body, message, what);
  }
  assert.equal(served.store.settingsHistory(served.enrolled.id).length, 1);
});

test("two pins cannot share a topic, and a removed criterion renumbers the rest", async (t) => {
  const served = await serveEnrolled(t);
  await save(served, (f) => {
    Object.assign(f, {
      [REPO_FIELDS.criterion(0, "sentence")]: "Tests pass.",
      [REPO_FIELDS.criterion(0, "argument")]: "test",
    });
  });
  await save(served, (f) => {
    Object.assign(f, {
      [REPO_FIELDS.criterion(1, "sentence")]: "Lint passes.",
      [REPO_FIELDS.criterion(1, "argument")]: "lint",
    });
  });
  assert.deepEqual(settingsOf(served).genericCriteria.map((g) => [g.id, g.check.argument]), [["G1", "test"], ["G2", "lint"]]);
  await save(served, (f) => (f[REPO_FIELDS.criterion(0, "remove")] = "on"));
  assert.deepEqual(settingsOf(served).genericCriteria.map((g) => [g.id, g.check.argument]), [["G1", "lint"]]);

  await save(served, (f) => (f[REPO_FIELDS.pin(0, "topic")] = "Pricing."));
  const refused = await save(served, (f) => (f[REPO_FIELDS.pin(1, "topic")] = "pricing."));
  assert.equal(refused.status, 400);
  assert.match(refused.body, /Another pin has this topic/);
});

test("a save from a page opened before another save is refused, keeping what was typed", async (t) => {
  const served = await serveEnrolled(t);
  const stale = formFrom((await page(served)).body);
  await save(served, (form) => (form[REPO_FIELDS.shadow] = "on"));
  stale[REPO_FIELDS.mergeMethod] = "merge";
  const refused = await postForm(served.server.info.port, REPO_SETTINGS_PATH, stale);
  assert.equal(refused.status, 409);
  assert.match(refused.body, /saved again \(version 2\) since you opened this page, so nothing was saved/);
  const again = formFrom(refused.body);
  assert.equal(again[REPO_FIELDS.mergeMethod], "merge", "the typed change is kept");
  assert.equal(again[REPO_FIELDS.basedOn], "2", "saving again is based on the version in force");
  assert.equal(served.store.settingsHistory(served.enrolled.id).length, 2);
  assert.equal((await postForm(served.server.info.port, REPO_SETTINGS_PATH, again)).status, 303);
  assert.equal(settingsOf(served).mergeMethod, "merge");
});

test("a save that lands while executors are being looked up is not overwritten", async (t) => {
  let served: Served | undefined;
  let landed = false;
  served = await serveEnrolled(t, {}, () => {
    if (landed || served === undefined) return;
    landed = true;
    const current = readRepoSettings(served.store, served.enrolled.id)!;
    served.store.saveSettings(served.enrolled.id, { ...current.settings, paused: true }, "Omkar");
  });
  const form = formFrom((await page(served)).body);
  form[REPO_FIELDS.executors] = "executor";
  const refused = await postForm(served.server.info.port, REPO_SETTINGS_PATH, form);
  assert.equal(refused.status, 409);
  assert.match(refused.body, /saved again \(version 2\)/);
  assert.equal(settingsOf(served).paused, true, "the other write survives");
  assert.deepEqual(settingsOf(served).executors, []);
  assert.equal(served.store.settingsHistory(served.enrolled.id).length, 2);
});

test("the settings form needs the per-start token, and an unknown repo is not found", async (t) => {
  const served = await serveEnrolled(t);
  const form = formFrom((await page(served)).body);
  delete form[TOKEN_FIELD];
  form[REPO_FIELDS.shadow] = "on";
  assert.equal((await postForm(served.server.info.port, REPO_SETTINGS_PATH, form)).status, 403);
  const ok = formFrom((await page(served)).body);
  assert.equal((await postForm(served.server.info.port, REPO_SETTINGS_PATH, { ...ok, [REPO_FIELDS.repo]: "99" })).status, 404);
  assert.equal((await send(served.server.info.port, { path: `${REPO_SETTINGS_PATH}?repo=99` })).status, 404);
  assert.equal(served.store.settingsHistory(served.enrolled.id).length, 1);
});

test("a change to the CI files after the generic criteria were confirmed shows a passive hint only", async (t) => {
  const served = await serveEnrolled(t);
  const mirror = await Mirror.open({
    dataDirectory: served.dataDirectory,
    key: { forge: "github", host: "github.com", projectId: served.enrolled.projectId },
    remote: { url: served.repo.remote, credentialHelper: null },
  });
  const fetch = async () => {
    served.repo.push();
    await mirror.updateDefaultBranch();
  };
  assert.doesNotMatch((await page(served)).body, /data-hint="ci-files-changed"/);

  served.repo.write("README.md", "tally, counted\n").commit("docs");
  await fetch();
  assert.doesNotMatch((await page(served)).body, /data-hint="ci-files-changed"/, "a change elsewhere is no hint");

  served.repo.write(".github/workflows/ci.yml", "on: push\njobs: {}\n").commit("add CI");
  await fetch();
  const hinted = await page(served);
  assert.match(hinted.body, /data-hint="ci-files-changed"[\s\S]*<code>\.github\/workflows\/ci\.yml<\/code>/);
  assert.equal(served.store.settingsHistory(served.enrolled.id).length, 1, "the hint saves nothing");
  assert.equal(served.store.openBoardItem(1), null, "and raises no board item");

  // Confirming them again clears it.
  const saved = await save(served, (form) => (form[REPO_FIELDS.reconfirm] = "on"));
  assert.equal(saved.status, 303);
  assert.equal(settingsOf(served).genericCriteriaConfirmedAt, served.repo.head());
  assert.doesNotMatch((await page(served)).body, /data-hint="ci-files-changed"/);
  assert.match((await page(served)).body, /<td>generic criteria confirmed again<\/td>/);

  // Editing the generic criteria confirms them at the head too.
  served.repo.write(".gitlab-ci.yml", "test:\n  script: npm test\n").commit("GitLab CI");
  await fetch();
  assert.match((await page(served)).body, /<code>\.gitlab-ci\.yml<\/code>/);
  await save(served, (form) => Object.assign(form, { [REPO_FIELDS.criterion(0, "sentence")]: "Tests pass.", [REPO_FIELDS.criterion(0, "argument")]: "test" }));
  assert.doesNotMatch((await page(served)).body, /data-hint="ci-files-changed"/);
  assert.ok(CI_FILE_PATHS.includes(".gitlab-ci.yml"));
});
