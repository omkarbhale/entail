# Landing check refuses the necessary consequences of a met criterion as "beyond its criteria"

entail's landing check refuses PRs as "beyond its criteria" for changes that are simply the necessary consequences of a criterion it agrees is met.

### What happened

On #175 (the board rebuilt as a React single-page app, for #169), the landing check found all five criteria met. It then refused the PR because the change "does something users can observe beyond its criteria":

- without JavaScript, the board shows a "turn on JavaScript" note, and it shows "Loading the board…" while it starts;
- requests asking for JSON get JSON, and the answer endpoint replies with JSON;
- the live-update endpoint moved from `/board/live` to `/board/data`.

All of these follow directly from C1 ("a client-rendered single-page app built with a front-end framework"). The same kind of refusal stalled tickets T1 and T6 in the live acceptance run on #176.

### Expected

- A change that is a necessary consequence of meeting a criterion is in scope, not "beyond" it.
- "Beyond the criteria" should catch genuinely separate behaviour the ticket didn't ask for, such as an extra feature or an unrelated change to how something works.
- Per `VISION.md`, a fix to how entail judges states the case it fixes (this one), what it could break (letting real scope creep through) and why.
