import { createElement as h, Fragment, useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import {
  ANSWER_FIELDS,
  BOARD_PATH,
  ITEM_PARAM,
  TOKEN_FIELD,
  type AnswerDraft,
  type AnswerReply,
  type BoardData,
  type ItemState,
  type ItemView,
  type ListEntry,
  type NoteView,
  type OutcomeView,
  type ReceiptView,
  type ReviewView,
} from "../app-view.ts";
import { Spinner, Time } from "./parts.ts";

/**
 * The board, rendered in the browser from the board's data (spec §13,
 * ADR-0012, ADR-0021): an inbox of the open items, oldest raised first across
 * all repos, beside the selected item with its parts in order. Every few
 * seconds it asks for the board again and refreshes the count, the list and
 * the shown item's state, with no reload. When the item is withdrawn,
 * answered, locked or gone, its form locks in place: what the owner typed
 * stays visible to copy and nothing more can be sent.
 *
 * The answer form is the one path an answer enters entail (ADR-0008): "Review
 * answer" records nothing and shows the review; "Record answer as <owner>
 * (final)" records it, and the receipt then stays in place. While either is in
 * flight the form shows it, and nothing can be sent twice.
 */

/** What the board needs from the server; the app passes the real one and tests a stand-in. */
export interface BoardApi {
  /** The board's data for one item, or for the oldest open item when none is named. */
  load(item: number | null): Promise<BoardData>;
  /** Posts the answer form, and reads its reply. */
  answer(fields: URLSearchParams): Promise<AnswerReply>;
  /** Names the shown item in the address bar, without a reload or a new history entry. */
  showItem(id: number): void;
  /** Tells the page an action is in flight, or done (null). */
  busy(what: string | null): void;
}

/** What the selected item's form part shows: the form, perhaps with what was refused, or the review. */
type Panel = { kind: "form"; error: string | null; refusal: string | null } | { kind: "review"; review: ReviewView };

/** Which step of the answer form is in flight. */
type Sending = "review" | "record" | null;

const EMPTY_DRAFT: AnswerDraft = { answer: "", text: "", note: "", showNote: false };

export function itemPath(id: number): string {
  return `${BOARD_PATH}?${ITEM_PARAM}=${id}`;
}

/**
 * Merges what a poll read into what the board shows. The count, the list and
 * the shown item's state are taken as read; the shown item itself stays as it
 * was first shown, so the form keeps the version it showed (ADR-0012). When
 * the item has left the board since, its state says so.
 */
export function mergePoll(shown: BoardData, read: BoardData): BoardData {
  const current = shown.detail;
  if (current.kind !== "item") return read;
  const next = read.detail;
  const merged = { ...read, selected: shown.selected, asked: shown.asked };
  if (next.kind === "item" && next.id === current.id) return { ...merged, detail: { ...current, status: next.status, state: next.state } };
  return { ...merged, detail: { ...current, state: { kind: "left" } } };
}

/**
 * What the board shows after a poll, and the item to name in the address bar
 * when it changed: the empty board shows the oldest item once one is raised,
 * and otherwise the poll is merged into what is shown. The board never moves
 * on from an item by itself.
 */
export function afterPoll(shown: BoardData, read: BoardData): { data: BoardData; show: number | null } {
  if (shown.selected === null && read.detail.kind === "item") return { data: { ...read, asked: true }, show: read.detail.id };
  return { data: mergePoll(shown, read), show: null };
}

/** Whether an item's form takes no answer now. */
function lockedState(state: ItemState): boolean {
  return state.kind !== "open";
}

export function Board({ initial, api }: { initial: BoardData; api: BoardApi }): ReactNode {
  const [data, setData] = useState(initial);
  const [from, setFrom] = useState(initial);
  // The app moved to another item, or loaded the board again: show what it loaded.
  if (initial !== from) {
    setFrom(initial);
    setData(initial);
  }
  const [drafts, setDrafts] = useState<ReadonlyMap<number, AnswerDraft>>(new Map());
  const [panels, setPanels] = useState<ReadonlyMap<number, Panel>>(new Map());
  const [sending, setSending] = useState<Sending>(null);
  const shown = useRef(data);
  shown.current = data;

  // Every few seconds, ask for the board again; a poll in flight is never doubled.
  useEffect(() => {
    let polling = false;
    let stopped = false;
    const timer = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const before = shown.current;
        const read = await api.load(before.selected);
        if (stopped || shown.current !== before) return;
        const next = afterPoll(before, read);
        if (next.show !== null) api.showItem(next.show);
        setData(next.data);
      } catch {
        // entail may be restarting; the next poll tries again.
      } finally {
        polling = false;
      }
    }, data.pollMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [api, data.pollMs]);

  useEffect(() => {
    document.title = `${data.title} · entail`;
  }, [data.title]);

  const detail = data.detail;
  const draftOf = (id: number) => drafts.get(id) ?? EMPTY_DRAFT;
  const setDraft = (id: number, draft: AnswerDraft | null) =>
    setDrafts((before) => {
      const next = new Map(before);
      if (draft === null) next.delete(id);
      else next.set(id, draft);
      return next;
    });
  const setPanel = (id: number, panel: Panel | null) =>
    setPanels((before) => {
      const next = new Map(before);
      if (panel === null) next.delete(id);
      else next.set(id, panel);
      return next;
    });

  const send = async (item: ItemView, step: "review" | "record", draft: AnswerDraft) => {
    if (sending !== null) return;
    const fields = new URLSearchParams();
    fields.set(TOKEN_FIELD, data.token);
    fields.set(ANSWER_FIELDS.item, String(item.id));
    fields.set(ANSWER_FIELDS.version, String(item.version));
    fields.set(ANSWER_FIELDS.answer, draft.answer);
    fields.set(ANSWER_FIELDS.text, draft.text);
    fields.set(ANSWER_FIELDS.note, draft.note);
    if (draft.showNote) fields.set(ANSWER_FIELDS.showNote, "1");
    fields.set(ANSWER_FIELDS.step, step);
    setSending(step);
    api.busy(step === "review" ? "Reviewing your answer…" : "Recording your answer…");
    try {
      const reply = await api.answer(fields);
      if (reply.kind === "review") {
        setPanel(item.id, { kind: "review", review: reply.review });
      } else if (reply.kind === "form") {
        setDraft(item.id, reply.draft);
        setPanel(item.id, { kind: "form", error: reply.error, refusal: reply.refusal });
        // A refused answer shows the item as it stands now: withdrawn, answered or at its current version.
        if (reply.refusal !== null) setData(await api.load(item.id));
      } else if (reply.kind === "recorded") {
        // The receipt stays in place on the item; the board does not move on by itself.
        const loaded = await api.load(item.id);
        setDraft(item.id, null);
        setPanel(item.id, null);
        setData(loaded);
      } else {
        setPanel(item.id, { kind: "form", error: null, refusal: reply.message });
      }
    } catch (error) {
      setPanel(item.id, { kind: "form", error: `entail did not answer, so nothing was recorded: ${messageOf(error)} Try again.`, refusal: null });
    } finally {
      setSending(null);
      api.busy(null);
    }
  };

  let body: ReactNode;
  if (detail.kind === "item") {
    body = h(Item, {
      item: detail,
      nextId: data.nextId,
      owner: data.owner,
      draft: draftOf(detail.id),
      touched: drafts.has(detail.id) || panels.has(detail.id),
      panel: panels.get(detail.id) ?? null,
      sending,
      onDraft: (draft: AnswerDraft) => setDraft(detail.id, draft),
      onReview: () => send(detail, "review", draftOf(detail.id)),
      onRecord: () => send(detail, "record", draftOf(detail.id)),
      onBack: () => setPanel(detail.id, { kind: "form", error: null, refusal: null }),
    });
  } else if (detail.kind === "left") {
    body = [
      h("h2", { key: "d", className: "decision" }, detail.decision),
      h(
        "p",
        { key: "p" },
        `This item has left the board: it was ${detail.answered ? "answered" : "withdrawn"} before today. `,
        h("a", { href: detail.historyPath }, "Its ticket's history"),
        " keeps it, and the ",
        h("a", { href: data.links.calls }, "Calls page"),
        " has every call.",
      ),
    ];
  } else if (detail.kind === "unknown") {
    body = h("p", null, "entail has no board item with this id.");
  } else {
    body = h("p", { className: "empty" }, "Nothing needs you.");
  }

  return h(
    "div",
    { id: "board", className: "board" },
    h(
      "div",
      { className: "board-head" },
      h("h1", null, "Board ", h("span", { id: "board-count", className: "count" }, `· ${data.open.length} open`)),
      h("a", { href: data.links.calls }, "Calls"),
      h(
        "span",
        { className: "muted answering" },
        "answering as ",
        data.owner === null ? h("a", { href: data.links.settings }, "no one yet: set your display name") : h("strong", null, data.owner),
      ),
    ),
    h(
      "div",
      { className: "inbox" },
      h(List, { data }),
      h("article", { id: "item", className: "item", "aria-live": "polite" }, body),
    ),
  );
}

function List({ data }: { data: BoardData }): ReactNode {
  const entry = (e: ListEntry) =>
    h(
      "li",
      { key: e.id },
      h(
        "a",
        { href: itemPath(e.id), "aria-current": e.id === data.selected ? "true" : undefined },
        h("span", { className: "d" }, e.decision),
        h(
          "span",
          { className: "m" },
          `${e.repo} · ${e.forge} · ${e.ago} `,
          h("span", { className: `tag why-${e.why.kind}` }, e.why.tag),
          e.status === "open" ? (e.locked ? [" ", h("span", { key: "s", className: "tag status" }, "locked")] : null) : [" ", h("span", { key: "s", className: "tag status" }, e.status)],
        ),
      ),
    );
  return h(
    "nav",
    { id: "board-list", className: "list", "aria-label": "Board items" },
    h("h2", null, `Needs you · ${data.open.length}`),
    data.open.length === 0 ? h("p", { className: "muted" }, "Nothing needs you.") : h("ol", { className: "entries" }, data.open.map(entry)),
    data.endedToday.length === 0
      ? null
      : [h("h2", { key: "h" }, "Answered or withdrawn today"), h("ol", { key: "l", className: "entries ended" }, data.endedToday.map(entry))],
  );
}

export interface ItemProps {
  item: ItemView;
  nextId: number | null;
  owner: string | null;
  draft: AnswerDraft;
  /** Whether the owner has started answering this item here, so its form stays even once it locks. */
  touched: boolean;
  panel: Panel | null;
  sending: Sending;
  onDraft(draft: AnswerDraft): void;
  onReview(): void;
  onRecord(): void;
  onBack(): void;
}

/** The selected item: its parts in the order spec §13 lists them, with its state after the decision. */
export function Item(props: ItemProps): ReactNode {
  const { item } = props;
  const meta = item.meta;
  return h(
    Fragment,
    null,
    h(
      "p",
      { className: "muted item-meta" },
      `${meta.repo} · ${meta.forge}${meta.issueNumber === null ? "" : ` · issue #${meta.issueNumber}`} · raised `,
      h(Time, { iso: meta.raisedAt }),
      ` (${meta.ago})`,
    ),
    h("section", { "data-part": "decision" }, h("h2", { className: "decision" }, item.decision)),
    h(StateBox, { state: item.state, nextId: props.nextId }),
    h("section", { "data-part": "why", className: "why" }, h("h3", null, "Why it was raised"), h("p", null, item.why)),
    h(VisionCheck, { item }),
    h(Ticket, { item }),
    h(Happened, { item }),
    h(FormPart, props),
  );
}

function VisionCheck({ item }: { item: ItemView }): ReactNode {
  const check = item.visionCheck;
  const heading = h("h3", null, "Vision check");
  if (check === null) return h("section", { "data-part": "vision-check" }, heading, h("p", { className: "muted" }, "Not recorded."));
  return h(
    "section",
    { "data-part": "vision-check" },
    heading,
    h("p", { className: "hint" }, `Only the lines that bear on this issue, quoted from ${check.visionPath} at `, h("code", null, check.commit), "."),
    check.lines.length === 0
      ? h("p", { className: "muted" }, "No vision line bears on this issue.")
      : h(
          "ul",
          { className: "vision" },
          check.lines.map((line) =>
            h(
              "li",
              { key: `${line.lineNumber}:${line.text}`, className: `vline mark-${line.mark}` },
              h("span", { className: "mark" }, line.markWords),
              h("q", null, line.text),
              line.heading ? [" ", h("span", { key: "h", className: "muted" }, `under “${line.heading}”`)] : null,
              " ",
              h("a", { href: line.permalink }, `line ${line.lineNumber}`),
            ),
          ),
        ),
  );
}

function Ticket({ item }: { item: ItemView }): ReactNode {
  const ticket = item.ticket;
  const heading = h("h3", null, "What the ticket was");
  if (ticket === null) return h("section", { "data-part": "ticket" }, heading, h("p", { className: "muted" }, "Not recorded."));
  return h(
    "section",
    { "data-part": "ticket" },
    heading,
    h(
      "p",
      null,
      h("strong", null, ticket.href ? h("a", { href: ticket.href }, ticket.title) : ticket.title),
      ` · #${ticket.number}${ticket.filedBy ? ` · filed by ${ticket.filedBy}` : ""}`,
    ),
    h("p", { className: "hint" }, "The reporter's request, not your word:"),
    h("blockquote", { className: "request" }, ticket.request),
  );
}

function Happened({ item }: { item: ItemView }): ReactNode {
  const history = h("p", null, h("a", { href: item.historyPath }, "The ticket's history"));
  if (item.happened === null) return h("section", { "data-part": "happened" }, h("h3", null, "What happened"), history);
  return h(
    "section",
    { "data-part": "happened" },
    h("h3", null, "What happened"),
    h(
      "ol",
      { className: "happened" },
      item.happened.map((event, i) =>
        h(
          "li",
          { key: i },
          h(Time, { iso: event.at }),
          " ",
          h("strong", null, event.label),
          event.otherTicket === null ? null : [" ", h("span", { key: "o", className: "muted" }, `(${event.otherTicket})`)],
          `: ${event.text}`,
          event.stateChange === null ? null : [" ", h("span", { key: "c", className: "muted" }, event.stateChange)],
        ),
      ),
    ),
    history,
  );
}

function NextDecision({ nextId }: { nextId: number | null }): ReactNode {
  return nextId === null ? null : h("p", null, h("a", { className: "next-decision", href: itemPath(nextId) }, "Next decision"));
}

/** The item's state when it is not simply open: locked, withdrawn, answered, or gone from the board. */
function StateBox({ state, nextId }: { state: ItemState; nextId: number | null }): ReactNode {
  const box = (kind: string, ...children: ReactNode[]) => h("div", { id: "item-state", className: `state state-${kind}`, role: "status" }, ...children);
  switch (state.kind) {
    case "open":
      return null;
    case "paused":
      return box(
        "paused",
        h("strong", null, "This item is locked: this repo is paused."),
        h("p", null, "Its form unlocks once the repo is resumed and entail has caught up with it."),
      );
    case "catching-up":
      return box(
        "catching-up",
        h("strong", null, "This item is locked: entail is catching up with this repo after its pause."),
        h("p", null, "Its form unlocks once entail has handled what changed during the pause. If that changed this item's basis, it is withdrawn instead."),
      );
    case "halted":
      return box(
        "halted",
        h("strong", null, `This item is locked: entail cannot reach ${state.host}.`),
        h("p", null, `Its form unlocks once entail reaches ${state.host} again and has caught up.`),
      );
    case "withdrawn":
      return box(
        "withdrawn",
        h("strong", null, "Withdrawn: this item takes no answer."),
        h("p", null, state.reason),
        state.next ? h("p", null, state.next) : null,
        h("p", { className: "hint" }, "Anything you typed stays below to copy. It is not recorded."),
        h(NextDecision, { nextId }),
      );
    case "left":
      return box("left", h("strong", null, "This item has left the board."), h(NextDecision, { nextId }));
    case "answered":
      return box("answered", h(Receipt, { receipt: state.receipt }), h(NextDecision, { nextId }));
  }
}

/** The receipt: who answered, when, the item version, the new state, what happens next and the comment. */
function Receipt({ receipt }: { receipt: ReceiptView }): ReactNode {
  return h(
    Fragment,
    null,
    h("p", null, h("strong", null, `Answered by ${receipt.answeredBy}`), " at ", h(Time, { iso: receipt.answeredAt }), ` · item version ${receipt.itemVersion}`),
    h("p", null, h("span", { className: "muted" }, "The answer:"), " ", h("strong", null, receipt.words)),
    h(NoteLine, { note: receipt.note }),
    h(Outcome, { outcome: receipt.outcome }),
    receipt.comment === null
      ? null
      : h("details", null, h("summary", null, "The comment entail posts on the issue"), h("pre", { className: "comment" }, receipt.comment)),
    receipt.posted !== null
      ? h("p", { className: "posted" }, "Posted on the issue: ", h("a", { href: receipt.posted }, "entail's comment"), ".")
      : receipt.unreachable !== null
        ? h(
            "p",
            { className: "warn" },
            `entail cannot reach ${receipt.unreachable} now. Your answer is recorded, and the comment is kept and posted when ${receipt.unreachable} answers again.`,
          )
        : null,
  );
}

/** Whether the note is private or shown on the issue, as the review and receipt say it. */
function NoteLine({ note }: { note: NoteView }): ReactNode {
  if (note.text === null) return h("p", { className: "muted" }, "No note.");
  return h(
    Fragment,
    null,
    h("p", null, h("span", { className: "muted" }, `Your note, ${note.shown ? "shown on the issue" : "private: kept in entail's records only"}:`)),
    h("blockquote", { className: "note" }, note.text),
  );
}

function Outcome({ outcome }: { outcome: OutcomeView }): ReactNode {
  return h(
    Fragment,
    null,
    h("p", null, "The ticket's new state: ", h("strong", null, outcome.stateWords), "."),
    h(
      "ul",
      { className: "steps" },
      outcome.next.map((step, i) => h("li", { key: i }, step)),
    ),
  );
}

/** The item's form part: the answer form, or the review of an answer (spec §13 "Answer shapes", "Answering"). */
function FormPart(props: ItemProps): ReactNode {
  const { item, panel } = props;
  // An answered item's receipt stands in its place; a fresh view shows no form under it.
  if (item.status === "answered" && !props.touched) return null;
  return h(
    "section",
    { "data-part": "form" },
    h("h3", null, "Your answer"),
    panel?.kind === "form" && panel.refusal !== null ? h("p", { className: "refusal", role: "alert" }, h("strong", null, "Not recorded."), ` ${panel.refusal}`) : null,
    panel?.kind === "form" && panel.error !== null ? h("p", { className: "error", role: "alert" }, panel.error) : null,
    panel?.kind === "review" && !lockedState(item.state) ? h(Review, { ...props, review: panel.review }) : h(AnswerForm, props),
  );
}

/** A submit button that shows its step in flight, and sends nothing twice. */
function StepButton({ step, sending, label, pendingLabel, disabled }: { step: string; sending: Sending; label: string; pendingLabel: string; disabled: boolean }): ReactNode {
  const pending = sending === step;
  return h(
    "button",
    { type: "submit", name: ANSWER_FIELDS.step, value: step, disabled: disabled || sending !== null, className: pending ? "pending" : undefined, "aria-busy": pending || undefined },
    pending ? [h(Spinner, { key: "s" }), pendingLabel] : label,
  );
}

function AnswerForm(props: ItemProps): ReactNode {
  const { item, draft, sending } = props;
  const locked = lockedState(item.state);
  const set = (change: Partial<AnswerDraft>) => props.onDraft({ ...draft, ...change });
  const choice = (value: string, title: string, outcome: string | null, warning: string | null, cls = "") =>
    h(
      "label",
      { key: value, className: `choice${cls}` },
      h("input", {
        type: "radio",
        name: ANSWER_FIELDS.answer,
        value,
        checked: draft.answer === value,
        disabled: locked,
        onChange: () => set({ answer: value }),
      }),
      " ",
      h("span", { className: "t" }, title),
      outcome ? h("span", { className: "o" }, outcome) : null,
      warning ? h("span", { className: "warn" }, warning) : null,
    );
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!locked) props.onReview();
  };
  return h(
    "form",
    { id: "answer-form", className: "answer", method: "post", "data-locked": String(locked), "aria-busy": sending !== null || undefined, onSubmit },
    h(
      "fieldset",
      null,
      h("legend", null, "How to answer"),
      item.form.options.map((o) => choice(`option:${o.id}`, o.title, o.outcome, o.warning)),
      choice("own-words", "Answer in my own words", null, null),
      h("textarea", {
        name: ANSWER_FIELDS.text,
        "aria-label": "Your own words",
        placeholder: "What should happen? An executor will build from this.",
        readOnly: locked,
        value: draft.text,
        onChange: (event: ChangeEvent<HTMLTextAreaElement>) => set({ text: event.target.value }),
      }),
      choice("dont-go-ahead", "Don't go ahead", item.form.dontGoAheadOutcome, null, " stop"),
    ),
    h(
      "details",
      { open: draft.note.trim() !== "" || undefined },
      h("summary", null, "Add a note"),
      h("textarea", {
        name: ANSWER_FIELDS.note,
        "aria-label": "Your note",
        placeholder: "Optional. Kept in entail's records.",
        readOnly: locked,
        value: draft.note,
        onChange: (event: ChangeEvent<HTMLTextAreaElement>) => set({ note: event.target.value }),
      }),
      h(
        "label",
        { className: "choice" },
        h("input", { type: "checkbox", name: ANSWER_FIELDS.showNote, value: "1", checked: draft.showNote, disabled: locked, onChange: (event: ChangeEvent<HTMLInputElement>) => set({ showNote: event.target.checked }) }),
        " Show my note on the issue",
      ),
    ),
    h(
      "p",
      { className: "actions" },
      h(StepButton, { step: "review", sending, label: "Review answer", pendingLabel: "Reviewing…", disabled: locked }),
      h("span", { className: "hint" }, "Nothing is recorded until you confirm."),
    ),
  );
}

/**
 * "Review answer": records nothing, and shows the answer, whether the note is
 * private or shown, what happens next and the exact comment entail will post.
 * "Record answer as <owner> (final)" records it; "Back" returns to the form
 * with everything as the owner left it.
 */
function Review(props: ItemProps & { review: ReviewView }): ReactNode {
  const { review, sending } = props;
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const step = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value");
    if (step === "back") props.onBack();
    else props.onRecord();
  };
  return h(
    "div",
    { id: "review", className: "review" },
    h("p", null, h("strong", null, "Check your answer before it is recorded. Answers are final.")),
    h("p", null, h("span", { className: "muted" }, "You answer:"), " ", h("strong", null, review.words)),
    review.warning ? h("p", { className: "warn" }, review.warning) : null,
    h(NoteLine, { note: review.note }),
    h("h4", null, "What happens next"),
    h(Outcome, { outcome: review.outcome }),
    review.comment === null
      ? [h("h4", { key: "h" }, "On the issue"), h("p", { key: "p" }, "entail posts no comment for this answer: merging the PR closes the issue.")]
      : [h("h4", { key: "h" }, "On the issue, entail will post"), h("pre", { key: "p", className: "comment" }, review.comment)],
    h(
      "form",
      { id: "answer-form", className: "answer", method: "post", "data-locked": "false", "aria-busy": sending !== null || undefined, onSubmit },
      h(
        "p",
        { className: "actions" },
        h(StepButton, { step: "record", sending, label: `Record answer as ${review.owner} (final)`, pendingLabel: `Recording as ${review.owner}…`, disabled: false }),
        h("button", { type: "submit", name: ANSWER_FIELDS.step, value: "back", disabled: sending !== null }, "Back"),
      ),
    ),
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
