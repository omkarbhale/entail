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

export type Motion = 'moving' | 'stopped' | 'landed'

export type StopCategory = 'stage-complete' | 'has-something-to-raise' | 'needs-user'

export type AdvanceMode = 'automatic' | 'stop-for-user'

/**
 * What the board hands the user for a stop that needs an answer: a ready-made
 * invocation of the MCP tool Entail is imagined to expose (DECISIONS.md D-52).
 * It is depicted only. No such tool exists and nothing here can call one.
 */
export type Handover = {
  /** Names this one thing to be resolved, so the agent need not reconstruct it. */
  readonly pending: Sourced<string>
  /** The imagined MCP tool's name. */
  readonly tool: Sourced<string>
  /** The words the user gives their agent, carrying the task and the thing being resolved. */
  readonly text: Sourced<string>
}

export type Stop = {
  readonly category: Sourced<StopCategory>
  /** One sentence saying what the item is stopped on. */
  readonly detail: Sourced<string>
  /** null for a stop that asks nothing, which is one waiting to be sent on. */
  readonly handover: Sourced<Handover | null>
}

/**
 * Who the words of an answer came from. Both arrive through an agent; they are
 * still not the same thing, and are never recorded as each other (D-56).
 */
export type AnswerOrigin = 'stated-by-user' | 'composed-by-agent'

export type Answer = {
  /** The Handover.pending it answers. */
  readonly pending: Sourced<string>
  /** What the item had asked, as it was asked. */
  readonly asked: Sourced<string>
  readonly answer: Sourced<string>
  readonly origin: Sourced<AnswerOrigin>
}

export type Item = {
  readonly id: Sourced<string>
  readonly title: Sourced<string>
  /** A Stage id from Board.stages. */
  readonly stage: Sourced<string>
  readonly motion: Sourced<Motion>
  /** null unless the item is stopped. */
  readonly stop: Sourced<Stop | null>
  /**
   * The tmux pane an agent is imagined to be working this item's stage in, while
   * the item is moving (D-51). Depicted only: nothing is spawned.
   */
  readonly agent: Sourced<string | null>
  readonly advanceMode: Sourced<AdvanceMode>
  /**
   * Whether POST .../advance would be accepted now. The rule lives on the
   * server so the UI holds none; the provenance says why, for this item.
   */
  readonly advanceable: Sourced<boolean>
  /** What the item has asked and had answered, in the order answered. */
  readonly answers: Sourced<ListOf<Answer>>
  /** null until the item has a pull request. */
  readonly pullRequest: Sourced<string | null>
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
  /** Shown beside the pane of a moving item's agent. */
  readonly agent: Sourced<string>
  readonly handover: Sourced<string>
  readonly copy: Sourced<string>
  readonly answers: Sourced<string>
  readonly statedByUser: Sourced<string>
  readonly composedByAgent: Sourced<string>
  /** The advance action's words at the last stage, where sending on means landing. */
  readonly land: Sourced<string>
  readonly landed: Sourced<string>
  readonly landedHeading: Sourced<string>
  readonly pullRequest: Sourced<string>
  /** Shown for a landed item that was never asked anything. */
  readonly noAnswers: Sourced<string>
  readonly describe: Sourced<string>
  readonly submit: Sourced<string>
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
  readonly handover: Handover
  readonly answer: Answer
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
 * POST /api/items                        -> 201 Sourced<Item> | 400 Sourced<Refusal>
 *        body: CreateItemRequest
 * POST /api/items/:id/advance            -> 200 Sourced<Item> | 404/409 Sourced<Refusal>
 * PUT  /api/items/:id/advance-mode       -> 200 Sourced<Item> | 400/404/409 Sourced<Refusal>
 *        body: SetAdvanceModeRequest
 * POST /api/resolutions                  -> 200 Sourced<Item> | 400/404/409 Sourced<Refusal>
 *        body: ResolveRequest
 * POST /api/stage-endings                -> 200 Sourced<Item> | 400/404/409 Sourced<Refusal>
 *        body: StageEndingRequest
 *
 * Any other path -> 404 Sourced<Refusal>.
 *
 * /api/resolutions stands in for the one write the imagined MCP tool would
 * make, and is the only way an answer enters (D-55). The board never calls
 * it; only the mockup's frame does, playing the agent.
 *
 * /api/stage-endings stands in for whatever ends a moving item's stage, which
 * does not exist (D-65). The board never calls it either; only the mockup's
 * frame does, playing a stage finishing.
 */
export type CreateItemRequest = {
  /** The task or feature, in the user's own words. */
  readonly description: string
}

export type SetAdvanceModeRequest = {
  readonly mode: AdvanceMode
}

/** What the imagined MCP tool would be given by the agent. */
export type ResolveRequest = {
  readonly item: string
  readonly pending: string
  readonly answer: string
  readonly origin: AnswerOrigin
}

/** How the frame's stand-in plays a moving item's stage ending (D-65). */
export type StageEndingRequest =
  | { readonly item: string; readonly category: 'stage-complete' }
  | {
      readonly item: string
      readonly category: Exclude<StopCategory, 'stage-complete'>
      /** What the stage asks, as the stand-in typed it. */
      readonly asks: string
    }

export type ApiResponseBody = Sourced<Board> | Sourced<Item> | Sourced<Refusal> | Catalogue

export type { Provenance, Sourced }
