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
}

/**
 * Renders a whole page: server-rendered HTML with no front-end framework and
 * no build step (spec §1). Every page shares one header, the place the health
 * strip goes (spec §16).
 */
export function renderPage(request: PageRequest, content: PageContent): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(content.title)} · entail</title>
<style>${STYLE}</style>
</head>
<body>
${renderHeader(request)}
<main>
${content.body}
</main>
</body>
</html>
`;
}

/** The header every page shares. */
function renderHeader(request: PageRequest): string {
  const links = request.server.nav
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
</header>`;
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
main { max-width: 48rem; padding: 1rem; margin: 0 auto; }
a { color: var(--accent); }
h1 { font-size: 1.4rem; }
h2 { font-size: 1.1rem; margin-top: 2rem; }
.muted, .hint { color: var(--muted); }
.hint { font-size: .875rem; margin: .25rem 0 0; }
.notice { padding: .5rem .75rem; background: var(--soft); border-left: 3px solid var(--accent); }
.error { color: var(--bad); font-size: .875rem; margin: .25rem 0 0; }
.field { margin: 1.25rem 0; }
.field label { display: block; font-weight: 600; }
input[type=text], input[type=number], select { font: inherit; padding: .35rem .5rem; width: 100%; max-width: 24rem; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 4px; }
input[aria-invalid=true] { border-color: var(--bad); }
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
`;
