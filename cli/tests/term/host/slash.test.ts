import { expect, test } from 'bun:test'
import { createSlashController, type SlashDeps } from '../../../src/term/host/slash.js'
import type { ReplState } from '../../../src/term/host/state.js'
import type { ForkedAgent } from '../../../src/native/index.js'
import type { QueryEvent } from '../../../src/native/contracts/query-event.js'
import { createInitialState } from '../../../src/term/app/run/state.js'
import { createPendingQueueState } from '../../../src/term/app/queue/pending-queue.js'
import { queueFixture } from '../../helpers/prompt-queue.js'

function event(kind: 'run_finished' | 'error'): QueryEvent {
  return { event_id: 'e', run_id: 'r', session_id: 'fork-session', created_at: '', turn: 0, kind,
    payload: kind === 'error' ? { message: 'fixture error' }
      : { text: '', usage: { input: 0, output: 0 }, turn_count: 1, duration_ms: 1, transcript_count: 0 } }
}

function harness(events: QueryEvent[] = [event('run_finished')]) {
  const native = queueFixture(events), outcomes: boolean[] = [], targets: unknown[] = [], notices: string[] = []
  const queries: unknown[][] = []
  const fork = { query: async (...args: unknown[]) => { queries.push(args); return native.stream } } as unknown as ForkedAgent
  const st = { sessionId: 'main-session', logMode: fork, logDiscardTarget: fork,
    appState: createInitialState('model', '/tmp'), pendingQueue: createPendingQueueState(), queueDispatchId: null,
    composerRevision: 0, destroyed: false, isLoading: false } as ReplState
  let generation = 0
  const deps = {
    cloudCtl: { queryBlockedByCloudLogin: () => false, activeProviderIsCloud: () => false },
    runCtl: { beginRun: () => ++generation, ownsRun: current => current === generation, startSpinner: () => {}, stopSpinner: () => {} },
    runThinking: { reset: () => {}, observe: () => {} },
    queueEdit: { entries: () => [], refresh: () => {} },
    queueLifecycle: { begin: target => { targets.push(target); return 1 }, started: () => {},
      reconcile: () => {}, settled: (_stream, _chain, success) => { outcomes.push(success) }, dispatchNext: () => {} },
    renderer: { termRows: 24, requestRender: () => {} },
    suggestionContext: { observe: () => {} }, suggestions: { cancel: () => {} }, suggest: { requestProductSuggestion: () => {} },
    scrollback: { commitUserMessage: () => {}, commitRunFooter: () => {}, commitLines: () => {}, commitFlushResult: () => {},
      commitSystem: (_id, message) => { notices.push(message) } },
  } as unknown as SlashDeps
  return { ctl: createSlashController(st, deps), st, native, fork, outcomes, targets, queries, notices, deps }
}

test('structured log continuation keeps its exact fork target and never changes main session identity', async () => {
  const h = harness(), content = '[{"type":"image","mimeType":"image/png","source":{"type":"base64","data":"fixture"}}]'
  await h.ctl.runLogQuery(h.fork, 'log follow-up', content)
  expect(h.targets).toEqual([h.fork])
  expect(h.queries).toEqual([['log follow-up', content]])
  expect(h.outcomes).toEqual([true])
  expect(h.st.sessionId).toBe('main-session')
  expect(h.st.logDiscardTarget).toBeNull()
})

test.each(['error', 'truncated', 'host-tool'])('log %s cannot report successful queue completion', async outcome => {
  const events = outcome === 'error' ? [event('error'), event('run_finished')]
    : outcome === 'host-tool' ? [{ kind: 'host_tool_call', payload: { tool_name: 'write', tool_call_id: 'x', arguments: {} } } as QueryEvent] : []
  const h = harness(events)
  await h.ctl.runLogQuery(h.fork, 'log query')
  expect(h.outcomes).toEqual([false])
  expect(h.st.isLoading).toBe(false)
})

test('leaving a fork with pending prompts requires an explicit second confirmation', () => {
  const h = harness(), removed: string[] = []
  h.st.logDiscardTarget = null
  Object.assign(h.deps.queueEdit, { entries: () => [{ id: 'pending-log', version: 1 }] })
  Object.assign(h.deps, { pendingQueue: { remove: entry => { removed.push(entry.id) } } })
  h.ctl.leaveLogMode()
  expect(h.st.logMode).toBe(h.fork)
  expect(removed).toEqual([])
  h.ctl.leaveLogMode()
  expect(h.st.logMode).toBeNull()
  expect(removed).toEqual(['pending-log'])
})
