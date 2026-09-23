// The HTTP side. Routes are listed in contract.ts. State is held in memory and
// resets when the process restarts.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type {
  AdvanceMode,
  AnswerOrigin,
  ApiResponseBody,
  Catalogue,
  Item,
  ListOf,
  ResolveRequest,
} from './contract.ts'
import { board, FIELDS, STAGE_IDS } from './fiction.ts'
import { sourced } from './mark.ts'
import { advance, describe, PROTOCOL, refusal, resolve, setAdvanceMode, type Outcome } from './rules.ts'
import type { Sourced } from './provenance.ts'

const ITEM_ROUTE = /^\/api\/items\/([^/]+)\/(advance|advance-mode)$/
const ADVANCE_MODES: readonly AdvanceMode[] = ['automatic', 'stop-for-user']
const ORIGINS: readonly AnswerOrigin[] = ['stated-by-user', 'composed-by-agent']
/** Long enough for a paragraph; the limit is the mock's (D-58). */
const MAX_TEXT = 2000

export function boardServer(initialItems: ListOf<Item>, catalogue: Omit<Catalogue, 'fields'>): Server {
  let items = initialItems
  // New ids cannot collide with the seeds, which are all item-N.
  let created = 0

  const replace = (updated: Sourced<Item>): void => {
    items = items.map((it) => (it.value.id.value === updated.value.id.value ? updated : it))
  }
  const find = (id: string) => items.find((it) => it.value.id.value === id)
  const apply = (current: Sourced<Item>, outcome: Outcome): [number, ApiResponseBody] => {
    if (!outcome.ok) return [409, sourced(outcome.refusal, PROTOCOL)]
    const updated = { ...current, value: outcome.item }
    replace(updated)
    return [200, updated]
  }
  const bad = (message: string): [number, ApiResponseBody] => [400, sourced(refusal(message), PROTOCOL)]
  const missing = (message: string): [number, ApiResponseBody] => [404, sourced(refusal(message), PROTOCOL)]

  const handle = async (req: IncomingMessage): Promise<[number, ApiResponseBody]> => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname

    if (req.method === 'GET' && path === '/api/board') return [200, board(items)]
    if (req.method === 'GET' && path === '/api/catalogue') return [200, { fields: FIELDS, ...catalogue }]

    if (req.method === 'POST' && path === '/api/items') {
      const body = await readJson(req)
      const description = text(body, 'description')
      if (description === undefined) return bad(`Body must be {"description": "..."}, non-empty, at most ${MAX_TEXT} characters.`)
      const id = `new-${++created}`
      const item = describe(id, description, STAGE_IDS)
      items = [...items, item]
      return [201, item]
    }

    // Stands in for the imagined MCP tool's one write (D-55). The board never calls it.
    if (req.method === 'POST' && path === '/api/resolutions') {
      const request = resolveRequest(await readJson(req))
      if (request === undefined) {
        return bad(
          `Body must be {"item": "...", "pending": "...", "answer": "...", "origin": ${ORIGINS.map((o) => `"${o}"`).join(' | ')}}.`,
        )
      }
      const current = find(request.item)
      if (current === undefined) return missing(`No item "${request.item}".`)
      return apply(current, resolve(current.value, request, STAGE_IDS))
    }

    const match = ITEM_ROUTE.exec(path)
    const expected = match?.[2] === 'advance' ? 'POST' : 'PUT'
    if (match?.[1] === undefined || req.method !== expected) return missing(`No route for ${req.method} ${path}.`)
    const id = decodeURIComponent(match[1])
    const current = find(id)
    if (current === undefined) return missing(`No item "${id}".`)

    if (match[2] === 'advance') return apply(current, advance(current.value, STAGE_IDS))

    const body = await readJson(req)
    const mode = ADVANCE_MODES.find((m) => field(body, 'mode') === m)
    if (mode === undefined) return bad(`Body must be {"mode": ${ADVANCE_MODES.map((m) => `"${m}"`).join(' | ')}}.`)
    return apply(current, { ok: true, item: setAdvanceMode(current.value, mode) })
  }

  return createServer((req, res) => {
    handle(req).then(
      ([status, body]) => send(res, status, body),
      (error: unknown) => send(res, 500, sourced(refusal(`Mock server error: ${String(error)}`), PROTOCOL)),
    )
  })
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = ''
  for await (const chunk of req) raw += String(chunk)
  try {
    return JSON.parse(raw)
  } catch {
    // Not JSON; refused by the caller like any other malformed body.
    return undefined
  }
}

function field(body: unknown, name: string): unknown {
  return typeof body === 'object' && body !== null && name in body ? (body as Record<string, unknown>)[name] : undefined
}

/** A non-empty string field, trimmed, within the mock's length limit. */
function text(body: unknown, name: string): string | undefined {
  const value = field(body, name)
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 || trimmed.length > MAX_TEXT ? undefined : trimmed
}

function resolveRequest(body: unknown): ResolveRequest | undefined {
  const item = text(body, 'item')
  const pending = text(body, 'pending')
  const answer = text(body, 'answer')
  const origin = ORIGINS.find((o) => field(body, 'origin') === o)
  if (item === undefined || pending === undefined || answer === undefined || origin === undefined) return undefined
  return { item, pending, answer, origin }
}

function send(res: ServerResponse, status: number, body: ApiResponseBody): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
