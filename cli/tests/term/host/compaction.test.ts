import { expect, test } from 'bun:test'
import { createCompactionController, type CompactionDeps } from '../../../src/term/host/compaction.js'
import type { ReplState } from '../../../src/term/host/state.js'
import type { ManualCompactionOutcome } from '../../../src/native/contracts/results.js'
import { ManualCompaction } from '../../../src/term/app/run/manual-compaction.js'
import { PendingQueue, createPendingQueueState } from '../../../src/term/app/queue/pending-queue.js'
import { draft } from '../../helpers/prompt-queue.js'

function harness() {
  const pending = new PendingQueue(createPendingQueueState()), manual = new ManualCompaction()
  const result = Promise.withResolvers<ManualCompactionOutcome>()
  const st = { sessionId: 'session-a', logMode: null, pendingQueue: pending.state,
    destroyed: false, isLoading: false } as ReplState
  let generation = 0
  const dispatched: string[] = [], notices: string[] = []
  const ctl = createCompactionController(st, {
    agent: { compact: () => ({ phase: 'summarizing', result: () => result.promise, abort: () => {} }) },
    manualCompaction: manual,
    queueLifecycle: { begin: target => pending.begin(target),
      settled: (_stream, chain, success) => { pending.settle(chain, success) },
      dispatchNext: () => { const next = pending.next(pending.state.chain); if (next) dispatched.push(next.text) } },
    runCtl: { beginRun: () => ++generation, ownsRun: current => current === generation, startSpinner: () => {}, stopSpinner: () => {} },
    renderer: { requestRender: () => {} },
    scrollback: { commitSystem: (_id, message) => { notices.push(message) } },
  } as unknown as CompactionDeps)
  const accept = (text: string) => pending.accept({ target: 'session-a', queue: 'follow_up', text, expandedText: text, snapshot: draft(text) })
  return { ctl, pending, st, result, accept, dispatched, notices, revoke: () => { generation++ } }
}

test('no-op compaction releases only the oldest prompt and leaves the rest visible', async () => {
  const h = harness(), running = h.ctl.runManualCompaction('')
  h.accept('B'); h.accept('C')
  expect(h.pending.state.entries.map(entry => entry.text)).toEqual(['B', 'C'])
  h.result.resolve({ status: 'nothing_to_compact' })
  await running
  expect(h.dispatched).toEqual(['B'])
  expect(h.pending.state.entries.map(entry => entry.text)).toEqual(['B', 'C'])
  expect(h.st.isLoading).toBe(false)
})

test.each(['cancelled', 'failure'])('compaction %s pauses B/C and never drains dependent work', async outcome => {
  const h = harness(), running = h.ctl.runManualCompaction('')
  h.accept('B'); h.accept('C')
  if (outcome === 'failure') h.result.reject(new Error('fixture failure'))
  else h.result.resolve({ status: 'cancelled' } as ManualCompactionOutcome)
  await running
  expect(h.dispatched).toEqual([])
  expect(h.pending.state.entries.every(entry => entry.paused)).toBe(true)
})

test('late compaction completion cannot clear or dispatch a successor session', async () => {
  const h = harness(), running = h.ctl.runManualCompaction('')
  h.accept('B'); h.pending.settle(h.pending.state.chain, false)
  h.revoke(); h.st.sessionId = 'session-new'; h.pending.begin('session-new')
  h.st.isLoading = true
  h.result.resolve({ status: 'nothing_to_compact' })
  await running
  expect(h.st.isLoading).toBe(true)
  expect(h.pending.state.target).toBe('session-new')
  expect(h.pending.state.entries[0]?.paused).toBe(true)
  expect(h.dispatched).toEqual([])
})
