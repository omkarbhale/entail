# entail

entail is a project to let an owner own the vision of a product while implementation and decisions happen automatically. It keeps a durable vision of record, uses it to decide which decisions actually need the owner, surfaces those on a board instead of in chat, and checks work against acceptance criteria when it starts and when it lands. MVP-1 is being built to the [MVP-1 spec](docs/spec/mvp-1.md); the direction is described in [PROBLEM.md](PROBLEM.md).

## Running

entail is one npm package with one `entail` command, for Node 24 LTS on Linux (WSL included) or macOS.

```sh
entail run
```

`entail run` stays in the foreground until SIGINT or SIGTERM. Only one copy runs per machine: a second `entail run` exits, naming the running pid. entail keeps its data, including the lock and the operational log (`operational-log.jsonl`), in `$XDG_DATA_HOME/entail` (by default `~/.local/share/entail`) on Linux and WSL, or `~/Library/Application Support/entail` on macOS.

While it runs, entail serves its pages on `http://127.0.0.1:7419/` (the board port, a global setting) and exits if that port is taken. Set your display name and the other entail-wide settings on the global settings page, `http://127.0.0.1:7419/settings`; a changed board port takes effect on the next start.

Enroll a repo on the Repos page, `http://127.0.0.1:7419/repos`, once your display name is set. State its forge (`github` or `gitlab`), host and path. entail checks the repo through your own `gh` or `glab` login, and refuses it if the CLI is missing or logged out, the project cannot be read, your account cannot add labels and comment, GitLab is older than 15.6, or the default branch has no VISION.md or an empty one. You then confirm one review screen, which holds the generic criteria G1…Gn entail proposes from the repo's CI files and build scripts in one model run, for you to edit, remove, add to or leave empty. Issues already open stay out of intake. Once enrolled, entail polls each repo every poll interval (a global setting, re-read each pass) and takes in each new issue you open as a ticket; issues opened by anyone else are ignored. Polls, backoffs and failures go to the operational log.

Each enrolled repo has a settings page, linked from the Repos page: generic criteria, merge method (GitHub only), shadow, who counts (anyone, or you plus listed executors), and pins. Every save is a new settings version, listed in the repo's settings history, and takes effect from the next pass.

## Development

```sh
npm ci
npm run typecheck
npm test        # node:test, running the TypeScript sources directly
npm run build   # compiles to dist/ for the published command
```

The acceptance harness (fixture repos, reset, scripted executor and board driver) is described in [test/acceptance/README.md](test/acceptance/README.md).
