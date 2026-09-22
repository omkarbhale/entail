// Everything on the board that can be inspected, keyed, with the provenance
// that explains it. Built from what the server sent and nothing else. The
// board looks targets up by key; the inspector shows one.
//
// A target has several parts because one thing on screen can answer several
// "where did this come from" questions at once: the value, why its field
// exists, and the words used to show it. The first part decides how loudly
// the target is marked on the board.

import type {
  AdvanceMode,
  Board,
  Catalogue,
  Item,
  Labels,
  Motion,
  Sourced,
  StopCategory,
} from '../../mock-server/src/contract.ts'
import type { Provenance } from '../../mock-server/src/provenance.ts'

export type Part = { readonly heading: string; readonly provenance: Provenance }

export type Target = {
  /** What this is, for the inspector's title. */
  readonly name: string
  /** The text the board shows for it. */
  readonly shown: string
  readonly parts: readonly [Part, ...Part[]]
}

export type Targets = ReadonlyMap<string, Target>

export const motionWord = (labels: Labels, motion: Motion): Sourced<string> =>
  motion === 'moving' ? labels.moving : labels.stopped

export const stopWord = (labels: Labels, category: StopCategory): Sourced<string> =>
  category === 'stage-complete'
    ? labels.stageComplete
    : category === 'has-something-to-raise'
      ? labels.hasSomethingToRaise
      : labels.needsUser

export const modeWord = (labels: Labels, mode: AdvanceMode): Sourced<string> =>
  mode === 'automatic' ? labels.automatic : labels.stopForUser

export const ADVANCE_MODES: readonly AdvanceMode[] = ['automatic', 'stop-for-user']

export const COLUMNS = ['title', 'stage', 'motion', 'stop', 'advanceMode'] as const satisfies readonly (keyof Item & keyof Labels)[]

export function buildTargets({ value: board, provenance: boardProvenance }: Sourced<Board>, { fields }: Catalogue): Targets {
  const labels = board.labels.value
  const targets = new Map<string, Target>()
  const add = (key: string, name: string, shown: Sourced<string> | string, ...parts: [Part, ...Part[]]): void => {
    targets.set(key, { name, shown: typeof shown === 'string' ? shown : shown.value, parts })
  }
  const words = (label: Sourced<string>): Part => ({ heading: 'The words used to show it', provenance: label.provenance })

  add(
    'heading',
    'The board',
    labels.heading,
    { heading: 'The board itself', provenance: boardProvenance },
    { heading: 'What it lists', provenance: fields.board.items },
    { heading: 'Which items, in what order', provenance: board.items.provenance },
    words(labels.heading),
  )
  add(
    'stages',
    'The stages',
    labels.stages,
    { heading: 'Why the board lists stages', provenance: fields.board.stages },
    { heading: 'This list of stages', provenance: board.stages.provenance },
    words(labels.stages),
  )
  for (const { value: stage } of board.stages.value) {
    add(`stage:${stage.id.value}`, 'A stage', stage.name, { heading: 'This stage', provenance: stage.name.provenance })
  }
  for (const column of COLUMNS) {
    add(
      `column:${column}`,
      'A column',
      labels[column],
      { heading: 'Why this column exists', provenance: fields.item[column] },
      words(labels[column]),
    )
  }

  const stageName = new Map(board.stages.value.map(({ value: s }) => [s.id.value, s.name]))
  for (const { value: item, provenance: itemProvenance } of board.items.value) {
    const id = item.id.value
    const of = `of “${item.title.value}”`
    add(
      `${id}:title`,
      'Title',
      item.title,
      { heading: 'This value', provenance: item.title.provenance },
      { heading: 'Why items have a title', provenance: fields.item.title },
      { heading: 'This item', provenance: itemProvenance },
    )
    const name = stageName.get(item.stage.value)
    add(
      `${id}:stage`,
      `Stage ${of}`,
      name ?? item.stage.value,
      { heading: 'This value', provenance: item.stage.provenance },
      { heading: 'Why items have a stage', provenance: fields.item.stage },
      ...(name === undefined ? [] : [{ heading: 'The stage’s name', provenance: name.provenance }]),
    )
    const motion = motionWord(labels, item.motion.value)
    add(
      `${id}:motion`,
      `Moving or stopped, ${of}`,
      motion,
      { heading: 'This value', provenance: item.motion.provenance },
      { heading: 'Why items are moving or stopped', provenance: fields.item.motion },
      words(motion),
    )
    const stop = item.stop.value
    if (stop === null) {
      add(
        `${id}:stop`,
        `Why it stopped, ${of}`,
        '—',
        { heading: 'This value: no stop', provenance: item.stop.provenance },
        { heading: 'Why items carry a stop', provenance: fields.item.stop },
      )
    } else {
      const category = stopWord(labels, stop.category.value)
      add(
        `${id}:stop.category`,
        `Why it stopped, ${of}`,
        category,
        { heading: 'This value', provenance: stop.category.provenance },
        { heading: 'Why stops have a reason', provenance: fields.stop.category },
        { heading: 'This stop', provenance: item.stop.provenance },
        words(category),
      )
      add(
        `${id}:stop.detail`,
        `What it stopped on, ${of}`,
        stop.detail,
        { heading: 'This value', provenance: stop.detail.provenance },
        { heading: 'Why a stop carries a sentence', provenance: fields.stop.detail },
      )
    }
    for (const mode of ADVANCE_MODES) {
      const word = modeWord(labels, mode)
      const field = { heading: 'Why items have this setting', provenance: fields.item.advanceMode }
      if (mode === item.advanceMode.value) {
        add(`${id}:mode:${mode}`, `Current setting ${of}`, word, { heading: 'This value', provenance: item.advanceMode.provenance }, field, words(word))
      } else {
        add(`${id}:mode:${mode}`, `Other setting ${of}`, word, { heading: 'The words of this option', provenance: word.provenance }, field)
      }
    }
    const action = item.advanceable.value ? labels.advance : labels.cannotAdvance
    add(
      `${id}:advance`,
      `Sending on ${of}`,
      action,
      { heading: item.advanceable.value ? 'Why it can be sent on now' : 'Why it cannot be sent on now', provenance: item.advanceable.provenance },
      { heading: 'Why the board knows this', provenance: fields.item.advanceable },
      words(action),
    )
  }
  return targets
}
