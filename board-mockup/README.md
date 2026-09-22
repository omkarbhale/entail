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
- `ui/` is the React and TypeScript board. It is not built yet.

TypeScript was chosen for these two packages only. It says nothing about
where Entail's orchestrator runs or what it is written in (DECISIONS.md D-33
and D-34).

## Running the mock server

Needs Node 22.18 or later, which runs the TypeScript sources directly.

```sh
cd board-mockup/mock-server
npm install
npm start          # http://localhost:4317, or PORT=...
npm run check      # typecheck, including the must-not-compile cases, then tests
```

State is in memory and resets when the server restarts. The server refuses to
start if any citation in its provenance does not match the file it cites, or
if any decision id it uses is missing from DECISIONS.md.
