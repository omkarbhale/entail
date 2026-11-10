// The board driver: the harness answering board items as the owner, through
// the real board on localhost (ADR-0008, ADR-0010, ADR-0021). The board is an
// app in the browser, so the driver speaks to the server as that app does: it
// reads the board's data for each open item, fills the answer the way a
// person would, sends "Review answer", then "Record answer as <owner>
// (final)" to the answer form's endpoint. The per-start token and the item
// version go back exactly as the board gave them, with the board's `Origin`;
// the driver never writes to entail's store.
import { ANSWER_FIELDS, BOARD_ANSWER_PATH, BOARD_DATA_PATH, ITEM_PARAM, TOKEN_FIELD, type AnswerDraft, type AnswerReply, type BoardData, type ItemView, type OptionView } from "../../src/app-view.ts";
import { fixtureIssueByTitle, FIXTURE_ISSUES, type TicketId } from "./fixture.ts";
import type { Forge } from "./forge.ts";
import { EXPECTED_ANSWERS, EXTRA_ANSWERS, LANDING_PIN_ANSWER, type PreparedAnswer } from "./prepared.ts";
import type { Log } from "./reset.ts";

const MERGE_AS_IT_IS = /merge this pr as it is/i;

export interface BoardDriverOptions {
  /** The board page, `http://127.0.0.1:7419/` by default. */
  boardUrl: string;
  /** Used to name an item's ticket from its issue number when the link text is not the title. */
  forges?: readonly Forge[];
  log: Log;
  fetch?: typeof fetch;
}

interface FoundItem {
  item: ItemView;
  token: string;
  ticket: TicketId | undefined;
  issue: string | undefined;
  key: string;
}

export class BoardDriverError extends Error {}

export class BoardDriver {
  readonly #board: URL;
  readonly #forges: readonly Forge[];
  readonly #log: Log;
  readonly #fetch: typeof fetch;
  readonly #handled = new Set<string>();
  readonly #failures = new Map<string, number>();
  readonly #issueTitles = new Map<string, string>();

  constructor(options: BoardDriverOptions) {
    this.#board = new URL(options.boardUrl);
    this.#forges = options.forges ?? [];
    this.#log = options.log;
    this.#fetch = options.fetch ?? fetch;
  }

  /** The board's data, for one item or the oldest open one, as the board app reads it. */
  async #data(item: number | null): Promise<BoardData> {
    const url = new URL(BOARD_DATA_PATH, this.#board);
    if (item !== null) url.searchParams.set(ITEM_PARAM, String(item));
    const response = await this.#fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new BoardDriverError(`GET ${url} answered ${response.status}`);
    return (await response.json()) as BoardData;
  }

  /** Sends one step of the answer form, as the board app does. */
  async #send(found: FoundItem, draft: AnswerDraft, step: "review" | "record"): Promise<AnswerReply> {
    const fields = new URLSearchParams();
    fields.set(TOKEN_FIELD, found.token);
    fields.set(ANSWER_FIELDS.item, String(found.item.id));
    fields.set(ANSWER_FIELDS.version, String(found.item.version));
    fields.set(ANSWER_FIELDS.answer, draft.answer);
    fields.set(ANSWER_FIELDS.text, draft.text);
    fields.set(ANSWER_FIELDS.note, draft.note);
    if (draft.showNote) fields.set(ANSWER_FIELDS.showNote, "1");
    fields.set(ANSWER_FIELDS.step, step);
    const target = new URL(BOARD_ANSWER_PATH, this.#board);
    const response = await this.#fetch(target, {
      method: "POST",
      body: fields.toString(),
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", Origin: this.#board.origin },
    });
    const text = await response.text();
    if (!response.ok) throw new BoardDriverError(`POST ${target} (${step}) answered ${response.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as AnswerReply;
  }

  /** The open items on the board that take an answer now, each read as the board shows it. */
  async #items(): Promise<FoundItem[]> {
    const board = await this.#data(null);
    const items: FoundItem[] = [];
    for (const entry of board.open) {
      const data = await this.#data(entry.id);
      const item = data.detail;
      if (item.kind !== "item" || item.state.kind !== "open") continue;
      const { ticket, issue } = await this.#ticketOf(item);
      items.push({ item, token: data.token, ticket, issue, key: `${item.id}:${item.version}` });
    }
    return items;
  }

  /** The ticket an item is for: from its issue's title, or failing that the only fixture title it quotes. */
  async #ticketOf(item: ItemView): Promise<{ ticket: TicketId | undefined; issue: string | undefined }> {
    const issue = item.ticket?.href || undefined;
    const byText = item.ticket ? fixtureIssueByTitle(item.ticket.title) : undefined;
    if (byText) return { ticket: byText.id, issue };
    const title = issue === undefined ? undefined : await this.#titleOf(issue);
    const byNumber = title === undefined ? undefined : fixtureIssueByTitle(title);
    if (byNumber) return { ticket: byNumber.id, issue };
    // Last resort: the only fixture title quoted in the item.
    const text = JSON.stringify(item);
    const titles = FIXTURE_ISSUES.filter((fixture) => text.includes(fixture.title));
    return { ticket: titles.length === 1 ? titles[0]!.id : undefined, issue };
  }

  async #titleOf(href: string): Promise<string | undefined> {
    if (!this.#issueTitles.has(href)) {
      for (const forge of this.#forges) {
        if (!href.includes(forge.path)) continue;
        const base = (await forge.repo())?.webUrl ?? "";
        for (const issue of await forge.listIssues("all")) {
          this.#issueTitles.set(`${base}/issues/${issue.number}`, issue.title);
          this.#issueTitles.set(`${base}/-/issues/${issue.number}`, issue.title);
        }
      }
    }
    return this.#issueTitles.get(href.replace(/\/$/, ""));
  }

  #answerFor(found: FoundItem): { answer: PreparedAnswer; extra: boolean } | undefined {
    if (found.item.form.options.some((o) => MERGE_AS_IT_IS.test(o.title))) {
      return { answer: { shape: "option", label: LANDING_PIN_ANSWER.label, fallback: "" }, extra: true };
    }
    if (!found.ticket) return undefined;
    const expected = EXPECTED_ANSWERS.get(found.ticket);
    if (expected) return { answer: expected, extra: false };
    const extra = EXTRA_ANSWERS.get(found.ticket);
    return extra ? { answer: extra, extra: true } : undefined;
  }

  /** Checks the board once and answers every open item it has an answer for. */
  async pass(): Promise<void> {
    for (const found of await this.#items()) {
      if (this.#handled.has(found.key)) continue;
      const chosen = this.#answerFor(found);
      if (!chosen) {
        this.#handled.add(found.key);
        const expected = found.ticket === "T8";
        this.#log({ event: expected ? "left-unanswered" : "extra-item-unanswered", ticket: found.ticket ?? null, issue: found.issue ?? null, extra: !expected });
        continue;
      }
      try {
        const receipt = await this.#answer(found, chosen.answer);
        this.#handled.add(found.key);
        this.#log({
          event: "answered",
          ticket: found.ticket ?? null,
          issue: found.issue ?? null,
          answer: chosen.answer,
          extra: chosen.extra,
          receipt: receipt.slice(0, 500),
        });
      } catch (error) {
        const failures = (this.#failures.get(found.key) ?? 0) + 1;
        this.#failures.set(found.key, failures);
        if (failures >= 3) this.#handled.add(found.key);
        this.#log({ event: "answer-failed", ticket: found.ticket ?? null, issue: found.issue ?? null, attempt: failures, error: String(error) });
      }
    }
  }

  /** Reviews the answer, records it, and returns the receipt the board then shows. */
  async #answer(found: FoundItem, answer: PreparedAnswer): Promise<string> {
    const draft = fillAnswer(found.item.form.options, answer);
    const review = await this.#send(found, draft, "review");
    if (review.kind !== "review") throw new BoardDriverError(`"Review answer" did not show the review: ${JSON.stringify(review).slice(0, 300)}`);
    // "Review answer" records nothing; the final step is "Record answer as <owner> (final)".
    const recorded = await this.#send(found, draft, "record");
    if (recorded.kind !== "recorded") throw new BoardDriverError(`"Record answer" recorded nothing: ${JSON.stringify(recorded).slice(0, 300)}`);
    const shown = (await this.#data(found.item.id)).detail;
    if (shown.kind !== "item" || shown.state.kind !== "answered") throw new BoardDriverError("the board shows no receipt for the recorded answer");
    const r = shown.state.receipt;
    return `Answered by ${r.answeredBy} at ${r.answeredAt} · item version ${r.itemVersion}. The answer: ${r.words}. The ticket's new state: ${r.outcome.stateWords}.`;
  }
}

/** The answer a prepared answer fills in: the named option, or the owner's own words when there is none. */
export function fillAnswer(options: readonly OptionView[], answer: PreparedAnswer): AnswerDraft {
  const draft: AnswerDraft = { answer: "", text: "", note: "", showNote: false };
  switch (answer.shape) {
    case "don't go ahead":
      return { ...draft, answer: "dont-go-ahead" };
    case "own words":
      return { ...draft, answer: "own-words", text: answer.text };
    case "option": {
      const escaped = answer.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const option = options.find((o) => new RegExp(escaped, "i").test(o.title));
      if (option) return { ...draft, answer: `option:${option.id}` };
      if (!answer.fallback) throw new BoardDriverError(`the form has no option "${answer.label}"`);
      return { ...draft, answer: "own-words", text: answer.fallback };
    }
  }
}
