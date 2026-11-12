#!/bin/sh
# An entail notice command for owners who run firstmate: drops the one line
# and the link into firstmate's inbox as a note, so it shows up where the
# owner already is. entail does not depend on firstmate; this is one sink.
#
#   entail settings --notice 'FIRSTMATE_HOME=/path/to/firstmate /path/to/entail/examples/notice-to-firstmate.sh'
#
# entail runs the command with the line and the link as its last two
# arguments, $1 and $2. The line says how many questions and calls wait; it
# never carries the question, and the answer is given on the board, not in
# chat.
: "${FIRSTMATE_HOME:?set FIRSTMATE_HOME to your firstmate checkout}"
exec "$FIRSTMATE_HOME/bin/fm-inbox.sh" note -- "$1 $2"
