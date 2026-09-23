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
  around the board (banner, legend, inspector and the two stand-ins) is the
  UI's own (D-41).

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

## What you can do on it

- **Describe a task or feature** in the box at the top, and it enters the
  pipeline at the first stage (D-58).
- **Send an item to the next stage** when it is waiting at a completed stage.
  Advancing is imagined to spawn an agent in a tmux pane; the board shows the
  pane's name and nothing is spawned (D-51). At the last stage the same action
  lands the item, and it moves to the *Landed* list with its pull request and
  every answer it was given (D-60, D-61).
- **Answer what an item raises** through an agent. An item that has something
  to raise, or needs you, shows what it asks and a ready-made invocation of
  the MCP Entail is imagined to expose (D-52, D-53). The board does not take
  the answer. The second dashed panel under the board is the mockup playing that
  agent: it is the only way an answer enters, through one stand-in route
  (D-55). No MCP exists and nothing can call one.
- **Play a stage finishing**, in the first dashed panel under the board.
  Nothing in the mock runs a stage, so a moving item stays moving until this
  panel, which is the mockup's frame and not the board, ends its stage: either
  done and waiting to be sent on, or stopped with something to raise or
  needing you, asking what you type. That is how work you describe gets
  through every stage to landing. What really ends a stage is open (D-65).

## Reading the board

Pointing at anything on the board shows, in the inspector beside it, where
that thing came from. Clicking keeps it there. Most things answer more than
one question: why the value is what it is, why the field exists at all, and
where the words used to show it came from.

The palette is defined in [`ui/src/styles.css`](ui/src/styles.css). Only
four marks appear on the board. A thing that answers several questions is
marked by the weakest answer among them, strongest first: recorded,
interpreted, assumed, placeholder. So it shows as recorded only if every part
of it is recorded. The exceptions are a value you set yourself, which shows
as set by you, and one an agent composed and you agreed to, which shows as
agreed by you, whatever their other parts say (DECISIONS.md D-50, D-56).

- **Recorded**, green: stated in `VISION.md` or `unfiled/`. It is rare on
  purpose.
- **Set by you**, blue: changed through one of the board's actions since the
  server started, or an answer whose words you stated.
- **Agreed by you**, violet, dashed: an answer an agent composed and you
  agreed to. You did not state it, so it is never shown as set by you.
- **Invented**, a quiet dotted underline: interpreted, assumed or
  placeholder. That is almost everything. The inspector says which of the
  three it is, and names the open question in DECISIONS.md where there is
  one.

## Checks

```sh
cd board-mockup/mock-server && npm run check   # typecheck, including the must-not-compile cases, then tests
cd board-mockup/ui && npm run check            # typecheck
```
