// Starts the mock server, after checking that every citation and decision id
// its provenance uses resolves. It will not serve state it cannot account for.

import { INITIAL_ITEMS } from './fiction.ts'
import { allProvenance, loadDecisions, problems } from './integrity.ts'
import { boardServer } from './server.ts'

const decisions = loadDecisions()
const found = problems(allProvenance(), decisions)
if (found.length > 0) {
  console.error('Provenance does not resolve; refusing to start:')
  for (const problem of found) console.error(`  - ${problem}`)
  process.exit(1)
}

// Fixed, because the UI's dev server forwards /api here (ui/vite.config.ts).
const port = 4317
boardServer(INITIAL_ITEMS, { decisions }).listen(port, () => {
  console.log(`Entail board mock server on http://localhost:${port} (in-memory, resets on restart)`)
})
