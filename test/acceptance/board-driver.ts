// The board driver: the harness answering board items as the owner, through
// the real board form on localhost (ADR-0008, ADR-0010). It reads the board
// page and the item pages it links to, fills the answer form the way a person
// would, presses "Review answer", then "Record answer as <owner> (final)". The
// form's own hidden fields, the per-start token and the item version among
// them, go back exactly as the page gave them; the driver never writes to
// entail's store.
import { fixtureIssueByTitle, FIXTURE_ISSUES, type TicketId } from "./fixture.ts";
import type { Forge } from "./forge.ts";
import { formData, parsePage, submitButtons, type Control, type Form, type Page } from "./html.ts";
import { EXPECTED_ANSWERS, EXTRA_ANSWERS, LANDING_PIN_ANSWER, type PreparedAnswer } from "./prepared.ts";
import type { Log } from "./reset.ts";

const REVIEW = /review answer/i;
const RECORD = /record answer/i;
const DONT_GO_AHEAD = /don['’]?t go ahead/i;
const OWN_WORDS = /own words/i;
const MERGE_AS_IT_IS = /merge this pr as it is/i;
/** Pages that are not the board: the Calls page, ticket pages, the Repos page and settings. */
const NOT_BOARD = /\/(calls|tickets?|repos|settings)(\/|$)/i;
const ISSUE_LINK = /\/(?:-\/)?issues\/(\d+)\/?$/;

export interface BoardDriverOptions {
  /** The board page, `http://127.0.0.1:7419/` by default. */
  boardUrl: string;
  /** Used to name an item's ticket from its issue number when the link text is not the title. */
  forges?: readonly Forge[];
  log: Log;
  fetch?: typeof fetch;
}

interface FoundItem {
  url: string;
  form: Form;
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

  async #get(url: URL): Promise<Page> {
    const response = await this.#fetch(url, { redirect: "follow" });
    if (!response.ok) throw new BoardDriverError(`GET ${url} answered ${response.status}`);
    return parsePage(await response.text());
  }

  async #submit(pageUrl: string, form: Form, button: Control): Promise<{ url: string; page: Page }> {
    const target = new URL(form.action || pageUrl, pageUrl);
    if (target.origin !== this.#board.origin) throw new BoardDriverError(`form posts to another origin: ${target}`);
    const data = formData(form, button);
    const init: RequestInit =
      form.method === "post"
        ? {
            method: "POST",
            body: data.toString(),
            headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: this.#board.origin },
            redirect: "follow",
          }
        : { method: "GET", redirect: "follow" };
    if (form.method !== "post") target.search = data.toString();
    const response = await this.#fetch(target, init);
    const text = await response.text();
    if (!response.ok) {
      throw new BoardDriverError(`${init.method} ${target} answered ${response.status}: ${parsePage(text).text.slice(0, 300)}`);
    }
    return { url: response.url || target.href, page: parsePage(text) };
  }

  /** The open items' answer forms on the board page and the board pages it links to. */
  async #items(): Promise<FoundItem[]> {
    const board = await this.#get(this.#board);
    const pages: { url: string; page: Page }[] = [{ url: this.#board.href, page: board }];
    const seen = new Set([this.#board.href]);
    for (const link of board.links) {
      const url = new URL(link.href, this.#board);
      url.hash = "";
      if (url.origin !== this.#board.origin || seen.has(url.href) || NOT_BOARD.test(url.pathname)) continue;
      seen.add(url.href);
      pages.push({ url: url.href, page: await this.#get(url) });
    }
    const items: FoundItem[] = [];
    const keys = new Set<string>();
    for (const { url, page } of pages) {
      for (const form of page.forms) {
        const buttons = submitButtons(form).filter((b) => !b.disabled);
        if (!buttons.some((b) => REVIEW.test(b.label) || RECORD.test(b.label))) continue;
        const hidden = form.controls.filter((c) => c.type === "hidden").map((c) => `${c.name}=${c.value}`);
        const key = `${new URL(form.action || url, url).href}?${hidden.sort().join("&")}`;
        if (keys.has(key)) continue;
        keys.add(key);
        const { ticket, issue } = await this.#ticketOf(page, form);
        items.push({ url, form, ticket, issue, key });
      }
    }
    return items;
  }

  /** The ticket an item is for: the issue linked closest before its form. */
  async #ticketOf(page: Page, form: Form): Promise<{ ticket: TicketId | undefined; issue: string | undefined }> {
    const before = page.links.filter((l) => l.offset < form.offset && ISSUE_LINK.test(new URL(l.href, this.#board).pathname));
    const link = before.at(-1) ?? page.links.find((l) => ISSUE_LINK.test(l.href));
    if (link) {
      const byText = fixtureIssueByTitle(link.text);
      if (byText) return { ticket: byText.id, issue: link.href };
      const title = await this.#titleOf(link.href);
      const byNumber = title === undefined ? undefined : fixtureIssueByTitle(title);
      if (byNumber) return { ticket: byNumber.id, issue: link.href };
    }
    // Last resort: the only fixture title quoted on the page.
    const titles = FIXTURE_ISSUES.filter((issue) => page.text.includes(issue.title));
    return { ticket: titles.length === 1 ? titles[0]!.id : undefined, issue: link?.href };
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

  #answerFor(item: FoundItem): { answer: PreparedAnswer; extra: boolean } | undefined {
    if (item.form.controls.some((c) => MERGE_AS_IT_IS.test(c.label))) {
      return { answer: { shape: "option", label: LANDING_PIN_ANSWER.label, fallback: "" }, extra: true };
    }
    if (!item.ticket) return undefined;
    const expected = EXPECTED_ANSWERS.get(item.ticket);
    if (expected) return { answer: expected, extra: false };
    const extra = EXTRA_ANSWERS.get(item.ticket);
    return extra ? { answer: extra, extra: true } : undefined;
  }

  /** Checks the board once and answers every open item it has an answer for. */
  async pass(): Promise<void> {
    for (const item of await this.#items()) {
      if (this.#handled.has(item.key)) continue;
      const chosen = this.#answerFor(item);
      if (!chosen) {
        this.#handled.add(item.key);
        const expected = item.ticket === "T8";
        this.#log({ event: expected ? "left-unanswered" : "extra-item-unanswered", ticket: item.ticket ?? null, issue: item.issue ?? null, extra: !expected });
        continue;
      }
      try {
        const receipt = await this.#answer(item, chosen.answer);
        this.#handled.add(item.key);
        this.#log({
          event: "answered",
          ticket: item.ticket ?? null,
          issue: item.issue ?? null,
          answer: chosen.answer,
          extra: chosen.extra,
          receipt: receipt.slice(0, 500),
        });
      } catch (error) {
        const failures = (this.#failures.get(item.key) ?? 0) + 1;
        this.#failures.set(item.key, failures);
        if (failures >= 3) this.#handled.add(item.key);
        this.#log({ event: "answer-failed", ticket: item.ticket ?? null, issue: item.issue ?? null, attempt: failures, error: String(error) });
      }
    }
  }

  async #answer(item: FoundItem, answer: PreparedAnswer): Promise<string> {
    const form = fillAnswer(item.form, answer);
    const buttons = submitButtons(form).filter((b) => !b.disabled);
    const review = buttons.find((b) => REVIEW.test(b.label)) ?? buttons.find((b) => RECORD.test(b.label))!;
    let result = await this.#submit(item.url, form, review);
    if (REVIEW.test(review.label)) {
      // "Review answer" records nothing; the final step is "Record answer as <owner> (final)".
      const confirm = result.page.forms
        .map((f) => ({ form: f, button: submitButtons(f).find((b) => RECORD.test(b.label) && !b.disabled) }))
        .find((f) => f.button);
      if (!confirm?.button) throw new BoardDriverError(`the review page has no "Record answer" step: ${result.page.text.slice(0, 300)}`);
      result = await this.#submit(result.url, confirm.form, confirm.button);
    }
    return result.page.text;
  }
}

function check(form: Form, control: Control): void {
  for (const other of form.controls) {
    if (other.type === "radio" && other.name === control.name) other.checked = other === control;
  }
  control.checked = true;
}

/** A copy of an answer form, filled in with a prepared answer. */
export function fillAnswer(original: Form, answer: PreparedAnswer): Form {
  const form: Form = { ...original, controls: original.controls.map((c) => ({ ...c, options: [...c.options] })) };
  const choices = form.controls.filter((c) => c.type === "radio" && !c.disabled);
  const selects = form.controls.filter((c) => c.tag === "select" && !c.disabled);

  const choose = (pattern: RegExp): boolean => {
    const radio = choices.find((c) => pattern.test(c.label));
    if (radio) {
      check(form, radio);
      return true;
    }
    for (const select of selects) {
      const option = select.options.find((o) => pattern.test(o.text));
      if (option) {
        select.value = option.value;
        return true;
      }
    }
    return false;
  };

  const ownWords = (text: string) => {
    if (!choose(OWN_WORDS)) throw new BoardDriverError('the form has no "Answer in my own words"');
    const fields = form.controls.filter(
      (c) => !c.disabled && (c.tag === "textarea" || (c.tag === "input" && c.type === "text")),
    );
    const describe = (c: Control) => `${c.name} ${c.label} ${c.placeholder}`;
    const field =
      fields.find((c) => !/note/i.test(describe(c)) && /word|answer|text|what should/i.test(describe(c))) ??
      fields.find((c) => !/note/i.test(describe(c)));
    if (!field) throw new BoardDriverError("the form has no field for the owner's own words");
    field.value = text;
  };

  switch (answer.shape) {
    case "don't go ahead":
      if (!choose(DONT_GO_AHEAD)) throw new BoardDriverError('the form has no "Don\'t go ahead"');
      break;
    case "own words":
      ownWords(answer.text);
      break;
    case "option": {
      const escaped = answer.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!choose(new RegExp(escaped, "i"))) {
        if (!answer.fallback) throw new BoardDriverError(`the form has no option "${answer.label}"`);
        ownWords(answer.fallback);
      }
      break;
    }
  }
  return form;
}
