#!/bin/sh
# An entail start command: appends the handoff for each go to a file, one line
# of JSON per go, for whatever picks up work there.
#
#   entail settings --start '/path/to/entail/examples/start-to-file.sh'
#
# entail runs the command when a go acts (at once, or once you confirm it),
# once per issue, with the handoff as one line of JSON on standard input: the
# repo, the issue's number, URL and title, the call's reason, the criteria the
# PR must meet with where each comes from, and the VISION.md commit the go was
# made against. Exit 0 once the work is handed off; entail records the exit status
# in the repo's log, and a failure never holds up the call.
# Set ENTAIL_START_FILE to choose the file; ~/entail-starts.jsonl otherwise.
cat >> "${ENTAIL_START_FILE:-$HOME/entail-starts.jsonl}"
