# Entail

Entail is tooling for programming with LLM assistance.

It is early. The implementation is undecided: no language, runtime, artifact
format or directory scheme has been chosen yet.

[`VISION.md`](VISION.md) is the authoritative statement of direction.

[`unfiled/`](unfiled/) is a provisional holding place for design material that
would otherwise live only in chat scrollback. It is not Entail's artifact
scheme; no such scheme has been chosen.

[`board-mockup/`](board-mockup/) holds the first code: a mockup of the board.
So far it is a TypeScript mock server serving the board's invented state; a
React and TypeScript UI for it is not built yet. It is a drawing made to find
the questions, not an implementation, and it chooses no language or runtime
for Entail itself. The questions it raised are in
[`board-mockup/DECISIONS.md`](board-mockup/DECISIONS.md).
