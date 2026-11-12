---
kind: landing
repo: omkarbhale/entail
issue: 169
pr: 175
head: d6717457fc2dd644e0fa260d69dceae9c16f733e
base: 380bf059ac1feab4822ebb52f9ff115216342fe1
call: merge
date: 2026-11-12
vision-commit: 380bf059ac1feab4822ebb52f9ff115216342fe1
reason-from: written from the record: the owner's issue #177 calls entail's refusal of this PR wrong, and the rebuild plan (#178) names it among the wrong calls; the owner wrote no other reason
---

Every criterion was met; the loading message, the note when JavaScript is off, the JSON replies, the moved endpoint and the hover style follow from rebuilding the board as a client-rendered app, so they are part of the job, not changes beyond it.

## What happened

entail's old landing check found all five criteria met, then refused the PR because it "does something users can observe beyond its criteria": the board shows "Loading the board…" and a note when JavaScript is off, pages asked for as JSON answer with JSON, the live endpoint moved from /board/live to /board/data, the built app is served under /ui/, the Content-Security-Policy is stricter, new error banners appear when a request fails, and board list items get a hover style.

## The owner's words

From #177, "Landing check refuses the necessary consequences of a met criterion as 'beyond its criteria'":

> A change that is a necessary consequence of meeting a criterion is in scope, not "beyond" it.
> "Beyond the criteria" should catch genuinely separate behaviour the ticket didn't ask for, such as an extra feature or an unrelated change to how something works.

The PR was later closed unmerged only because the tree was restarted (#178), not for anything in it.
