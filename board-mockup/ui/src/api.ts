// The only way the UI gets anything to show. Types come from the mock
// server's contract, so the UI and the server cannot disagree on a shape.

import type {
  AdvanceMode,
  Board,
  Catalogue,
  CreateItemRequest,
  Item,
  Refusal,
  ResolveRequest,
  SetAdvanceModeRequest,
  Sourced,
  StageEndingRequest,
} from '../../mock-server/src/contract.ts'

export async function loadBoard(): Promise<{ board: Sourced<Board>; catalogue: Catalogue }> {
  const [board, catalogue] = await Promise.all([
    request<Sourced<Board>>('GET', '/api/board'),
    request<Catalogue>('GET', '/api/catalogue'),
  ])
  return { board, catalogue }
}

export const advance = (id: string): Promise<Sourced<Item>> =>
  request('POST', `/api/items/${encodeURIComponent(id)}/advance`)

export const setAdvanceMode = (id: string, mode: AdvanceMode): Promise<Sourced<Item>> =>
  request('PUT', `/api/items/${encodeURIComponent(id)}/advance-mode`, { mode } satisfies SetAdvanceModeRequest)

export const describeWork = (description: string): Promise<Sourced<Item>> =>
  request('POST', '/api/items', { description } satisfies CreateItemRequest)

/**
 * Stands in for the imagined MCP tool's one write (DECISIONS.md D-55). Only
 * the mockup's frame calls it, playing the agent; the board never does.
 */
export const resolveAsAgent = (resolution: ResolveRequest): Promise<Sourced<Item>> =>
  request('POST', '/api/resolutions', resolution)

/**
 * Stands in for whatever ends a moving item's stage (DECISIONS.md D-65). Only
 * the mockup's frame calls it, playing a stage finishing; the board never does.
 */
export const endStageAsStandIn = (ending: StageEndingRequest): Promise<Sourced<Item>> =>
  request('POST', '/api/stage-endings', ending)

/** Thrown when the mock server answers with a refusal; carries its served reason. */
export class Refused extends Error {}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const text = await res.text()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    // Vite's proxy answers with a non-JSON 5xx when the mock server is down.
    throw new Error(`${method} ${path} answered ${res.status} without JSON`)
  }
  if (!res.ok) throw new Refused((json as Sourced<Refusal>).value.reason.value)
  return json as T
}
