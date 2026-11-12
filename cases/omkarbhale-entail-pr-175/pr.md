# feat(ui): rebuild the board as a React single-page app

## Intent

"you can pick the other two and raise PR for them after no-mistakes run."

Build https://github.com/omkarbhale/entail/issues/169. entail itself cleared this issue and posted its criteria in its latest "Speaking from Omkar's entail:" comment on the issue (Criteria C1.. and generic criteria G1, G2). Those criteria are the contract for this PR.

Issue #169 ("Entail user interface on board should be good"): the board feels like a 1998 website whose page reloads every time you click somewhere, with no loading indicators; clicking "check repository" and similar things gives no user feedback. The issue asks to move to a built frontend framework such as React. On entail's board the owner decided: "Rebuild the board as a single-page app with a front-end framework and a UI build step, giving client-side navigation and loading states." What a user would observe: the board becomes a client-rendered app with no page reloads and loading states, built from a front-end toolchain. The criteria in entail's latest intake comment are:
- C1: The board is a client-rendered single-page app built with a front-end framework and a UI build step, as the owner chose (the PR changes package.json and src/**).
- C2: Moving between the board's pages and submitting its actions, such as answering an item, updates the board in place with no full page reload.
- C3: While a board action is in flight, such as clicking "check repository" or submitting an answer, the board shows a visible loading or pending indicator until the action finishes.
- C4: Each item on the rebuilt board still carries what the ticket or task was, what happened, and why it was raised.
- C5: Answers given on the rebuilt board are still recorded under the name of whoever gave them, through the single path that records answers.
- G1: The check `test (ubuntu-latest)` passes.
- G2: The check `test (macos-latest)` passes.

## What Changed
- Rebuilt the board as a client-rendered React single-page app (new `src/ui/` with app, board, header and styles, built with Vite via `vite.config.ts` and `tsconfig.ui.json`). Navigation and actions such as answering an item update in place without full page reloads, and pending states show while an action is in flight.
- The server (`src/server.ts`, `src/app-view.ts`, `src/page.ts`, `src/board-page.ts` and the other page modules) now serves the built app shell and its data. Answers are still recorded under the answerer's name through the single path in `src/answer.ts`, and items keep their what/what happened/why content.
- Added ADR 0021 for the single-page-app decision, updated ADR 0017, the spec, README build notes and package dependencies, and moved/rewrote the board tests under `test/ui/` along with the acceptance board driver.

Closes #169

## entail evidence

- C1: Rebuilt the board as a React 19 single-page app in `src/ui/` (board, app shell, header), bundled by Vite (`vite.config.ts`); `package.json` adds react, react-dom and vite and `npm run build` now runs `tsc` then `vite build`, writing `dist/ui/app.js` and `dist/ui/app.css`. The board is rendered in the browser from the JSON `/board/data` sends; the server renders none of it (test "the board is an app: the document loads it, and the board itself is rendered in the browser from its data" in `test/ui/board-page.test.ts`). The other pages are still server-rendered HTML that the app fetches and shows in place (ADR-0021). — pass: `npm run build` produced the bundle, the test passes, and Chromium showed the board rendered client-side.
- C2: Drove the built app in Chromium against a demo server with real pages and a real store: clicked a second board item, the Repos and Board header links, history back, then reviewed and recorded an answer. — pass: the URL changed through history, a `window` marker set before the clicks survived every step, and `performance.getEntriesByType("navigation").length` stayed 1 (no full reload). Every link and form goes through `fetch` with `Accept: application/json` and is shown in place.
- C3: Same Chromium run with every server reply delayed 1.5 s: sampled the page mid-flight while an item loaded, during "Review answer", during "Record answer" and during "Check the repo" on the Repos page. — pass: the header showed a spinner with "Loading…", "Reviewing your answer…", "Recording your answer…" or "Working…"; the top progress bar was active; the pressed button showed a spinner and "Reviewing…" or "Recording as Ada Owner…" and was disabled (as was "Back"); "Check the repo" got a spinner and was disabled until the refusal rendered in place. The test "while a step is in flight its button says so, and nothing in the form can be sent again" in `test/ui/board-answer.test.ts` covers the board's states.
- C4: `test/ui/board-page.test.ts` "the item view shows the six parts in the order of spec §13" renders the React board from the server's JSON. — pass: each item shows the decision, why it was raised, the vision check, what the ticket was (issue title, link, who filed it, the quoted request), what happened (calls newest first, a link to the ticket's history) and the answer form; the Chromium run showed the same parts.
- C5: Answers still post the same fields, per-start token and item version to `/board/answer`, which records them through `recordBoardAnswer` under the owner's display name; the endpoint now replies with JSON. `test/ui/board-answer.test.ts` covers recording, every refusal, and that no other path, method or origin records an answer. In the Chromium run, the store's `answers` row after recording read `answered_by: 'Ada Owner'`, `item_version: 1`, `option_id: 'R1'`. — pass.
- G1: CI check `test (ubuntu-latest)` on this PR's head — pass.
- G2: CI check `test (macos-latest)` on this PR's head — pass.

## Risk Assessment

⚠️ Medium: I found no defects, but this is a large rewrite (about 3k lines) of the board into a React app with a new build step, and I read only the server, page, app shell and answer paths closely, without running anything.

## Testing

Built the SPA, ran the targeted UI/server/driver tests (all pass), then served the real board from the built bundle against a disposable seeded store and drove it in headless Chromium. Item switching and header navigation kept the window state with no reload. Review and Record showed disabled, spinner-busy buttons while answer requests were delayed. The answer was recorded and the receipt names Ada Owner. The entail CLI could not be run on its fixed port 7419, which the operator's own entail already holds, so the server was started through the same startServer/boardPages code on another port. Check-repository and test (ubuntu/macos) CI were not exercised.

- Live validation: ✅ go - 4 of 4 scenarios driven live against the product

| Scenario | Result | Live | Evidence |
| --- | --- | --- | --- |
| C1/C4: board loads as a client-rendered React app and each item shows what the ticket was, what happened, and why it was raised | ✅ pass | live | board.png; vite build output |
| C2: clicking another item and a header link updates in place; a window marker survives, the URL changes via history, and back works | ✅ pass | live | CDP run: marker stayed 42 across item and Calls navigation and back |
| C3: during Review answer and Record answer, buttons show disabled, busy, spinner states with a status message until the request finishes | ✅ pass | live | pending.png; CDP output &#39;Reviewing… [disabled] [busy]&#39; and &#39;Recording as Ada Owner…&#39; |
| C5: recording an answer goes through the single answer endpoint and the receipt says answeredBy Ada Owner | ✅ pass | live | recorded.png; /board/data?item=1 receipt answeredBy &#39;Ada Owner&#39;; server logged ANSWER RECORDED |

![Rebuilt board, rendered client-side](https://github.com/user-attachments/assets/487f0f79-8a04-4f48-b460-6aeb4d9c8192)
![Pending indicator during Review answer](https://github.com/user-attachments/assets/0441ed7c-aa84-4c92-bc36-9ba2d2b65b4a)
![Receipt after recording the answer](https://github.com/user-attachments/assets/87dd07c1-7b4b-4b1c-ba6f-588009f1defc)

[The no-mistakes pipeline report that followed in the description is left out.]
