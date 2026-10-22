import { expect, test } from 'bun:test'
import { PromptSuggestion, SuggestionContext, type SuggestionHints } from '../src/term/app/suggestion.js'
import { context as fixtureContext } from './helpers/suggestion-context.js'
import type { SuggestionTrigger } from '../src/term/app/composer-guidance.js'
import type { SuggestionOutcome } from '../src/native/contracts/ports.js'
import type { UIMessage } from '../src/term/app/types.js'
import { resolveComposerGuidance, allowedSuggestionCommand } from '../src/term/app/composer-guidance.js'
import { resolveRunInteraction } from '../src/term/app/run-interaction.js'

function messages(): UIMessage[] {
  return [
    { id: 'u0', role: 'user', text: 'Implement the tests', timestamp: 0 },
    { id: 'a0', role: 'assistant', text: 'The implementation is ready.', timestamp: 0 },
    { id: 'u', role: 'user', text: '\u7ee7\u7eed\u5b9e\u73b0 suggestion \u6d4b\u8bd5', timestamp: 1 },
    { id: 'a', role: 'assistant', text: '', timestamp: 2, content: [
      { type: 'thinking', text: 'private reasoning', contentIndex: 0 },
      { type: 'text', text: 'Tests are ready.', contentIndex: 1 },
    ] },
  ]
}

function harness(options: { allowsCommand?: (text: string) => boolean } = {}) {
  let key = 'session:1'
  let eligible = true
  let automaticEligible = true
  let draft = ''
  let changes = 0
  let snapshot = fixtureContext()
  const requests: { resolve(value: string[], status?: SuggestionOutcome['status']): void; reject(error: Error): void; aborted: boolean; hints?: SuggestionHints }[] = []
  const controller = new PromptSuggestion({
    key: () => key, eligible: () => eligible, automaticEligible: () => automaticEligible, context: () => snapshot,
    changed: () => changes++, draft: () => draft,
    ...options,
    start: (_messages, hints) => {
      let resolve!: (value: SuggestionOutcome) => void
      let reject!: (error: Error) => void
      const result = new Promise<SuggestionOutcome>((yes, no) => { resolve = yes; reject = no })
      const request = { resolve: (candidates: string[], status: SuggestionOutcome['status'] = 'ready') => resolve({ candidates, status }), reject, aborted: false, hints }
      requests.push(request)
      return { result: async () => (await result).candidates[0] ?? null, outcome: () => result, abort: () => { request.aborted = true } }
    },
  })
  return { controller, requests,
    start: (history: UIMessage[], trigger?: SuggestionTrigger) => { snapshot = fixtureContext(history); controller.start(trigger) },
    complete: (history: UIMessage[], text: string) => { snapshot = fixtureContext(history); controller.complete(text) },
    setKey: (value: string) => { key = value },
    setEligible: (value: boolean) => { eligible = value }, setAutomaticEligible: (value: boolean) => { automaticEligible = value }, setDraft: (value: string) => { draft = value }, changes: () => changes }
}

// Flush both the optional progress reader and the final-outcome promise.
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

test('context retains authored intent across tool-only history without including tool chatter', () => {
  const history = messages()
  history.unshift({ id: 's', role: 'system', text: 'secret instructions', timestamp: 0 })
  history.splice(history.length - 1, 0, { id: 'tool', role: 'assistant', text: 'tool chatter', timestamp: 1, content: [
    { type: 'tool_call', contentIndex: 0, toolCall: { id: 't', name: 'bash', args: { command: 'secret' }, status: 'done' } },
  ] })
  expect(fixtureContext(history).messages).toEqual([
    { role: 'user', text: 'Implement the tests' }, { role: 'assistant', text: 'The implementation is ready.' },
    { role: 'user', text: messages()[2]!.text }, { role: 'assistant', text: 'Tests are ready.' },
  ])
})

test('live context includes committed users even though AppState only retained assistant events', () => {
  const source = new SuggestionContext()
  source.user('Add the tests')
  source.observe({ kind: 'assistant_completed', payload: { stop_reason: 'stop', content: [{ type: 'text', text: 'Tests are ready.' }] } })
  expect(source.snapshot().messages).toEqual([
    { role: 'user', text: 'Add the tests' },
    { role: 'assistant', text: 'Tests are ready.' },
  ])
  const h = harness()
  h.start(source.snapshot().messages.map((message, index) => ({ ...message, id: String(index), timestamp: 0 })))
  expect(h.requests).toHaveLength(1)
})

test('context is a bounded contiguous suffix of whole messages', () => {
  const history = Array.from({ length: 30 }, (_, index): UIMessage => ({
    id: String(index), role: index % 2 ? 'assistant' : 'user', timestamp: index,
    text: 'x'.repeat(3000) + '\u7ed3\u8bba',
  }))
  const context = fixtureContext(history).messages
  expect(context).toHaveLength(5)
  expect(context.every(message => message.text === history[0]!.text)).toBe(true)
  const long = fixtureContext([...messages().slice(0, -1), { ...messages()[3]!, content: undefined, text: 'Opening context\n' + 'x'.repeat(20000) + '\nUse Tab or Enter?' }]).messages
  expect(long.at(-1)!.text).toStartWith('Opening context')
  expect(long.at(-1)!.text).toEndWith('Use Tab or Enter?')
  expect(long.at(-2)!.role).toBe('user')
  expect(long.at(-1)!.text).toContain('[... middle omitted ...]')
  expect(long.reduce((sum, item) => sum + Math.ceil(JSON.stringify(item).length / 4), 0)).toBeLessThanOrEqual(4096)
  const oversized = { ...messages()[0]!, text: 'x'.repeat(20000) }
  expect(fixtureContext([messages()[0]!, oversized, ...messages().slice(-2)]).messages).toEqual([
    { role: 'user', text: messages()[2]!.text }, { role: 'assistant', text: 'Tests are ready.' },
  ])
})

test('recognizes text-only answer boundaries, not deltas or tool-bearing responses', () => {
  const isSuggestionBoundary = (event: { kind: string; payload: Record<string, unknown> }) => { const source = new SuggestionContext(); source.observe(event); return source.hasAnswer }
  const payload = { stop_reason: 'stop', content: [{ type: 'text', text: 'Done' }] }
  expect(isSuggestionBoundary({ kind: 'assistant_completed', payload })).toBe(true)
  for (const kind of ['assistant_delta', 'run_finished', 'tool_finished']) {
    expect(isSuggestionBoundary({ kind, payload })).toBe(false)
  }
  for (const stop_reason of ['length', 'error', 'toolUse', 'aborted']) {
    expect(isSuggestionBoundary({ kind: 'assistant_completed', payload: { ...payload, stop_reason } })).toBe(false)
  }
  expect(isSuggestionBoundary({ kind: 'assistant_completed', payload: {
    ...payload, content: [...payload.content, { type: 'tool_call' }],
  } })).toBe(false)
})

test('result is not editor text; take is explicit, single-use and does not submit', async () => {
  const { controller, requests, start } = harness()
  start(messages())
  expect(controller.text()).toBe('')
  requests[0]!.resolve(['\u8fd0\u884c\u5b9a\u5411\u6d4b\u8bd5'])
  await tick()
  expect(controller.text()).toBe('\u8fd0\u884c\u5b9a\u5411\u6d4b\u8bd5')
  expect(controller.position()).toEqual({ current: 1, total: 1 })
  expect(controller.take()).toBe('\u8fd0\u884c\u5b9a\u5411\u6d4b\u8bd5')
  expect(controller.text()).toBe('')
  expect(controller.take()).toBe('')
})

test('Tab loops over three cached candidates in order without extra requests', async () => {
  const h = harness()
  const candidates = ['one', 'two', 'three']
  h.start(messages())
  h.requests[0]!.resolve([...candidates, 'fourth is dropped'])
  await tick()
  for (let i = 0; i < 25; i++) {
    expect(h.controller.text()).toBe(candidates[i % 3]!)
    expect(h.controller.position()).toEqual({ current: (i % 3) + 1, total: 3 })
    expect(h.controller.next()).toBe(true)
    expect(h.controller.pending()).toBe(false)
  }
  expect(h.requests).toHaveLength(1)
  expect(h.requests[0]!.hints?.explicit).toBeUndefined()
  expect(h.controller.take()).toBe('two')
  expect(h.controller.text()).toBe('')
  expect(h.controller.next()).toBe(false)
})

test('one candidate stays selected on Tab instead of fetching more', async () => {
  const h = harness()
  h.start(messages())
  h.requests[0]!.resolve(['one'])
  await tick()
  for (let i = 0; i < 8; i++) expect(h.controller.next()).toBe(true)
  expect(h.controller.text()).toBe('one')
  expect(h.controller.position()).toEqual({ current: 1, total: 1 })
  expect(h.requests).toHaveLength(1)
  h.controller.cancel()
  h.setKey('session:2')
  h.start(messages())
  expect(h.requests).toHaveLength(2)
  expect(h.requests[1]!.hints?.explicit).toBeUndefined()
})

test('Tab on a draft completes it; the continuation is bound to that exact draft', async () => {
  const h = harness()
  // One finished answer is enough once the user has typed intent.
  h.setDraft('Run the')
  h.complete(messages().slice(-2), 'Run the')
  expect(h.requests).toHaveLength(1)
  expect(h.requests[0]!.hints).toMatchObject({ explicit: true, draft: 'Run the', suffix: '' })
  h.requests[0]!.resolve([' targeted tests', ' full suite', '/done'])
  await tick()
  expect(h.controller.completing()).toBe(true)
  expect(h.controller.text()).toBe(' targeted tests')
  expect(h.controller.position()).toEqual({ current: 1, total: 2 })
  h.controller.next()
  expect(h.controller.take()).toBe(' full suite')
  expect(h.controller.completing()).toBe(false)
  // A changed draft invalidates a pending or shown completion.
  h.setDraft('Review')
  h.complete(messages().slice(-2), 'Review')
  h.setDraft('Review the')
  h.requests[1]!.resolve(['everything'])
  await tick()
  expect(h.controller.text()).toBe('')
  // Commands without arguments retain their local input paths.
  for (const draft of ['/done', '/lo']) {
    h.setDraft(draft)
    h.complete(messages().slice(-2), draft)
  }
  expect(h.requests).toHaveLength(2)
})

test('explicit Tab work is visible: pending while loading, exhausted when nothing comes back', async () => {
  const h = harness()
  // Unprompted sampling after an answer stays silent.
  h.start(messages())
  expect(h.controller.pending()).toBe(false)
  h.requests[0]!.resolve(['one', 'two'])
  await tick()
  // Once the batch is available, Tab wraps locally without a loading state.
  h.controller.next()
  h.controller.next()
  expect(h.controller.pending()).toBe(false)
  expect(h.controller.exhausted()).toBe(false)
  expect(h.controller.text()).toBe('one')
  expect(h.requests).toHaveLength(1)
  // Tab on a draft: pending, then an explicit "nothing" bound to that draft.
  h.controller.cancel()
  h.setDraft('hi --')
  h.complete(messages().slice(-2), 'hi --')
  expect(h.controller.pending()).toBe(true)
  h.requests[1]!.resolve([])
  await tick()
  expect(h.controller.pending()).toBe(false)
  expect(h.controller.exhausted()).toBe(true)
  h.setDraft('hi -- more')
  expect(h.controller.exhausted()).toBe(false)
  // Transport errors settle the same way instead of spinning forever.
  h.setDraft('Run the')
  h.complete(messages().slice(-2), 'Run the')
  h.requests[2]!.reject(new Error('unavailable'))
  await tick()
  expect(h.controller.pending()).toBe(false)
  expect(h.controller.feedback()).toBe('failed')
})

test('continuations preserve literal spacing, partial words, punctuation and CJK', async () => {
  for (const [draft, suffix] of [['Run t', 'ests'], ['Run the', ' tests'], ['Run the ', 'tests'], ['\u7528 Tab', '\u5207\u6362'], ['hi --', ' can you help?']]) {
    const h = harness()
    h.setDraft(draft!)
    h.complete(messages(), draft!)
    h.requests[0]!.resolve([suffix!])
    await tick()
    expect(h.controller.take()).toBe(suffix!)
  }
})

test('unsafe or duplicate candidates are dropped individually, not the whole result', async () => {
  const h = harness()
  h.start(messages())
  h.requests[0]!.resolve(['Run the tests', '\u001b[31mbad', '/new', 'run the tests', '  Review the diff  '])
  await tick()
  expect(h.controller.text()).toBe('Run the tests')
  expect(h.controller.position()).toEqual({ current: 1, total: 2 })
  h.controller.next()
  expect(h.controller.text()).toBe('Review the diff')
})

test('empty-composer suggestions restore the selected candidate after typing and clearing', async () => {
  for (const explicit of [false, true]) {
    const h = harness()
    if (explicit) h.complete(messages(), '')
    else h.start(messages())
    h.requests[0]!.resolve(['Run the tests', 'Review the diff'])
    await tick()
    if (explicit) h.controller.next()
    const selected = explicit ? 'Review the diff' : 'Run the tests'
    for (const draft of ['new input', 'new inpu', '', 'another draft', '']) {
      h.setDraft(draft)
      h.controller.reconcile()
      expect(h.controller.text()).toBe(draft ? '' : selected)
      expect(h.controller.pending()).toBe(false)
      if (draft) expect(h.controller.next()).toBe(false)
    }
    expect(h.controller.position()).toEqual({ current: explicit ? 2 : 1, total: 2 })
    expect(h.requests).toHaveLength(1)
    expect(h.controller.take()).toBe(selected)
  }
})

test('empty-composer suggestions survive temporary completion windows until the draft is cleared', async () => {
  for (const explicit of [false, true]) {
    const h = harness()
    if (explicit) h.complete(messages(), '')
    else h.start(messages())
    h.requests[0]!.resolve(['Run the tests', 'Review the diff'])
    await tick()
    if (explicit) h.controller.next()
    h.setDraft('/resume')
    h.setEligible(false)
    h.controller.reconcile()
    expect(h.controller.text()).toBe('')
    expect(h.controller.next()).toBe(false)
    expect(h.controller.dismiss()).toBe(false)
    h.setDraft('/')
    h.controller.reconcile()
    h.setDraft('')
    h.controller.reconcile()
    expect(h.controller.text()).toBe('')
    h.setEligible(true)
    h.controller.reconcile()
    expect(h.controller.text()).toBe(explicit ? 'Review the diff' : 'Run the tests')
    expect(h.controller.position()).toEqual({ current: explicit ? 2 : 1, total: 2 })
    expect(h.requests).toHaveLength(1)
  }
})

test('suspended placeholders are discarded on dismissal, session changes and new runs', async () => {
  for (const invalidate of ['cancel', 'session', 'run'] as const) {
    const h = harness()
    h.start(messages())
    h.requests[0]!.resolve(['Run the tests'])
    await tick()
    h.setDraft('temporary input')
    h.controller.reconcile()
    if (invalidate === 'cancel') h.controller.cancel()
    else if (invalidate === 'session') h.setKey('other session')
    else h.setAutomaticEligible(false)
    h.controller.reconcile()
    h.setDraft('')
    h.setKey('session:1')
    h.setEligible(true)
    h.setAutomaticEligible(true)
    expect(h.controller.text()).toBe('')
  }
})

test('draft-bound completions do not reappear after editing back to their original draft', async () => {
  const h = harness()
  h.setDraft('Run the')
  h.complete(messages(), 'Run the')
  h.requests[0]!.resolve([' tests'])
  await tick()
  h.setDraft('Run something else')
  h.controller.reconcile()
  h.setDraft('Run the')
  expect(h.controller.text()).toBe('')
  h.setDraft('')
  expect(h.controller.text()).toBe('')
})

test('typing cancels transport and late success cannot reappear', async () => {
  const { controller, requests, start } = harness()
  start(messages())
  controller.cancel()
  expect(requests[0]!.aborted).toBe(true)
  requests[0]!.resolve(['\u8fd0\u884c\u6d4b\u8bd5'])
  await tick()
  expect(controller.text()).toBe('')
})

test('session/run changes discard results, including changing back after cancellation', async () => {
  const h = harness()
  h.start(messages())
  h.setKey('other:2')
  h.requests[0]!.resolve(['old result'])
  await tick()
  expect(h.controller.text()).toBe('')
  h.controller.cancel()
  h.setKey('session:1')
  expect(h.controller.text()).toBe('')
})

test('new request cancels the previous one; older completion never overwrites newest', async () => {
  const h = harness()
  h.start(messages())
  h.setKey('session:2')
  h.start(messages())
  expect(h.requests[0]!.aborted).toBe(true)
  h.requests[1]!.resolve(['\u65b0\u7684\u5efa\u8bae'])
  await tick()
  h.requests[0]!.resolve(['\u8fc7\u671f\u5efa\u8bae'])
  await tick()
  expect(h.controller.text()).toBe('\u65b0\u7684\u5efa\u8bae')
})

test('draft, overlay or unavailable capability silently suppresses results', async () => {
  const h = harness()
  h.setEligible(false)
  h.start(messages())
  expect(h.requests).toHaveLength(0)
  h.setEligible(true)
  h.start(messages())
  h.setEligible(false)
  h.requests[0]!.resolve(['\u8fc7\u671f\u5efa\u8bae'])
  await tick()
  h.setEligible(true)
  expect(h.controller.text()).toBe('')
})

test('asynchronous overlays and attachment changes cancel rather than only hiding a result', async () => {
  const h = harness()
  h.start(messages())
  h.setEligible(false)
  h.controller.reconcile()
  expect(h.requests[0]!.aborted).toBe(true)
  h.requests[0]!.resolve(['Run the tests'])
  await tick()
  h.setEligible(true)
  expect(h.controller.text()).toBe('')
})

test('errors, nulls, slash commands and control text are silent', async () => {
  for (const result of [[], [''], ['/new'], ['\u001b[31mtext'], ['first\nsecond'], ['a\u202eb'], null, 'plain string']) {
    const h = harness()
    h.start(messages())
    h.requests[0]!.resolve(result as unknown as string[])
    await tick()
    expect(h.controller.text()).toBe('')
  }
  const h = harness()
  h.start(messages())
  h.requests[0]!.reject(new Error('unavailable'))
  await tick()
  expect(h.controller.text()).toBe('')
})

test('duplicate state notifications and redraws never restart a request, including after silence', async () => {
  const h = harness()
  h.start(messages(), 'resume')
  h.start(messages(), 'resume')
  expect(h.requests).toHaveLength(1)
  h.requests[0]!.resolve([])
  await tick()
  h.start(messages(), 'resume')
  expect(h.requests).toHaveLength(1)
  h.start(messages(), 'mode_changed')
  expect(h.requests).toHaveLength(2)
})

test('first answer is sufficient on resume, mode changes and loop waits', () => {
  for (const trigger of ['answer', 'resume', 'mode_changed', 'loop_waiting'] as const) {
    const h = harness()
    h.start(messages().slice(-2), trigger)
    expect(h.requests).toHaveLength(1)
  }
})

test('busy input never starts an early speculative sample', async () => {
  const h = harness()
  h.setEligible(false)
  h.start(messages())
  expect(h.requests).toHaveLength(0)
  h.setEligible(true)
  h.start(messages())
  h.requests[0]!.resolve(['Run the tests'])
  await tick()
  expect(h.controller.text()).toBe('Run the tests')
})

test('local command allowlist governs both receipt and acceptance without model metadata', async () => {
  const guidance = resolveComposerGuidance({ interaction: resolveRunInteraction({ active: false, owner: null, loopParked: true }), mode: 'plan' })
  let actions = guidance.allowedCommands
  const h = harness({ allowsCommand: text => allowedSuggestionCommand(text, actions) })
  h.start(messages(), 'loop_waiting')
  h.requests[0]!.resolve(['/loop 15m', 'Check the login tests now'])
  await tick()
  expect(h.controller.text()).toBe('/loop 15m')
  expect(h.controller.position()).toEqual({ current: 1, total: 2 })
  actions = []
  // The disallowed action disappears from the cycle; prose remains.
  expect(h.controller.position()).toEqual({ current: 1, total: 1 })
  expect(h.controller.text()).toBe('Check the login tests now')
  expect(h.controller.take()).toBe('Check the login tests now')
  h.setKey('session:2')
  h.start(messages(), 'loop_waiting')
  h.requests[1]!.resolve(['/new'])
  await tick()
  expect(h.controller.text()).toBe('')
})

test('explicit input completion works during task execution and survives retries and completion', async () => {
  const h = harness()
  h.setAutomaticEligible(false)
  h.start(messages())
  expect(h.requests).toHaveLength(0)
  h.setDraft('Cancel the')
  h.complete([messages()[0]!], 'Cancel the')
  expect(h.requests).toHaveLength(1)
  expect(h.controller.pending()).toBe(true)
  for (let i = 0; i < 5; i++) {
    h.controller.cancelAutomatic()
    h.controller.reconcile()
  }
  expect(h.requests[0]!.aborted).toBe(false)
  h.requests[0]!.resolve([' current task', ' remaining steps', ' pending deployment'])
  await tick()
  expect(h.controller.text()).toBe(' current task')
  h.controller.cancelAutomatic()
  h.controller.next()
  expect(h.controller.text()).toBe(' remaining steps')
  h.setAutomaticEligible(true)
  h.start(messages())
  expect(h.requests).toHaveLength(1)
  expect(h.controller.take()).toBe(' remaining steps')
})

test('an explicit empty-composer batch is not replaced when the foreground run finishes', async () => {
  const h = harness()
  h.setAutomaticEligible(false)
  h.complete([messages()[0]!], '')
  h.setAutomaticEligible(true)
  h.start(messages())
  expect(h.requests).toHaveLength(1)
  expect(h.requests[0]!.aborted).toBe(false)
  h.requests[0]!.resolve(['Pause the task', 'Show progress', 'Change the approach'])
  await tick()
  h.start(messages(), 'loop_waiting')
  h.controller.cancelAutomatic()
  h.controller.next()
  expect(h.controller.text()).toBe('Show progress')
  expect(h.requests).toHaveLength(1)
  expect(h.controller.isExplicit()).toBe(true)
})

test('draft Tab joins the initial request, then cycles its suffixes without rejecting them', async () => {
  const h = harness()
  h.setDraft('hi --')
  h.complete(messages().slice(-2), 'hi --')
  for (let i = 0; i < 8; i++) h.controller.next()
  expect(h.requests).toHaveLength(1)
  expect(h.requests[0]!.aborted).toBe(false)
  expect(h.requests[0]!.hints).toMatchObject({ explicit: true, draft: 'hi --', suffix: '' })
  const candidates = [' help me debug this?', ' explain this code', ' review this change']
  h.requests[0]!.resolve(candidates)
  await tick()
  for (let i = 0; i < 16; i++) {
    expect(h.controller.text()).toBe(candidates[i % 3]!)
    expect(h.controller.next()).toBe(true)
  }
  expect(h.requests).toHaveLength(1)
  expect(h.controller.feedback()).toBeUndefined()
  expect(h.controller.take()).toBe(' explain this code')
})

test('Tab while an automatic request is pending promotes its eventual empty result to visible feedback', async () => {
  const h = harness()
  h.start(messages())
  expect(h.controller.pending()).toBe(false)
  h.controller.next()
  expect(h.controller.pending()).toBe(true)
  expect(h.requests).toHaveLength(1)
  h.requests[0]!.resolve([], 'failed')
  await tick()
  expect(h.controller.feedback()).toBe('failed')
  h.controller.next()
  expect(h.requests).toHaveLength(2)
})

test('failed or empty initial requests are retryable until a batch is available', async () => {
  const h = harness()
  h.start(messages())
  for (const status of ['failed', 'timed_out', 'unavailable', 'empty'] as const) {
    h.controller.next()
    h.requests.at(-1)!.resolve([], status)
    await tick()
    expect(h.controller.feedback()).toBe(status === 'empty' ? 'none' : status)
    expect(h.controller.text()).toBe('')
    expect(h.controller.next()).toBe(true)
  }
  expect(h.requests).toHaveLength(5)
  h.requests[4]!.resolve(['Review the diff'])
  await tick()
  for (let i = 0; i < 8; i++) h.controller.next()
  expect(h.controller.text()).toBe('Review the diff')
  expect(h.requests).toHaveLength(5)
})

test('empty initial draft result does not suppress the next explicit request', async () => {
  const h = harness()
  h.setDraft('hi')
  h.complete(messages(), 'hi')
  h.requests[0]!.resolve([])
  await tick()
  expect(h.controller.feedback()).toBe('none')
  h.controller.next()
  expect(h.requests).toHaveLength(2)
  h.requests[1]!.resolve([' there'])
  await tick()
  expect(h.controller.take()).toBe(' there')
})

test('legacy addon strings still work, and synchronous failures stop the spinner', async () => {
  for (const throws of [false, true]) {
    const h = new PromptSuggestion({ key: () => 's', eligible: () => true, context: () => fixtureContext(messages()), draft: () => 'hi', changed: () => {},
      start: () => {
        if (throws) throw new Error('old addon unavailable')
        return { result: async () => ' there', abort: () => {} }
      },
    })
    h.complete('hi')
    await tick()
    expect(h.pending()).toBe(false)
    expect(h.feedback()).toBe(throws ? 'failed' : undefined)
    expect(h.text()).toBe(throws ? '' : ' there')
  }
})

test('live long final replies keep the pending question and latest user request', () => {
  const source = new SuggestionContext()
  source.user('Make suggestions smarter')
  source.observe({ kind: 'assistant_completed', payload: { stop_reason: 'stop', content: [{ type: 'text', text: 'Implementation details\n' + 'x'.repeat(30000) + '\nTab cycles or accepts?' }] } })
  const context = source.snapshot().messages
  expect(context.map(message => message.role)).toEqual(['user', 'assistant'])
  expect(context[0]!.text).toBe('Make suggestions smarter')
  expect(context[1]!.text).toEndWith('Tab cycles or accepts?')
})

test('commands and incomplete context do not start samples', () => {
  const h = harness()
  h.start([...messages().slice(0, 2), { ...messages()[2]!, text: '/sessions \u5c0f\u7ea2\u4e66' }, messages()[3]!])
  h.start([messages()[0]!])
  expect(h.requests).toHaveLength(0)
})
