// The invented state this mock serves, in one place.
//
// Every value below is written through sourced(), so each one says where it
// came from. Almost all of it is invented: the stages are one reading of the
// design record, the items are samples, and the field table says which parts
// of the shape itself are open questions. The few values that are recorded
// cite the file they are recorded in (sources.ts).

import type {
  AdvanceMode,
  Answer,
  AnswerOrigin,
  Board,
  FieldCatalogue,
  Handover,
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
import { advanceability, agentPane } from './rules.ts'
import {
  BOARD_IS_WANTED,
  BOARD_STATEMENT,
  FLOW_ARRIVES,
  FLOW_DECISIONS,
  FLOW_RUNS,
  FLOW_UNTIL_PR,
  FLOW_USER_SAY,
  FLOW_VISION,
  PROMOTION_ASKS_USER,
  USER_GAVE_VS_LAYER_PRODUCED,
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
const NOT_STOPPED = placeholder('This sample item is not stopped, so it has no stop.')
const NOTHING_ASKED = placeholder('This stop is waiting to be sent on and asks nothing, so there is nothing to hand over.')
const SAMPLE_ANSWER = placeholder('Sample answer on a sample item. Nobody gave it, and nothing was asked.')
const SAMPLE_ANSWERS = placeholder('Sample answers on a sample item.')
const NO_SAMPLE_PR = placeholder('This sample item has no pull request yet.')
const IDLE = placeholder('This sample item is not moving, so no agent is imagined at work on it.')

/** The imagined MCP tool (D-52). No such tool exists. */
const TOOL = sourced('entail_resolve', assumed('D-52', 'Nothing records an MCP or its tools. The name is this mock’s.'))
const PENDING_ID = assumed('D-53', 'Names the one thing to be resolved, so the agent need not reconstruct it. Its form is this mock’s.')
const HANDOVER = assumed(
  'D-53',
  'What the board hands over is only what points at the thing: the task, where it stopped, and what it asks. The MCP is imagined to give the agent the rest.',
)

type SampleAnswer = { readonly asked: string; readonly answer: string; readonly origin: AnswerOrigin }

type Seed = {
  readonly id: string
  readonly title: string
  readonly stage: string
  readonly advanceMode: AdvanceMode
  readonly stop?: { readonly category: StopCategory; readonly detail: string }
  readonly landed?: true
  readonly answers?: readonly SampleAnswer[]
  readonly pullRequest?: string
}

const STAGE_NAME = new Map(STAGES.map(({ value: s }) => [s.id.value, s.name.value]))

const handover = (seed: Seed, detail: string): Sourced<Handover> => {
  const pending = `${seed.id}/q1`
  const text =
    `Ask Entail’s MCP (${TOOL.value}) about ${pending} and do what it tells you. ` +
    `Task: ${seed.id}, “${seed.title}”, stopped at ${STAGE_NAME.get(seed.stage) ?? seed.stage}. ` +
    `It asks: ${detail}`
  return sourced({ pending: sourced(pending, PENDING_ID), tool: TOOL, text: sourced(text, HANDOVER) }, HANDOVER)
}

const sampleAnswer = (seed: Seed, a: SampleAnswer, i: number): Sourced<Answer> =>
  sourced(
    {
      pending: sourced(`${seed.id}/q${i + 1}`, SAMPLE_ANSWER),
      asked: sourced(a.asked, SAMPLE_ANSWER),
      answer: sourced(a.answer, SAMPLE_ANSWER),
      origin: sourced(a.origin, SAMPLE_ANSWER),
    },
    SAMPLE_ANSWER,
  )

const item = (seed: Seed): Sourced<Item> => {
  const motion: Motion = seed.landed ? 'landed' : seed.stop === undefined ? 'moving' : 'stopped'
  const stop: Sourced<Stop | null> =
    seed.stop === undefined
      ? sourced(null, NOT_STOPPED)
      : sourced(
          {
            category: sourced(seed.stop.category, SAMPLE),
            detail: sourced(seed.stop.detail, SAMPLE),
            handover:
              seed.stop.category === 'stage-complete' ? sourced(null, NOTHING_ASKED) : handover(seed, seed.stop.detail),
          },
          SAMPLE,
        )
  const position = { stage: sourced(seed.stage, SAMPLE), motion: sourced(motion, SAMPLE), stop }
  return sourced(
    {
      id: sourced(seed.id, ITEM_ID),
      title: sourced(seed.title, SAMPLE),
      ...position,
      agent: motion === 'moving' ? agentPane(seed.id, seed.stage) : sourced(null, IDLE),
      advanceMode: sourced(seed.advanceMode, SAMPLE),
      advanceable: advanceability(position, STAGE_IDS),
      answers: sourced((seed.answers ?? []).map((a, i) => sampleAnswer(seed, a, i)), SAMPLE_ANSWERS),
      pullRequest: seed.pullRequest === undefined ? sourced(null, NO_SAMPLE_PR) : sourced(seed.pullRequest, SAMPLE),
    },
    SAMPLE_ITEM,
  )
}

// One item per situation the board has to show: stopped for each of the three
// assumed reasons, moving, stopped at the last stage, where sending it on lands
// it, and landed, with what it left behind.
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
    pullRequest: '#318',
  }),
  item({
    id: 'item-6',
    title: 'Paginate the audit log',
    stage: 'pull-request',
    advanceMode: 'stop-for-user',
    landed: true,
    pullRequest: '#301',
    answers: [
      {
        asked: 'Nothing upstream settles whether the page size is fixed or chosen by the reader.',
        answer: 'Fixed at 50. Readers do not choose.',
        origin: 'stated-by-user',
      },
      {
        asked: 'The decisions do not say whether older entries are paged by date or by count.',
        answer: 'By count, so every page is the same length; dates are shown on each entry.',
        origin: 'composed-by-agent',
      },
    ],
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
const RECORD_WORDS = (words: string, from: Citation = BOARD_STATEMENT): Provenance =>
  interpreted(
    { ...from, quote: words },
    'D-39',
    `The record says “${words}”. Using that as this label is this mock’s.`,
  )
const MOCK_WORDS = assumed('D-39', 'Nothing records these words. They are this mock’s.')

const LABELS: Labels = {
  heading: sourced('In flight', RECORD_WORDS('in-flight features')),
  stages: sourced('Stages:', RECORD_WORDS('the next stage')),
  stageSeparator: sourced(' → ', assumed('D-11', 'An arrow between stage names says the stages are one ordered, fixed line that every item follows. That is this mock’s assumption.')),
  title: sourced('Task or feature', RECORD_WORDS('all tasks and in-flight features')),
  stage: sourced('Stage', RECORD_WORDS('the next stage')),
  motion: sourced('Moving or stopped', MOCK_WORDS),
  stop: sourced('Why it stopped', MOCK_WORDS),
  noStop: sourced('—', assumed('D-39', 'Nothing records how an item with no stop is shown. A dash is this mock’s.')),
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
  agent: sourced('agent at work in tmux pane', assumed('D-51', 'Advancing is imagined to spawn an agent in a tmux pane. Nothing records it; these words are this mock’s.')),
  handover: sourced('Give this to an agent. Entail’s MCP tells it what to do:', assumed('D-52', 'Nothing records an MCP. These words are this mock’s.')),
  copy: sourced('Copy', MOCK_WORDS),
  answers: sourced('Answered', MOCK_WORDS),
  statedByUser: sourced('you said this', RECORD_WORDS('what the user gave', USER_GAVE_VS_LAYER_PRODUCED)),
  composedByAgent: sourced('an agent proposed this, and you agreed', assumed('D-56', 'Nothing records these words. They are this mock’s.')),
  land: sourced('Land it', MOCK_WORDS),
  landed: sourced('landed', MOCK_WORDS),
  landedHeading: sourced('Landed', MOCK_WORDS),
  pullRequest: sourced('Pull request', RECORD_WORDS('the final pull request', FLOW_UNTIL_PR)),
  noAnswers: sourced('Nothing was asked of you.', MOCK_WORDS),
  describe: sourced('Describe a task or feature', RECORD_WORDS('describes some task, feature', FLOW_ARRIVES)),
  submit: sourced('Put it into the pipeline', RECORD_WORDS('That goes into a pipeline', FLOW_ARRIVES)),
}

const LABEL_SET = assumed('D-41', 'The board’s own words and glyphs are served, so each carries provenance like any other value.')
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

const HANDING_OVER = assumed('D-52', 'The board hands over what an agent needs to answer through Entail’s imagined MCP, and takes no answer itself.')
const TWO_ORIGINS = assumed('D-56', 'An answer the user stated and one an agent composed and the user agreed to are shown in different words.')
const TAKING_WORK = interpreted(
  FLOW_ARRIVES,
  'D-58',
  'The record has somebody describe a task and it goes into the pipeline. One box on the board for that description, and nothing else asked, is this mock’s.',
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
    stageSeparator: LABEL_FIELD,
    title: LABEL_FIELD,
    stage: LABEL_FIELD,
    motion: LABEL_FIELD,
    stop: LABEL_FIELD,
    noStop: LABEL_FIELD,
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
    agent: assumed('D-51', 'Showing what advancing is imagined to start, beside a moving item, is this mock’s.'),
    handover: HANDING_OVER,
    copy: HANDING_OVER,
    answers: assumed('D-57', 'Showing what an item was asked and answered, on the item, is this mock’s.'),
    statedByUser: TWO_ORIGINS,
    composedByAgent: TWO_ORIGINS,
    land: assumed('D-60', 'That sending an item on from its last stage lands it, so the action needs other words there, is this mock’s.'),
    landed: assumed('D-60', 'A third state for an item that has landed is this mock’s.'),
    landedHeading: assumed('D-63', 'Listing landed items apart from those in flight is this mock’s.'),
    pullRequest: assumed('D-61', 'Showing the pull request an item leaves behind is this mock’s.'),
    noAnswers: assumed('D-61', 'Saying so when a landed item was never asked anything is this mock’s.'),
    describe: TAKING_WORK,
    submit: TAKING_WORK,
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
    agent: assumed('D-51', 'Advancing is imagined to spawn an agent in a tmux pane. Showing which pane, and only while the item moves, is this mock’s.'),
    answers: interpreted(
      USER_GAVE_VS_LAYER_PRODUCED,
      'D-56',
      'The captain raised separating what the user gave from what a layer produced, and did not rule on it. Keeping every answer on its item with who its words came from is this mock’s.',
    ),
    pullRequest: interpreted(
      FLOW_UNTIL_PR,
      'D-61',
      'The record ends the flow at the final pull request. Carrying it on the item, and keeping it once the item lands, are this mock’s.',
    ),
  },
  stop: {
    category: STOP_REASONS,
    detail: assumed('D-19', 'A single sentence as the whole of what a stop tells the user is this mock’s.'),
    handover: interpreted(
      PROMOTION_ASKS_USER,
      'D-52',
      'The record has the orchestrator ask the user what to do. That the board answers that by handing over an invocation of an MCP Entail exposes, for the user to give an agent, is this mock’s.',
    ),
  },
  handover: {
    pending: PENDING_ID,
    tool: assumed('D-52', 'Nothing records an MCP. Naming the tool the invocation calls is this mock’s.'),
    text: HANDOVER,
  },
  answer: {
    pending: assumed('D-55', 'An answer names what it answers, so it can be refused if that is not what the item waits on.'),
    asked: assumed('D-57', 'Keeping what was asked beside the answer, as it was asked, is this mock’s.'),
    answer: assumed('D-55', 'The answer’s words, as the agent passed them to the imagined MCP.'),
    origin: interpreted(
      USER_GAVE_VS_LAYER_PRODUCED,
      'D-56',
      'The captain raised separating what the user gave from what was produced for them. Telling an answer the user stated from one an agent composed and the user agreed to is this mock’s reading of that.',
    ),
  },
  refusal: {
    reason: assumed('D-24', 'That an action can be refused, and says why in a sentence, follows from this mock’s advance rule.'),
  },
}
