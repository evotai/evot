import { expect, test } from 'bun:test'
import { createQueueLifecycle } from '../../../src/term/app/queue/queue-lifecycle.js'
import { PendingQueue, createPendingQueueState, type PendingEntry } from '../../../src/term/app/queue/pending-queue.js'
import { draft, queueFixture } from '../../helpers/prompt-queue.js'

function harness(run: (entry: PendingEntry) => Promise<void>) {
  const queue = new PendingQueue(createPendingQueueState()), native = queueFixture()
  queue.begin('session-a')
  let dispatch: string | null = null
  const notices: string[] = [], consumed: string[] = []
  const ctl = createQueueLifecycle({
    queue, getTarget: () => 'session-a', getStream: () => null,
    busy: () => false, preparing: () => false, editing: () => false,
    getDispatch: () => dispatch, setDispatch: id => { dispatch = id },
    runQueued: run, consumed: entries => { consumed.push(...entries.map(entry => entry.text)) },
    notify: message => { notices.push(message) }, requestRender: () => {},
  })
  const accept = (text: string) => queue.accept({ target: 'session-a', queue: 'follow_up', text, expandedText: text, snapshot: draft(text) })
  return { queue, native, ctl, accept, notices, consumed, dispatch: () => dispatch }
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

test.each(['rejected', 'not-started'])('dispatch %s pauses FIFO backlog without dropping the initial entry', async outcome => {
  const calls: string[] = []
  const h = harness(async entry => { calls.push(entry.text); if (outcome === 'rejected') throw new Error('fixture rejection') })
  h.accept('B'); h.accept('C')
  h.ctl.dispatchNext(); h.ctl.dispatchNext()
  await tick()
  expect(calls).toEqual(['B'])
  expect(h.queue.state.entries.map(entry => [entry.text, entry.paused])).toEqual([['B', true], ['C', true]])
  expect(h.dispatch()).toBeNull()
  expect(h.notices.join(' ')).toContain(outcome === 'rejected' ? 'fixture rejection' : 'did not start')
})

test('ownership recovery never retries a read failure as if native consumption were acknowledged', () => {
  const h = harness(async () => {})
  h.accept('B'); h.accept('C')
  h.queue.attach(h.native.stream)
  h.native.failRead(true)
  h.ctl.pause(h.native.stream)
  expect(h.queue.state.blocked).toBe(true)
  expect(h.consumed).toEqual([])
  h.ctl.resumePaused()
  expect(h.dispatch()).toBeNull()
  expect(h.queue.state.entries.map(entry => entry.text)).toEqual(['B', 'C'])
})
