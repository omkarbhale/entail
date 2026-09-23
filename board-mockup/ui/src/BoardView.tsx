// The board: a place to describe new work, the stages once, one row per item
// in flight, then what has landed. Every word and glyph here is served; the
// component only decides where it goes.

import { useState } from 'react'
import type { AdvanceMode, Board, Item, Sourced } from '../../mock-server/src/contract.ts'
import { Mark } from './Mark.tsx'
import { ADVANCE_MODES, COLUMNS } from './targets.ts'

type Props = {
  readonly board: Sourced<Board>
  readonly busy: boolean
  readonly onDescribe: (description: string) => Promise<boolean>
  readonly onAdvance: (id: string) => void
  readonly onSetMode: (id: string, mode: AdvanceMode) => void
}

export function BoardView({ board: { value: board }, busy, onDescribe, onAdvance, onSetMode }: Props) {
  const [draft, setDraft] = useState('')
  const items = board.items.value.map(({ value }) => value)
  const inFlight = items.filter((item) => item.motion.value !== 'landed')
  const landed = items.filter((item) => item.motion.value === 'landed')
  const submit = async () => {
    if (await onDescribe(draft)) setDraft('')
  }
  return (
    <section className="board" aria-label="Board">
      <form
        className="describe"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <label htmlFor="describe-work">
          <Mark k="describe" />
        </label>
        <textarea id="describe-work" rows={2} value={draft} onChange={(event) => setDraft(event.target.value)} />
        <div>
          <Mark k="submit" disabled={busy || draft.trim() === ''} onAct={() => void submit()} />
        </div>
      </form>

      <h1>
        <Mark k="heading" />
      </h1>
      <p className="stages">
        <Mark k="stages" />{' '}
        {board.stages.value.map(({ value: stage }, i) => (
          <span key={stage.id.value}>
            {i > 0 && <Mark k="stage-separator" />}
            <Mark k={`stage:${stage.id.value}`} />
          </span>
        ))}
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {COLUMNS.map((column) => (
                <th key={column} scope="col">
                  <Mark k={`column:${column}`} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {inFlight.map((item) => {
              const id = item.id.value
              const handover = item.stop.value?.handover.value
              return (
                <tr key={id}>
                  <td>
                    <Mark k={`${id}:title`} />
                    <Answers item={item} />
                  </td>
                  <td>
                    <Mark k={`${id}:stage`} />
                    <div className="advance">
                      <Mark k={`${id}:advance`} disabled={busy || !item.advanceable.value} onAct={() => onAdvance(id)} />
                    </div>
                  </td>
                  <td>
                    <Mark k={`${id}:motion`} />
                    {item.agent.value !== null && (
                      <div className="agent">
                        <Mark k={`${id}:label:agent`} />
                        <br />
                        <code>
                          <Mark k={`${id}:agent`} />
                        </code>
                      </div>
                    )}
                  </td>
                  <td className="stop">
                    {item.stop.value === null ? (
                      <Mark k={`${id}:stop`} />
                    ) : (
                      <>
                        <Mark k={`${id}:stop.category`} />
                        <br />
                        <span className="stop-detail">
                          <Mark k={`${id}:stop.detail`} />
                        </span>
                        {handover != null && (
                          <div className="handover">
                            <Mark k={`${id}:label:handover`} />
                            <div className="handover-text">
                              <Mark k={`${id}:handover`} />
                            </div>
                            <Mark k={`${id}:copy`} onAct={() => void navigator.clipboard?.writeText(handover.text.value)} />
                          </div>
                        )}
                      </>
                    )}
                  </td>
                  <td>
                    <div className="modes" role="group">
                      {ADVANCE_MODES.map((mode) => {
                        const current = mode === item.advanceMode.value
                        return (
                          <Mark
                            key={mode}
                            k={`${id}:mode:${mode}`}
                            pressed={current}
                            disabled={busy || current}
                            onAct={() => onSetMode(id, mode)}
                          />
                        )
                      })}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {landed.length > 0 && (
        <section className="landed" aria-label="Landed">
          <h2>
            <Mark k="landed-heading" />
          </h2>
          <ul>
            {landed.map((item) => {
              const id = item.id.value
              return (
                <li key={id}>
                  <Mark k={`${id}:title`} /> <Mark k={`${id}:motion`} />
                  {item.pullRequest.value !== null && (
                    <div>
                      <Mark k={`${id}:label:pullRequest`} /> <Mark k={`${id}:pullRequest`} />
                    </div>
                  )}
                  {item.answers.value.length === 0 ? (
                    <div className="answers">
                      <Mark k={`${id}:no-answers`} />
                    </div>
                  ) : (
                    <Answers item={item} />
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </section>
  )
}

/** What an item asked and was answered, each with who the words came from (D-56). */
function Answers({ item }: { readonly item: Item }) {
  const id = item.id.value
  if (item.answers.value.length === 0) return null
  return (
    <div className="answers">
      <Mark k={`${id}:label:answers`} />
      <ul>
        {item.answers.value.map((_, i) => (
          <li key={i}>
            <span className="answer-asked">
              <Mark k={`${id}:answer:${i}:asked`} />
            </span>
            <br />
            <Mark k={`${id}:answer:${i}`} />
            <br />
            <span className="answer-origin">
              <Mark k={`${id}:answer:${i}:origin`} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
