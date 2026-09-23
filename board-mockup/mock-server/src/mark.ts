// Constructors for Provenance and Sourced values. Plain functions; the type
// system does the enforcing, these only save repetition.

import type { Citation, DecisionId, Payload, Provenance, Sourced } from './provenance.ts'

export const recorded = (cites: Citation): Provenance => ({ kind: 'recorded', cites })

export const interpreted = (cites: Citation, decision: DecisionId, gap: string): Provenance => ({
  kind: 'interpreted',
  cites,
  gap,
  decision,
})

export const assumed = (decision: DecisionId, reason: string): Provenance => ({
  kind: 'assumed',
  reason,
  decision,
})

export const placeholder = (reason: string): Provenance => ({ kind: 'placeholder', reason })

export const userInput = (action: string, note: string): Provenance => ({
  kind: 'user-input',
  action,
  note,
})

export const agentComposed = (action: string, note: string): Provenance => ({
  kind: 'agent-composed',
  action,
  note,
})

export const sourced = <T extends Payload>(value: T, provenance: Provenance): Sourced<T> => ({
  value,
  provenance,
})
