// The mockup's frame: banner, legend, inspector, the stand-ins and errors. This text
// describes the mockup and is not served; everything that depicts the board is
// (DECISIONS.md D-41). The frame is drawn apart from the board so the two
// cannot be confused.

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AdvanceMode, Board, Catalogue, Sourced } from '../../mock-server/src/contract.ts'
import { AgentStandIn } from './AgentStandIn.tsx'
import * as api from './api.ts'
import { BoardView } from './BoardView.tsx'
import { Inspector } from './Inspector.tsx'
import { StageEndingStandIn } from './StageEndingStandIn.tsx'
import { InspectionContext, type Inspection } from './Mark.tsx'
import { buildTargets } from './targets.ts'

type Loaded = { readonly board: Sourced<Board>; readonly catalogue: Catalogue }

export function App() {
  const [loaded, setLoaded] = useState<Loaded>()
  const [loadError, setLoadError] = useState<string>()
  const [actionError, setActionError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [hovered, setHovered] = useState<string>()
  const [pinned, setPinned] = useState<string>()

  const reload = useCallback(async () => {
    try {
      setLoaded(await api.loadBoard())
      setLoadError(undefined)
    } catch (error) {
      setLoadError(String(error instanceof Error ? error.message : error))
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  /** Runs one action, then refetches the board; says whether the action was accepted. */
  const act = useCallback(
    async (action: () => Promise<unknown>): Promise<boolean> => {
      setBusy(true)
      setActionError(undefined)
      let ok = true
      try {
        await action()
      } catch (error) {
        ok = false
        setActionError(error instanceof api.Refused ? `The mock server refused: ${error.message}` : String(error))
      }
      await reload()
      setBusy(false)
      return ok
    },
    [reload],
  )

  const targets = useMemo(() => (loaded === undefined ? undefined : buildTargets(loaded.board, loaded.catalogue)), [loaded])
  const shown = hovered ?? pinned
  const inspection: Inspection | undefined =
    targets === undefined ? undefined : { targets, shown, pinned, setHovered, setPinned }

  return (
    <div className="page">
      <header className="frame">
        <p className="banner">
          <strong>Mockup of Entail’s board.</strong> Everything inside the board below comes from the mock server, and
          almost all of it is invented. Nothing runs here: a moving item stays moving until the first panel under the
          board plays its stage finishing (D-65), and no agent, tmux pane or MCP exists. The second panel plays the
          agent, so an answer can be seen arriving. Every question this drawing had
          to answer is listed, unanswered, in <code>board-mockup/DECISIONS.md</code>.
        </p>
        <ul className="legend" aria-label="Legend">
          <li>
            <span className="mark mark-recorded mark-text">Recorded</span> stated in <code>VISION.md</code> or{' '}
            <code>unfiled/</code>
          </li>
          <li>
            <span className="mark mark-user mark-text">Set by you</span> changed through an action since the server
            started
          </li>
          <li>
            <span className="mark mark-agreed mark-text">Agreed by you</span> an agent composed it and you agreed; you
            did not state it
          </li>
          <li>
            <span className="mark mark-invented mark-text">Invented</span> interpreted, assumed or placeholder: made up
            so the board could be drawn
          </li>
          <li>Point at anything on the board to see where it came from; click to keep it in the inspector.</li>
        </ul>
        {actionError !== undefined && (
          <p className="frame-error" role="alert">
            {actionError}
          </p>
        )}
      </header>

      {loadError !== undefined ? (
        <p className="frame-error frame-down" role="alert">
          The mock server is not reachable ({loadError}). Start it in another terminal with{' '}
          <code>cd board-mockup/mock-server &amp;&amp; npm start</code>, then reload this page.
        </p>
      ) : loaded === undefined || inspection === undefined ? (
        <p className="frame-loading">Loading from the mock server…</p>
      ) : (
        <InspectionContext.Provider value={inspection}>
          <div className="workspace">
            <div className="column">
              <BoardView
                board={loaded.board}
                busy={busy}
                onDescribe={(description) => act(() => api.describeWork(description))}
                onAdvance={(id) => void act(() => api.advance(id))}
                onSetMode={(id: string, mode: AdvanceMode) => void act(() => api.setAdvanceMode(id, mode))}
              />
              <StageEndingStandIn
                board={loaded.board}
                busy={busy}
                onEndStage={(ending) => act(() => api.endStageAsStandIn(ending))}
              />
              <AgentStandIn
                board={loaded.board}
                busy={busy}
                onResolve={(resolution) => act(() => api.resolveAsAgent(resolution))}
              />
            </div>
            <Inspector
              target={shown === undefined ? undefined : inspection.targets.get(shown)}
              pinned={shown !== undefined && shown === pinned && hovered === undefined}
              decisions={loaded.catalogue.decisions}
            />
          </div>
        </InspectionContext.Provider>
      )}
    </div>
  )
}
