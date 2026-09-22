// Provenance: where a served value came from.
//
// Every value this server serves is a Sourced<T>. The types below make that
// a compile-time rule rather than a habit: a served record whose field is a
// bare value instead of a Sourced<...> does not satisfy Payload, so it cannot
// be wrapped, so it cannot be served. See provenance.test-d.ts for the cases
// that must fail to compile.
//
// This file is types only, so the UI can import it without importing server
// code.

/** A file in this repository that records direction. Nothing else can be cited. */
export type RecordedFile = 'VISION.md' | `unfiled/${string}.md`

/**
 * A pointer into a recorded file. `section` is a heading in that file, verbatim
 * without its leading #s; `quote` is text from under that heading, verbatim
 * apart from line breaks and blockquote markers. Both are checked against the
 * file at startup and in the tests (integrity.ts), so a citation that does not
 * resolve stops the server.
 */
export type Citation = {
  readonly file: RecordedFile
  readonly section: string
  readonly quote: string
}

/** An entry in ../DECISIONS.md. Checked against that file like a citation. */
export type DecisionId = `D-${number}`

/**
 * Why a value is what it is. One of five kinds, and every served value must
 * pick one; there is no "unmarked".
 *
 * - recorded:    the value is stated in a recorded file. The only kind that
 *                claims the captain said it.
 * - interpreted: a recorded statement bears on the value but does not settle
 *                it. `gap` says what this mock added on top of the statement,
 *                and `decision` names the open question the gap belongs to.
 * - assumed:     nothing recorded settles it. The value is a stand-in answer to
 *                an open question, taken only so the board could be drawn.
 * - placeholder: sample content with no design weight: a made-up task title,
 *                an id. It exists so there is something to render.
 * - user-input:  the person using this mockup set it, through one of the
 *                mock's actions, since the server started.
 */
export type Provenance =
  | { readonly kind: 'recorded'; readonly cites: Citation }
  | {
      readonly kind: 'interpreted'
      readonly cites: Citation
      readonly gap: string
      readonly decision: DecisionId
    }
  | { readonly kind: 'assumed'; readonly reason: string; readonly decision: DecisionId }
  | { readonly kind: 'placeholder'; readonly reason: string }
  | { readonly kind: 'user-input'; readonly action: string; readonly note: string }

export type ProvenanceKind = Provenance['kind']

/** A value together with where it came from. The only thing this server serves. */
export type Sourced<T extends Payload> = {
  readonly value: T
  readonly provenance: Provenance
}

/**
 * What may sit inside a Sourced. Scalars, or containers whose every element or
 * field is itself Sourced. A record with a bare field, or a list of bare
 * values, is not a Payload.
 */
export type Payload = string | number | boolean | null | ServedList | ServedRecord

export interface ServedList extends ReadonlyArray<Sourced<Payload>> {}

// Served record types must be declared as type aliases, not interfaces: an
// interface does not satisfy an index signature, so it would be rejected here
// even with every field Sourced.
export interface ServedRecord {
  readonly [field: string]: Sourced<Payload>
}

/**
 * Why each field of a served record exists at all, separate from why any one
 * value in it is what it is. The mapped type makes the table complete: a field
 * added to a record without an entry here does not compile.
 */
export type FieldProvenance<T extends ServedRecord> = {
  readonly [K in keyof T]-?: Provenance
}
