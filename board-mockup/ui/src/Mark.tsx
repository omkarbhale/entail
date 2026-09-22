// One inspectable thing on the board, drawn by how loudly its provenance
// should show: recorded loudly, set-by-you plainly, everything invented
// quietly. Which kind a target shows as is decided in targets.ts (D-50).
// Pointing at it or focusing it shows it in the inspector; clicking keeps it
// there and, for a control, also acts.

import { createContext, useContext, type ReactNode } from 'react'
import type { ProvenanceKind } from '../../mock-server/src/provenance.ts'
import type { Targets } from './targets.ts'

export type Inspection = {
  readonly targets: Targets
  readonly shown: string | undefined
  readonly pinned: string | undefined
  readonly setHovered: (key: string | undefined) => void
  readonly setPinned: (key: string) => void
}

export const InspectionContext = createContext<Inspection | undefined>(undefined)

/** The palette has three marks, not five: see styles.css. */
export const markOf = (kind: ProvenanceKind): 'recorded' | 'user' | 'invented' =>
  kind === 'recorded' ? 'recorded' : kind === 'user-input' ? 'user' : 'invented'

type Props = {
  readonly k: string
  readonly children?: ReactNode
  /** Makes this a control: clicking acts instead of pinning. */
  readonly onAct?: () => void
  readonly disabled?: boolean
  readonly pressed?: boolean
}

export function Mark({ k, children, onAct, disabled = false, pressed }: Props) {
  const inspection = useContext(InspectionContext)
  const target = inspection?.targets.get(k)
  if (inspection === undefined || target === undefined) {
    throw new Error(`Nothing to inspect for "${k}"; every mark needs a target`)
  }
  const classes = [
    'mark',
    `mark-${markOf(target.kind)}`,
    onAct === undefined ? 'mark-text' : 'mark-control',
    inspection.shown === k ? 'mark-shown' : '',
  ]
  return (
    <button
      type="button"
      className={classes.join(' ')}
      aria-disabled={disabled || undefined}
      aria-pressed={pressed}
      onMouseEnter={() => inspection.setHovered(k)}
      onMouseLeave={() => inspection.setHovered(undefined)}
      onFocus={() => inspection.setHovered(k)}
      onBlur={() => inspection.setHovered(undefined)}
      onClick={() => {
        inspection.setPinned(k)
        if (onAct !== undefined && !disabled) onAct()
      }}
    >
      {children ?? target.shown}
    </button>
  )
}
