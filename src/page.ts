import { APP_ASSETS_PATH, APP_ELEMENT_ID, BOOT_ELEMENT_ID, type Chrome, type PageView } from "./app-view.ts";
import type { HealthCondition, PageHealth } from "./health.ts";
import type { PageRequest } from "./server.ts";

/** Escapes text for HTML element content and quoted attribute values. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** A stored ISO time, shown to the minute in UTC. */
export function timeHtml(iso: string): string {
  const shown = `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
  return `<time datetime="${escapeHtml(iso)}">${escapeHtml(shown)}</time>`;
}

export interface PageContent {
  title: string;
  /** The page's own HTML, already escaped. */
  body: string;
  /** Lets the page use the window's full width, as the board's list beside its item does. */
  wide?: boolean;
}

/** What the shared header shows for a request: the pages and entail's health, read now. */
export function chromeOf(request: PageRequest): Chrome {
  return { nav: request.server.nav, health: readHealth(request) };
}

/**
 * Renders the whole document a browser loads (ADR-0021). It carries the
 * shared header and, for a page the server renders, the page itself, so the
 * page reads the same before the board app starts. It loads the app, which
 * takes over from there: it renders the board from its data and shows every
 * later page in place, with no reload. The view the document shows travels
 * beside it as JSON, which is never run as script.
 */
export function renderDocument(request: PageRequest, view: PageView): string {
  const wide = view.kind === "board" || view.wide;
  // The page's HTML is already in the document; the app reads it from there rather than twice.
  const boot: PageView = view.kind === "html" ? { ...view, body: "" } : view;
  const main =
    view.kind === "html"
      ? view.body
      : `<div class="app-loading"><p class="muted">Loading the board…</p>
<noscript><p>The board is an app that runs in your browser: turn on JavaScript for ${escapeHtml(request.server.origin)} to see and answer its items.</p></noscript></div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(view.title)} · entail</title>
<style>${STYLE}</style>
<link rel="stylesheet" href="${APP_ASSETS_PATH}app.css">
<script type="module" src="${APP_ASSETS_PATH}app.js"></script>
</head>
<body>
<div id="${APP_ELEMENT_ID}">
${renderHeader(request, view.chrome)}
<main${wide ? ' class="wide"' : ""}>
${main}
</main>
</div>
<script type="application/json" id="${BOOT_ELEMENT_ID}">${JSON.stringify(boot).replaceAll("<", "\\u003c")}</script>
</body>
</html>
`;
}

/** Renders a page the server renders as the whole document a browser loads. */
export function renderPage(request: PageRequest, content: PageContent, status = 200): string {
  return renderDocument(request, { kind: "html", status, title: content.title, body: content.body, wide: content.wide === true, chrome: chromeOf(request) });
}

/**
 * The header every page shares, as the document first shows it; the board
 * app renders the same header from {@link Chrome}. While anything is halted or
 * warned, the health strip follows it with one line each: what is wrong, what
 * it stops, since when and what clears it. Otherwise the header says only when
 * the last pass ran (spec §16). The strip is not a board item and takes no answer.
 */
function renderHeader(request: PageRequest, chrome: Chrome): string {
  const health = chrome.health;
  const links = chrome.nav
    .map((link) => {
      const current = link.path === request.url.pathname ? ' aria-current="page"' : "";
      return `<a href="${escapeHtml(link.path)}"${current}>${escapeHtml(link.label)}</a>`;
    })
    .join("\n");
  return `<header class="site">
<span class="brand">entail</span>
<nav>
${links}
</nav>
${health !== null && health.strip.length === 0 ? `<span class="last-pass muted">${lastPassHtml(health.lastPass)}</span>\n` : ""}</header>${health === null ? "" : healthStripHtml(health.strip)}`;
}

function readHealth(request: PageRequest): PageHealth | null {
  try {
    return request.server.health?.() ?? null;
  } catch {
    // Health that cannot be read leaves the page as it is.
    return null;
  }
}

function lastPassHtml(lastPass: string | null): string {
  return lastPass === null ? "No pass has run yet" : `Last pass ${timeHtml(lastPass)}`;
}

/** The health strip: one line per halt or warning, or nothing when all is well (spec §16). */
export function healthStripHtml(conditions: readonly HealthCondition[]): string {
  if (conditions.length === 0) return "";
  const lines = conditions.map(
    (condition) =>
      `<li data-kind="${condition.kind}" data-key="${escapeHtml(condition.key)}"><strong>${condition.kind === "halt" ? "Halted" : "Warning"}: ${escapeHtml(condition.wrong)}.</strong> ${escapeHtml(condition.stops)} since ${timeHtml(condition.since)}. ${escapeHtml(condition.clears)}.</li>`,
  );
  return `
<section class="health-strip" role="status" aria-label="entail's health">
<ul>
${lines.join("\n")}
</ul>
</section>`;
}

const STYLE = `
:root { color-scheme: light dark; --fg: #1d1d1f; --muted: #5f6368; --bg: #fff; --line: #d9dce0; --accent: #1f5fbf; --bad: #b3261e; --soft: #f3f5f8; }
@media (prefers-color-scheme: dark) { :root { --fg: #e8eaed; --muted: #a0a6ad; --bg: #16181b; --line: #3a3f45; --accent: #8ab4f8; --bad: #f28b82; --soft: #1f2226; } }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
header.site { display: flex; gap: 1.5rem; align-items: baseline; padding: .75rem 1rem; border-bottom: 1px solid var(--line); }
header.site .brand { font-weight: 600; }
header.site nav { display: flex; gap: 1rem; }
header.site a[aria-current] { font-weight: 600; text-decoration: none; color: var(--fg); }
header.site .last-pass { margin-left: auto; font-size: .875rem; }
.health-strip { padding: .5rem 1rem; background: var(--soft); border-bottom: 2px solid var(--bad); }
.health-strip ul { margin: 0; padding-left: 1.25rem; }
.health-strip li[data-kind=warning] strong { color: var(--fg); }
.health-strip li[data-kind=halt] strong { color: var(--bad); }
main { max-width: 48rem; padding: 1rem; margin: 0 auto; }
main.wide { max-width: 80rem; }
a { color: var(--accent); }
h1 { font-size: 1.4rem; }
h2 { font-size: 1.1rem; margin-top: 2rem; }
.muted, .hint { color: var(--muted); }
.hint { font-size: .875rem; margin: .25rem 0 0; }
.notice { padding: .5rem .75rem; background: var(--soft); border-left: 3px solid var(--accent); }
.error { color: var(--bad); font-size: .875rem; margin: .25rem 0 0; }
.field { margin: 1.25rem 0; }
.field label { display: block; font-weight: 600; }
input[type=text], input[type=number], select, textarea { font: inherit; padding: .35rem .5rem; width: 100%; max-width: 24rem; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 4px; }
input[aria-invalid=true], textarea[aria-invalid=true] { border-color: var(--bad); }
fieldset.row { padding: .5rem .75rem; border: 1px solid var(--line); border-radius: 4px; }
fieldset.row > label:not(.choice) { display: block; font-weight: 600; margin-top: .5rem; }
fieldset { border: 0; padding: 0; margin: 1.25rem 0; }
legend { font-weight: 600; padding: 0; }
.field label.choice { display: block; font-weight: normal; }
code { font-size: .9em; }
button { font: inherit; padding: .4rem 1rem; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: .35rem 1rem; }
dt { font-weight: 600; }
dd { margin: 0; overflow-wrap: anywhere; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: .25rem 0; padding: .5rem; font-size: .85em; background: var(--soft); border-radius: 4px; }
.filters p { margin: .25rem 0; }
.filters a, .filters span { margin-right: .5rem; }
.filters [aria-current] { font-weight: 600; color: var(--fg); text-decoration: none; }
.filter-name { font-weight: 600; }
article.call, section.event { border-top: 1px solid var(--line); padding-top: .5rem; margin-top: 1rem; }
ol.history { list-style: none; padding: 0; }
`;
