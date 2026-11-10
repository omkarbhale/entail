import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AGAINST_VISION_WARNING, answerComment, CRITERIA_TO_COME, type ChosenAnswer } from "../../src/answer.ts";
import type { AnswerReply, BoardData, ReviewView } from "../../src/app-view.ts";
import { BOARD_ITEM_VERSION, boardOptions, decisionSentence, whyRaised, type BoardItemSnapshot, type WhyRaisedInput } from "../../src/board-item.ts";
import { BOARD_ANSWER_PATH, BOARD_DATA_PATH, boardPages } from "../../src/board-page.ts";
import { commentRuleViolations } from "../../src/comment-rules.ts";
import type { VisionCheck, VisionCheckMark } from "../../src/intake-comment.ts";
import { startServer, type LocalServer } from "../../src/server.ts";
import { Store, type BoardItemRecord, type RepoRecord, type TicketRecord } from "../../src/store.ts";
import { BoardDriver } from "../acceptance/board-driver.ts";
import { FIXTURE_ISSUES } from "../acceptance/fixture.ts";
import type { HarnessEvent } from "../acceptance/reset.ts";
import { decodeEntities, parsePage, type Page } from "../acceptance/html.ts";
import { postForm, send } from "../http-client.ts";
import { boardPage, renderItem } from "./render.ts";

const VISION_SHA = "d".repeat(40);
const NETWORK = "tally never reaches the network.";
const OWNER = "Ada Owner";

interface Fixture {
  store: Store;
  server: LocalServer;
  github: RepoRecord;
  gitlab: RepoRecord;
  /** How many times the board said an answer was recorded, as the records repo hears it. */
  answersRecorded(): number;
  raise(repo: RepoRecord, issueNumber: number, why: WhyRaisedInput, options?: { mark?: VisionCheckMark; title?: string; version?: number }): { ticket: TicketRecord; item: BoardItemRecord };
  /** The board page as the app renders it from the server's data. */
  get(path: string): Promise<{ status: number; body: string; data: BoardData }>;
  /** Posts the answer form as the board app does, with the per-start token unless it is left out. */
  post(fields: Record<string, string>, options?: { token?: boolean }): Promise<{ status: number; body: string; reply: AnswerReply | null }>;
}

async function serveBoard(t: TestContext, options: { hostHalted?: (host: string) => boolean; catchingUp?: (repoId: number) => boolean } = {}): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "entail-answer-"));
  let now = new Date(2026, 10, 9, 9, 0, 0).getTime();
  const store = Store.openIn(dir, { now: () => new Date((now += 1000)) });
  const github = store.enrollRepo({ forge: "github", host: "github.com", projectId: 11, path: "acme/tally", ownerAccountId: 1, ownerLogin: "owner" });
  const gitlab = store.enrollRepo({ forge: "gitlab", host: "gitlab.com", projectId: 22, path: "acme/tally-gl", ownerAccountId: 2, ownerLogin: "owner" });
  store.saveGlobalSettings({ ownerDisplayName: OWNER }, OWNER);

  const raise: Fixture["raise"] = (repo, issueNumber, why, options = {}) => {
    const ticket = store.takeIn({ repoId: repo.id, issueNumber });
    store.recordCall({ ticketId: ticket.id, kind: "intake", reason: "Taken in." });
    const call = store.recordCall({ ticketId: ticket.id, kind: "raise", reason: "Raised to the owner.", stateTo: "on-the-board" });
    const check: VisionCheck = {
      commit: VISION_SHA,
      lines: [
        {
          text: NETWORK,
          heading: "What tally is",
          lineNumber: 4,
          mark: options.mark ?? "contradicts",
          permalink: `https://${repo.host}/${repo.path}/blob/${VISION_SHA}/VISION.md#L4`,
        },
      ],
      unquotable: [],
    };
    const w = whyRaised(why, check);
    const decision = decisionSentence(issueNumber, w);
    const snapshot: BoardItemSnapshot = {
      version: options.version ?? BOARD_ITEM_VERSION,
      decision,
      why: w,
      visionCheck: check,
      ticket: {
        repo: { forge: repo.forge, host: repo.host, path: repo.path },
        issue: { number: issueNumber, title: options.title ?? `Issue ${issueNumber}`, url: `https://${repo.host}/${repo.path}/issues/${issueNumber}` },
        filedBy: { forge: repo.forge, host: repo.host, id: 7, username: "reporter" },
        request: "Please count web pages.",
      },
      happened: { calls: [], answers: [], historyLink: `http://127.0.0.1:7419/ticket?id=${ticket.id}` },
      form: {
        options: boardOptions(
          [
            { id: "R1", reading: "Any Unicode whitespace separates words", observed_outcome: "“new york” counts as 2 words." },
            { id: "R2", reading: "Only spaces, tabs and line breaks", observed_outcome: "“new york” counts as 1 word." },
          ],
          [],
          check,
        ),
      },
    };
    const item = store.raiseBoardItem({ ticketId: ticket.id, callId: call.id, decision, whyRaised: why.kind, snapshot });
    return { ticket, item };
  };

  let answersRecorded = 0;
  const server = await startServer({
    port: 0,
    pages: boardPages({ store, now: () => new Date(now), hostHalted: options.hostHalted, catchingUp: options.catchingUp, afterAnswer: () => answersRecorded++ }),
  });
  t.after(async () => {
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const result = (r: { status: number; body: string; headers: Record<string, string | string[] | undefined> }) => ({
    status: r.status,
    body: r.body,
    reply: String(r.headers["content-type"]).startsWith("application/json") ? (JSON.parse(r.body) as AnswerReply) : null,
  });
  return {
    store,
    server,
    github,
    gitlab,
    answersRecorded: () => answersRecorded,
    raise,
    get: (path) => boardPage(server.info.port, path),
    post: async (fields, options = {}) =>
      result(
        await postForm(server.info.port, BOARD_ANSWER_PATH, options.token === false ? fields : { token: server.info.token, ...fields }, { Accept: "application/json" }),
      ),
  };
}

/** The answer form on a page. */
function answerForm(page: Page) {
  const form = page.forms.find((f) => f.controls.some((c) => c.name === "answer" || /Record answer/.test(c.label)));
  assert.ok(form, "the page has the answer form");
  return form;
}

/** The text of the page's comment preview, as the owner reads it. */
function previewedComment(html: string): string {
  const m = /<pre class="comment">([\s\S]*?)<\/pre>/.exec(html);
  assert.ok(m, "the page shows the comment");
  return decodeEntities(m[1]!);
}

/** The review a reply carries. */
function reviewOf(reply: AnswerReply | null): ReviewView {
  assert.equal(reply?.kind, "review", JSON.stringify(reply));
  return (reply as AnswerReply & { kind: "review" }).review;
}

/** The item with the review in place of its form, as the app shows it. */
async function reviewed(board: Fixture, item: BoardItemRecord, reply: AnswerReply | null): Promise<string> {
  const review = reviewOf(reply);
  return renderItem((await board.get(`/?item=${item.id}`)).data, { panel: { kind: "review", review }, touched: true });
}

/** The item with the form as a refused or incomplete answer left it, as the app shows it. */
async function refused(board: Fixture, item: BoardItemRecord, reply: AnswerReply | null): Promise<string> {
  assert.equal(reply?.kind, "form", JSON.stringify(reply));
  const form = reply as AnswerReply & { kind: "form" };
  return renderItem((await board.get(`/?item=${item.id}`)).data, { draft: form.draft, panel: { kind: "form", error: form.error, refusal: form.refusal } });
}

function fields(item: BoardItemRecord, rest: Record<string, string>): Record<string, string> {
  return { item: String(item.id), version: String(BOARD_ITEM_VERSION), ...rest };
}

const CHOSEN_R1: ChosenAnswer = { shape: "option", optionId: "R1", text: null, note: null, showNoteOnIssue: false };

test("the board's answer form offers Review answer, never a one-click record, and the board carries the per-start token", async (t) => {
  const board = await serveBoard(t);
  const { item } = board.raise(board.github, 7, { kind: "contradiction" });
  const page = await board.get(`/?item=${item.id}`);
  const form = answerForm(parsePage(page.body));
  assert.equal(form.method, "post");
  assert.equal(page.data.token, board.server.info.token);
  const buttons = form.controls.filter((c) => c.tag === "button").map((c) => c.label);
  assert.deepEqual(buttons, ["Review answer"], "the only step the form offers is the review");
});

test("Review answer records nothing and shows the answer, the note's visibility, what happens next and the exact comment", async (t) => {
  const board = await serveBoard(t);
  const { ticket, item } = board.raise(board.github, 7, { kind: "contradiction" });
  const reply = await board.post(fields(item, { answer: "option:R1", note: "Keep it fast.", step: "review" }));
  assert.equal(reply.status, 200);
  assert.equal(board.store.answerFor(item.id), null, "a review records nothing");

  const html = await reviewed(board, item, reply.reply);
  const page = parsePage(html);
  assert.match(page.text, /Check your answer before it is recorded\. Answers are final\./);
  assert.match(page.text, /You answer: Any Unicode whitespace separates words/);
  assert.match(page.text, /Your note, private: kept in entail's records only:\s*Keep it fast\./);
  assert.match(page.text, /The ticket's new state: deciding, to write criteria\./);
  assert.match(page.text, /entail writes the criteria from your answer, without running the verdict again/);
  assert.match(page.text, /Your note stays in entail's records, not on the issue\./);
  assert.match(page.text, new RegExp(AGAINST_VISION_WARNING.replace(/[.;]/g, "\\$&")), "the chosen option goes against a line, so the review carries its warning");

  const expected = answerComment(OWNER, ticket.id, { ...CHOSEN_R1, note: "Keep it fast." }, board.store.boardItem(item.id)!.item.snapshot as BoardItemSnapshot, "github");
  assert.equal(previewedComment(html), expected, "the exact comment entail will post");
  assert.deepEqual(commentRuleViolations(expected, OWNER, ticket.id), []);
  assert.ok(!expected.includes("Keep it fast."), "a private note never appears in the comment");
  assert.match(expected, /Ada Owner decided:\n\n> Any Unicode whitespace separates words\n\nWhat a user would observe: “new york” counts as 2 words\./);
  assert.ok(expected.includes(CRITERIA_TO_COME));
  assert.match(expected, /### Vision check[\s\S]*> tally never reaches the network\./);

  const confirm = page.forms.find((f) => f.controls.some((c) => /Record answer/.test(c.label)))!;
  assert.deepEqual(
    confirm.controls.filter((c) => c.tag === "button").map((c) => c.label),
    [`Record answer as ${OWNER} (final)`, "Back"],
  );
});

test("while a step is in flight its button says so, and nothing in the form can be sent again", async (t) => {
  const board = await serveBoard(t);
  const { item } = board.raise(board.github, 7, { kind: "contradiction" });
  const data = (await board.get(`/?item=${item.id}`)).data;
  const draft = { answer: "option:R1", text: "", note: "", showNote: false };
  const reviewing = renderItem(data, { draft, sending: "review" });
  assert.match(reviewing, /<form id="answer-form"[^>]* aria-busy="true"/, "the form is busy");
  const button = /<button[^>]*>([\s\S]*?)<\/button>/.exec(reviewing)!;
  assert.match(button[0], /disabled=""/);
  assert.match(button[0], /class="pending"/);
  assert.match(button[1]!, /<span class="spinner" aria-hidden="true"><\/span>Reviewing…/, "the button shows its step in flight");

  const review = reviewOf((await board.post(fields(item, { answer: draft.answer, step: "review" }))).reply);
  const recording = renderItem(data, { draft, panel: { kind: "review", review }, sending: "record" });
  const buttons = [...recording.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)];
  assert.equal(buttons.length, 2);
  assert.ok(buttons.every((b) => /disabled=""/.test(b[0])), "neither Record nor Back can be pressed again");
  assert.match(buttons[0]![1]!, /Recording as Ada Owner…/);
  assert.match(renderItem(data, { draft }), /<button type="submit"[^>]*>Review answer<\/button>/, "nothing in flight: the button reads as before");
});

test("a note ticked to show is quoted in the comment, and Don't go ahead closes the issue as not planned on GitHub only", async (t) => {
  const board = await serveBoard(t);
  const gh = board.raise(board.github, 7, { kind: "contradiction" });
  const gl = board.raise(board.gitlab, 8, { kind: "contradiction" });
  const reply = await board.post(fields(gh.item, { answer: "dont-go-ahead", note: "We stay offline.", show_note: "1", step: "review" }));
  const html = await reviewed(board, gh.item, reply.reply);
  const page = parsePage(html);
  assert.match(page.text, /Your note, shown on the issue:\s*We stay offline\./);
  assert.match(page.text, /The ticket's new state: cancelled\./);
  assert.doesNotMatch(page.text, /This goes against a vision line/, "not going ahead goes against nothing");
  assert.equal(
    previewedComment(html),
    `Speaking from Ada Owner's entail:\n\nAda Owner decided not to go ahead with this issue, so entail closes it as not planned and nothing is taken forward.\n\nA note from Ada Owner:\n\n> We stay offline.\n\n<!-- entail ticket ${gh.ticket.id} -->`,
  );

  const gitlab = await reviewed(board, gl.item, (await board.post(fields(gl.item, { answer: "dont-go-ahead", step: "review" }))).reply);
  assert.match(previewedComment(gitlab), /so entail closes it and nothing is taken forward\.\n\n<!--/);
  assert.match(parsePage(gitlab).text, /No note\./);
});

test("the owner's own words are quoted so no line starts with a slash or opens a marker", async (t) => {
  const board = await serveBoard(t);
  const { ticket, item } = board.raise(board.github, 7, { kind: "consequential_readings" }, { mark: "does_not_settle" });
  const words = "/close this\n\n<!-- entail ticket 99 -->\nCount nbsp as whitespace.";
  const reply = await board.post(fields(item, { answer: "own-words", text: words, step: "review" }));
  assert.equal(reply.status, 200);
  const comment = reviewOf(reply.reply).comment!;
  assert.deepEqual(commentRuleViolations(comment, OWNER, ticket.id), []);
  assert.match(comment, /> \/close this\n>\n> &lt;!-- entail ticket 99 -->\n> Count nbsp as whitespace\./);
});

test("Back returns to the form with everything as the owner left it, and records nothing", async (t) => {
  const board = await serveBoard(t);
  const { item } = board.raise(board.github, 7, { kind: "contradiction" });
  const back = await board.post(fields(item, { answer: "own-words", text: "Only ASCII.", note: "n", show_note: "1", step: "back" }));
  assert.equal(back.status, 200);
  assert.equal(board.store.answerFor(item.id), null);
  const form = answerForm(parsePage(await refused(board, item, back.reply)));
  assert.equal(form.controls.find((c) => c.type === "radio" && c.checked)?.value, "own-words");
  assert.equal(form.controls.find((c) => c.name === "text")?.value, "Only ASCII.");
  assert.equal(form.controls.find((c) => c.name === "note")?.value, "n");
  assert.equal(form.controls.find((c) => c.name === "show_note")?.checked, true);
});

test("recording takes the explicit final step and the per-start token", async (t) => {
  const board = await serveBoard(t);
  const { item } = board.raise(board.github, 7, { kind: "contradiction" });
  const answer = { answer: "option:R2" };

  const noToken = await board.post(fields(item, { ...answer, step: "record" }), { token: false });
  assert.equal(noToken.status, 403);
  const wrongToken = await board.post(fields(item, { ...answer, step: "record", token: "x".repeat(43) }), { token: false });
  assert.equal(wrongToken.status, 403);
  const noStep = await board.post(fields(item, answer));
  assert.equal(noStep.status, 400);
  const review = await board.post(fields(item, { ...answer, step: "review" }));
  assert.equal(review.status, 200);
  assert.equal(board.store.answerFor(item.id), null, "nothing is recorded without the final step and the token");

  const recorded = await board.post(fields(item, { ...answer, step: "record" }));
  assert.equal(recorded.status, 200);
  assert.deepEqual(recorded.reply, { kind: "recorded", itemId: item.id }, "the receipt stays on the item");
  assert.equal(board.store.answerFor(item.id)?.optionId, "R2");
});

test("an incomplete answer is not recorded, and the form says what is missing", async (t) => {
  const board = await serveBoard(t);
  const { item } = board.raise(board.github, 7, { kind: "contradiction" });
  for (const [form, missing] of [
    [{}, /Choose how to answer/],
    [{ answer: "own-words", text: "   " }, /Write your answer in your own words/],
    [{ answer: "option:R9" }, /not one this item offers/],
  ] as const) {
    const reply = await board.post(fields(item, { ...form, step: "record" }));
    assert.equal(reply.status, 400);
    assert.match(parsePage(await refused(board, item, reply.reply)).text, missing);
  }
  assert.equal(board.store.answerFor(item.id), null);
});

test("the answer is recorded under the owner's display name with the time, the item version and the note's visibility", async (t) => {
  const board = await serveBoard(t);
  const shown = board.raise(board.github, 7, { kind: "contradiction" }, { version: 2 });
  const priv = board.raise(board.gitlab, 8, { kind: "contradiction" });
  await board.post({ item: String(shown.item.id), version: "2", answer: "own-words", text: " Count nbsp. ", note: " Shown note ", show_note: "1", step: "record" });
  await board.post(fields(priv.item, { answer: "dont-go-ahead", note: "Private note", step: "record" }));

  const a = board.store.answerFor(shown.item.id)!;
  assert.equal(a.answeredBy, OWNER);
  assert.match(a.answeredAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(a.itemVersion, 2);
  assert.deepEqual([a.shape, a.text, a.note, a.showNoteOnIssue], ["own-words", "Count nbsp.", "Shown note", true]);
  const b = board.store.answerFor(priv.item.id)!;
  assert.deepEqual([b.shape, b.itemVersion, b.note, b.showNoteOnIssue], ["dont-go-ahead", 1, "Private note", false]);
  assert.equal(board.store.callsForTicket(priv.ticket.id).filter((c) => c.answerId !== null).length, 0, "the answer itself is not a call");
});

test("the board tells the records repo of each recorded answer, and of nothing else", async (t) => {
  const board = await serveBoard(t);
  const { item } = board.raise(board.github, 7, { kind: "contradiction" });
  assert.equal((await board.post(fields(item, { answer: "option:R1", step: "review" }))).status, 200);
  assert.equal(board.answersRecorded(), 0, "a review records nothing");
  assert.equal((await board.post(fields(item, { answer: "option:R1", step: "record" }))).reply?.kind, "recorded");
  assert.equal(board.answersRecorded(), 1, "the recorded answer");
  assert.equal((await board.post(fields(item, { answer: "dont-go-ahead", step: "record" }))).status, 409);
  assert.equal(board.answersRecorded(), 1, "a refused answer is not recorded");
});

test("an answer to a withdrawn item is refused with a clear message, keeping the typed text", async (t) => {
  const board = await serveBoard(t);
  const { ticket, item } = board.raise(board.github, 7, { kind: "contradiction" });
  const call = board.store.recordCall({ ticketId: ticket.id, kind: "recheck", reason: "The issue was edited.", stateTo: "deciding" });
  board.store.withdrawBoardItem({ boardItemId: item.id, callId: call.id, reason: "The issue was edited." });
  for (const step of ["review", "record"]) {
    const reply = await board.post(fields(item, { answer: "own-words", text: "My typed words.", step }));
    assert.equal(reply.status, 409);
    const page = parsePage(await refused(board, item, reply.reply));
    assert.match(page.text, /Not recorded\. This item was withdrawn, so it takes no answer and yours was not recorded\. The issue was edited\./);
    assert.equal(answerForm(page).controls.find((c) => c.name === "text")?.value, "My typed words.", "typed text stays to copy");
  }
  assert.equal(board.store.answerFor(item.id), null);
});

test("an answer to an already answered item is refused, and the first answer stands", async (t) => {
  const board = await serveBoard(t);
  const { item } = board.raise(board.github, 7, { kind: "contradiction" });
  assert.equal((await board.post(fields(item, { answer: "option:R1", step: "record" }))).reply?.kind, "recorded");
  const again = await board.post(fields(item, { answer: "dont-go-ahead", step: "record" }));
  assert.equal(again.status, 409);
  assert.match(parsePage(await refused(board, item, again.reply)).text, /This item was already answered by Ada Owner\. Answers are final, so yours was not recorded\./);
  assert.equal(board.store.answerFor(item.id)?.shape, "option");
});

test("an answer to an older item version is refused, and the board offers the current version again", async (t) => {
  const board = await serveBoard(t);
  const { item } = board.raise(board.github, 7, { kind: "contradiction" }, { version: 2 });
  for (const version of ["1", "x"]) {
    const reply = await board.post({ item: String(item.id), version, answer: "option:R1", step: "record" });
    assert.equal(reply.status, 409);
    const html = await refused(board, item, reply.reply);
    assert.match(parsePage(html).text, version === "1" ? /you answered version 1, and it is now version 2\. Nothing was recorded\./ : /did not say which version/);
    const current = (await board.get(`/?item=${item.id}`)).data.detail;
    assert.equal(current.kind === "item" && current.version, 2, "the board shows the current version again");
    assert.equal(answerForm(parsePage(html)).controls.find((c) => c.type === "radio" && c.checked)?.value, "option:R1", "the answer stays filled in");
  }
  assert.equal(board.store.answerFor(item.id), null);
});

test("an answer to an item whose repo is paused is refused", async (t) => {
  const board = await serveBoard(t);
  const { item } = board.raise(board.github, 7, { kind: "contradiction" });
  board.store.saveSettings(board.github.id, { paused: true }, OWNER);
  const reply = await board.post(fields(item, { answer: "option:R1", step: "record" }));
  assert.equal(reply.status, 409);
  assert.match(parsePage(await refused(board, item, reply.reply)).text, /This item is locked, so nothing was recorded: this repo is paused\./);
  assert.equal(board.store.answerFor(item.id), null);
});

test("an answer to an item of a repo entail is still catching up with after a pause is refused, and taken once it has caught up", async (t) => {
  const caughtUp = { now: false };
  const board = await serveBoard(t, { catchingUp: () => !caughtUp.now });
  const { item } = board.raise(board.github, 7, { kind: "contradiction" });
  const reply = await board.post(fields(item, { answer: "option:R1", step: "record" }));
  assert.equal(reply.status, 409);
  assert.match(parsePage(await refused(board, item, reply.reply)).text, /This item is locked, so nothing was recorded: entail is catching up with this repo after its pause\./);
  assert.equal(board.store.answerFor(item.id), null);

  caughtUp.now = true;
  const taken = await board.post(fields(item, { answer: "option:R1", step: "record" }));
  assert.equal(taken.reply?.kind, "recorded");
  assert.ok(board.store.answerFor(item.id));
});

test("the vision-line warning appears exactly when going ahead goes against a line, with no link to edit the vision", async (t) => {
  const board = await serveBoard(t);
  const against = board.raise(board.github, 7, { kind: "contradiction" });
  const silent = board.raise(board.github, 8, { kind: "consequential_readings" }, { mark: "does_not_settle" });

  const page = (await board.get(`/?item=${against.item.id}`)).body;
  const form = answerForm(parsePage(page));
  const radios = form.controls.filter((c) => c.type === "radio");
  const warned = radios.filter((c) => c.label.includes(AGAINST_VISION_WARNING)).map((c) => c.value);
  assert.deepEqual(warned, ["option:R1", "option:R2"], "each option that goes ahead against the line carries it, once");
  assert.equal(page.split(AGAINST_VISION_WARNING).length - 1, 2);
  for (const link of parsePage(page).links) {
    assert.doesNotMatch(link.href, /\/edit\/|\/settings|\/vision$/, "no link edits the vision");
  }

  const other = (await board.get(`/?item=${silent.item.id}`)).body;
  assert.ok(!other.includes(AGAINST_VISION_WARNING), "no warning when going ahead goes against no line");
  const review = await board.post(fields(silent.item, { answer: "option:R1", step: "review" }));
  assert.equal(reviewOf(review.reply).warning, null);
  assert.ok(!review.body.includes(AGAINST_VISION_WARNING));
});

test("the receipt shows who answered, when, the item version, the new state, what happens next and the comment, with Next decision", async (t) => {
  const board = await serveBoard(t);
  const older = board.raise(board.github, 6, { kind: "contradiction" });
  const { ticket, item } = board.raise(board.github, 7, { kind: "contradiction" });
  const newer = board.raise(board.gitlab, 8, { kind: "contradiction" });
  const recorded = await board.post(fields(item, { answer: "dont-go-ahead", note: "Offline only.", step: "record" }));
  assert.equal(recorded.reply?.kind, "recorded");
  const receipt = await board.get(`/?item=${item.id}`);
  assert.equal(receipt.status, 200);
  const text = parsePage(receipt.body).text;
  const answer = board.store.answerFor(item.id)!;
  assert.match(text, new RegExp(`Answered by Ada Owner at ${answer.answeredAt.slice(0, 10)} ${answer.answeredAt.slice(11, 16)} UTC · item version 1`));
  assert.match(text, /The answer: Don't go ahead\./);
  assert.match(text, /Your note, private: kept in entail's records only:\s*Offline only\./);
  assert.match(text, /The ticket's new state: cancelled\./);
  assert.match(text, /entail cancels the ticket, comments on the issue and closes it as not planned\./);
  assert.match(text, /The comment entail posts on the issue/);
  assert.equal(previewedComment(receipt.body), answerComment(OWNER, ticket.id, answer, board.store.boardItem(item.id)!.item.snapshot as BoardItemSnapshot, "github"));

  const next = /<a class="next-decision" href="([^"]*)">Next decision<\/a>/.exec(receipt.body)?.[1];
  assert.equal(next, `/?item=${older.item.id}`, "Next decision opens the oldest open item");
  assert.notEqual(next, `/?item=${newer.item.id}`);
  assert.ok(!parsePage(receipt.body).forms.some((f) => f.controls.some((c) => c.name === "answer")), "the receipt takes the form's place");
});

test("an answer recorded while its host is halted keeps its comment, and the receipt says it is posted when the host answers again", async (t) => {
  let halted = false;
  const board = await serveBoard(t, { hostHalted: (host) => halted && host === "github.com" });
  const { item } = board.raise(board.github, 7, { kind: "contradiction" });
  await board.post(fields(item, { answer: "dont-go-ahead", step: "record" }));
  halted = true;
  const receipt = parsePage((await board.get(`/?item=${item.id}`)).body).text;
  assert.match(receipt, /entail cannot reach github\.com now\. Your answer is recorded, and the comment is kept and posted when github\.com answers again\./);
  assert.match(receipt, /The comment entail posts on the issue/);
  const live = JSON.parse((await send(board.server.info.port, { path: `${BOARD_DATA_PATH}?item=${item.id}` })).body) as BoardData;
  assert.equal(live.detail.kind === "item" && live.detail.state.kind === "answered" && live.detail.state.receipt.unreachable, "github.com", "the live board says so too");
});

test("once the answer's comment is posted, the receipt links it", async (t) => {
  const board = await serveBoard(t);
  const { ticket, item } = board.raise(board.github, 7, { kind: "contradiction" });
  await board.post(fields(item, { answer: "dont-go-ahead", step: "record" }));
  assert.doesNotMatch((await board.get(`/?item=${item.id}`)).body, /Posted on the issue/);

  const answer = board.store.answerFor(item.id)!;
  const call = board.store.recordCall({ ticketId: ticket.id, kind: "cancel-on-answer", reason: "The owner decided not to go ahead.", answerId: answer.id, stateTo: "cancelled" });
  const intent = board.store.recordForgeWriteIntent({ repoId: board.github.id, ticketId: ticket.id, callId: call.id, kind: "comment", target: "issue", number: 7, payload: { body: "x" } });
  board.store.confirmForgeWrite({ intentId: intent.id, comment: { id: "c1", url: "https://github.com/acme/tally/issues/7#issuecomment-1" } });
  const receipt = await board.get(`/?item=${item.id}`);
  assert.match(receipt.body, /Posted on the issue: <a href="https:\/\/github\.com\/acme\/tally\/issues\/7#issuecomment-1">entail&#x27;s comment<\/a>\./);
});

test("the acceptance board driver answers through the real board: review, then record as the owner", async (t) => {
  const board = await serveBoard(t);
  const t7 = FIXTURE_ISSUES.find((issue) => issue.id === "T7")!;
  const { item } = board.raise(board.github, 7, { kind: "contradiction" }, { title: t7.title });
  const events: HarnessEvent[] = [];
  const driver = new BoardDriver({ boardUrl: `${board.server.info.origin}/`, log: (event) => events.push(event) });
  await driver.pass();
  assert.deepEqual(
    events.map((e) => (e as { event: string }).event),
    ["answered"],
    JSON.stringify(events),
  );
  const answer = board.store.answerFor(item.id)!;
  assert.deepEqual([answer.shape, answer.answeredBy, answer.itemVersion], ["dont-go-ahead", OWNER, 1]);
});

test("an answer enters only through the answer form's final step: no other path, method or origin records one", async (t) => {
  const board = await serveBoard(t);
  const { item } = board.raise(board.github, 7, { kind: "contradiction" });
  const answer = fields(item, { token: board.server.info.token, answer: "dont-go-ahead", step: "record" });
  const port = board.server.info.port;
  for (const path of ["/", BOARD_DATA_PATH, "/calls", "/settings"]) {
    const reply = await postForm(port, path, answer);
    assert.ok(reply.status >= 400, `POST ${path} records nothing (${reply.status})`);
  }
  assert.equal((await send(port, { path: `${BOARD_ANSWER_PATH}?${new URLSearchParams(answer)}` })).status, 405, "a link cannot record an answer");
  const foreign = await postForm(port, BOARD_ANSWER_PATH, answer, { Origin: "https://github.com" });
  assert.equal(foreign.status, 403, "a page on the forge cannot post an answer");
  const json = await send(port, { method: "POST", path: BOARD_ANSWER_PATH, headers: { Origin: board.server.info.origin, "Content-Type": "application/json" }, body: JSON.stringify(answer) });
  assert.equal(json.status, 415, "only the form's own encoding is taken");
  assert.equal(board.store.answerFor(item.id), null);
});

test("the command line has no way to answer a board item", (t) => {
  const home = mkdtempSync(join(tmpdir(), "entail-answer-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, XDG_DATA_HOME: join(home, "xdg") };
  const cli = join(import.meta.dirname, "..", "..", "src", "cli.ts");
  const answer = spawnSync(process.execPath, [cli, "answer", "1", "dont-go-ahead"], { env, encoding: "utf8" });
  assert.equal(answer.status, 2);
  assert.match(answer.stderr, /unknown command: answer/);
  const usage = spawnSync(process.execPath, [cli, "--help"], { env, encoding: "utf8" });
  assert.doesNotMatch(usage.stdout, /answer/i, "no command answers a board item");
});
