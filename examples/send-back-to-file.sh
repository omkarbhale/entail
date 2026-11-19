#!/bin/sh
# An entail send-back command: appends the handoff for each PR entail sends
# back or cancels to a file, one line of JSON each, for whatever picks the work
# up again.
#
#   entail settings --send-back '/path/to/entail/examples/send-back-to-file.sh'
#
# entail runs the command once per send-back or cancel (not when a PR merges),
# after its comment is posted, with the handoff as one line of JSON on standard
# input: the repo, `outcome` (send-back or cancel), the PR and the issue it
# closes, the judged head, entail's reason, what needs to change and the
# checklist. Exit 0 once the work is handed off; entail records the exit status
# in the repo's log, and a failure never holds up the call.
# Set ENTAIL_SEND_BACK_FILE to choose the file; ~/entail-send-backs.jsonl otherwise.
cat >> "${ENTAIL_SEND_BACK_FILE:-$HOME/entail-send-backs.jsonl}"
