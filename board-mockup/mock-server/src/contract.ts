// The API contract between the board UI and this mock server.
//
// Types only, so the UI imports it without importing server code. Every
// response body except the catalogue is a Sourced<...>; the catalogue is the
// provenance vocabulary itself (see Catalogue below).
//
// Nothing here is a design for Entail's real interface. The words, the
// shapes and the routes were all chosen to make a mockup drawable, and each
// choice that answers an open question is listed in ../DECISIONS.md.

import type {
  DecisionId,
  FieldProvenance,
  Payload,
  Provenance,
  Sourced,
} from './provenance.ts'

export type ListOf<T extends Payload> = readonly Sourced<T>[]

// ---- Served records -------------------------------------------------------

export type Stage = {
  /** Referenced by Item.stage. */
  readonly id: Sourced<string>
  readonly name: Sourced<string>
}

export type Motion = 'moving' | 'stopped'

export type StopCategory = 'stage-complete' | 'has-something-to-raise' | 'needs-user'

export type AdvanceMode = 'automatic' | 'stop-for-user'

export type Stop = {
  readonly category: Sourced<StopCategory>
  /** One sentence saying what the item is stopped on. */
  readonly detail: Sourced<string>
}

export type Item = {
  readonly id: Sourced<string>
  readonly title: Sourced<string>
  /** A Stage id from Board.stages. */
  readonly stage: Sourced<string>
  readonly motion: Sourced<Motion>
  /** null while the item is moving. */
  readonly stop: Sourced<Stop | null>
  readonly advanceMode: Sourced<AdvanceMode>
  /**
   * Whether POST .../advance would be accepted now. The rule lives on the
   * server so the UI holds none; the provenance says why, for this item.
   */
  readonly advanceable: Sourced<boolean>
}

/**
 * Every word and glyph the board itself shows, so that each one carries
 * provenance like any other value. Text that describes the mockup rather than
 * depicting the board (its banner, legend and inspector) is the UI's own; see
 * DECISIONS.md D-41.
 */
export type Labels = {
  readonly heading: Sourced<string>
  readonly stages: Sourced<string>
  /** Drawn between consecutive stage names. */
  readonly stageSeparator: Sourced<string>
  readonly title: Sourced<string>
  readonly stage: Sourced<string>
  readonly motion: Sourced<string>
  readonly stop: Sourced<string>
  /** Shown in the stop column for an item with no stop. */
  readonly noStop: Sourced<string>
  readonly advanceMode: Sourced<string>
  readonly moving: Sourced<string>
  readonly stopped: Sourced<string>
  readonly stageComplete: Sourced<string>
  readonly hasSomethingToRaise: Sourced<string>
  readonly needsUser: Sourced<string>
  readonly automatic: Sourced<string>
  readonly stopForUser: Sourced<string>
  readonly advance: Sourced<string>
  readonly cannotAdvance: Sourced<string>
}

export type Board = {
  /** In order; advancing moves an item to the next one in this list. */
  readonly stages: Sourced<ListOf<Stage>>
  readonly items: Sourced<ListOf<Item>>
  readonly labels: Sourced<Labels>
}

/** Body of a refused request, served with a 4xx status. */
export type Refusal = {
  readonly reason: Sourced<string>
}

// ---- The catalogue: what provenance points into -----------------------------

/** Every served record type, by name. FieldCatalogue is derived from it. */
export type ServedRecords = {
  readonly board: Board
  readonly labels: Labels
  readonly stage: Stage
  readonly item: Item
  readonly stop: Stop
  readonly refusal: Refusal
}

export type FieldCatalogue = {
  readonly [N in keyof ServedRecords]: FieldProvenance<ServedRecords[N]>
}

/** An entry of ../DECISIONS.md, parsed from that file when the server starts. */
export type DecisionEntry = {
  readonly id: DecisionId
  readonly question: string
}

/**
 * GET /api/catalogue. Not wrapped in Sourced: it is the marking, not marked
 * state. `fields` says why each field of each served record exists; its
 * entries are Provenance, which is where the recursion stops. `decisions` is
 * ../DECISIONS.md itself, so the UI can show the question a DecisionId names
 * without the question being written down twice.
 */
export type Catalogue = {
  readonly fields: FieldCatalogue
  readonly decisions: readonly DecisionEntry[]
}

// ---- Routes ---------------------------------------------------------------

/**
 * GET  /api/board                        -> 200 Sourced<Board>
 * GET  /api/catalogue                    -> 200 Catalogue
 * POST /api/items/:id/advance            -> 200 Sourced<Item> | 404/409 Sourced<Refusal>
 * PUT  /api/items/:id/advance-mode       -> 200 Sourced<Item> | 400/404 Sourced<Refusal>
 *        body: SetAdvanceModeRequest
 *
 * Any other path -> 404 Sourced<Refusal>.
 */
export type SetAdvanceModeRequest = {
  readonly mode: AdvanceMode
}

export type ApiResponseBody = Sourced<Board> | Sourced<Item> | Sourced<Refusal> | Catalogue

export type { Provenance, Sourced }
