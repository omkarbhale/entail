# Board mockup

A mockup of Entail's board, built to map out what the user can do on it. It
is not Entail, and it does not implement any of Entail's behaviour. Nothing
here runs a stage, derives an artifact or evaluates anything.

- [`DECISIONS.md`](DECISIONS.md) lists every question the mockup had to answer
  before it could be drawn, and the assumption it took for each one. None of
  them has been answered.
- [`mock-server/`](mock-server/) is a TypeScript HTTP server that serves the
  board's invented state. Every value it serves carries provenance, which says
  whether the value is recorded in this repository, and where, or invented,
  and why. [`mock-server/src/contract.ts`](mock-server/src/contract.ts) is the
  API contract.
- [`ui/`](ui/) is the React and TypeScript board. It holds no state of its
  own: everything on the board arrives from the mock server. Only the text
  around the board (banner, legend, inspector) is the UI's own (D-41).

TypeScript was chosen for these two packages only. It says nothing about
where Entail's orchestrator runs or what it is written in (DECISIONS.md D-33
and D-34).

## Running it

Needs Node 22.18 or later. The mock server runs its TypeScript sources
directly, with no build step. From the repository root, in two terminals:

```sh
# Terminal 1: the mock server, on http://localhost:4317
cd board-mockup/mock-server
npm ci
npm start
```

```sh
# Terminal 2: the board, on http://localhost:5173
cd board-mockup/ui
npm ci
npm run dev
```

Then open <http://localhost:5173>. The UI sends every `/api` request to the
mock server on port 4317. If the mock server is not running, the page says
so instead of drawing a board.

State is in memory. Restart the mock server to get the initial fiction back.
The server refuses to start if any citation in its provenance does not match
the file it cites, or if any decision id it uses is missing from
DECISIONS.md.

## Reading the board

Pointing at anything on the board shows, in the inspector beside it, where
that thing came from. Clicking keeps it there. Most things answer more than
one question: why the value is what it is, why the field exists at all, and
where the words used to show it came from.

The palette is defined in [`ui/src/styles.css`](ui/src/styles.css). Only
three marks appear on the board:

- **Recorded**, green: stated in `VISION.md` or `unfiled/`. It is rare on
  purpose.
- **Set by you**, blue: changed through one of the two actions since the
  server started.
- **Invented**, a quiet dotted underline: interpreted, assumed or
  placeholder. That is almost everything. The inspector says which of the
  three it is, and names the open question in DECISIONS.md where there is
  one.

## Checks

```sh
cd board-mockup/mock-server && npm run check   # typecheck, including the must-not-compile cases, then tests
cd board-mockup/ui && npm run check            # typecheck
```
