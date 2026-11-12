#!/bin/sh
# An entail notice command: appends the one line and the link to a file.
#
#   entail settings --notice '/path/to/entail/examples/notice-to-file.sh'
#
# entail runs the command with the line and the link as its last two
# arguments, $1 and $2. The line says how many questions and calls wait; it
# never carries the question.
# Set ENTAIL_NOTICE_FILE to choose the file; ~/entail-notices.txt otherwise.
printf '%s %s %s\n' "$(date '+%Y-%m-%d %H:%M')" "$1" "$2" >> "${ENTAIL_NOTICE_FILE:-$HOME/entail-notices.txt}"
