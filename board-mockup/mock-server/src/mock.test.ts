import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import type { Board, Catalogue, Item, Refusal } from './contract.ts'
import { INITIAL_ITEMS } from './fiction.ts'
import { allProvenance, loadDecisions, problems } from './integrity.ts'
import type { Provenance, Sourced } from './provenance.ts'
import { boardServer } from './server.ts'

describe('integrity', () => {
  const decisions = loadDecisions()

  it('resolves every citation and decision id the server can serve', () => {
    assert.deepEqual(problems(allProvenance(), decisions), [])
  })

  it('parses the decisions document', () => {
    assert.ok(decisions.length >= 40)
    assert.deepEqual(decisions[0], { id: 'D-01', question: "Is the board's unit a task, a stage, or a decision?" })
  })

  it('catches a quote the file does not contain, a missing heading and an unknown decision', () => {
    const file = 'unfiled/x.md'
    const read = (f: string) => (f === file ? '## Real\n\nThe captain said this.\n\n## Other\n\nAnd this.\n' : undefined)
    const bad: Provenance[] = [
      { kind: 'recorded', cites: { file, section: 'Real', quote: 'And this.' } },
      { kind: 'recorded', cites: { file, section: 'Missing', quote: 'x' } },
      { kind: 'recorded', cites: { file: 'unfiled/none.md', section: 'Real', quote: 'x' } },
      { kind: 'assumed', decision: 'D-999', reason: 'x' },
      { kind: 'recorded', cites: { file, section: 'Real', quote: 'The captain said this.' } },
    ]
    assert.equal(problems(bad, decisions, read).length, 4)
  })
})

describe('HTTP', () => {
  let base = ''
  const server = boardServer(INITIAL_ITEMS, { decisions: loadDecisions() })

  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, resolve))
    base = `http://localhost:${(server.address() as AddressInfo).port}`
  })
  after(() => server.close())

  const call = async <T>(method: string, path: string, body?: unknown): Promise<[number, T]> => {
    const res = await fetch(base + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return [res.status, (await res.json()) as T]
  }
  const itemOf = async (id: string): Promise<Item> => {
    const [, board] = await call<Sourced<Board>>('GET', '/api/board')
    const found = board.value.items.value.find((it) => it.value.id.value === id)
    assert.ok(found)
    return found.value
  }

  it('serves the board with provenance on every value', async () => {
    const [status, board] = await call<Sourced<Board>>('GET', '/api/board')
    assert.equal(status, 200)
    assert.equal(board.provenance.kind, 'recorded')
    assert.equal(board.value.stages.value.length, 6)
    assert.equal(board.value.items.value.length, 5)
    const everyValueSourced = (node: unknown): boolean =>
      typeof node !== 'object' || node === null
        ? false
        : 'value' in node && 'provenance' in node
          ? typeof node.value !== 'object' || node.value === null
            ? true
            : Object.values(node.value).every(everyValueSourced)
          : false
    assert.ok(everyValueSourced(board))
  })

  it('serves the catalogue', async () => {
    const [status, catalogue] = await call<Catalogue>('GET', '/api/catalogue')
    assert.equal(status, 200)
    assert.equal(catalogue.fields.item.stage.kind, 'recorded')
    assert.ok(catalogue.decisions.some((d) => d.id === 'D-24'))
  })

  it('advances an item stopped at a completed stage, and marks the result', async () => {
    assert.equal((await itemOf('item-1')).advanceable.value, true)
    const [status, item] = await call<Sourced<Item>>('POST', '/api/items/item-1/advance')
    assert.equal(status, 200)
    assert.equal(item.value.stage.value, 'pull-request')
    assert.equal(item.value.stage.provenance.kind, 'user-input')
    assert.equal(item.value.motion.value, 'moving')
    assert.equal(item.value.stop.value, null)
    assert.equal(item.value.advanceable.value, false)
    assert.equal((await itemOf('item-1')).stage.value, 'pull-request')
  })

  for (const [id, why] of [
    ['item-2', 'has something to raise'],
    ['item-3', 'needs the user'],
    ['item-4', 'is moving'],
    ['item-5', 'is at the last stage'],
  ] as const) {
    it(`refuses to advance an item that ${why}`, async () => {
      assert.equal((await itemOf(id)).advanceable.value, false)
      const [status, refusal] = await call<Sourced<Refusal>>('POST', `/api/items/${id}/advance`)
      assert.equal(status, 409)
      assert.equal(refusal.value.reason.provenance.kind, 'assumed')
    })
  }

  it('sets the advance mode and changes nothing else', async () => {
    const before = await itemOf('item-4')
    const [status, item] = await call<Sourced<Item>>('PUT', '/api/items/item-4/advance-mode', { mode: 'stop-for-user' })
    assert.equal(status, 200)
    assert.equal(item.value.advanceMode.value, 'stop-for-user')
    assert.equal(item.value.advanceMode.provenance.kind, 'user-input')
    assert.deepEqual({ ...item.value, advanceMode: before.advanceMode }, before)
  })

  it('refuses a malformed mode, an unknown item and an unknown route', async () => {
    assert.equal((await call('PUT', '/api/items/item-4/advance-mode', { mode: 'sometimes' }))[0], 400)
    assert.equal((await call('POST', '/api/items/nope/advance'))[0], 404)
    assert.equal((await call('GET', '/api/items/item-4/advance'))[0], 404)
    assert.equal((await call('GET', '/api/nothing'))[0], 404)
  })
})
