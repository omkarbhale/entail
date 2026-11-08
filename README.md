# entail

entail is a project to let an owner own the vision of a product while implementation and decisions happen automatically. It keeps a durable vision of record, uses it to decide which decisions actually need the owner, surfaces those on a board instead of in chat, and checks work against acceptance criteria when it starts and when it lands. MVP-1 is being built to the [MVP-1 spec](docs/spec/mvp-1.md); the direction is described in [PROBLEM.md](PROBLEM.md).

## Running

entail is one npm package with one `entail` command, for Node 24 LTS on Linux (WSL included) or macOS.

```sh
entail run
```

`entail run` stays in the foreground until SIGINT or SIGTERM. Only one copy runs per machine: a second `entail run` exits, naming the running pid. entail keeps its data, including the lock and the operational log (`operational-log.jsonl`), in `$XDG_DATA_HOME/entail` (by default `~/.local/share/entail`) on Linux and WSL, or `~/Library/Application Support/entail` on macOS.

While it runs, entail serves its pages on `http://127.0.0.1:7419/` (the board port, a global setting) and exits if that port is taken. Set your display name and the other entail-wide settings on the global settings page, `http://127.0.0.1:7419/settings`; a changed board port takes effect on the next start.

## Development

```sh
npm ci
npm run typecheck
npm test        # node:test, running the TypeScript sources directly
npm run build   # compiles to dist/ for the published command
```

The acceptance harness (fixture repos, reset, scripted executor and board driver) is described in [test/acceptance/README.md](test/acceptance/README.md).
