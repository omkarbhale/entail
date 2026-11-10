import type { HealthCondition } from "./health.ts";

/**
 * What the local server and the board app in the browser (src/ui) agree on
 * (ADR-0021): the paths and fields both use, and the JSON the server sends the
 * app. The app is a single-page app built with React; the server sends it data
 * and the app renders it, so moving between pages and answering an item never
 * reload the page.
 *
 * This module holds constants and types only, with type-only imports, so the
 * app's bundle takes nothing else from the server.
 */

/** The board: the inbox of open items beside the selected one (spec §13). */
export const BOARD_PATH = "/";
/** Where the app asks for the board while it is open: local traffic, no forge requests (ADR-0012). */
export const BOARD_DATA_PATH = "/board/data";
/** How often the app asks: every few seconds. */
export const BOARD_POLL_MS = 3000;
/** The query parameter naming the selected item, as `boardItemLink` writes it. */
export const ITEM_PARAM = "item";
/** Where the answer form posts: to review an answer, record it as final, or go back. */
export const BOARD_ANSWER_PATH = "/board/answer";
/** Where the app's own script and stylesheet are served from. */
export const APP_ASSETS_PATH = "/ui/";
/** The id of the JSON the first page load carries for the app to start from. */
export const BOOT_ELEMENT_ID = "entail-boot";
/** The id of the element the app renders into. */
export const APP_ELEMENT_ID = "app";
/** The hidden field that carries the per-start token on every form. */
export const TOKEN_FIELD = "token";

/** The answer form's fields. The per-start token travels beside them in {@link TOKEN_FIELD}. */
export const ANSWER_FIELDS = {
  item: "item",
  version: "version",
  answer: "answer",
  text: "text",
  note: "note",
  showNote: "show_note",
  step: "step",
} as const;

/** One page listed in the shared header. */
export interface NavLink {
  path: string;
  label: string;
}

/** What the shared header shows on every page: the pages, and entail's health (spec §16). */
export interface Chrome {
  nav: readonly NavLink[];
  /** Null when entail's health could not be read; the header then shows no health at all. */
  health: { strip: readonly HealthCondition[]; lastPass: string | null } | null;
}

/** A page the server renders as HTML, which the app shows in place. */
export interface HtmlView {
  kind: "html";
  status: number;
  title: string;
  /** The page's own HTML, already escaped by the server. */
  body: string;
  wide: boolean;
  chrome: Chrome;
}

/** The board, which the app renders itself from {@link BoardData}. */
export interface BoardView {
  kind: "board";
  status: number;
  title: string;
  data: BoardData;
  chrome: Chrome;
}

/** What the server sends for a page the app asked for, and what the first page load starts from. */
export type PageView = HtmlView | BoardView;

/** How an item on the board stands. */
export type BoardItemStatus = "open" | "answered" | "withdrawn";

/** One item in the board's list. */
export interface ListEntry {
  id: number;
  decision: string;
  repo: string;
  forge: string;
  /** How long ago it was raised, in a few words. */
  ago: string;
  /** Why it was raised, as a kind for styling and a tag to read. */
  why: { kind: string; tag: string };
  status: BoardItemStatus;
  locked: boolean;
}

/** One vision line in an item's vision check. */
export interface VisionLineView {
  mark: string;
  markWords: string;
  text: string;
  heading: string | null;
  permalink: string;
  lineNumber: number;
}

/** One event in what happened on the ticket, newest first. */
export interface HappenedEvent {
  at: string;
  /** What it was: a call's kind, or who answered. */
  label: string;
  /** Set when it happened on an earlier ticket for the same issue. */
  otherTicket: string | null;
  text: string;
  /** A call's state change, as `from → to`. */
  stateChange: string | null;
}

/** One way to go ahead the answer form offers. */
export interface OptionView {
  id: string;
  title: string;
  outcome: string;
  /** The warning shown when going ahead this way goes against a vision line. */
  warning: string | null;
}

/** An answer's note: none, private, or shown on the issue. */
export interface NoteView {
  text: string | null;
  shown: boolean;
}

/** What an answer does to its ticket. */
export interface OutcomeView {
  stateWords: string;
  next: string[];
}

/** The receipt in place on an answered item. */
export interface ReceiptView {
  answeredBy: string;
  answeredAt: string;
  itemVersion: number;
  words: string;
  note: NoteView;
  outcome: OutcomeView;
  /** The comment entail posts on the issue, or null when it posts none. */
  comment: string | null;
  /** The posted comment's link, once it is on the issue. */
  posted: string | null;
  /** The item's host while entail cannot reach it, so the comment waits. */
  unreachable: string | null;
}

/** The selected item's state, which the app re-reads every few seconds. */
export type ItemState =
  | { kind: "open" }
  | { kind: "paused" }
  | { kind: "catching-up" }
  | { kind: "halted"; host: string }
  | { kind: "withdrawn"; reason: string; next: string | null }
  | { kind: "answered"; receipt: ReceiptView }
  /** Set by the app, never sent: the item it shows has left the board since. */
  | { kind: "left" };

/** The selected item with its parts in the order spec §13 lists them. */
export interface ItemView {
  kind: "item";
  id: number;
  /** The item version the form shows and submits. */
  version: number;
  ticketId: number;
  status: BoardItemStatus;
  meta: { repo: string; forge: string; issueNumber: number | null; raisedAt: string; ago: string };
  /** 1. The decision, one sentence. */
  decision: string;
  state: ItemState;
  /** 2. Why it was raised. */
  why: string;
  /** 3. The vision check, or null when not recorded. */
  visionCheck: { commit: string; visionPath: string; lines: VisionLineView[] } | null;
  /** 4. What the ticket was, or null when not recorded. */
  ticket: { title: string; number: number; href: string; filedBy: string | null; request: string } | null;
  /** 5. What happened, or null when not recorded; the ticket's history is linked either way. */
  happened: HappenedEvent[] | null;
  historyPath: string;
  /** 6. The answer form's options and what "Don't go ahead" does. */
  form: { options: OptionView[]; dontGoAheadOutcome: string };
}

/** What the board shows beside its list. */
export type BoardDetail =
  | ItemView
  | { kind: "left"; id: number; decision: string; answered: boolean; historyPath: string }
  | { kind: "unknown" }
  | { kind: "empty" };

/** The board as the app renders it. */
export interface BoardData {
  title: string;
  /** The per-start token every answer carries back. */
  token: string;
  pollMs: number;
  /** The owner's display name, whom answers are recorded as; null until set. */
  owner: string | null;
  links: { calls: string; settings: string };
  open: ListEntry[];
  endedToday: ListEntry[];
  /** The selected item: the one asked for, or else the oldest open item. */
  selected: number | null;
  /** Whether the selected item was asked for by id. */
  asked: boolean;
  /** The oldest open item, which "Next decision" opens. */
  nextId: number | null;
  detail: BoardDetail;
}

/** What the owner filled in, exactly as the form sent it. */
export interface AnswerDraft {
  /** `option:<id>`, `own-words` or `dont-go-ahead`; empty when nothing was chosen. */
  answer: string;
  text: string;
  note: string;
  showNote: boolean;
}

/** "Review answer": what would be recorded, what happens next and the exact comment, with nothing recorded. */
export interface ReviewView {
  owner: string;
  words: string;
  /** The vision-line warning, when going ahead this way goes against one. */
  warning: string | null;
  note: NoteView;
  outcome: OutcomeView;
  /** The exact comment entail will post, or null when it posts none. */
  comment: string | null;
}

/** The answer form's reply, as JSON. */
export type AnswerReply =
  | { kind: "form"; itemId: number; draft: AnswerDraft; error: string | null; refusal: string | null }
  | { kind: "review"; itemId: number; draft: AnswerDraft; review: ReviewView }
  | { kind: "recorded"; itemId: number }
  | { kind: "unknown"; message: string };
