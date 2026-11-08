# entail

entail is a project to let an owner own the vision of a product while implementation and decisions happen automatically. It keeps a durable vision of record, uses it to decide which decisions actually need the owner, surfaces those on a board instead of in chat, and checks work against acceptance criteria when it starts and when it lands. MVP-1 is being built to the [MVP-1 spec](docs/spec/mvp-1.md); the direction is described in [PROBLEM.md](PROBLEM.md).

## Running

entail is one npm package with one `entail` command, for Node 24 LTS on Linux (WSL included) or macOS.

```sh
entail run
```

`entail run` stays in the foreground until SIGINT or SIGTERM. Only one copy runs per machine: a second `entail run` exits, naming the running pid. entail keeps its data, including the lock and the operational log (`operational-log.jsonl`), in `$XDG_DATA_HOME/entail` (by default `~/.local/share/entail`) on Linux and WSL, or `~/Library/Application Support/entail` on macOS.

To keep entail running without a terminal, `entail service install` registers the same `entail run` as a per-user service: a systemd user unit on Linux and WSL (WSL needs systemd enabled in `/etc/wsl.conf`), or a launchd agent on macOS. It starts the service now, starts it at login and restarts it after a crash. The service keeps the `PATH` of the shell that installed it, and on Linux its `XDG_DATA_HOME`, so it finds the same CLIs and shares the same data directory and lock: a foreground `entail run` refuses to start while the service runs, and installing refuses while a foreground copy runs. Run `entail service install` again after moving Node or entail. `entail service uninstall` stops the service and removes it.

While it runs, entail serves its pages on `http://127.0.0.1:7419/` (the board port, a global setting) and exits if that port is taken. Set your display name and the other entail-wide settings on the global settings page, `http://127.0.0.1:7419/settings`; a changed board port takes effect on the next start.

entail keeps a copy of its records in the records repo, a git repository at `records/` in the data directory holding a text export of the store: `records.json` and one JSON-lines file per table under `tables/`. It commits after every answer, at least every hour and when it stops, and pushes to the records repo remote set on the global settings page, with your own git credentials. Without a remote, commits stay on this machine, and the settings page says "no remote set". entail refuses a remote it can verify is public, such as a public GitHub or GitLab repo, and says why; a remote it cannot check is accepted, and one on this machine is accepted with a note that it does not survive losing the machine. The settings page shows when the last push succeeded, and the last failure since. Nothing else in the data directory, such as the operational log, is a record, and none of it goes into the records repo.

Enroll a repo on the Repos page, `http://127.0.0.1:7419/repos`, once your display name is set. State its forge (`github` or `gitlab`), host and path. entail checks the repo through your own `gh` or `glab` login, and refuses it if the CLI is missing or logged out, the project cannot be read, your account cannot add labels and comment, GitLab is older than 15.6, or the default branch has no VISION.md or an empty one. You then confirm one review screen, which holds the generic criteria G1…Gn entail proposes from the repo's CI files and build scripts in one model run, for you to edit, remove, add to or leave empty. Issues already open stay out of intake. Once enrolled, entail polls each repo every poll interval (a global setting, re-read each pass) and takes in each new issue you open as a ticket; issues opened by anyone else are ignored. Polls, backoffs and failures go to the operational log.

Each enrolled repo has a settings page, linked from the Repos page: generic criteria, merge method (GitHub only), shadow, who counts (anyone, or you plus listed executors), and pins. Every save is a new settings version, listed in the repo's settings history, and takes effect from the next pass.

The board, `http://127.0.0.1:7419/`, is an inbox of the decisions that need you. Open items are listed under "Needs you", oldest raised first across all repos, each with its decision, repo and forge, how long ago it was raised and why: it contradicts a vision line, has consequential readings, touches a pin, or failed a check. Beside the list, the selected item shows the decision, why it was raised, the vision check, the issue quoted as the reporter's request, what happened so far with a link to the ticket's history, and the answer form. The page checks the board every few seconds. An item withdrawn while you are on it locks its form and says why and what happens next, keeping anything you typed to copy, and offers a "Next decision" link to the oldest open item; the page never moves on by itself. A paused repo's items and the items of a host entail cannot reach stay listed with their forms locked. Answered and withdrawn items stay under "Answered or withdrawn today" until the end of the day.

The answer form is the only way an answer enters entail; no issue comment, chat or command line records one. Choose an option, answer in your own words, or "Don't go ahead", with an optional note behind "Add a note" that stays private unless you tick "Show my note on the issue". An option that goes against a vision line says so: the exception is for this ticket only, and the line stays as it is. "Review answer" records nothing: it shows your answer, whether the note is private or shown, what happens next and the exact comment entail will post on the issue. "Record answer as <your name> (final)" records it under your display name with the time and the item version you answered, and "Back" returns to the form. A receipt then stays on the item with who answered, when, the item version, the ticket's new state, what happens next and the comment, plus "Next decision". entail refuses an answer to an item that was withdrawn, already answered or changed since the page showed it, and says so.

Every call entail makes is on the read-only Calls page, `http://127.0.0.1:7419/calls`, newest first, filterable by repo, ticket, kind and date. Each call shows its reason, citation permalinks, check and challenge results and links to the issue and PR, and links each model run's full input and output. Each ticket has a page with its whole history, the answers given on it under the name of whoever gave them, and whether its model step is failing and when it is tried again. Neither page asks anything or offers any action: to fix a wrong call, close the issue, revert the change, add a vision line or add a pin.

## Development

```sh
npm ci
npm run typecheck
npm test        # node:test, running the TypeScript sources directly
npm run build   # compiles to dist/ for the published command
```

The acceptance harness (fixture repos, reset, scripted executor and board driver) is described in [test/acceptance/README.md](test/acceptance/README.md).
