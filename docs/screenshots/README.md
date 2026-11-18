# Board screenshots

The pictures of the board and of a posted call that [the user guide](../guide.md#the-board) and the [README](../../README.md) show.

| File | What it shows |
| --- | --- |
| `waiting.png` | The Waiting page: a go on an issue to confirm, with its criteria and the vision line it rests on, and below it a merge call on a PR. |
| `log.png` | The Log page: every call newest first, those waiting on the owner beside those the owner confirmed. |
| `repos.png` | The Repos page: one enrolled repo with confirm mode, the model and effort, suggesting work, the vision and the pins. |
| `call.png` | entail's go as posted on the public issue [#203](https://github.com/omkarbhale/entail/issues/203#issuecomment-6971185621), as a signed-out reader sees it on GitHub. |

## Retake them when the board's pages change

Any change to what the Waiting, Log or Repos page shows, or to what entail posts on an issue, retakes these pictures in the same PR. From a built checkout, with Chromium or Chrome installed:

```sh
npm run build
node docs/screenshots/take.mjs
```

[`take.mjs`](take.mjs) adds no dependency. It writes a demo data directory with [`demo-data.mjs`](demo-data.mjs) into a temporary directory under `$HOME`, starts a real `entail run` on it on port 4391 (`PORT=` to change it) with stand-ins for `gh`, `glab` and `claude` that never answer, so the run posts nothing and reaches no forge, and drives a headless browser (`CHROME=` to pick one) at 1280 pixels wide, full page height, in the light theme over the three pages. It then opens the posted call on #203 signed out and crops to the comment. It removes the temporary directory when it is done.

The demo data names only the public repo omkarbhale/entail and its public issues: no private repos, no tokens, no email addresses. Keep it that way when changing it, and look at each picture before committing it. When the board shows something new that the demo data does not exercise, add entries to `demo-data.mjs` in the format `src/records.ts` reads. Keep each PNG under 300 KB.
