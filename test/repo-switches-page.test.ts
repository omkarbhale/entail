import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { CLEARED_LABEL } from "../src/intake-comment.ts";
import { readRepoSettings } from "../src/repo-settings.ts";
import { REPO_SETTINGS_PATH } from "../src/repo-settings-page.ts";
import { PAUSE_PATH, SWITCH_BACK, SWITCH_FIELDS, SWITCHES, UNENROLL_PATH } from "../src/repo-switches-page.ts";
import { UNENROLL_REASON } from "../src/repo-switches.ts";
import { REPOS_PATH, reposPages, type RepoActivity } from "../src/repos-page.ts";
import { startServer, TOKEN_FIELD, type LocalServer } from "../src/server.ts";
import type { RepoRecord } from "../src/store.ts";
import { enrollmentSetup, type EnrollmentSetup, FakeForge, PROPOSAL } from "./enrollment-fixture.ts";
import { postForm, send } from "./http-client.ts";

interface Served extends EnrollmentSetup {
  server: LocalServer;
  enrolled: RepoRecord;
  /** The forge the pages write to on unenroll. */
  forge: FakeForge;
  /** Whether the repo is still busy, which shows a paused repo as pausing. */
  busy: { now: boolean };
}

/** A GitHub repo enrolled through the fixture, served with the Repos page and its switches. */
async function serveEnrolled(t: TestContext): Promise<Served> {
  const setup = enrollmentSetup(t, { proposals: [{ output: PROPOSAL }, { output: PROPOSAL }] });
  const checked = await setup.enroller.check({ forge: "github", host: "github.com", path: "acme/tally" });
  assert.ok(checked.ok);
  const confirmed = await setup.enroller.confirm(checked.review, { visionOrigin: "agent-proposed-owner-approved", mergeMethod: "squash" });
  assert.ok(confirmed.ok);
  const forge = new FakeForge({ forge: "github", host: "github.com", path: "acme/tally" }, setup.world);
  const busy = { now: false };
  const activity: RepoActivity = { pausing: () => busy.now };
  const pages = reposPages({ store: setup.store, enroller: setup.enroller, dataDirectory: setup.dataDirectory, activity, forgeFor: () => forge });
  const server = await startServer({ port: 0, pages });
  t.after(() => server.close());
  return { ...setup, server, enrolled: confirmed.repo, forge, busy };
}

function get(served: Served, path: string) {
  return send(served.server.info.port, { path });
}

function post(served: Served, path: string, form: Record<string, string>) {
  return postForm(served.server.info.port, path, { [TOKEN_FIELD]: served.server.info.token, ...form });
}

function stateShown(html: string): string | undefined {
  return html.match(/data-state="([^"]*)"/)?.[1];
}

/** Takes issue `number` in and moves its ticket to `state`, carrying its label on the forge. */
function ticketIn(served: Served, number: number, state: "deciding" | "on-the-board" | "cleared") {
  const { store } = served;
  const ticket = store.takeIn({ repoId: served.enrolled.id, issueNumber: number });
  if (state === "on-the-board") {
    const call = store.recordCall({ ticketId: ticket.id, kind: "raise", reason: "Needs the owner.", stateTo: "on-the-board" });
    store.raiseBoardItem({ ticketId: ticket.id, callId: call.id, decision: "Go ahead?", whyRaised: "pin", snapshot: { version: 1 } });
  }
  if (state === "cleared") {
    store.recordCall({ ticketId: ticket.id, kind: "criteria", reason: "Criteria written.", stateTo: "cleared" });
    served.forge.state.labels[number] = [CLEARED_LABEL];
  }
  return ticket;
}

test("the Repos page pauses and resumes a repo, saving a settings version each time, and shows it pausing until its runs finish", async (t) => {
  const served = await serveEnrolled(t);
  const page = await get(served, REPOS_PATH);
  assert.equal(stateShown(page.body), "active");
  assert.match(page.body, new RegExp(`<form method="post" action="${PAUSE_PATH}"`));
  assert.match(page.body, /<button type="submit" name="switch" value="pause">Pause<\/button>/);
  assert.match(page.body, new RegExp(`href="${UNENROLL_PATH}\\?repo=${served.enrolled.id}"`));

  served.busy.now = true;
  const paused = await post(served, PAUSE_PATH, { [SWITCH_FIELDS.repo]: String(served.enrolled.id), [SWITCH_FIELDS.switch]: SWITCHES.pause });
  assert.equal(paused.status, 303);
  assert.equal(paused.headers.location, REPOS_PATH);
  const settings = readRepoSettings(served.store, served.enrolled.id)!;
  assert.equal(settings.settings.paused, true);
  assert.equal(settings.version.version, 2);
  assert.equal(settings.version.savedBy, "Ada");
  assert.equal(stateShown((await get(served, REPOS_PATH)).body), "pausing", "running decider and landing runs are finishing");
  served.busy.now = false;
  const pausedPage = await get(served, REPOS_PATH);
  assert.equal(stateShown(pausedPage.body), "paused");
  assert.match(pausedPage.body, /value="resume">Resume<\/button>/);

  const resumed = await post(served, PAUSE_PATH, {
    [SWITCH_FIELDS.repo]: String(served.enrolled.id),
    [SWITCH_FIELDS.switch]: SWITCHES.resume,
    [SWITCH_FIELDS.back]: SWITCH_BACK.settings,
  });
  assert.equal(resumed.status, 303);
  assert.equal(resumed.headers.location, `${REPO_SETTINGS_PATH}?repo=${served.enrolled.id}&saved=3`, "back to the settings page it was pressed on");
  assert.equal(readRepoSettings(served.store, served.enrolled.id)!.settings.paused, false);
  assert.equal(stateShown((await get(served, REPOS_PATH)).body), "active");
  assert.deepEqual(served.store.listCalls({ repoId: served.enrolled.id }), [], "a pause is a setting, not a call");
});

test("the pause and unenroll forms need the per-start token, and refuse a repo that is not enrolled", async (t) => {
  const served = await serveEnrolled(t);
  const port = served.server.info.port;
  const repo = String(served.enrolled.id);
  assert.equal((await postForm(port, PAUSE_PATH, { [SWITCH_FIELDS.repo]: repo, [SWITCH_FIELDS.switch]: SWITCHES.pause })).status, 403);
  assert.equal((await postForm(port, UNENROLL_PATH, { [SWITCH_FIELDS.repo]: repo })).status, 403);
  assert.equal(readRepoSettings(served.store, served.enrolled.id)!.settings.paused, false);
  assert.equal(served.store.isEnrolled(served.enrolled.id), true);
  assert.equal((await post(served, PAUSE_PATH, { [SWITCH_FIELDS.repo]: "999", [SWITCH_FIELDS.switch]: SWITCHES.pause })).status, 404);
  assert.equal((await post(served, PAUSE_PATH, { [SWITCH_FIELDS.repo]: repo, [SWITCH_FIELDS.switch]: "maybe" })).status, 400);
  assert.equal((await get(served, `${UNENROLL_PATH}?repo=999`)).status, 404);
});

test("the settings page carries the pause switch and the way to unenroll", async (t) => {
  const served = await serveEnrolled(t);
  const page = await get(served, `${REPO_SETTINGS_PATH}?repo=${served.enrolled.id}`);
  assert.match(page.body, /<h2>Pause<\/h2>/);
  assert.match(page.body, new RegExp(`name="back" value="settings">`));
  assert.match(page.body, new RegExp(`href="${UNENROLL_PATH}\\?repo=${served.enrolled.id}">unenroll this repo</a>`));
});

test("unenrolling shows the in-flight count first, then cancels, withdraws and removes labels with no comment or close", async (t) => {
  const served = await serveEnrolled(t);
  const { store } = served;
  const deciding = ticketIn(served, 11, "deciding");
  const onBoard = ticketIn(served, 12, "on-the-board");
  const cleared = ticketIn(served, 13, "cleared");

  const confirm = await get(served, `${UNENROLL_PATH}?repo=${served.enrolled.id}`);
  assert.equal(confirm.status, 200);
  assert.match(confirm.body, /data-in-flight="3"><strong>3 tickets are in flight<\/strong> in acme\/tally on github\.com, 1 of them on the board\./);
  assert.match(confirm.body, /posts no comment and closes no issue/);
  assert.equal(store.isEnrolled(served.enrolled.id), true, "showing the confirm screen changes nothing");

  const done = await post(served, UNENROLL_PATH, { [SWITCH_FIELDS.repo]: String(served.enrolled.id) });
  assert.equal(done.status, 303);
  assert.equal(done.headers.location, `${REPOS_PATH}?unenrolled=${served.enrolled.id}`);
  for (const ticket of [deciding, onBoard, cleared]) {
    const now = store.getTicket(ticket.id)!;
    assert.equal(now.state, "cancelled");
    assert.equal(store.getCall(now.stateCallId!)!.reason, UNENROLL_REASON);
  }
  assert.equal(store.boardItemsForTicket(onBoard.id).at(-1)!.withdrawal?.reason, "The repo was unenrolled.");
  assert.deepEqual(served.forge.state.labels[13], [], "the cleared label is removed");
  assert.deepEqual(served.forge.state.sends, { comment: 0, addLabel: 0, removeLabel: 1, close: 0, merge: 0 });

  const repos = await get(served, done.headers.location as string);
  assert.match(repos.body, /data-unenrolled="\d+">Unenrolled acme\/tally on github\.com: 3 tickets were cancelled, with no comment posted and no issue closed\./);
  assert.match(repos.body, /<h2>Unenrolled<\/h2>/);
  assert.match(repos.body, /<p class="muted">No repo is enrolled yet\.<\/p>/, "it leaves the enrolled list");

  // Its records stay, read-only.
  const settingsPage = await get(served, `${REPO_SETTINGS_PATH}?repo=${served.enrolled.id}`);
  assert.equal(settingsPage.status, 200);
  assert.match(settingsPage.body, /This repo was unenrolled/);
  assert.doesNotMatch(settingsPage.body, new RegExp(`<form method="post" action="${REPO_SETTINGS_PATH}">`), "no form to change them");
  const versions = served.store.settingsHistory(served.enrolled.id).length;
  const refused = await post(served, REPO_SETTINGS_PATH, { repo: String(served.enrolled.id), based_on: String(versions), merge_method: "merge", who_counts: "anyone" });
  assert.equal(refused.status, 409);
  assert.equal(served.store.settingsHistory(served.enrolled.id).length, versions, "nothing is saved for an unenrolled repo");
  assert.equal((await post(served, PAUSE_PATH, { [SWITCH_FIELDS.repo]: String(served.enrolled.id), [SWITCH_FIELDS.switch]: SWITCHES.pause })).status, 404);
  assert.equal((await post(served, UNENROLL_PATH, { [SWITCH_FIELDS.repo]: String(served.enrolled.id) })).status, 409, "it cannot be unenrolled twice");
});

test("an unenrolled repo can be enrolled again by its owner, keeping its record; another account is refused", async (t) => {
  const served = await serveEnrolled(t);
  await post(served, UNENROLL_PATH, { [SWITCH_FIELDS.repo]: String(served.enrolled.id) });

  served.world.actor = { forge: "github", host: "github.com", id: 2002, username: "someone-else" };
  const other = await served.enroller.check({ forge: "github", host: "github.com", path: "acme/tally" });
  assert.ok(!other.ok);
  assert.equal(other.refusals[0]?.reason, "another-owner");
  assert.match(other.refusals[0]!.message, /enrolled before with the account owner/);

  served.world.actor = { forge: "github", host: "github.com", id: 1001, username: "owner" };
  const checked = await served.enroller.check({ forge: "github", host: "github.com", path: "acme/tally" });
  assert.ok(checked.ok, "an unenrolled repo is not already enrolled");
  const again = await served.enroller.confirm(checked.review, { visionOrigin: "owner-stated", mergeMethod: "squash" });
  assert.ok(again.ok);
  assert.equal(again.repo.id, served.enrolled.id, "the same record, keyed on the project id");
  assert.equal(served.store.isEnrolled(served.enrolled.id), true);
  assert.ok(again.enrollment.enrolledAt > served.enrolled.enrolledAt, "a new enrollment, so only issues opened after it enter");
  assert.deepEqual(again.enrollment.openIssueNumbers, [1, 3], "issues open now are left alone");
  assert.equal(readRepoSettings(served.store, served.enrolled.id)!.settings.paused, false);
  assert.equal(stateShown((await get(served, REPOS_PATH)).body), "active");
});
