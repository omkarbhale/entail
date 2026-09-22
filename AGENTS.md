# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- `VISION.md` and everything under `unfiled/` are recorded direction. Never
  correct, reword or add invented material to them; `VISION.md`'s own header
  and `unfiled/README.md` say why.
- `board-mockup/` is a mockup, not Entail (see `board-mockup/README.md` for
  how to run it). Every value its mock server serves must be a `Sourced<T>`
  (`board-mockup/mock-server/src/provenance.ts`), and `npm run check` in
  `mock-server/` fails if a citation stops matching its file or a decision id
  is missing from `board-mockup/DECISIONS.md`.
- `board-mockup/DECISIONS.md` ids are cited by code: append new entries, never
  renumber. Any question a change forces you to answer goes there as an
  assumption, not an answer.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
