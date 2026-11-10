# The board is a single-page app built with React

> **Amends ADR-0017.** Its stack said the pages are server-rendered HTML with a little inline script and no front-end framework or UI build step. That part no longer holds.

The board felt like an old website: every click reloaded the page, and nothing showed that an action such as checking a repo or reviewing an answer was under way. The owner decided on the board to rebuild it as a single-page app with a front-end framework and a UI build step, giving client-side navigation and loading states ([#169](https://github.com/omkarbhale/entail/issues/169)).

entail's pages are now one **board app**, built with **React** and bundled by **Vite**:

- **The board** (the inbox and its items) is rendered in the browser from JSON the local server sends. The server no longer renders any of the board's HTML. The app asks for the board's data every few seconds, as before (ADR-0012).
- **The other pages** (Repos, repo settings, Calls, ticket history and global settings) are still rendered as HTML by the server. The app shows each one in place.
- **Moving between pages** and **sending a form** never reload the page. A link or a form is sent with `fetch`, the reply comes back as JSON and is shown in place. The address bar and the back and forward buttons work as before.
- **While a page loads or an action is in flight**, the header shows a spinner and says what is happening, a bar runs across the top, and the button that was pressed shows that it is working and cannot be pressed again until the reply arrives.

The one answer path is unchanged (ADR-0008). The board's answer form posts the same fields, with the same per-start token, to the same endpoint, `/board/answer`. "Review answer" records nothing, and "Record answer as <owner> (final)" records the answer under the owner's display name from settings, with the time and the item version the form showed. The endpoint now replies with JSON for the app to render. Every refusal ADR-0012 lists still applies.

## Considered options

- **Keep server-rendered HTML and add a little more inline script for loading states**: what entail's own reasoning favoured, passed over by the owner in favour of a real front-end toolchain.
- **Render every page in the browser**: not done yet. The pages other than the board are forms and read-only listings that the server already renders and tests. The app shows them in place, so they gain in-place navigation and loading states without a second copy of their rendering. Any of them can move to the browser later behind the same JSON reply.
- **Preact, or a framework with its own server**: React is the most familiar choice, and nothing here needs server-side rendering.

## Consequences

- **Build.** `npm run build` runs `tsc` for the server and `vite build` for the app, which writes `dist/ui/app.js` and `dist/ui/app.css`. React, React DOM and Vite are dev dependencies, because the bundle carries everything the browser needs and the published package ships only `dist`.
- **Serving.** The server serves the app's files under `/ui/`. Every page a browser loads is a whole document: the shared header, the page itself when the server renders it, the view as JSON in a `<script type="application/json">` element that never runs, and the app's script. A request that sends `Accept: application/json` gets the same page as JSON. Redirects after a form are followed in place.
- **Security.** The Host and Origin checks and the per-start token are unchanged (ADR-0017). The content security policy is now stricter: `script-src 'self'`, so no inline script runs at all.
- **Typecheck.** The app's code lives in `src/ui` with its own `tsconfig.ui.json`, which adds the DOM library. `npm run typecheck` checks both.
- **Tests.** The app's components are written with `createElement` in plain `.ts`, so `node:test` renders them with `react-dom/server` straight from the server's JSON, with no extra test tooling. The acceptance test's board driver (ADR-0010) answers through the same JSON and answer endpoint the app uses.
- **Without JavaScript** the board shows only a note that it needs JavaScript. The other pages still read as before.
- Decided on [Entail user interface on board should be good](https://github.com/omkarbhale/entail/issues/169).
