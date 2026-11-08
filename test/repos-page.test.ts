import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Mirror } from "../src/mirror.ts";
import { enrollmentSettings } from "../src/repo-settings.ts";
import {
  CHECK_PATH,
  criterionField,
  ENROLL_ACTIONS,
  ENROLL_FIELDS,
  ENROLL_PATH,
  FRESH_START_PATH,
  FRESH_START_REPO_FIELD,
  REPO_SETTINGS_PATH,
  REPOS_PATH,
  repoState,
  reposPages,
  REVIEW_TTL_MS,
  type RepoActivity,
} from "../src/repos-page.ts";
import { startServer, TOKEN_FIELD, type LocalServer } from "../src/server.ts";
import { globalSettingsPage } from "../src/settings-page.ts";
import { enrollmentSetup, type EnrollmentSetup } from "./enrollment-fixture.ts";
import { postForm, send } from "./http-client.ts";
import { hiddenMarker } from "../src/comment-rules.ts";
import { RecordsCheck } from "../src/records-check.ts";
import { actor, IntakeForge, issueComment } from "./pass-fixture.ts";

interface Served extends EnrollmentSetup {
  recordsCheck?: RecordsCheck;
  server: LocalServer;
  /** Moves the page's clock on. */
  advance(ms: number): void;
}

async function serveRepos(
  t: TestContext,
  options: Parameters<typeof enrollmentSetup>[1] & { activity?: RepoActivity; recordsForge?: IntakeForge } = {},
): Promise<Served> {
  const setup = enrollmentSetup(t, options);
  const recordsForge = options.recordsForge;
  const recordsCheck = recordsForge ? new RecordsCheck({ store: setup.store, forgeFor: () => recordsForge }) : undefined;
  let offset = 0;
  const pages = [
    ...reposPages({
      store: setup.store,
      enroller: setup.enroller,
      dataDirectory: setup.dataDirectory,
      activity: options.activity,
      now: () => new Date(Date.now() + offset),
      recordsCheck,
    }),
    globalSettingsPage(setup.store),
  ];
  const server = await startServer({ port: 0, pages });
  t.after(() => server.close());
  return { ...setup, server, recordsCheck, advance: (ms) => (offset += ms) };
}

function check(served: Served, stated: Record<string, string>) {
  return postForm(served.server.info.port, CHECK_PATH, { [TOKEN_FIELD]: served.server.info.token, ...stated });
}

const GITHUB = { [ENROLL_FIELDS.forge]: "github", [ENROLL_FIELDS.host]: "github.com", [ENROLL_FIELDS.path]: "acme/tally" };
const GITLAB = { [ENROLL_FIELDS.forge]: "gitlab", [ENROLL_FIELDS.host]: "gitlab.example.org", [ENROLL_FIELDS.path]: "acme/tally" };

function inputValue(html: string, name: string): string | undefined {
  const tag = html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0];
  return tag?.match(/value="([^"]*)"/)?.[1];
}

/** The value of the checked radio button in a group, if one is checked. */
function checked(html: string, name: string): string | undefined {
  const tag = html.match(new RegExp(`<input type="radio" name="${name}" value="[^"]*" checked[^>]*>`))?.[0];
  return tag?.match(/value="([^"]*)"/)?.[1];
}

function radios(html: string, name: string): string[] {
  return [...html.matchAll(new RegExp(`<input type="radio" name="${name}" value="([^"]*)"`, "g"))].map((m) => m[1]!);
}

test("the Repos page lists nothing at first and offers the enrollment form", async (t) => {
  const served = await serveRepos(t);
  const page = await send(served.server.info.port, { path: REPOS_PATH });
  assert.equal(page.status, 200);
  assert.match(page.body, /No repo is enrolled yet/);
  assert.match(page.body, new RegExp(`<form method="post" action="${CHECK_PATH}">`));
  assert.equal(inputValue(page.body, TOKEN_FIELD), served.server.info.token);
  assert.match(page.body, /<option value="github"[^>]*>github<\/option>/);
  assert.match(page.body, /<option value="gitlab">gitlab<\/option>/);
  assert.match(page.body, /href="\/settings">Global settings<\/a>/, "links to the global settings");
  assert.match(page.body, /<a href="\/repos" aria-current="page">Repos<\/a>/);
});

test("enrolling is unavailable on the page until the display name is set", async (t) => {
  const served = await serveRepos(t, { displayName: null });
  const page = await send(served.server.info.port, { path: REPOS_PATH });
  assert.doesNotMatch(page.body, new RegExp(`action="${CHECK_PATH}"`), "no enrollment form");
  assert.match(page.body, /Enrolling waits until your display name is set/);
  assert.match(page.body, /<a href="\/settings">Set it in the global settings<\/a>/);

  const posted = await check(served, GITHUB);
  assert.equal(posted.status, 422);
  assert.match(posted.body, /Nothing was enrolled/);
  assert.match(posted.body, /data-reason="no-display-name"/);
  assert.deepEqual(served.created, [], "the forge is not asked");
});

test("checking a repo shows the review screen with the preselected origin, merge method and the defaults", async (t) => {
  const served = await serveRepos(t);
  served.world.mergeMethods = ["merge", "rebase"];
  const review = await check(served, GITHUB);
  assert.equal(review.status, 200);
  const html = review.body;
  assert.match(html, /Review and enroll acme\/tally/);
  assert.match(html, /<dt>Project id<\/dt><dd>5001<\/dd>/);
  assert.match(html, /owner <span class="muted">\(account 1001\)<\/span>/);
  assert.match(html, new RegExp(`at <code>${served.repo.head().slice(0, 12)}</code>`));
  assert.deepEqual(radios(html, ENROLL_FIELDS.visionOrigin), ["owner-stated", "agent-proposed-owner-approved", "automatic-owner-notified"]);
  assert.equal(checked(html, ENROLL_FIELDS.visionOrigin), "agent-proposed-owner-approved");
  assert.match(html, /Proposed by an agent and approved by the owner/);
  assert.match(html, /each of its 2 vision lines/);
  assert.deepEqual(radios(html, ENROLL_FIELDS.mergeMethod), ["merge", "rebase"], "only the allowed methods");
  assert.equal(checked(html, ENROLL_FIELDS.mergeMethod), "merge", "squash is not allowed, so merge commit");
  assert.match(html, /<li>Shadow: off<\/li>/);
  assert.match(html, /<li>Who counts as an executor: anyone<\/li>/);
  assert.match(html, /<li>Pins: VISION\.md only, which is always pinned<\/li>/);
  assert.match(html, /Generic criteria<\/h2>\n<p class="hint">Proposed from the repo's CI files and build scripts\./);
  assert.match(html, /Issues already open are not taken in/);
  assert.equal(inputValue(html, TOKEN_FIELD), served.server.info.token);
  assert.ok(inputValue(html, ENROLL_FIELDS.review), "the review is held for the confirmation");
  assert.deepEqual(served.store.listRepos(), [], "nothing is enrolled by checking");
});

test("when GitHub does not say which merge methods are allowed, all are offered with squash preselected", async (t) => {
  const served = await serveRepos(t);
  served.world.mergeMethods = [];
  const html = (await check(served, GITHUB)).body;
  assert.deepEqual(radios(html, ENROLL_FIELDS.mergeMethod), ["squash", "merge", "rebase"]);
  assert.equal(checked(html, ENROLL_FIELDS.mergeMethod), "squash");
  assert.match(html, /GitHub did not say/);
});

test("a GitLab review has no merge method to pick", async (t) => {
  const served = await serveRepos(t, { forge: "gitlab" });
  const html = (await check(served, GITLAB)).body;
  assert.deepEqual(radios(html, ENROLL_FIELDS.mergeMethod), []);
  assert.match(html, /GitLab's own merge method and squash setting for the project apply/);
});

test("confirming the review enrolls the repo and lists it with its forge, state and settings link", async (t) => {
  const served = await serveRepos(t);
  const { port, token } = served.server.info;
  const html = (await check(served, GITHUB)).body;
  const confirmed = await postForm(port, ENROLL_PATH, {
    [TOKEN_FIELD]: token,
    [ENROLL_FIELDS.review]: inputValue(html, ENROLL_FIELDS.review)!,
    [ENROLL_FIELDS.visionOrigin]: "owner-stated",
    [ENROLL_FIELDS.mergeMethod]: "rebase",
  });
  assert.equal(confirmed.status, 303);
  const [repo] = served.store.listRepos();
  assert.ok(repo);
  assert.equal(confirmed.headers.location, `${REPOS_PATH}?enrolled=${repo.id}`);
  const settings = served.store.latestSettings(repo.id)?.settings as { mergeMethod: string; visionOrigin: string };
  assert.equal(settings.mergeMethod, "rebase");
  assert.equal(settings.visionOrigin, "owner-stated");

  const list = await send(port, { path: confirmed.headers.location as string });
  assert.match(list.body, /Enrolled acme\/tally on github\.com/);
  assert.match(list.body, /<td>acme\/tally<br><span class="muted">github\.com<\/span><\/td>\n<td>GitHub<\/td>/);
  assert.match(list.body, /data-state="active">active</);
  assert.match(list.body, /not yet polled/);
  assert.match(list.body, new RegExp(`<a href="${REPO_SETTINGS_PATH.replace("/", "\\/")}\\?repo=${repo.id}">Settings</a>`));

  // The review was used up.
  const again = await postForm(port, ENROLL_PATH, {
    [TOKEN_FIELD]: token,
    [ENROLL_FIELDS.review]: inputValue(html, ENROLL_FIELDS.review)!,
    [ENROLL_FIELDS.visionOrigin]: "owner-stated",
    [ENROLL_FIELDS.mergeMethod]: "rebase",
  });
  assert.equal(again.status, 410);
  assert.equal(served.store.listRepos().length, 1);
});

test("the repo's settings link shows what was enrolled", async (t) => {
  const served = await serveRepos(t);
  const result = await served.enroller.check({ forge: "github", host: "github.com", path: "acme/tally" });
  assert.ok(result.ok);
  const confirmed = await served.enroller.confirm(result.review, { visionOrigin: "agent-proposed-owner-approved", mergeMethod: "squash" });
  assert.ok(confirmed.ok);
  const page = await send(served.server.info.port, { path: `${REPO_SETTINGS_PATH}?repo=${confirmed.repo.id}` });
  assert.equal(page.status, 200);
  assert.match(page.body, /In force: version 1, saved .* by Ada\./);
  assert.match(page.body, /<dt>Project id<\/dt><dd>5001<\/dd>/);
  assert.match(page.body, /<dt>Origin of the existing VISION\.md<\/dt><dd>Proposed by an agent and approved by the owner<\/dd>/);
  assert.equal(checked(page.body, "merge_method"), "squash");
  assert.match(page.body, /<input type="checkbox" name="shadow" value="on">/, "shadow is off");
  assert.equal(checked(page.body, "who_counts"), "anyone");
  assert.match(page.body, /data-pin="vision"/, "VISION.md is pinned");
  assert.doesNotMatch(page.body, /data-pin="0"[\s\S]*name="p0_remove"/, "and no other pin is");
  assert.equal((await send(served.server.info.port, { path: `${REPO_SETTINGS_PATH}?repo=99` })).status, 404);
  assert.equal((await send(served.server.info.port, { path: `${REPO_SETTINGS_PATH}?repo=x` })).status, 404);
});

test("a refused repo shows every reason, keeps what was typed and enrolls nothing", async (t) => {
  const served = await serveRepos(t, { forge: "gitlab" });
  served.world.instance = { version: "15.0.0", unsupported: "GitLab 15.0.0 is older than 15.6, the oldest version entail serves" };
  served.world.access = { cannotLabelAndComment: "the logged-in account has Guest access only", mayLackMerge: null };
  const refused = await check(served, GITLAB);
  assert.equal(refused.status, 422);
  assert.match(refused.body, /Nothing was enrolled/);
  assert.match(refused.body, /data-reason="gitlab-too-old"/);
  assert.match(refused.body, /data-reason="cannot-label-and-comment"/);
  assert.equal(inputValue(refused.body, ENROLL_FIELDS.path), "acme/tally");
  assert.match(refused.body, /<option value="gitlab" selected>gitlab<\/option>/);
  assert.deepEqual(served.store.listRepos(), []);
});

test("an empty VISION.md is refused on the page with a pointer to /vision", async (t) => {
  const served = await serveRepos(t, { vision: "" });
  const refused = await check(served, GITHUB);
  assert.equal(refused.status, 422);
  assert.match(refused.body, /Nothing was enrolled/);
  assert.match(refused.body, /data-reason="empty-vision"/);
  assert.match(refused.body, /Write one with \/vision/);
  assert.equal(inputValue(refused.body, ENROLL_FIELDS.path), "acme/tally");
  assert.deepEqual(served.store.listRepos(), []);
});

test("a possible lack of merge permission is warned on the review screen", async (t) => {
  const served = await serveRepos(t);
  served.world.access = { cannotLabelAndComment: null, mayLackMerge: "the logged-in account has no push access, which merging needs" };
  const review = await check(served, GITHUB);
  assert.equal(review.status, 200);
  assert.match(review.body, /<p class="notice" role="status">owner may lack permission to merge/);
});

test("a confirmation without a valid origin or merge method shows the review again and enrolls nothing", async (t) => {
  const served = await serveRepos(t);
  const { port, token } = served.server.info;
  served.world.mergeMethods = ["squash"];
  const id = inputValue((await check(served, GITHUB)).body, ENROLL_FIELDS.review)!;
  const bad = await postForm(port, ENROLL_PATH, {
    [TOKEN_FIELD]: token,
    [ENROLL_FIELDS.review]: id,
    [ENROLL_FIELDS.visionOrigin]: "made-up",
    [ENROLL_FIELDS.mergeMethod]: "rebase",
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body, /Pick the origin of the existing VISION\.md/);
  assert.match(bad.body, /Pick the merge method/, "rebase is not allowed on this repo");
  assert.deepEqual(served.store.listRepos(), []);
  const good = await postForm(port, ENROLL_PATH, {
    [TOKEN_FIELD]: token,
    [ENROLL_FIELDS.review]: id,
    [ENROLL_FIELDS.visionOrigin]: "owner-stated",
    [ENROLL_FIELDS.mergeMethod]: "squash",
  });
  assert.equal(good.status, 303, "the review is still open after a refused confirmation");
});

test("a review left too long expires", async (t) => {
  const served = await serveRepos(t);
  const id = inputValue((await check(served, GITHUB)).body, ENROLL_FIELDS.review)!;
  served.advance(REVIEW_TTL_MS + 1);
  const late = await postForm(served.server.info.port, ENROLL_PATH, {
    [TOKEN_FIELD]: served.server.info.token,
    [ENROLL_FIELDS.review]: id,
    [ENROLL_FIELDS.visionOrigin]: "owner-stated",
    [ENROLL_FIELDS.mergeMethod]: "squash",
  });
  assert.equal(late.status, 410);
  assert.match(late.body, /no longer open/);
  assert.deepEqual(served.store.listRepos(), []);
});

test("the enrollment forms need the per-start token", async (t) => {
  const served = await serveRepos(t);
  const posted = await postForm(served.server.info.port, CHECK_PATH, GITHUB);
  assert.equal(posted.status, 403);
  assert.deepEqual(served.created, []);
});

test("each repo shows its state: active, pausing, paused or no vision", async (t) => {
  const pausing = new Set<number>();
  const served = await serveRepos(t, {
    activity: { pausing: (repo) => pausing.has(repo.id), lastSuccessfulPoll: (repo) => (repo.id === 1 ? "2026-11-08T12:34:00.000Z" : null) },
  });
  const result = await served.enroller.check({ forge: "github", host: "github.com", path: "acme/tally" });
  assert.ok(result.ok);
  const confirmed = await served.enroller.confirm(result.review, { visionOrigin: "owner-stated", mergeMethod: "squash" });
  assert.ok(confirmed.ok);
  const repoId = confirmed.repo.id;
  const stateOf = async () => {
    const html = (await send(served.server.info.port, { path: REPOS_PATH })).body;
    return html.match(/data-state="([^"]*)"/)?.[1];
  };
  assert.equal(await stateOf(), "active");
  assert.match((await send(served.server.info.port, { path: REPOS_PATH })).body, /2026-11-08 12:34 UTC/, "the last successful poll");

  // The vision vanishes from the default branch, and the mirror fetches it.
  served.repo.remove("VISION.md").commit("drop the vision");
  served.repo.push();
  const mirror = await Mirror.open({
    dataDirectory: served.dataDirectory,
    key: { forge: "github", host: "github.com", projectId: confirmed.repo.projectId },
    remote: { url: served.repo.remote, credentialHelper: null },
  });
  await mirror.updateDefaultBranch();
  assert.equal(await stateOf(), "no vision");

  served.store.saveSettings(repoId, { ...enrollmentSettings("owner-stated", "squash"), paused: true }, "Ada");
  pausing.add(repoId);
  assert.equal(await stateOf(), "pausing");
  pausing.delete(repoId);
  assert.equal(await stateOf(), "paused");
});

test("the state rule puts the owner's pause before a vanished vision", () => {
  assert.equal(repoState(false, false, true), "active");
  assert.equal(repoState(false, false, null), "active", "nothing fetched yet");
  assert.equal(repoState(false, false, false), "no vision");
  assert.equal(repoState(true, true, false), "pausing");
  assert.equal(repoState(true, false, false), "paused");
});

/** The review's held id and every field of its form as shown, as a browser would post them unchanged. */
function formOf(html: string): Record<string, string | string[]> {
  const fields: Record<string, string | string[]> = {};
  const add = (name: string, value: string) => {
    const seen = fields[name];
    fields[name] = seen === undefined ? value : Array.isArray(seen) ? [...seen, value] : [seen, value];
  };
  const form = html.slice(html.indexOf(`<form method="post" action="${ENROLL_PATH}">`));
  for (const [tag] of form.matchAll(/<input [^>]*>/g)) {
    const name = tag.match(/name="([^"]*)"/)?.[1];
    if (name === undefined) continue;
    const type = tag.match(/type="([^"]*)"/)?.[1];
    if ((type === "radio" || type === "checkbox") && !/ checked/.test(tag)) continue;
    add(name, unescape(tag.match(/value="([^"]*)"/)?.[1] ?? ""));
  }
  for (const [, name, options] of form.matchAll(/<select id="[^"]*" name="([^"]*)">([\s\S]*?)<\/select>/g)) {
    add(name!, options!.match(/<option value="([^"]*)" selected>/)?.[1] ?? "");
  }
  return fields;
}

function unescape(value: string): string {
  return value.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

async function postReview(served: Served, fields: Record<string, string | string[]>) {
  const { port, token } = served.server.info;
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries({ ...fields, [TOKEN_FIELD]: token })) {
    for (const one of Array.isArray(value) ? value : [value]) body.append(name, one);
  }
  return send(port, {
    method: "POST",
    path: ENROLL_PATH,
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: `http://127.0.0.1:${port}` },
    body: body.toString(),
  });
}

function genericCriteriaOf(served: Served): unknown {
  const [repo] = served.store.listRepos();
  assert.ok(repo, "the repo is enrolled");
  return (served.store.latestSettings(repo.id)?.settings as { genericCriteria: unknown }).genericCriteria;
}

test("the review shows each proposed generic criterion with its sentence, mechanical check and source file", async (t) => {
  const served = await serveRepos(t);
  const html = (await check(served, GITHUB)).body;
  assert.match(html, /<legend>G1<\/legend>/);
  assert.equal(inputValue(html, criterionField(0, "sentence")), "The check `test` passes.");
  assert.match(html, new RegExp(`name="${criterionField(0, "check_kind")}">[\\s\\S]*?<option value="check_passes" selected>`));
  assert.equal(inputValue(html, criterionField(0, "check_argument")), "test");
  assert.match(html, /Mechanical check: the check <code>test<\/code> passes\./);
  assert.match(html, /Inferred from <code>\.github\/workflows\/ci\.yml<\/code>\./);
  assert.match(html, /<legend>G2<\/legend>/);
  assert.equal(inputValue(html, criterionField(1, "sentence")), "The check `lint` passes.");
  assert.match(html, /Mechanical check: the check <code>lint<\/code> passes\./);
  assert.match(html, /<legend>New row<\/legend>/, "an empty row to add one");
  assert.match(html, /Checks that reported on the default branch's recent commits: <code>lint<\/code>, <code>test<\/code>\./);
  assert.doesNotMatch(html, /data-warning="unseen-check"/, "test reported, so no warning");
});

test("a proposed criterion naming a check that has not reported on recent default-branch commits is warned about", async (t) => {
  const served = await serveRepos(t, {
    proposals: [
      {
        output: {
          criteria: [{ sentence: "The check `build` passes.", check: { kind: "check_passes", argument: "build" }, source_file: "Makefile" }],
          reason: "r",
        },
      },
    ],
  });
  const html = (await check(served, GITHUB)).body;
  assert.match(html, /data-warning="unseen-check">The check <code>build<\/code> has not reported on the default branch's recent commits\./);
  // Enrolling as shown keeps the row: the owner has seen its warning.
  const enrolled = await postReview(served, { ...formOf(html), [ENROLL_FIELDS.visionOrigin]: "owner-stated" });
  assert.equal(enrolled.status, 303);
  assert.deepEqual(genericCriteriaOf(served), [
    { id: "G1", sentence: "The check `build` passes.", check: { kind: "check_passes", argument: "build" }, source: "Makefile" },
  ]);
});

test("rows can be edited, removed and added before enrolling", async (t) => {
  const served = await serveRepos(t);
  const fields = formOf((await check(served, GITHUB)).body);
  fields[criterionField(0, "sentence")] = "The check `lint` passes.";
  fields[criterionField(0, "check_argument")] = "lint";
  fields[criterionField(1, "remove")] = "1";
  fields[criterionField(2, "sentence")] = "The PR leaves VISION.md alone.";
  fields[criterionField(2, "check_kind")] = "leaves_path";
  fields[criterionField(2, "check_argument")] = "VISION.md";
  const enrolled = await postReview(served, fields);
  assert.equal(enrolled.status, 303);
  assert.deepEqual(genericCriteriaOf(served), [
    { id: "G1", sentence: "The check `lint` passes.", check: { kind: "check_passes", argument: "lint" }, source: ".github/workflows/ci.yml" },
    { id: "G2", sentence: "The PR leaves VISION.md alone.", check: { kind: "leaves_path", argument: "VISION.md" }, source: null },
  ]);
});

test("every row can be removed, and the empty list is accepted", async (t) => {
  const served = await serveRepos(t);
  const fields = formOf((await check(served, GITHUB)).body);
  fields[criterionField(0, "remove")] = "1";
  fields[criterionField(1, "remove")] = "1";
  assert.equal((await postReview(served, fields)).status, 303);
  assert.deepEqual(genericCriteriaOf(served), []);
});

test("adding a row shows the review again with the edits kept and one more empty row, and enrolls nothing", async (t) => {
  const served = await serveRepos(t);
  const fields = formOf((await check(served, GITHUB)).body);
  fields[criterionField(1, "remove")] = "1";
  fields[criterionField(2, "sentence")] = "The PR updates the changelog.";
  fields[criterionField(2, "check_kind")] = "changes_path";
  fields[criterionField(2, "check_argument")] = "CHANGELOG.md";
  const added = await postReview(served, { ...fields, [ENROLL_FIELDS.action]: ENROLL_ACTIONS.addRow });
  assert.equal(added.status, 200);
  assert.deepEqual(served.store.listRepos(), []);
  const html = added.body;
  assert.equal(inputValue(html, criterionField(0, "sentence")), "The check `test` passes.");
  assert.equal(inputValue(html, criterionField(1, "sentence")), "The PR updates the changelog.", "the removed row is gone");
  assert.match(html, /<legend>G2<\/legend>/);
  assert.match(html, /Added by you\./);
  assert.equal(inputValue(html, ENROLL_FIELDS.criteriaCount), "3");
  assert.equal(inputValue(html, criterionField(2, "sentence")), "", "one more empty row");
  assert.equal((await postReview(served, formOf(html))).status, 303, "the review is still open");
  assert.equal((genericCriteriaOf(served) as unknown[]).length, 2);
});

test("a check the owner names that has not reported is warned about before it is enrolled", async (t) => {
  const served = await serveRepos(t);
  const fields = formOf((await check(served, GITHUB)).body);
  fields[criterionField(0, "check_argument")] = "tset";
  const warned = await postReview(served, fields);
  assert.equal(warned.status, 200, "shown again, not refused");
  assert.match(warned.body, /enroll again to keep it/);
  assert.match(warned.body, /The check <code>tset<\/code> has not reported on the default branch's recent commits\./);
  assert.deepEqual(served.store.listRepos(), []);
  assert.equal((await postReview(served, formOf(warned.body))).status, 303, "enrolling again keeps it");
  assert.deepEqual((genericCriteriaOf(served) as { check: unknown }[])[0]!.check, { kind: "check_passes", argument: "tset" });
});

test("a row that cannot be kept shows the review again and enrolls nothing", async (t) => {
  const served = await serveRepos(t);
  const fields = formOf((await check(served, GITHUB)).body);
  fields[criterionField(0, "sentence")] = "/close";
  fields[criterionField(1, "check_kind")] = "changes_path";
  fields[criterionField(1, "check_argument")] = "";
  const refused = await postReview(served, fields);
  assert.equal(refused.status, 400);
  assert.match(refused.body, /Generic criterion G1: Its sentence cannot start with \//);
  assert.match(refused.body, /Generic criterion G2: Its mechanical check needs a path glob\./);
  assert.deepEqual(served.store.listRepos(), []);
});

test("a machine failure of the proposal is explained, leaves an empty list and does not block enrolling", async (t) => {
  const served = await serveRepos(t, { proposals: [{ failure: { kind: "usage-limit", message: "the usage limit was reached" } }] });
  const review = await check(served, GITHUB);
  assert.equal(review.status, 200);
  assert.match(review.body, /entail could not propose generic criteria: the usage limit was reached \(usage-limit\)\. The list starts empty/);
  assert.doesNotMatch(review.body, /<legend>G1<\/legend>/);
  assert.match(review.body, /<legend>New row<\/legend>/);
  assert.equal((await postReview(served, formOf(review.body))).status, 303);
  assert.deepEqual(genericCriteriaOf(served), []);
});

/** Enrolls acme/tally through the page, as the owner would. */
async function enrollThroughPage(served: Served) {
  const { port, token } = served.server.info;
  const html = (await check(served, GITHUB)).body;
  return postForm(port, ENROLL_PATH, {
    [TOKEN_FIELD]: token,
    [ENROLL_FIELDS.review]: inputValue(html, ENROLL_FIELDS.review)!,
    [ENROLL_FIELDS.visionOrigin]: "owner-stated",
    [ENROLL_FIELDS.mergeMethod]: "squash",
  });
}

function markedComment(id: number, issueNumber: number, ticketId: number) {
  return issueComment(id, issueNumber, actor(1001), `Speaking from Ada's entail:\n\nTaken in.\n\n${hiddenMarker(ticketId)}`);
}

test("a repo enrolled with marked issues and no records waits for them, says why, and offers a fresh start", async (t) => {
  const recordsForge = new IntakeForge();
  recordsForge.commentChanges = [markedComment(8001, 3, 12), markedComment(8002, 7, 19)];
  const served = await serveRepos(t, { recordsForge });
  const { port, token } = served.server.info;

  const enrolled = await enrollThroughPage(served);
  assert.equal(enrolled.status, 303);
  const [repo] = served.store.listRepos();
  assert.ok(repo);
  assert.equal(recordsForge.reads.changes, 1, "the check runs at enrollment");
  assert.equal(served.recordsCheck!.standing(repo.id).status, "missing");

  const page = (await send(port, { path: enrolled.headers.location as string })).body;
  assert.match(page, /data-state="waiting for records">waiting for records</);
  assert.match(page, /its issues carry entail's hidden marker with no records behind it/);
  assert.match(page, /acme\/tally is waiting for its records/);
  assert.match(page, /2 issues carry entail's hidden marker, but entail has no records for them: #3, #7/);
  assert.match(page, /<code>entail restore &lt;records remote&gt; --replace<\/code>/, "how to restore");
  assert.match(page, new RegExp(`<form method="post" action="${FRESH_START_PATH}">`));
  assert.equal(inputValue(page, FRESH_START_REPO_FIELD), String(repo.id));

  // The form needs the per-start token.
  const forged = await postForm(port, FRESH_START_PATH, { [FRESH_START_REPO_FIELD]: String(repo.id) });
  assert.equal(forged.status, 403);
  assert.deepEqual(served.store.freshStarts(repo.id), []);

  const confirmed = await postForm(port, FRESH_START_PATH, { [TOKEN_FIELD]: token, [FRESH_START_REPO_FIELD]: String(repo.id) });
  assert.equal(confirmed.status, 303);
  assert.equal(confirmed.headers.location, `${REPOS_PATH}?fresh-start=${repo.id}`);
  const [freshStart] = served.store.freshStarts(repo.id);
  assert.deepEqual(freshStart?.markedIssueNumbers, [3, 7]);
  assert.equal(freshStart?.confirmedBy, "Ada");
  assert.equal(served.recordsCheck!.mayAct(repo.id), true);

  const after = (await send(port, { path: confirmed.headers.location as string })).body;
  assert.match(after, /Confirmed a fresh start for acme\/tally on github\.com/);
  assert.match(after, /data-state="active">active</);
  assert.doesNotMatch(after, /is waiting for its records/);

  const again = await postForm(port, FRESH_START_PATH, { [TOKEN_FIELD]: token, [FRESH_START_REPO_FIELD]: String(repo.id) });
  assert.equal(again.status, 409);
  assert.match(again.body, /is not waiting for records/);
  assert.equal(served.store.freshStarts(repo.id).length, 1, "nothing more is recorded");
});

test("a repo enrolled with no marked issues is active, and one whose check could not run waits for it", async (t) => {
  const recordsForge = new IntakeForge();
  recordsForge.failChanges = new Error("host unreachable");
  const served = await serveRepos(t, { recordsForge });
  const enrolled = await enrollThroughPage(served);
  assert.equal(enrolled.status, 303, "a check that could not run does not undo the enrollment");
  const page = (await send(served.server.info.port, { path: enrolled.headers.location as string })).body;
  assert.match(page, /data-state="checking records">checking records</);

  const [repo] = served.store.listRepos();
  await served.recordsCheck!.check(repo!);
  assert.match((await send(served.server.info.port, { path: REPOS_PATH })).body, /data-state="active">active</);
});

test("the state rule puts the owner's pause first, then missing or unchecked records, then a vanished vision", () => {
  assert.equal(repoState(false, false, false, "missing"), "waiting for records");
  assert.equal(repoState(false, false, true, "unchecked"), "checking records");
  assert.equal(repoState(false, false, false, "clear"), "no vision");
  assert.equal(repoState(true, false, true, "missing"), "paused");
});
