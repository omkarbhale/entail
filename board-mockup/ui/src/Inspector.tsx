// Part of the mockup's frame, not of the board: says where one thing on the
// board came from, in full.

import type { DecisionEntry } from '../../mock-server/src/contract.ts'
import type { Citation, DecisionId, Provenance } from '../../mock-server/src/provenance.ts'
import { markOf } from './Mark.tsx'
import type { Target } from './targets.ts'

const KIND_NAMES: Record<Provenance['kind'], string> = {
  recorded: 'Recorded',
  interpreted: 'Interpreted',
  assumed: 'Assumed',
  placeholder: 'Placeholder',
  'user-input': 'Set by you',
  'agent-composed': 'Agreed by you, composed by an agent',
}

type Props = {
  readonly target: Target | undefined
  readonly pinned: boolean
  readonly decisions: readonly DecisionEntry[]
}

export function Inspector({ target, pinned, decisions }: Props) {
  if (target === undefined) {
    return (
      <aside className="inspector" aria-label="Inspector">
        <p className="inspector-empty">Point at anything on the board to see where it came from. Click to keep it here.</p>
      </aside>
    )
  }
  const question = (id: DecisionId) => decisions.find((d) => d.id === id)?.question ?? '(not in DECISIONS.md)'
  return (
    <aside className="inspector" aria-label="Inspector" aria-live="polite">
      <p className="inspector-name">
        {target.name}
        {pinned && <span className="inspector-pinned"> · kept</span>}
      </p>
      <p className="inspector-shown">{target.shown}</p>
      {target.parts.map((part) => (
        <section key={part.heading} className="inspector-part">
          <h2>{part.heading}</h2>
          <p>
            <span className={`kind kind-${markOf(part.provenance.kind)}`}>{KIND_NAMES[part.provenance.kind]}</span>
          </p>
          <Explanation provenance={part.provenance} question={question} />
        </section>
      ))}
    </aside>
  )
}

function Explanation({ provenance: p, question }: { provenance: Provenance; question: (id: DecisionId) => string }) {
  switch (p.kind) {
    case 'recorded':
      return <Quote cites={p.cites} lead="Stated in" />
    case 'interpreted':
      return (
        <>
          <Quote cites={p.cites} lead="Bears on it:" />
          <p>What this mockup added: {p.gap}</p>
          <Open id={p.decision} question={question(p.decision)} />
        </>
      )
    case 'assumed':
      return (
        <>
          <p>{p.reason}</p>
          <Open id={p.decision} question={question(p.decision)} />
        </>
      )
    case 'placeholder':
      return <p>{p.reason}</p>
    case 'user-input':
      return (
        <p>
          You did this ({p.action}). {p.note}
        </p>
      )
    case 'agent-composed':
      return (
        <p>
          An agent composed this and you agreed to it ({p.action}). {p.note}
        </p>
      )
  }
}

function Quote({ cites, lead }: { cites: Citation; lead: string }) {
  return (
    <>
      <p>
        {lead} <code>{cites.file}</code> § {cites.section}
      </p>
      <blockquote>{cites.quote}</blockquote>
    </>
  )
}

function Open({ id, question }: { id: DecisionId; question: string }) {
  return (
    <p className="open">
      Open question <strong>{id}</strong> in <code>board-mockup/DECISIONS.md</code>: {question}
    </p>
  )
}
