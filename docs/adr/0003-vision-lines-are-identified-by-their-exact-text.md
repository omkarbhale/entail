# Vision lines are identified by their exact text

entail identifies a vision line by its exact text, compared after collapsing whitespace, and assigns it no id. A citation therefore quotes whole lines at the vision's commit sha. VISION.md carries no per-line marks, the owner and /vision reword lines freely, and new words are exactly what needs a fresh origin. Text identity is mechanical, and it never carries an old origin or citation onto words the owner did not see in that form.

## Considered options

- **Ids that entail assigns and carries across edits by matching old and new text**: rejected. The matching is a heuristic, and a reworded line could change meaning while keeping an id that says it is the same line.
- **Anchors inside VISION.md** (HTML comments or ids): rejected. VISION.md says it carries no per-line marks, and a /vision re-run would strip them.
- **Quoting any substring of a line**: rejected. A verdict could quote one clause without the sentence that limits it.

## Consequences

- Moving a line, or renaming its heading, keeps its identity. Any change of words, even a typo fix, makes a new line, which needs its origin recorded again and makes stale any citation of the old line.
- A citation stores, for each line, the commit sha, the heading above it, its exact text and its line number. The line number is used only for a permalink at that sha, which resolves on GitHub and GitLab after any later edit.
- A vision change is computed as the lines removed and added, so finding the tickets whose citations went stale is a lookup, not a judgment.
- Decided on [How are vision lines identified and their origins kept outside the prose?](https://github.com/omkarbhale/entail/issues/20).
