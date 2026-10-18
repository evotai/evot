import { expect, test } from 'bun:test'
import type { NativeSuggestion, SuggestionOutcome } from '../src/native/contracts/ports.js'
import { PromptSuggestion } from '../src/term/app/suggestion.js'
import { context } from './helpers/suggestion-context.js'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

function harness() {
  let resolve!: (outcome: SuggestionOutcome) => void
  const result = new Promise<SuggestionOutcome>(done => { resolve = done })
  const pending: ((value: string[] | null) => void)[] = []
  const queued: (string[] | null)[] = []
  let calls = 0
  let aborted = false
  let draft = 'Run '
  const emit = (value: string[] | null) => {
    const waiter = pending.shift()
    if (waiter) waiter(value)
    else queued.push(value)
  }
  const request: NativeSuggestion = {
    result: async () => (await result).candidates[0] ?? null,
    outcome: () => result,
    nextCandidates: () => queued.length ? Promise.resolve(queued.shift() ?? null) : new Promise(done => { pending.push(done) }),
    abort: () => { aborted = true; emit(null); resolve({ candidates: [], status: 'empty' }) },
  }
  const controller = new PromptSuggestion({
    key: () => 'same session', eligible: () => true, context, draft: () => draft, changed: () => {},
    start: () => { calls++; return request },
  })
  controller.complete(draft)
  return { controller, emit, resolve: (value: SuggestionOutcome) => { resolve(value); emit(null) },
    calls: () => calls, aborted: () => aborted, setDraft: (text: string) => { draft = text } }
}

test('first complete candidate is usable before the final result; later candidates keep the selection', async () => {
  const h = harness()
  expect(h.controller.pending()).toBe(true)
  h.emit(['first'])
  await tick()
  expect(h.controller.text()).toBe('first')
  expect(h.controller.pending()).toBe(false)
  h.emit(['first', 'second'])
  await tick()
  h.controller.next()
  expect(h.controller.text()).toBe('second')
  h.emit(['first', 'second', 'third'])
  await tick()
  expect(h.controller.text()).toBe('second')
  h.resolve({ candidates: ['first', 'second', 'third'], status: 'ready' })
  await tick()
  expect(h.controller.position()).toEqual({ current: 2, total: 3 })
  h.controller.next()
  expect(h.controller.text()).toBe('third')
  expect(h.calls()).toBe(1)
})

test('Tab with one streamed candidate waits for the next option without a new request', async () => {
  const h = harness()
  h.emit(['first'])
  await tick()
  for (let i = 0; i < 5; i++) h.controller.next()
  expect(h.controller.pending()).toBe(true)
  h.emit(['first', 'second'])
  await tick()
  expect(h.controller.text()).toBe('second')
  expect(h.controller.pending()).toBe(false)
  expect(h.calls()).toBe(1)
  h.resolve({ candidates: ['first', 'second'], status: 'ready' })
  await tick()
})

test('accepting early cancels remaining generation and late candidates cannot reappear', async () => {
  const h = harness()
  h.emit(['first'])
  await tick()
  expect(h.controller.take()).toBe('first')
  expect(h.aborted()).toBe(true)
  h.emit(['first', 'second', 'third'])
  await tick()
  expect(h.controller.text()).toBe('')
})

test('invalid progress and input changes never expose unsafe or stale suggestions', async () => {
  const h = harness()
  h.emit(['\u001b[31mbad', 'valid'])
  await tick()
  expect(h.controller.text()).toBe('valid')
  h.setDraft('Other ')
  h.emit(['valid', 'stale'])
  await tick()
  expect(h.controller.text()).toBe('')
  h.controller.reconcile()
  expect(h.aborted()).toBe(true)
})

test('provider failure withdraws a streamed preview and leaves Tab retry feedback', async () => {
  const h = harness()
  h.emit(['first'])
  await tick()
  h.emit([])
  h.resolve({ candidates: [], status: 'failed' })
  await tick()
  expect(h.controller.text()).toBe('')
  expect(h.controller.feedback()).toBe('failed')
})
