# The board is an inbox, and an answer is reviewed before it is recorded

The owner tried three layouts of entail's local board page in a clickable prototype and chose the **inbox**:
- the open board items are listed on the left;
- the selected item is shown on the right, with its parts in the order ADR-0008 decided: the decision, why it was raised, the vision check, what the ticket was, what happened, and the answer form.

The prototype's data came from the `tally` acceptance-test fixture. The owner answered every question on how the page behaves, as recommended:
- an answer is reviewed before it is recorded;
- a receipt stays in place after answering;
- items are listed oldest first across repos;
- a one-line warning appears when going ahead goes against a vision line;
- answered items stay until the end of the day.

VISION.md says the board's value over chat is structure: each item carries what the ticket was, what happened and why it was raised. The inbox shows that structure before the form and keeps the count of waiting decisions in view.

## The page

- **Header.** The board, with the number of open items, and a link to the Calls page (ADR-0009). It names whose answers it records: "answering as" the owner's display name from settings.
- **The list.**
  - Open items come first, under "Needs you", oldest raised first across all repos, in one list.
  - Each entry shows the decision sentence, the repo and forge, how long ago it was raised, and a tag for why it was raised: contradicts a line, consequential readings, a pin by name, or a failed check.
  - This is only display order. The owner cannot reorder or postpone items, because that is work management.
  - Answered and withdrawn items move to "Answered or withdrawn today" and leave the board at the end of the day. After that they are on the Calls page and the ticket's history page.
- **The item.**
  - The decision is the heading.
  - The issue is quoted as the reporter's request, never the owner's word (ADR-0001).
  - The vision check quotes only the lines that bear on the issue, at the vision's commit.
  - What happened lists the calls so far, newest first, and links to the ticket's history.
- **The answer form.** It offers the item's options, each with the outcome a user would observe, then "Answer in my own words", then "Don't go ahead" (ADR-0008). An optional note sits behind "Add a note", with a "Show my note on the issue" tick. When going ahead goes against a vision line, the option carries one warning: "This goes against a vision line for this ticket only. The line stays as it is; to change the rule, edit VISION.md." The form offers no link to edit the vision.

## Answering

1. **Review.** "Review answer" records nothing yet. It shows the answer, whether the note is private or shown, what happens next, and the exact comment entail will post on the issue. "Record answer as <owner> (final)" records it, and "Back" returns to the form.
2. **Receipt.** The item then shows a receipt in place:
   - who answered, when, and the item version answered;
   - the ticket's new state, deciding to write criteria or cancelled, and what happens next;
   - the comment entail will post.

   A "Next decision" button opens the oldest open item. The page does not move on by itself.

## An item that changes while it is open

- The page asks entail's local process for the board every few seconds.
- An open item can be withdrawn while the owner is on it: the issue was closed elsewhere, or a vision or pin change touched it (ADR-0008). When that happens, its form locks and says why and what happens next.
- Text the owner had typed stays visible to copy and is never recorded.
- The form submits the item version it showed. entail refuses an answer to a withdrawn item, an answered item or an older version, and the page says so.

## Considered options

- **One item at a time, answer first, evidence folded** (prototype layout B): passed over by the owner. It is quicker, but it hides the vision check and the history the board exists to show.
- **Every open item on one page, with one-click answers** (layout C): passed over by the owner. It crowds once there are more than a few items, and one-click answers skip the review.
- **Record on one click, with no review**: rejected by the owner. Answers are final, and the chosen option or the owner's words are quoted on a possibly public issue.
- **Move to the next item automatically after answering**: rejected by the owner in favour of the receipt and a "Next decision" button.
- **Newest first, or grouped by repo**: rejected by the owner. Oldest first keeps any item from waiting forever behind newer ones, and one list keeps the board a single place to look.
- **A link to edit VISION.md, or to run /vision, beside a contradicting option**: rejected by the owner. Vision editing stays off the board, and the vision changes by hand or through /vision.
- **Keep answered items until the owner clears them, or drop them at once**: rejected by the owner. Clearing them is a chore, and dropping them at once hides what was just done.

## Consequences

- The prototype is kept, unmerged, on the `prototype/board-page` branch as the primary source.
  - Its first version showed a colour item and a `--json` item, both raised under the old small rule. Seeing them led to ADR-0011, under which both are cleared.
  - Its current version shows only items that still reach the owner: two contradictions, a touched pin, and consequential readings.
- An item's version is part of the board's data, since the form submits it.
- The board's polling is local traffic to entail's own process and costs no forge requests.
- Decided on [How should the board page look and behave when the owner answers an item?](https://github.com/omkarbhale/entail/issues/29).
