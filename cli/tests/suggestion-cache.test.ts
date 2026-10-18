import { expect, test } from 'bun:test'
import { SuggestionCache } from '../src/term/app/suggestion/cache.js'
import { SuggestionContext, IDLE_WORKFLOW } from '../src/term/app/suggestion/context.js'
import { PromptSuggestion } from '../src/term/app/suggestion/controller.js'
import { SuggestionCandidates } from '../src/term/app/suggestion/candidates.js'
import { commandIdentity, validCommandInput } from '../src/term/app/suggestion/arguments.js'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

test('exact-input cache expires, is bounded and never exposes mutable stored arrays', () => {
  let now = 0
  const cache = new SuggestionCache(() => now)
  cache.put('first', ['one'])
  const value = cache.get('first')!
  value.push('mutated')
  expect(cache.get('first')).toEqual(['one'])
  now = 30_000
  expect(cache.get('first')).toBeUndefined()
  for (let i = 0; i < 9; i++) cache.put(String(i), [String(i)])
  expect(cache.get('0')).toBeUndefined()
  expect(cache.get('8')).toEqual(['8'])
})

test('returning to the exact draft reuses a final result; task state or context changes do not', async () => {
  let calls = 0
  const source = new SuggestionContext()
  const runtime = { ...IDLE_WORKFLOW }
  const controller = new PromptSuggestion({
    key: () => 's', eligible: () => true, draft: () => 'Run ', context: () => source.snapshot(runtime), changed: () => {},
    start: () => { calls++; return { result: async () => null, outcome: async () => ({ candidates: ['unit tests', 'integration tests'], status: 'ready' as const }), abort: () => {} } },
  })
  controller.complete('Run ')
  await tick()
  controller.cancel()
  controller.complete('Run ')
  expect(calls).toBe(1)
  expect(controller.text()).toBe('unit tests')
  controller.cancel()
  runtime.execution = 'running'
  controller.complete('Run ')
  await tick()
  expect(calls).toBe(2)
  controller.cancel()
  source.user('A different goal')
  controller.complete('Run ')
  await tick()
  expect(calls).toBe(3)
})

test('command semantics remove provable duplicates and reject invalid results', () => {
  const inventory = { models: [], sessions: [] }
  const batch = new SuggestionCandidates([' 60s check CI', ' 1m check CI', ' 2h invalid interval', ' 5m check CI', ' status'], '/loop', () => false,
    { suffix: '', command: '/loop' }, text => validCommandInput(text, inventory), text => commandIdentity(text, inventory))
  expect(batch.values()).toEqual([' 60s check CI', ' 5m check CI', ' status'])
})
