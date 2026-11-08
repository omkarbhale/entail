import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Mirror } from "../src/mirror.ts";
import { enrollmentSettings } from "../src/repo-settings.ts";
import {
  CHECK_PATH,
  ENROLL_FIELDS,
  ENROLL_PATH,
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

interface Served extends EnrollmentSetup {
  server: LocalServer;
  /** Moves the page's clock on. */
  advance(ms: number): void;
}

async function serveRepos(
  t: TestContext,
  options: Parameters<typeof enrollmentSetup>[1] & { activity?: RepoActivity } = {},
): Promise<Served> {
  const setup = enrollmentSetup(t, options);
  let offset = 0;
  const pages = [
    ...reposPages({
      store: setup.store,
      enroller: setup.enroller,
      dataDirectory: setup.dataDirectory,
      activity: options.activity,
      now: () => new Date(Date.now() + offset),
    }),
    globalSettingsPage(setup.store),
  ];
  const server = await startServer({ port: 0, pages });
  t.after(() => server.close());
  return { ...setup, server, advance: (ms) => (offset += ms) };
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
  assert.match(html, /Generic criteria<\/h2>\n<p class="muted">None\. The list starts empty\./);
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
