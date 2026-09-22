// Checks that provenance points at something real.
//
// The type system guarantees every served value carries provenance. It cannot
// guarantee a citation quotes what the file says, or that a decision id names
// an entry in ../DECISIONS.md. This does, against the files themselves. The
// server refuses to start if anything fails, and the tests run it too.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DecisionEntry } from './contract.ts'
import { board, FIELDS, INITIAL_ITEMS } from './fiction.ts'
import type { Citation, DecisionId, Provenance } from './provenance.ts'
import { RULE_PROVENANCE } from './rules.ts'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')
const DECISIONS_FILE = join(REPO_ROOT, 'board-mockup', 'DECISIONS.md')

const DECISION_HEADING = /^### (D-\d+)\. (.+)$/

export function loadDecisions(text = readFileSync(DECISIONS_FILE, 'utf8')): DecisionEntry[] {
  const entries: DecisionEntry[] = []
  for (const line of text.split('\n')) {
    const match = DECISION_HEADING.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined) {
      entries.push({ id: match[1] as DecisionId, question: match[2] })
    }
  }
  return entries
}

/** Every provenance the server can serve: the initial state, the field table, and what the rules stamp. */
export function allProvenance(): Provenance[] {
  const found: Provenance[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk)
    } else if (typeof node === 'object' && node !== null) {
      if ('provenance' in node && 'value' in node) {
        found.push(node.provenance as Provenance)
        walk(node.value)
      } else {
        Object.values(node).forEach(walk)
      }
    }
  }
  walk(board(INITIAL_ITEMS))
  for (const fields of Object.values(FIELDS)) found.push(...(Object.values(fields) as Provenance[]))
  found.push(...RULE_PROVENANCE)
  return found
}

export function problems(
  provenances: readonly Provenance[],
  decisions: readonly DecisionEntry[],
  readRecorded: (file: string) => string | undefined = readRepoFile,
): string[] {
  const out: string[] = []
  const ids = new Set<string>()
  for (const { id } of decisions) {
    if (ids.has(id)) out.push(`DECISIONS.md lists ${id} more than once`)
    ids.add(id)
  }
  const checked = new Set<Citation>()
  for (const p of provenances) {
    if ((p.kind === 'interpreted' || p.kind === 'assumed') && !ids.has(p.decision)) {
      out.push(`${p.decision} is cited but is not an entry in DECISIONS.md`)
    }
    if ((p.kind === 'recorded' || p.kind === 'interpreted') && !checked.has(p.cites)) {
      checked.add(p.cites)
      const problem = citationProblem(p.cites, readRecorded)
      if (problem !== undefined) out.push(problem)
    }
  }
  return out
}

function readRepoFile(file: string): string | undefined {
  try {
    return readFileSync(join(REPO_ROOT, file), 'utf8')
  } catch {
    return undefined
  }
}

function citationProblem(cites: Citation, readRecorded: (file: string) => string | undefined): string | undefined {
  const text = readRecorded(cites.file)
  if (text === undefined) return `${cites.file} does not exist`
  const body = section(text, cites.section)
  if (body === undefined) return `${cites.file} has no heading "${cites.section}"`
  if (!normalise(body).includes(normalise(cites.quote))) {
    return `${cites.file} § "${cites.section}" does not contain: ${cites.quote}`
  }
  return undefined
}

/** The text under a heading, up to the next heading of the same or a higher level. */
function section(text: string, heading: string): string | undefined {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => {
    const level = headingLevel(line)
    return level !== undefined && line.slice(level + 1) === heading
  })
  if (start === -1) return undefined
  const level = headingLevel(lines[start] ?? '') ?? 0
  const end = lines.findIndex((line, i) => i > start && (headingLevel(line) ?? Infinity) <= level)
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n')
}

function headingLevel(line: string): number | undefined {
  return /^(#+) /.exec(line)?.[1]?.length
}

/** Joins wrapped lines and drops blockquote markers, so a quote need not match line breaks. */
function normalise(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*>\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}
