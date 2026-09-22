// Compile-time tests: `npm run typecheck` fails if any line below marked as
// an expected error stops being an error, that is, if a value without
// provenance ever becomes servable. Never run; only type-checked.

import type { FieldProvenance, Provenance, Sourced } from './provenance.ts'
import type { ApiResponseBody, Item } from './contract.ts'

declare const p: Provenance

// A served record may not hold a bare field.
// @ts-expect-error title has no provenance
export type BareField = Sourced<{ readonly title: string }>

// A served list may not hold bare elements.
// @ts-expect-error the elements have no provenance
export type BareList = Sourced<readonly string[]>

// A record declared as an interface is refused too, even with every field
// Sourced, so the rule cannot be dodged by declaring it differently.
interface AsInterface {
  readonly title: Sourced<string>
}
// @ts-expect-error served records must be type aliases
export type InterfaceRecord = Sourced<AsInterface>

// A response body must be Sourced (or the catalogue).
// @ts-expect-error a bare record is not a response body
export const bareBody: ApiResponseBody = { title: 'x' }

// The field table must cover every field.
// @ts-expect-error advanceable has no entry
export const incomplete: FieldProvenance<Item> = { id: p, title: p, stage: p, motion: p, stop: p, advanceMode: p }

// And what is allowed, for contrast.
export const fine: Sourced<{ readonly title: Sourced<string> }> = {
  value: { title: { value: 'x', provenance: p } },
  provenance: p,
}
