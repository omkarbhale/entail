// Part of the mockup's frame, not of the board. It plays a moving item's stage
// finishing, so the whole flow can be seen in a browser on work the user
// created: nothing in the mock runs a stage, so without it a moving item would
// stay moving (DECISIONS.md D-65). It decides nothing about what finishing
// means, derives nothing and runs no agent. Nothing Entail shows is designed
// here, and the board itself never calls it.

import { useState } from 'react'
import type { Board, Sourced, StageEndingRequest, StopCategory } from '../../mock-server/src/contract.ts'

type Props = {
  readonly board: Sourced<Board>
  readonly busy: boolean
  readonly onEndStage: (ending: StageEndingRequest) => Promise<boolean>
}

const ENDINGS: readonly { readonly category: StopCategory; readonly text: string }[] = [
  { category: 'stage-complete', text: 'The stage finishes, and the item waits to be sent on.' },
  { category: 'has-something-to-raise', text: 'The stage stops with something to raise.' },
  { category: 'needs-user', text: 'The stage stops because the user is needed.' },
]

export function StageEndingStandIn({ board, busy, onEndStage }: Props) {
  const moving = board.value.items.value.flatMap(({ value: item }) =>
    item.motion.value === 'moving' ? [{ id: item.id.value, title: item.title.value, stage: item.stage.value }] : [],
  )
  const [chosen, setChosen] = useState<string>()
  const [category, setCategory] = useState<StopCategory>()
  const [asks, setAsks] = useState('')
  const current = moving.find((m) => m.id === chosen) ?? moving[0]

  if (current === undefined) {
    return (
      <section className="stand-in" aria-label="Stage-ending stand-in">
        <h2>Stand-in for a stage finishing</h2>
        <p>Nothing on the board is moving.</p>
      </section>
    )
  }
  const request: StageEndingRequest | undefined =
    category === undefined
      ? undefined
      : category === 'stage-complete'
        ? { item: current.id, category }
        : asks.trim() === ''
          ? undefined
          : { item: current.id, category, asks }
  const ready = request !== undefined && !busy
  return (
    <section className="stand-in" aria-label="Stage-ending stand-in">
      <h2>Stand-in for a stage finishing</h2>
      <p>
        Not part of the board. In Entail something would end a moving item’s stage; nothing records what, or what says
        a stage is done, and none of it exists. This panel plays that ending. It sends one call to the mock server’s
        stand-in for it, and the board shows the item stopped.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (!ready) return
          void onEndStage(request).then((ok) => {
            if (ok) {
              setCategory(undefined)
              setAsks('')
              setChosen(undefined)
            }
          })
        }}
      >
        <label>
          Moving:{' '}
          <select value={current.id} onChange={(event) => setChosen(event.target.value)}>
            {moving.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}, {m.stage}: {m.title}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>How does its stage end? Nothing here decides it.</legend>
          {ENDINGS.map((e) => (
            <label key={e.category}>
              <input
                type="radio"
                name="stage-ending"
                checked={category === e.category}
                onChange={() => setCategory(e.category)}
              />{' '}
              {e.text}
            </label>
          ))}
        </fieldset>
        {category !== undefined && category !== 'stage-complete' && (
          <label>
            What the stage asks
            <textarea rows={2} value={asks} onChange={(event) => setAsks(event.target.value)} />
          </label>
        )}
        <button type="submit" disabled={!ready}>
          End the stage as the stand-in
        </button>
      </form>
    </section>
  )
}
