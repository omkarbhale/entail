# Vision

tally is a small command-line tool that counts the words, lines and characters in text.
It serves people who want quick counts in a terminal or a script.

## What it does

tally reads plain text from the files it is given, or from standard input when it is given none.
It prints one line of counts per input, as plain text that other tools can parse.
A word is a run of characters between whitespace.
Errors go to standard error, and tally then exits with a non-zero status.

## What it refuses

tally never reaches the network.
tally reads no configuration files; everything it does is set by its command-line flags.
