// Every citation this mock makes, each written once.
//
// These are the only places a served value can point at recorded direction.
// integrity.ts checks each one against its file: the file exists, the section
// heading exists, and the quote appears under it.

import type { Citation } from './provenance.ts'

const DESIGN_RECORD = 'unfiled/2026-09-20-pipeline-design-record.md'
const FLOW = '1. The flow'

export const BOARD_STATEMENT: Citation = {
  file: DESIGN_RECORD,
  section: 'Point 4 — "Already decided" matching is treated as free',
  quote:
    'Entail is also to have a user interface showing all tasks and in-flight ' +
    'features and their status, where they can be sent to the next stage or ' +
    'sent automatically, stopping only when they have something to raise or ' +
    'the user is needed somewhere.',
}

export const BOARD_IS_WANTED: Citation = {
  file: DESIGN_RECORD,
  section: 'Point 4 — "Already decided" matching is treated as free',
  quote: 'The board is wanted and is part of the product.',
}

export const FLOW_VISION: Citation = {
  file: DESIGN_RECORD,
  section: FLOW,
  quote: 'First step: check the product vision — conflicts, missing, scope mismatch.',
}

export const FLOW_DECISIONS: Citation = {
  file: DESIGN_RECORD,
  section: FLOW,
  quote: 'Once that is done, check decisions',
}

export const FLOW_USER_SAY: Citation = {
  file: DESIGN_RECORD,
  section: FLOW,
  quote:
    'For vision, decisions, and architecture — at least the early layers — ' +
    'the user wants some say in what is going on.',
}

export const FLOW_RUNS: Citation = {
  file: DESIGN_RECORD,
  section: FLOW,
  quote:
    'the pipeline spawns runs: development, testing, performance validation, ' +
    'UX design, UX validation, and quality concerns such as accessibility.',
}

export const FLOW_UNTIL_PR: Citation = {
  file: DESIGN_RECORD,
  section: FLOW,
  quote: 'And so on, until the final pull request.',
}

export const FLOW_ARRIVES: Citation = {
  file: DESIGN_RECORD,
  section: FLOW,
  quote:
    'Somebody arrives and describes some task, feature, activity, or a product ' +
    'to build. That goes into a pipeline and follows it.',
}

export const PROMOTION_ASKS_USER: Citation = {
  file: DESIGN_RECORD,
  section: '3. Promotion of per-task artifacts',
  quote: 'the orchestrator asks the user to go into the right layer, and asks them what to do.',
}

export const USER_GAVE_VS_LAYER_PRODUCED: Citation = {
  file: 'unfiled/2026-09-20-build-philosophy.md',
  section: '3. Raised, and not settled',
  quote: 'There should probably be separation between what the user gave and what a layer produced',
}
