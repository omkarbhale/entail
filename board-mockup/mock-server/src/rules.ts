// The mock's assumed behaviour: when an item may be advanced, what advancing
// and setting the advance mode do to it. None of this is recorded; each rule
// is a stand-in answer to an open question in ../DECISIONS.md, and the
// provenance it stamps on the values it produces says which.
//
// Nothing here runs a stage, derives anything or moves an item on its own.
// An item only changes when someone calls one of the two actions.

import type { AdvanceMode, Item, Refusal } from './contract.ts'
import { assumed, placeholder, sourced, userInput } from './mark.ts'
import type { Provenance, Sourced } from './provenance.ts'

const ADVANCEABLE = {
  allowed: assumed(
    'D-24',
    'Allowed: this item is stopped at a completed stage. This mock assumes that is the only time an item can be advanced.',
  ),
  moving: assumed(
    'D-24',
    'Refused: this item is moving. This mock assumes an item can be advanced only when it is stopped at a completed stage.',
  ),
  raised: assumed(
    'D-24',
    'Refused: this item stopped because it has something to raise or needs you. This mock assumes that must be dealt with first, and the board has no action for dealing with it (D-20).',
  ),
  lastStage: assumed(
    'D-07',
    'Refused: this item is at the last stage. Nothing recorded says what comes after the final pull request.',
  ),
} as const

const AFTER_ADVANCE_MOTION = assumed(
  'D-26',
  'After an advance this mock puts the item in motion in its new stage. Nothing runs in this mock, so it stays moving until the server restarts.',
)

const AFTER_ADVANCE_STOP = assumed('D-26', 'Cleared by the advance: a moving item has no stop.')

const ADVANCED_STAGE = userInput(
  'advance',
  'You sent this item to the next stage. Which stage is next comes from the assumed stage list (D-10).',
)

const MODE_SET = userInput(
  'set advance mode',
  'You set this. In this mock it changes nothing else about the item, not even one already waiting at a completed stage (D-30).',
)

export const PROTOCOL = placeholder(
  'Protocol message of this mock server. It carries no design meaning.',
)

/** Every provenance this module can stamp, for integrity.ts to check at startup. */
export const RULE_PROVENANCE: readonly Provenance[] = [
  ...Object.values(ADVANCEABLE),
  AFTER_ADVANCE_MOTION,
  AFTER_ADVANCE_STOP,
  ADVANCED_STAGE,
  MODE_SET,
  PROTOCOL,
]

type Position = Pick<Item, 'stage' | 'motion' | 'stop'>

export function advanceability(item: Position, stageIds: readonly string[]): Sourced<boolean> {
  const why = refusalReason(item, stageIds)
  return why === undefined ? sourced(true, ADVANCEABLE.allowed) : sourced(false, why)
}

function refusalReason(item: Position, stageIds: readonly string[]): Provenance | undefined {
  if (item.motion.value === 'moving') return ADVANCEABLE.moving
  if (item.stop.value?.category.value !== 'stage-complete') return ADVANCEABLE.raised
  if (stageIds.indexOf(item.stage.value) === stageIds.length - 1) return ADVANCEABLE.lastStage
  return undefined
}

export type Outcome = { readonly ok: true; readonly item: Item } | { readonly ok: false; readonly refusal: Refusal }

export function advance(item: Item, stageIds: readonly string[]): Outcome {
  const why = refusalReason(item, stageIds)
  if (why !== undefined) {
    return { ok: false, refusal: { reason: sourced(explain(why), why) } }
  }
  const next = stageIds[stageIds.indexOf(item.stage.value) + 1]
  if (next === undefined) {
    // refusalReason already refused the last stage; an unknown stage lands here.
    return { ok: false, refusal: refusal(`Stage "${item.stage.value}" is not in the stage list.`) }
  }
  const moved = {
    stage: sourced(next, ADVANCED_STAGE),
    motion: sourced('moving' as const, AFTER_ADVANCE_MOTION),
    stop: sourced(null, AFTER_ADVANCE_STOP),
  }
  return { ok: true, item: { ...item, ...moved, advanceable: advanceability(moved, stageIds) } }
}

export function setAdvanceMode(item: Item, mode: AdvanceMode): Item {
  return { ...item, advanceMode: sourced(mode, MODE_SET) }
}

/** A refusal about the request itself rather than about the board. */
export function refusal(message: string): Refusal {
  return { reason: sourced(message, PROTOCOL) }
}

function explain(provenance: Provenance): string {
  return provenance.kind === 'assumed' ? provenance.reason : 'Refused.'
}
