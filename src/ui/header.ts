import { createElement as h, type ReactNode } from "react";
import type { Chrome } from "../app-view.ts";
import { Spinner, Time } from "./parts.ts";

/**
 * The header every page shares (spec §16): the pages, then what the app is
 * doing while a page loads or an action is in flight. While anything is halted
 * or warned, the health strip follows it with one line each; otherwise the
 * header says only when the last pass ran. The strip takes no answer.
 */
export function Header({ chrome, path, busy }: { chrome: Chrome; path: string; busy: string | null }): ReactNode {
  const health = chrome.health;
  return h(
    "div",
    { className: "chrome" },
    h("div", { className: `progress${busy === null ? "" : " active"}`, "aria-hidden": true }),
    h(
      "header",
      { className: "site" },
      h("span", { className: "brand" }, "entail"),
      h(
        "nav",
        null,
        chrome.nav.map((link) => h("a", { key: link.path, href: link.path, "aria-current": link.path === path ? "page" : undefined }, link.label)),
      ),
      h("span", { className: "busy", role: "status", "aria-live": "polite" }, busy === null ? null : [h(Spinner, { key: "s" }), busy]),
      health !== null && health.strip.length === 0
        ? h("span", { className: "last-pass muted" }, health.lastPass === null ? "No pass has run yet" : ["Last pass ", h(Time, { key: "t", iso: health.lastPass })])
        : null,
    ),
    health === null || health.strip.length === 0
      ? null
      : h(
          "section",
          { className: "health-strip", role: "status", "aria-label": "entail's health" },
          h(
            "ul",
            null,
            health.strip.map((condition) =>
              h(
                "li",
                { key: condition.key, "data-kind": condition.kind, "data-key": condition.key },
                h("strong", null, `${condition.kind === "halt" ? "Halted" : "Warning"}: ${condition.wrong}.`),
                ` ${condition.stops} since `,
                h(Time, { iso: condition.since }),
                `. ${condition.clears}.`,
              ),
            ),
          ),
        ),
  );
}
