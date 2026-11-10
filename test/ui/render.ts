// Renders the board app's components the way the browser does, from the data
// the real server sends, so the tests read what the owner sees.
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AnswerDraft, BoardData, PageView, ReviewView } from "../../src/app-view.ts";
import { Board, Item, type BoardApi } from "../../src/ui/board.ts";
import { send } from "../http-client.ts";

/** A board API that is never called: static rendering runs no effects and sends nothing. */
export const NO_API: BoardApi = {
  load: () => Promise.reject(new Error("not called")),
  answer: () => Promise.reject(new Error("not called")),
  showItem: () => {},
  busy: () => {},
};

/** Asks the server for a page as the board app does: as JSON. */
export async function getView(port: number, path: string): Promise<{ status: number; view: PageView }> {
  const reply = await send(port, { path, headers: { Accept: "application/json" } });
  assert.match(String(reply.headers["content-type"]), /^application\/json/, `${path} answers the app with JSON`);
  return { status: reply.status, view: JSON.parse(reply.body) as PageView };
}

/** The board's data, as the app asks for it every few seconds. */
export async function getData(port: number, path: string): Promise<BoardData> {
  const reply = await send(port, { path, headers: { Accept: "application/json" } });
  assert.equal(reply.status, 200, path);
  return JSON.parse(reply.body) as BoardData;
}

/** The board as the app renders it from its data. */
export function renderBoard(data: BoardData): string {
  return renderToStaticMarkup(h(Board, { initial: data, api: NO_API }));
}

/**
 * The board page as the browser shows it: the server's JSON, rendered by the
 * app. The status is the page's own.
 */
export async function boardPage(port: number, path: string): Promise<{ status: number; body: string; data: BoardData }> {
  const { status, view } = await getView(port, path);
  assert.equal(view.kind, "board", `${path} is the board`);
  if (view.kind !== "board") throw new Error("not the board");
  return { status, body: renderBoard(view.data), data: view.data };
}

/** The selected item as the app renders it, with what the owner typed and the panel the answer form shows. */
export function renderItem(
  data: BoardData,
  options: { draft?: AnswerDraft; touched?: boolean; panel?: { kind: "form"; error: string | null; refusal: string | null } | { kind: "review"; review: ReviewView } | null; sending?: "review" | "record" | null } = {},
): string {
  assert.equal(data.detail.kind, "item");
  if (data.detail.kind !== "item") throw new Error("no item");
  return renderToStaticMarkup(
    h(Item, {
      item: data.detail,
      nextId: data.nextId,
      owner: data.owner,
      draft: options.draft ?? { answer: "", text: "", note: "", showNote: false },
      touched: options.touched ?? options.draft !== undefined,
      panel: options.panel ?? null,
      sending: options.sending ?? null,
      onDraft: () => {},
      onReview: () => {},
      onRecord: () => {},
      onBack: () => {},
    }),
  );
}
