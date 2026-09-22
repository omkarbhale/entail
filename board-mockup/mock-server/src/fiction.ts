// The invented state this mock serves, in one place.
//
// Every value below is written through sourced(), so each one says where it
// came from. Almost all of it is invented: the stages are one reading of the
// design record, the items are samples, and the field table says which parts
// of the shape itself are open questions. The few values that are recorded
// cite the file they are recorded in (sources.ts).

import type {
  AdvanceMode,
  Board,
  FieldCatalogue,
  Item,
  Labels,
  ListOf,
  Motion,
  Stage,
  Stop,
  StopCategory,
} from './contract.ts'
import { assumed, interpreted, placeholder, recorded, sourced } from './mark.ts'
import type { Citation, Provenance, Sourced } from './provenance.ts'
import { advanceability } from './rules.ts'
import {
  BOARD_IS_WANTED,
  BOARD_STATEMENT,
  FLOW_DECISIONS,
  FLOW_RUNS,
  FLOW_UNTIL_PR,
  FLOW_USER_SAY,
  FLOW_VISION,
} from './sources.ts'

// ---- Stages ---------------------------------------------------------------

const STAGE_KEY = placeholder('Key this mock uses to connect items to stages. It carries no meaning.')

const stage = (id: string, name: string, cites: Citation, gap: string): Sourced<Stage> => {
  const why = interpreted(cites, 'D-10', gap)
  return sourced({ id: sourced(id, STAGE_KEY), name: sourced(name, why) }, why)
}

const STAGES: ListOf<Stage> = [
  stage('vision', 'Vision', FLOW_VISION, 'The record describes checking the vision as a step of the flow. Treating it as a board stage, and its name, are this mock’s.'),
  stage('decisions', 'Decisions', FLOW_DECISIONS, 'The record describes checking decisions as the step after the vision. Treating it as a board stage, and its name, are this mock’s.'),
  stage('architecture', 'Architecture', FLOW_USER_SAY, 'The record names architecture among the early layers. Placing it third, as a board stage, is this mock’s.'),
  stage('development', 'Development', FLOW_RUNS, 'The record names development among the runs the pipeline spawns. Treating that run as a board stage is this mock’s.'),
  stage('testing', 'Testing', FLOW_RUNS, 'The record names testing among the runs, and elsewhere as not mandatory. Treating it as a fixed board stage is this mock’s.'),
  stage('pull-request', 'Pull request', FLOW_UNTIL_PR, 'The record ends the flow at the final pull request. Treating that as a board stage, and the last one, is this mock’s.'),
]

export const STAGE_IDS: readonly string[] = STAGES.map((s) => s.value.id.value)

const STAGE_LIST = interpreted(
  FLOW_UNTIL_PR,
  'D-10',
  'The record describes a flow and names layers and runs along it. This list of six, their order, and leaving out the optional validation runs are this mock’s.',
)

// ---- Items ----------------------------------------------------------------

const SAMPLE = placeholder('Sample value on a sample item. No such work exists and nothing is running it.')
const ITEM_ID = placeholder('Identifier this mock uses to address actions. It carries no meaning.')
const SAMPLE_ITEM = placeholder('Sample item. No such work exists and nothing is running it.')
const NOT_STOPPED = placeholder('This sample item is moving, and a moving item has no stop.')

type Seed = {
  readonly id: string
  readonly title: string
  readonly stage: string
  readonly advanceMode: AdvanceMode
  readonly stop?: { readonly category: StopCategory; readonly detail: string }
}

const item = (seed: Seed): Sourced<Item> => {
  const motion: Motion = seed.stop === undefined ? 'moving' : 'stopped'
  const stop: Sourced<Stop | null> =
    seed.stop === undefined
      ? sourced(null, NOT_STOPPED)
      : sourced(
          { category: sourced(seed.stop.category, SAMPLE), detail: sourced(seed.stop.detail, SAMPLE) },
          SAMPLE,
        )
  const position = { stage: sourced(seed.stage, SAMPLE), motion: sourced(motion, SAMPLE), stop }
  return sourced(
    {
      id: sourced(seed.id, ITEM_ID),
      title: sourced(seed.title, SAMPLE),
      ...position,
      advanceMode: sourced(seed.advanceMode, SAMPLE),
      advanceable: advanceability(position, STAGE_IDS),
    },
    SAMPLE_ITEM,
  )
}

// One item per situation the board has to show: stopped for each of the three
// assumed reasons, moving, and stopped at the last stage, where there is
// nowhere recorded to advance to.
const ITEMS: ListOf<Item> = [
  item({
    id: 'item-1',
    title: 'Export a report as CSV',
    stage: 'testing',
    advanceMode: 'stop-for-user',
    stop: { category: 'stage-complete', detail: 'Testing is finished and waiting for you to send it on.' },
  }),
  item({
    id: 'item-2',
    title: 'Rate-limit the public API',
    stage: 'architecture',
    advanceMode: 'automatic',
    stop: {
      category: 'has-something-to-raise',
      detail: 'Nothing upstream settles whether limits apply per user or per key, so it is flagged instead of chosen.',
    },
  }),
  item({
    id: 'item-3',
    title: 'Rename workspaces to projects',
    stage: 'decisions',
    advanceMode: 'automatic',
    stop: {
      category: 'needs-user',
      detail: 'Blocked: the existing decisions contradict each other on naming, and you are asked to go into the decisions layer.',
    },
  }),
  item({ id: 'item-4', title: 'Dark mode for the settings page', stage: 'development', advanceMode: 'automatic' }),
  item({
    id: 'item-5',
    title: 'Retry failed webhook deliveries',
    stage: 'pull-request',
    advanceMode: 'stop-for-user',
    stop: { category: 'stage-complete', detail: 'The pull request is ready and waiting for you.' },
  }),
]

const ITEM_LIST = assumed(
  'D-08',
  'The items are samples. They are listed in the order this mock declares them, which is not an ordering rule.',
)

// ---- Words ----------------------------------------------------------------

// A label built from the record's own words is interpreted, never recorded:
// the words are recorded, their use as this label is not. The citation quotes
// just those words, so integrity.ts checks they are really there.
const RECORD_WORDS = (words: string): Provenance =>
  interpreted(
    { ...BOARD_STATEMENT, quote: words },
    'D-39',
    `The record says “${words}”. Using that as this label is this mock’s.`,
  )
const MOCK_WORDS = assumed('D-39', 'Nothing records these words. They are this mock’s.')

const LABELS: Labels = {
  heading: sourced('In flight', RECORD_WORDS('in-flight features')),
  stages: sourced('Stages', RECORD_WORDS('the next stage')),
  title: sourced('Task or feature', RECORD_WORDS('all tasks and in-flight features')),
  stage: sourced('Stage', RECORD_WORDS('the next stage')),
  motion: sourced('Moving or stopped', MOCK_WORDS),
  stop: sourced('Why it stopped', MOCK_WORDS),
  advanceMode: sourced('When its stage is done', MOCK_WORDS),
  moving: sourced('moving', MOCK_WORDS),
  stopped: sourced('stopped', RECORD_WORDS('stopping only when')),
  stageComplete: sourced('stage done, waiting to be sent on', MOCK_WORDS),
  hasSomethingToRaise: sourced('has something to raise', RECORD_WORDS('something to raise')),
  needsUser: sourced('you are needed', RECORD_WORDS('the user is needed somewhere')),
  automatic: sourced('send it on automatically', RECORD_WORDS('sent automatically')),
  stopForUser: sourced('stop and wait for me', MOCK_WORDS),
  advance: sourced('Send to the next stage', RECORD_WORDS('sent to the next stage')),
  cannotAdvance: sourced('cannot be sent on now', MOCK_WORDS),
}

const LABEL_SET = assumed('D-41', 'The board’s own words are served, so each carries provenance like any other value.')
const LABEL_FIELD = assumed('D-09', 'Which words the board needs follows from its layout, which is this mock’s.')

// ---- The board ------------------------------------------------------------

const BOARD = recorded(BOARD_IS_WANTED)

export function board(items: ListOf<Item>): Sourced<Board> {
  return sourced(
    {
      stages: sourced(STAGES, STAGE_LIST),
      items: sourced(items, ITEM_LIST),
      labels: sourced(LABELS, LABEL_SET),
    },
    BOARD,
  )
}

export const INITIAL_ITEMS: ListOf<Item> = ITEMS

// ---- Why each field exists --------------------------------------------------

const STOP_REASONS: Provenance = interpreted(
  BOARD_STATEMENT,
  'D-17',
  'The record names two occasions to stop in one sentence. Treating them as two categories, adding a third for an item waiting to be sent on, and their names, are this mock’s.',
)

export const FIELDS: FieldCatalogue = {
  board: {
    stages: interpreted(
      BOARD_STATEMENT,
      'D-10',
      'The record speaks of sending items to the next stage, so stages exist. Which stages, and listing them on the board, are this mock’s.',
    ),
    items: recorded(BOARD_STATEMENT),
    labels: LABEL_SET,
  },
  labels: {
    heading: LABEL_FIELD,
    stages: LABEL_FIELD,
    title: LABEL_FIELD,
    stage: LABEL_FIELD,
    motion: LABEL_FIELD,
    stop: LABEL_FIELD,
    advanceMode: LABEL_FIELD,
    moving: LABEL_FIELD,
    stopped: LABEL_FIELD,
    stageComplete: LABEL_FIELD,
    hasSomethingToRaise: LABEL_FIELD,
    needsUser: LABEL_FIELD,
    automatic: LABEL_FIELD,
    stopForUser: LABEL_FIELD,
    advance: LABEL_FIELD,
    cannotAdvance: LABEL_FIELD,
  },
  stage: {
    id: STAGE_KEY,
    name: assumed('D-39', 'Showing a stage by a short name is this mock’s.'),
  },
  item: {
    id: ITEM_ID,
    title: assumed('D-03', 'Nothing records how an item is identified to the user. A short title is this mock’s choice.'),
    stage: recorded(BOARD_STATEMENT),
    motion: interpreted(
      BOARD_STATEMENT,
      'D-16',
      'The record speaks of items stopping. That an item is otherwise “moving”, and that these are its only two states, are this mock’s.',
    ),
    stop: STOP_REASONS,
    advanceMode: interpreted(
      BOARD_STATEMENT,
      'D-28',
      'The record says items can be sent on or sent automatically. That the choice is set per item, and its two values, are this mock’s.',
    ),
    advanceable: assumed('D-24', 'Nothing records when an item may be advanced. This field carries the mock’s rule so the UI holds none.'),
  },
  stop: {
    category: STOP_REASONS,
    detail: assumed('D-19', 'A single sentence as the whole of what a stop tells the user is this mock’s.'),
  },
  refusal: {
    reason: assumed('D-24', 'That an action can be refused, and says why in a sentence, follows from this mock’s advance rule.'),
  },
}
