import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { APP_ELEMENT_ID, BOOT_ELEMENT_ID, type PageView } from "../app-view.ts";
import { App } from "./app.ts";
import "./app.css";

// The document the server sent shows the first page; the app takes over from it (ADR-0021).
const root = document.getElementById(APP_ELEMENT_ID);
const bootText = document.getElementById(BOOT_ELEMENT_ID)?.textContent;
if (root !== null && bootText) {
  const boot = JSON.parse(bootText) as PageView;
  // A page the server rendered is already in the document; it is not sent twice.
  if (boot.kind === "html") boot.body = root.querySelector("main")?.innerHTML ?? "";
  createRoot(root).render(h(App, { boot }));
}
