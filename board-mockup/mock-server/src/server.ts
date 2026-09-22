// The HTTP side. Routes are listed in contract.ts. State is held in memory and
// resets when the process restarts.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AdvanceMode, ApiResponseBody, Catalogue, Item, ListOf } from './contract.ts'
import { board, FIELDS, STAGE_IDS } from './fiction.ts'
import { sourced } from './mark.ts'
import { advance, PROTOCOL, refusal, setAdvanceMode } from './rules.ts'
import type { Sourced } from './provenance.ts'

const ITEM_ROUTE = /^\/api\/items\/([^/]+)\/(advance|advance-mode)$/
const ADVANCE_MODES: readonly AdvanceMode[] = ['automatic', 'stop-for-user']

export function boardServer(initialItems: ListOf<Item>, catalogue: Omit<Catalogue, 'fields'>): Server {
  let items = initialItems

  const replace = (updated: Sourced<Item>): void => {
    items = items.map((it) => (it.value.id.value === updated.value.id.value ? updated : it))
  }

  const handle = async (req: IncomingMessage): Promise<[number, ApiResponseBody]> => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname

    if (req.method === 'GET' && path === '/api/board') return [200, board(items)]
    if (req.method === 'GET' && path === '/api/catalogue') return [200, { fields: FIELDS, ...catalogue }]

    const match = ITEM_ROUTE.exec(path)
    const expected = match?.[2] === 'advance' ? 'POST' : 'PUT'
    if (match?.[1] === undefined || req.method !== expected) {
      return [404, sourced(refusal(`No route for ${req.method} ${path}.`), PROTOCOL)]
    }
    const id = decodeURIComponent(match[1])
    const current = items.find((it) => it.value.id.value === id)
    if (current === undefined) return [404, sourced(refusal(`No item "${id}".`), PROTOCOL)]

    if (match[2] === 'advance') {
      const outcome = advance(current.value, STAGE_IDS)
      if (!outcome.ok) return [409, sourced(outcome.refusal, PROTOCOL)]
      const updated = { ...current, value: outcome.item }
      replace(updated)
      return [200, updated]
    }

    const mode = await readMode(req)
    if (mode === undefined) {
      return [400, sourced(refusal(`Body must be {"mode": ${ADVANCE_MODES.map((m) => `"${m}"`).join(' | ')}}.`), PROTOCOL)]
    }
    const updated = { ...current, value: setAdvanceMode(current.value, mode) }
    replace(updated)
    return [200, updated]
  }

  return createServer((req, res) => {
    handle(req).then(
      ([status, body]) => send(res, status, body),
      (error: unknown) => send(res, 500, sourced(refusal(`Mock server error: ${String(error)}`), PROTOCOL)),
    )
  })
}

async function readMode(req: IncomingMessage): Promise<AdvanceMode | undefined> {
  let raw = ''
  for await (const chunk of req) raw += String(chunk)
  try {
    const body: unknown = JSON.parse(raw)
    if (typeof body === 'object' && body !== null && 'mode' in body) {
      return ADVANCE_MODES.find((m) => m === body.mode)
    }
  } catch {
    // Not JSON; refused below like any other malformed body.
  }
  return undefined
}

function send(res: ServerResponse, status: number, body: ApiResponseBody): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
