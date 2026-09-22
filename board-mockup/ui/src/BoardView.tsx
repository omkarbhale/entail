// The board: the stages once, then one row per item in flight. Every word and
// glyph here is served; the component only decides where it goes.

import type { AdvanceMode, Board, Sourced } from '../../mock-server/src/contract.ts'
import { Mark } from './Mark.tsx'
import { ADVANCE_MODES, COLUMNS } from './targets.ts'

type Props = {
  readonly board: Sourced<Board>
  readonly busy: boolean
  readonly onAdvance: (id: string) => void
  readonly onSetMode: (id: string, mode: AdvanceMode) => void
}

export function BoardView({ board: { value: board }, busy, onAdvance, onSetMode }: Props) {
  return (
    <section className="board" aria-label="Board">
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
            {board.items.value.map(({ value: item }) => {
              const id = item.id.value
              return (
                <tr key={id}>
                  <td>
                    <Mark k={`${id}:title`} />
                  </td>
                  <td>
                    <Mark k={`${id}:stage`} />
                    <div className="advance">
                      <Mark k={`${id}:advance`} disabled={busy || !item.advanceable.value} onAct={() => onAdvance(id)} />
                    </div>
                  </td>
                  <td>
                    <Mark k={`${id}:motion`} />
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
    </section>
  )
}
