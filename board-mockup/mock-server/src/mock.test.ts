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
    assert.equal(board.value.items.value.length, 6)
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
    ['item-6', 'has landed'],
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

  it('lands an item sent on from its completed last stage, keeping its pull request', async () => {
    assert.equal((await itemOf('item-5')).advanceable.value, true)
    const [status, item] = await call<Sourced<Item>>('POST', '/api/items/item-5/advance')
    assert.equal(status, 200)
    assert.equal(item.value.motion.value, 'landed')
    assert.equal(item.value.motion.provenance.kind, 'user-input')
    assert.equal(item.value.stage.value, 'pull-request')
    assert.equal(item.value.pullRequest.value, '#318')
    assert.equal(item.value.agent.value, null)
    assert.equal(item.value.advanceable.value, false)
  })

  it('shows an agent pane on a moving item and after an advance, spawning nothing', async () => {
    assert.equal((await itemOf('item-4')).agent.value, 'entail:item-4.development')
    assert.equal((await itemOf('item-1')).agent.value, 'entail:item-1.pull-request')
    assert.equal((await itemOf('item-1')).agent.provenance.kind, 'assumed')
  })

  it('hands over a ready-made invocation for a stop that asks something, and none for one that does not', async () => {
    const raised = await itemOf('item-2')
    const handover = raised.stop.value?.handover.value
    assert.ok(handover)
    assert.equal(handover.pending.value, 'item-2/q1')
    assert.match(handover.text.value, /item-2\/q1/)
    assert.match(handover.text.value, /Rate-limit the public API/)
    assert.match(handover.text.value, /entail_resolve/)
    assert.ok((await itemOf('item-3')).stop.value?.handover.value)
  })

  it('puts described work into the pipeline at the first stage, in the user’s words', async () => {
    const [status, item] = await call<Sourced<Item>>('POST', '/api/items', { description: '  Export audit log as JSON  ' })
    assert.equal(status, 201)
    assert.equal(item.value.title.value, 'Export audit log as JSON')
    assert.equal(item.value.title.provenance.kind, 'user-input')
    assert.equal(item.value.stage.value, 'vision')
    assert.equal(item.value.motion.value, 'moving')
    assert.equal(item.value.agent.value, `entail:${item.value.id.value}.vision`)
    assert.equal(item.value.advanceMode.value, 'stop-for-user')
    assert.deepEqual(await itemOf(item.value.id.value), item.value)
    assert.equal((await call('POST', '/api/items', { description: '   ' }))[0], 400)
    assert.equal((await call('POST', '/api/items', {}))[0], 400)
  })

  it('records an answer the user stated as set by the user, and one an agent composed as not', async () => {
    const stated = { item: 'item-2', pending: 'item-2/q1', answer: 'Per key.', origin: 'stated-by-user' }
    const [status, item] = await call<Sourced<Item>>('POST', '/api/resolutions', stated)
    assert.equal(status, 200)
    assert.equal(item.value.motion.value, 'moving')
    assert.equal(item.value.stage.value, 'architecture')
    assert.equal(item.value.stop.value, null)
    const [answer] = item.value.answers.value
    assert.ok(answer)
    assert.equal(answer.value.answer.value, 'Per key.')
    assert.equal(answer.value.answer.provenance.kind, 'user-input')
    assert.equal(answer.value.origin.value, 'stated-by-user')

    const composed = { item: 'item-3', pending: 'item-3/q1', answer: 'Use “project”.', origin: 'composed-by-agent' }
    const [, other] = await call<Sourced<Item>>('POST', '/api/resolutions', composed)
    const [agreed] = other.value.answers.value
    assert.ok(agreed)
    assert.equal(agreed.value.answer.provenance.kind, 'agent-composed')
    assert.equal(agreed.value.origin.provenance.kind, 'agent-composed')
    assert.equal(agreed.provenance.kind, 'agent-composed')
  })

  it('refuses an answer for something the item is not waiting on', async () => {
    const wrong = { item: 'item-4', pending: 'item-4/q1', answer: 'x', origin: 'stated-by-user' }
    assert.equal((await call('POST', '/api/resolutions', wrong))[0], 409)
    const stale = { item: 'item-2', pending: 'item-2/q1', answer: 'again', origin: 'stated-by-user' }
    assert.equal((await call('POST', '/api/resolutions', stale))[0], 409)
    assert.equal((await call('POST', '/api/resolutions', { ...wrong, item: 'nope' }))[0], 404)
    assert.equal((await call('POST', '/api/resolutions', { ...wrong, origin: 'someone' }))[0], 400)
  })

  it('refuses a malformed mode, an unknown item and an unknown route', async () => {
    assert.equal((await call('PUT', '/api/items/item-4/advance-mode', { mode: 'sometimes' }))[0], 400)
    assert.equal((await call('POST', '/api/items/nope/advance'))[0], 404)
    assert.equal((await call('GET', '/api/items/item-4/advance'))[0], 404)
    assert.equal((await call('GET', '/api/nothing'))[0], 404)
  })
})
