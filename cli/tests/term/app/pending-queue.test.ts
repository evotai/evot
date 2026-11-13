import { expect, test } from 'bun:test'
import { pendingEntryLabel, visiblePendingEntries, PendingQueue, createPendingQueueState } from '../../../src/term/app/queue/pending-queue.js'
import { draft, queueFixture } from '../../helpers/prompt-queue.js'

function accept(queue: PendingQueue, text: string) {
  return queue.accept({ target: 'session-a', queue: 'follow_up', text, expandedText: text, snapshot: draft(text) })
}

function harness() {
  const queue = new PendingQueue(createPendingQueueState())
  const native = queueFixture()
  const chain = queue.begin('session-a')
  const accept = (text: string) => queue.accept({ target: 'session-a', queue: 'follow_up', text, expandedText: text, snapshot: draft(text) })
  return { queue, native, chain, accept }
}

test('visible pending entries are a pure session-scoped projection', () => {
  const h = harness(), b = h.accept('B')
  const before = structuredClone(h.queue.state)
  expect(visiblePendingEntries(h.queue.state, 'session-a')).toEqual([b])
  expect(visiblePendingEntries(h.queue.state, 'session-other')).toEqual([])
  expect(pendingEntryLabel(b)).toBe('[next] B')
  expect(h.queue.state).toEqual(before)
  h.queue.settle(h.chain, false)
  expect(pendingEntryLabel(b)).toBe('[paused] B')
})

test('expanded queue edits never expose the host envelope in display or recovery text', () => {
  const h = harness(), b = h.accept('/x-review old')
  h.queue.attach(h.native.stream)
  h.queue.update(b, b.version, '/x-review new', '<command>expanded instructions</command>')
  expect(b.text).toBe('/x-review new')
  expect(b.snapshot.text).toBe('/x-review new')
  expect(b.expandedText).toBe('<command>expanded instructions</command>')
})

test('follow-ups register FIFO, never steer, and reconcile one native consumption at a time', () => {
  const h = harness()
  const b = h.accept('B'), c = h.accept('C')
  h.queue.attach(h.native.stream)
  h.queue.attach(h.native.stream)
  expect(h.native.calls).toEqual(['follow_up', 'follow_up'])
  expect(h.queue.reconcile(h.native.stream)).toEqual([])
  h.native.consume()
  expect(h.queue.reconcile(h.native.stream)).toEqual([b])
  expect(h.queue.state.entries).toEqual([c])
  expect(h.queue.reconcile(h.native.stream)).toEqual([])
})

test('a final-poll survivor transfers to local ownership exactly once', () => {
  const h = harness(), consumed: string[] = []
  const b = h.accept('B')
  h.queue.attach(h.native.stream)
  h.queue.detach(h.native.stream, entries => consumed.push(...entries.map(entry => entry.id)))
  h.queue.settle(h.chain, true)
  expect(consumed).toEqual([])
  expect(b.native).toBeUndefined()
  expect(h.native.queues.follow_up).toEqual([])
  expect(h.queue.next(h.chain)).toBe(b)
})

test('dequeue and consumption cannot both win', () => {
  for (const consumed of [false, true]) {
    const h = harness(), b = h.accept('B')
    h.queue.attach(h.native.stream)
    if (consumed) {
      h.native.consume()
      expect(() => h.queue.remove(b, b.version)).toThrow()
      expect(h.queue.reconcile(h.native.stream)).toEqual([b])
    } else {
      h.queue.remove(b, b.version)
      expect(h.native.consume()).toBeUndefined()
      expect(h.queue.reconcile(h.native.stream)).toEqual([])
    }
    expect(h.queue.state.entries).toEqual([])
  }
})

test('queue read failure never acknowledges consumption and failed detach blocks reuse', () => {
  const h = harness(), b = h.accept('B')
  h.queue.attach(h.native.stream)
  h.native.failRead()
  expect(() => h.queue.detach(h.native.stream, () => {})).toThrow()
  expect(h.queue.state.entries).toEqual([b])
  expect(h.queue.state.blocked).toBe(true)
  expect(() => h.queue.begin('unrelated')).toThrow()
  h.native.failRead(false)
  h.queue.detach(h.native.stream, () => {})
  expect(h.queue.state.blocked).toBe(false)
})

test('acknowledged consumption is committed even when a later native removal fails', () => {
  const h = harness(), b = h.accept('B'), c = h.accept('C'), committed: string[] = []
  h.queue.attach(h.native.stream)
  h.native.consume()
  h.native.failRemove()
  expect(() => h.queue.detach(h.native.stream, entries => committed.push(...entries.map(entry => entry.id)))).toThrow()
  expect(committed).toEqual([b.id])
  expect(h.queue.state.entries).toEqual([c])
  h.native.failRemove(false)
  h.queue.detach(h.native.stream, entries => committed.push(...entries.map(entry => entry.id)))
  expect(committed).toEqual([b.id])
})

test('paused backlog is isolated from unrelated Enter chains and resumes only explicitly', () => {
  const h = harness(), b = h.accept('B'), c = h.accept('C')
  h.queue.settle(h.chain, false)
  expect(b.paused).toBe(true)
  const unrelated = h.queue.begin('session-a')
  const d = h.accept('D')
  h.queue.attach(h.native.stream)
  expect(h.native.queues.follow_up).toHaveLength(1)
  expect(h.queue.next(unrelated)).toBeUndefined()
  h.native.consume()
  expect(h.queue.reconcile(h.native.stream)).toEqual([d])
  h.queue.settle(unrelated, true)
  h.queue.resume('session-a')
  expect(h.queue.next(h.queue.state.chain)).toBe(b)
  expect(h.queue.state.entries).toEqual([b, c])
})

test('compaction B/C remain visible and register before a newly accepted D', () => {
  const h = harness(), b = h.accept('B'), c = h.accept('C')
  h.queue.settle(h.chain, true)
  expect(h.queue.visible('session-a')).toEqual([b, c])
  h.queue.remove(b, b.version) // B accepted as the successor's initial input.
  h.queue.state.running = true
  h.queue.attach(h.native.stream)
  const d = h.accept('D')
  h.queue.attach(h.native.stream)
  expect(h.native.queues.follow_up.map(entry => entry.message.content)).toEqual([
    [{ type: 'text', text: 'C' }], [{ type: 'text', text: 'D' }],
  ])
  expect(h.queue.visible('session-a')).toEqual([c, d])
})

test('startup identity binds only the active unbound chain', () => {
  const h = harness()
  h.queue.begin(null)
  const entry = h.queue.accept({ target: null, queue: 'follow_up', text: 'B', expandedText: 'B', snapshot: draft('B') })
  h.queue.bindSession('created-session')
  expect(entry.target).toBe('created-session')
  expect(h.queue.visible('session-a')).toEqual([])
  expect(h.queue.visible('created-session')).toEqual([entry])
})

test('edits update recovery content and stale versions cannot delete or overwrite an entry', () => {
  const h = harness(), b = h.accept('B')
  h.queue.attach(h.native.stream)
  h.queue.update(b, 1, 'edited B')
  expect(b.snapshot.text).toBe('edited B')
  expect(b.version).toBe(2)
  expect(() => h.queue.remove(b, 1)).toThrow()
  expect(() => h.queue.update(b, 1, 'stale')).toThrow()
  expect(b.expandedText).toBe('edited B')
})

test('structured content passes untouched and the text-only update path refuses it', () => {
  const h = harness(), b = h.accept('[Image #1]')
  b.contentJson = JSON.stringify([{ type: 'image', mimeType: 'image/png', source: { type: 'base64', data: 'fixture' } }])
  h.queue.attach(h.native.stream)
  expect(h.native.queues.follow_up[0]?.message.content).toEqual(JSON.parse(b.contentJson))
  expect(() => h.queue.update(b, b.version, 'text')).toThrow('attachments')
})

test('image reservation blocks newer deferred entries but not older work or explicit steering', () => {
  const queue = new PendingQueue(createPendingQueueState()), native = queueFixture()
  queue.begin('session-a')
  const b = accept(queue, 'B')
  const reservation = queue.reserve('session-a')
  const d = accept(queue, 'D')
  const steer = queue.accept({ target: 'session-a', queue: 'steering', text: 'now', expandedText: 'now', snapshot: draft('now') })
  queue.attach(native.stream)
  expect(b.native).toBeDefined()
  expect(d.native).toBeUndefined()
  expect(steer.native).toBeDefined()
  expect(native.calls).toEqual(['follow_up', 'steering'])
  const c = queue.accept({ target: 'session-a', queue: 'follow_up', text: 'C', expandedText: 'C', snapshot: draft('C') }, reservation.sequence)
  queue.release(reservation)
  queue.attach(native.stream)
  expect(native.queues.follow_up.map(entry => entry.id)).toEqual([b.native?.id, c.native?.id, d.native?.id])
})

test('binding startup identities cannot expose an abandoned unsaved session', () => {
  const queue = new PendingQueue(createPendingQueueState())
  const first = { startup: 1 }, second = { startup: 2 }
  queue.begin(first)
  const old = queue.accept({ target: first, queue: 'follow_up', text: 'old', expandedText: 'old', snapshot: draft('old') })
  queue.settle(queue.state.chain, false)
  queue.begin(second)
  queue.bindSession('session-new')
  expect(old.target).toBe(first)
  expect(queue.visible('session-new')).toEqual([])
})

test('version reconciliation enables safe retry without treating a conflict as consumption', () => {
  const queue = new PendingQueue(createPendingQueueState()), native = queueFixture()
  queue.begin('session-a')
  const b = accept(queue, 'B')
  queue.attach(native.stream)
  if (!b.native) throw new Error('entry was not registered')
  native.stream.updateQueuedPrompt('follow_up', b.native.id, b.native.version, 'external edit')
  expect(() => queue.update(b, b.version, 'unsaved edit')).toThrow()
  expect(queue.reconcile(native.stream)).toEqual([])
  expect(b.native.version).toBe(1)
  queue.update(b, b.version, 'unsaved edit')
  expect(b.expandedText).toBe('unsaved edit')
  queue.remove(b, b.version)
  expect(queue.state.entries).toEqual([])
})

test('bounded seeded actions conserve every accepted entry and never consume an ID twice', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const h = harness(), accepted = new Set<string>(), terminal = new Set<string>()
    let random = seed
    const finish = (id: string) => { expect(terminal.has(id)).toBe(false); terminal.add(id) }
    for (let step = 0; step < 80; step++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0
      const action = random % 4
      if (action === 0) accepted.add(h.accept(`seed-${seed}-${step}`).id)
      if (action === 1) h.queue.attach(h.native.stream)
      if (action === 2) { h.native.consume(); h.queue.reconcile(h.native.stream).forEach(entry => finish(entry.id)) }
      if (action === 3) {
        const entry = h.queue.state.entries.at(-1)
        if (entry) { h.queue.remove(entry, entry.version); finish(entry.id) }
      }
      expect(new Set([...terminal, ...h.queue.state.entries.map(entry => entry.id)])).toEqual(accepted)
      expect(terminal.size + h.queue.state.entries.length).toBe(accepted.size)
    }
  }
})
