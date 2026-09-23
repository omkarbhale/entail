// The mock's assumed behaviour: when an item may be advanced, what advancing,
// landing, setting the advance mode, describing new work, answering what an
// item asked and the frame's stand-in for a stage finishing do to it. None of this is recorded; each rule is a stand-in
// answer to an open question in ../DECISIONS.md, and the provenance it stamps
// on the values it produces says which.
//
// Nothing here runs a stage, spawns an agent, derives anything or moves an item
// on its own. An item only changes when someone calls one of the actions. Where
// a value depicts an agent in a tmux pane, that pane is a name and nothing more.

import type {
  AdvanceMode,
  Answer,
  AnswerOrigin,
  Handover,
  Item,
  Refusal,
  ResolveRequest,
  StageEndingRequest,
  Stop,
} from './contract.ts'
import { agentComposed, assumed, placeholder, sourced, userInput } from './mark.ts'
import type { Provenance, Sourced } from './provenance.ts'

const ADVANCEABLE = {
  allowed: assumed(
    'D-24',
    'Allowed: this item is stopped at a completed stage. This mock assumes that is the only time an item can be advanced.',
  ),
  allowedLand: assumed(
    'D-60',
    'Allowed: this item is stopped at its last stage, completed. This mock assumes sending it on from there lands it.',
  ),
  moving: assumed(
    'D-24',
    'Refused: this item is moving. This mock assumes an item can be advanced only when it is stopped at a completed stage.',
  ),
  raised: assumed(
    'D-24',
    'Refused: this item is waiting on an answer from you. It is answered through an agent, with what the board hands over, and cannot be sent on around it (D-52).',
  ),
  landed: assumed('D-60', 'Refused: this item has landed. Nothing comes after landing in this mock.'),
} as const

const AFTER_ADVANCE_MOTION = assumed(
  'D-26',
  'After an advance this mock puts the item in motion in its new stage. Nothing runs in this mock, so it stays moving until the mockup’s frame plays its stage finishing (D-65).',
)

const AFTER_ADVANCE_STOP = assumed('D-26', 'Cleared by the advance: a moving item has no stop.')

const ADVANCED_STAGE = userInput(
  'advance',
  'You sent this item to the next stage. Which stage is next comes from the assumed stage list (D-10).',
)

/** What advancing is imagined to mean. Depicted only: the pane is a name. */
const AGENT_PANE = assumed(
  'D-51',
  'Advancing is imagined to spawn an agent for the stage in a tmux pane of its own. This is that pane’s name only. Nothing was spawned and nothing runs.',
)

const NO_AGENT = assumed('D-51', 'No agent is imagined at work: the item is not moving.')

const LANDED = userInput(
  'land',
  'You sent this item on from its last stage, which this mock treats as landing it (D-60). Nothing was merged.',
)

const MODE_SET = userInput(
  'set advance mode',
  'You set this. In this mock it changes nothing else about the item, not even one already waiting at a completed stage (D-30).',
)

// ---- Describing new work ----------------------------------------------------

const NEW_ITEM = assumed('D-58', 'You described this, and this mock put it into the pipeline as a new item.')
const NEW_ID = placeholder('Identifier this mock gave the new item to address actions. It carries no meaning.')
const DESCRIBED = userInput('describe', 'You described this. Your words are its title, unchanged (D-58).')
const NEW_STAGE = assumed('D-58', 'New work enters at the first stage of the assumed stage list.')
const NEW_MOTION = assumed(
  'D-58',
  'New work is put in motion at once. Nothing runs in this mock, so it stays moving until the mockup’s frame plays its stage finishing (D-65).',
)
const NEW_STOP = assumed('D-58', 'New work is moving, and a moving item has no stop.')
const NEW_MODE = assumed(
  'D-59',
  'New work waits for you when a stage is done, until you say otherwise. Nothing records a default.',
)
const NEW_ANSWERS = assumed('D-58', 'New work has asked nothing yet.')
const NO_PULL_REQUEST = assumed('D-61', 'No pull request exists before the last stage.')

// ---- Handing over what an item asks -----------------------------------------

/** The imagined MCP tool (D-52). No such tool exists. */
const TOOL = sourced('entail_resolve', assumed('D-52', 'Nothing records an MCP or its tools. The name is this mock’s.'))
export const PENDING_ID = assumed('D-53', 'Names the one thing to be resolved, so the agent need not reconstruct it. Its form is this mock’s.')
export const HANDOVER = assumed(
  'D-53',
  'What the board hands over is only what points at the thing: the task, where it stopped, and what it asks. The MCP is imagined to give the agent the rest.',
)

// ---- Answering what an item asked -------------------------------------------

const ORIGIN: Record<AnswerOrigin, Provenance> = {
  'stated-by-user': userInput(
    'answer',
    'You stated these words and an agent passed them on unchanged, through the MCP Entail is imagined to expose (D-56). The board did not collect them.',
  ),
  'composed-by-agent': agentComposed(
    'answer',
    'An agent composed these words and you agreed to them, through the MCP Entail is imagined to expose (D-56). You did not state them, so they are not marked as set by you.',
  ),
}

const AFTER_ANSWER_MOTION = assumed(
  'D-57',
  'Once what it asked is answered, the item goes back into motion in the same stage. It is not sent on.',
)
const AFTER_ANSWER_STOP = assumed('D-57', 'Cleared by the answer: a moving item has no stop.')
const ANSWERS_KEPT = assumed(
  'D-57',
  'Every answer stays on the item, with who its words came from, and is still there once the item lands (D-61).',
)

const RESOLVE_REFUSED = {
  nothingPending: assumed('D-55', 'Refused: this item is not waiting on an answer.'),
  otherPending: assumed(
    'D-55',
    'Refused: that is not what this item is waiting on. An answer is accepted only for the thing the board handed over.',
  ),
} as const

// ---- A stage finishing, played by the mockup's frame ------------------------

const STAGE_ENDING = 'The mockup’s frame played this stage finishing, standing in for machinery that does not exist. It is not a claim about how Entail completes work.'
const ENDED_MOTION = assumed('D-65', STAGE_ENDING)
const ENDED_AGENT = assumed('D-65', `${STAGE_ENDING} No agent is imagined at work on a stopped item.`)
const ENDED_STOP = assumed('D-65', STAGE_ENDING)
const ENDED_DONE = assumed(
  'D-65',
  `${STAGE_ENDING} This sentence is the mock’s. The stage is done and the item waits to be sent on, whatever its advance mode says.`,
)
const ENDED_NOTHING_ASKED = assumed('D-65', `${STAGE_ENDING} A stage that finished asks nothing, so nothing is handed over.`)
const ENDED_ASKS = assumed(
  'D-65',
  `${STAGE_ENDING} Whoever played it typed what the stage asks. Nobody asked it, and it is not set by you.`,
)
const ENDED_PULL_REQUEST = assumed(
  'D-65',
  `${STAGE_ENDING} The last stage finishing leaves this placeholder pull request. None was opened.`,
)
const STAGE_ENDING_REFUSED = assumed('D-65', 'Refused: this item is not moving, so it has no stage running to finish.')

export const PROTOCOL = placeholder(
  'Protocol message of this mock server. It carries no design meaning.',
)

/** Every provenance this module can stamp, for integrity.ts to check at startup. */
export const RULE_PROVENANCE: readonly Provenance[] = [
  ...Object.values(ADVANCEABLE),
  AFTER_ADVANCE_MOTION,
  AFTER_ADVANCE_STOP,
  ADVANCED_STAGE,
  AGENT_PANE,
  NO_AGENT,
  LANDED,
  MODE_SET,
  NEW_ITEM,
  NEW_ID,
  DESCRIBED,
  NEW_STAGE,
  NEW_MOTION,
  NEW_STOP,
  NEW_MODE,
  NEW_ANSWERS,
  NO_PULL_REQUEST,
  ...Object.values(ORIGIN),
  AFTER_ANSWER_MOTION,
  AFTER_ANSWER_STOP,
  ANSWERS_KEPT,
  ...Object.values(RESOLVE_REFUSED),
  TOOL.provenance,
  PENDING_ID,
  HANDOVER,
  ENDED_MOTION,
  ENDED_AGENT,
  ENDED_STOP,
  ENDED_DONE,
  ENDED_NOTHING_ASKED,
  ENDED_ASKS,
  ENDED_PULL_REQUEST,
  STAGE_ENDING_REFUSED,
  PROTOCOL,
]

/** The imagined pane an item's stage agent works in (D-51). A name, nothing more. */
export const paneName = (id: string, stage: string): string => `entail:${id}.${stage}`

export const agentPane = (id: string, stage: string): Sourced<string> => sourced(paneName(id, stage), AGENT_PANE)

type Position = Pick<Item, 'stage' | 'motion' | 'stop'>

export function advanceability(item: Position, stageIds: readonly string[]): Sourced<boolean> {
  const why = refusalReason(item)
  if (why !== undefined) return sourced(false, why)
  return sourced(true, isLast(item, stageIds) ? ADVANCEABLE.allowedLand : ADVANCEABLE.allowed)
}

function refusalReason(item: Position): Provenance | undefined {
  if (item.motion.value === 'landed') return ADVANCEABLE.landed
  if (item.motion.value === 'moving') return ADVANCEABLE.moving
  if (item.stop.value?.category.value !== 'stage-complete') return ADVANCEABLE.raised
  return undefined
}

const isLast = (item: Position, stageIds: readonly string[]): boolean =>
  stageIds.indexOf(item.stage.value) === stageIds.length - 1

export type Outcome = { readonly ok: true; readonly item: Item } | { readonly ok: false; readonly refusal: Refusal }

export function advance(item: Item, stageIds: readonly string[]): Outcome {
  const why = refusalReason(item)
  if (why !== undefined) {
    return { ok: false, refusal: { reason: sourced(explain(why), why) } }
  }
  if (isLast(item, stageIds)) {
    const landed = {
      motion: sourced('landed' as const, LANDED),
      stop: sourced(null, LANDED),
      agent: sourced(null, NO_AGENT),
    }
    return { ok: true, item: { ...item, ...landed, advanceable: advanceability({ ...item, ...landed }, stageIds) } }
  }
  const next = stageIds[stageIds.indexOf(item.stage.value) + 1]
  if (next === undefined) {
    return { ok: false, refusal: refusal(`Stage "${item.stage.value}" is not in the stage list.`) }
  }
  const moved = {
    stage: sourced(next, ADVANCED_STAGE),
    motion: sourced('moving' as const, AFTER_ADVANCE_MOTION),
    stop: sourced(null, AFTER_ADVANCE_STOP),
    agent: agentPane(item.id.value, next),
  }
  return { ok: true, item: { ...item, ...moved, advanceable: advanceability(moved, stageIds) } }
}

export function setAdvanceMode(item: Item, mode: AdvanceMode): Outcome {
  if (item.motion.value === 'landed') return refused(ADVANCEABLE.landed)
  return { ok: true, item: { ...item, advanceMode: sourced(mode, MODE_SET) } }
}

/**
 * What the board hands over for the stop of item `id` that asks something
 * (D-53). `n` counts what the item has been asked, this included.
 */
export function handover(id: string, title: string, stageName: string, n: number, asks: string): Sourced<Handover> {
  const pending = `${id}/q${n}`
  const text =
    `Ask Entail’s MCP (${TOOL.value}) about ${pending} and do what it tells you. ` +
    `Task: ${id}, “${title}”, stopped at ${stageName}. ` +
    `It asks: ${asks}`
  return sourced({ pending: sourced(pending, PENDING_ID), tool: TOOL, text: sourced(text, HANDOVER) }, HANDOVER)
}

/** New work, from the words the user described it in (D-58). */
export function describe(id: string, description: string, stageIds: readonly string[]): Sourced<Item> {
  const first = stageIds[0] ?? ''
  const position = {
    stage: sourced(first, NEW_STAGE),
    motion: sourced('moving' as const, NEW_MOTION),
    stop: sourced(null, NEW_STOP),
  }
  return sourced(
    {
      id: sourced(id, NEW_ID),
      title: sourced(description, DESCRIBED),
      ...position,
      agent: agentPane(id, first),
      advanceMode: sourced('stop-for-user' as const, NEW_MODE),
      advanceable: advanceability(position, stageIds),
      answers: sourced([], NEW_ANSWERS),
      pullRequest: sourced(null, NO_PULL_REQUEST),
    },
    NEW_ITEM,
  )
}

/**
 * What the imagined MCP tool's one write would do (D-55). The only way an
 * answer enters; the board never calls it.
 */
export function resolve(item: Item, request: ResolveRequest, stageIds: readonly string[]): Outcome {
  const stop = item.stop.value
  const handover = stop?.handover.value
  if (item.motion.value !== 'stopped' || stop == null || handover == null) {
    return refused(RESOLVE_REFUSED.nothingPending)
  }
  if (handover.pending.value !== request.pending) return refused(RESOLVE_REFUSED.otherPending)
  const origin = ORIGIN[request.origin]
  const answer: Sourced<Answer> = sourced(
    {
      pending: handover.pending,
      asked: stop.detail,
      answer: sourced(request.answer, origin),
      origin: sourced(request.origin, origin),
    },
    origin,
  )
  const resumed = {
    motion: sourced('moving' as const, AFTER_ANSWER_MOTION),
    stop: sourced(null, AFTER_ANSWER_STOP),
  }
  return {
    ok: true,
    item: {
      ...item,
      ...resumed,
      agent: agentPane(item.id.value, item.stage.value),
      advanceable: advanceability({ ...item, ...resumed }, stageIds),
      answers: sourced([...item.answers.value, answer], ANSWERS_KEPT),
    },
  }
}

/**
 * The frame's stand-in for a moving item's stage finishing (D-65): it stops,
 * either done or asking what the request says. Decides and derives nothing;
 * the board never calls it.
 */
export function endStage(
  item: Item,
  request: StageEndingRequest,
  stageIds: readonly string[],
  stageName: string,
): Outcome {
  if (item.motion.value !== 'moving') return refused(STAGE_ENDING_REFUSED)
  const stop: Stop =
    request.category === 'stage-complete'
      ? {
          category: sourced(request.category, ENDED_STOP),
          detail: sourced('The stage is finished and waiting for you to send it on.', ENDED_DONE),
          handover: sourced(null, ENDED_NOTHING_ASKED),
        }
      : {
          category: sourced(request.category, ENDED_STOP),
          detail: sourced(request.asks, ENDED_ASKS),
          handover: handover(item.id.value, item.title.value, stageName, item.answers.value.length + 1, request.asks),
        }
  const stopped = { motion: sourced('stopped' as const, ENDED_MOTION), stop: sourced(stop, ENDED_STOP) }
  const leavesPullRequest =
    request.category === 'stage-complete' && isLast(item, stageIds) && item.pullRequest.value === null
  return {
    ok: true,
    item: {
      ...item,
      ...stopped,
      agent: sourced(null, ENDED_AGENT),
      advanceable: advanceability({ ...item, ...stopped }, stageIds),
      pullRequest: leavesPullRequest ? sourced(`#pr-${item.id.value}`, ENDED_PULL_REQUEST) : item.pullRequest,
    },
  }
}

/** A refusal about the request itself rather than about the board. */
export function refusal(message: string): Refusal {
  return { reason: sourced(message, PROTOCOL) }
}

function refused(why: Provenance): Outcome {
  return { ok: false, refusal: { reason: sourced(explain(why), why) } }
}

function explain(provenance: Provenance): string {
  return provenance.kind === 'assumed' ? provenance.reason : 'Refused.'
}
