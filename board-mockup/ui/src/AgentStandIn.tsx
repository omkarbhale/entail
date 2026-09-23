// Part of the mockup's frame, not of the board. It plays the agent the user
// hands the board's invocation to, so the loop can be seen in a browser: it
// sends the answer through the mock's stand-in for the imagined MCP tool, the
// only way an answer enters (DECISIONS.md D-55). Nothing Entail shows is
// designed here, and the board itself never calls it.

import { useState } from 'react'
import type { AnswerOrigin, Board, ResolveRequest, Sourced } from '../../mock-server/src/contract.ts'

type Props = {
  readonly board: Sourced<Board>
  readonly busy: boolean
  readonly onResolve: (resolution: ResolveRequest) => Promise<boolean>
}

const ORIGINS: readonly { readonly origin: AnswerOrigin; readonly text: string }[] = [
  { origin: 'stated-by-user', text: 'The user said these words; the agent passes them on unchanged.' },
  { origin: 'composed-by-agent', text: 'The agent composed these words; the user agreed to them.' },
]

export function AgentStandIn({ board, busy, onResolve }: Props) {
  const pending = board.value.items.value.flatMap(({ value: item }) => {
    const handover = item.stop.value?.handover.value
    return handover == null ? [] : [{ item: item.id.value, pending: handover.pending.value, text: handover.text.value }]
  })
  const [chosen, setChosen] = useState<string>()
  const [answer, setAnswer] = useState('')
  const [origin, setOrigin] = useState<AnswerOrigin>()
  const current = pending.find((p) => p.pending === chosen) ?? pending[0]

  if (current === undefined) {
    return (
      <section className="stand-in" aria-label="Agent stand-in">
        <h2>Stand-in for an agent</h2>
        <p>Nothing on the board is waiting on an answer.</p>
      </section>
    )
  }
  const ready = answer.trim() !== '' && origin !== undefined && !busy
  return (
    <section className="stand-in" aria-label="Agent stand-in">
      <h2>Stand-in for an agent</h2>
      <p>
        Not part of the board. In Entail the user would give what the board hands over to an agent, and the agent would
        answer through Entail’s MCP, which does not exist. This panel plays that agent. It sends one call to the mock
        server’s stand-in for the MCP tool, and the board shows what that recorded.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (!ready) return
          void onResolve({ item: current.item, pending: current.pending, answer, origin }).then((ok) => {
            if (ok) {
              setAnswer('')
              setOrigin(undefined)
              setChosen(undefined)
            }
          })
        }}
      >
        <label>
          Handed over:{' '}
          <select value={current.pending} onChange={(event) => setChosen(event.target.value)}>
            {pending.map((p) => (
              <option key={p.pending} value={p.pending}>
                {p.pending}
              </option>
            ))}
          </select>
        </label>
        <blockquote>{current.text}</blockquote>
        <label>
          Answer
          <textarea rows={2} value={answer} onChange={(event) => setAnswer(event.target.value)} />
        </label>
        <fieldset>
          <legend>Whose words are they? The agent must say, and nothing checks it (D-56).</legend>
          {ORIGINS.map((o) => (
            <label key={o.origin}>
              <input type="radio" name="origin" checked={origin === o.origin} onChange={() => setOrigin(o.origin)} />{' '}
              {o.text}
            </label>
          ))}
        </fieldset>
        <button type="submit" disabled={!ready}>
          Send as the agent
        </button>
      </form>
    </section>
  )
}
