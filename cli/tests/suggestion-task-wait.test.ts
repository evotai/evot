import { expect, test } from 'bun:test'
import { resolveComposerGuidance } from '../src/term/app/composer-guidance.js'
import { resolveRunInteraction, type RunInteractionInput } from '../src/term/app/run-interaction.js'
import { SuggestionContext, type WorkflowRuntime } from '../src/term/app/suggestion/context.js'
import { PromptSuggestion } from '../src/term/app/suggestion/controller.js'
import { TaskWaitSuggestion } from '../src/term/app/suggestion/task-wait.js'
import type { SuggestionHints } from '../src/native/contracts/suggestion.js'
import type { SuggestionOutcome } from '../src/native/contracts/ports.js'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

function harness(prose = '') {
  const source = new SuggestionContext()
  source.user('Run the benchmark and report the results')
  source.begin()
  source.observe({ kind: 'assistant_completed', payload: { stop_reason: 'toolUse', content: [
    ...(prose ? [{ type: 'text', text: prose }] : []),
    { type: 'tool_call', id: 'wait', name: 'task_output', input: { task_id: 'bench', block: true } },
  ] } })
  source.observe({ kind: 'tool_started', payload: { tool_call_id: 'wait', tool_name: 'task_output' } })
  const input: RunInteractionInput = { active: true, owner: 'run', blockingWaits: 1, backgroundTasks: 1 }
  let mode: 'normal' | 'log' = 'normal'
  let queued = 0
  let draft = ''
  let eligible = true
  let elapsedMinutes = 1
  const interaction = () => resolveRunInteraction(input)
  const policy = () => resolveComposerGuidance({ interaction: interaction(), mode, queuedCount: queued })
  const runtime = (): WorkflowRuntime => ({
    toolWait: input.active === true && interaction().kind === 'waiting-task',
    execution: input.active ? interaction().kind === 'waiting-task' ? 'waiting' : 'running' : input.backgroundTasks ? 'waiting' : 'idle',
    mode, queued, background: input.backgroundTasks ?? 0,
    activities: [{ kind: 'background', id: 'bench', phase: 'running', elapsed_minutes: elapsedMinutes }],
  })
  const requests: { hints?: SuggestionHints; aborted: boolean; resolve(candidates: string[]): void }[] = []
  const controller = new PromptSuggestion({
    key: () => 'session', eligible: () => eligible, automaticEligible: () => policy().allowSuggestion,
    context: () => source.snapshot(runtime()), draft: () => draft, changed: () => {},
    start: (_messages, hints) => {
      let resolve!: (outcome: SuggestionOutcome) => void
      const outcome = new Promise<SuggestionOutcome>(yes => { resolve = yes })
      const request = { hints, aborted: false, resolve: (candidates: string[]) => resolve({ status: candidates.length ? 'ready' : 'empty', candidates }) }
      requests.push(request)
      return { result: async () => (await outcome).candidates[0] ?? null, outcome: () => outcome, abort: () => { request.aborted = true } }
    },
  })
  const wait = new TaskWaitSuggestion(controller)
  return { controller, requests, source, input, runtime,
    poll: () => { wait.sync(interaction().kind === 'waiting-task'); controller.reconcile() },
    setMode: (value: typeof mode) => { mode = value }, setQueued: (value: number) => { queued = value },
    setDraft: (value: string) => { draft = value }, setEligible: (value: boolean) => { eligible = value },
    advanceMinutes: () => { elapsedMinutes++ },
  }
}

test('task_output waits automatically sample unfinished exchanges with or without assistant prose', async () => {
  for (const prose of ['', 'The build is still running; I will wait for its result.']) {
    const h = harness(prose)
    expect(h.source.hasAnswer).toBe(false)
    expect(h.source.snapshot({ ...h.runtime(), execution: 'running', toolWait: false }).automatic).toBe(false)
    h.poll()
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]!.hints?.explicit).toBeUndefined()
    expect(h.requests[0]!.hints).toMatchObject({ activity: 'waiting', workflow: {
      last_turn: 'unfinished', pending_tools: 1, runtime: { execution: 'waiting', background_tasks: 1 },
    } })
    expect(h.source.snapshot(h.runtime()).messages.some(message => message.role === 'assistant')).toBe(Boolean(prose))
    h.requests[0]!.resolve(['Show partial benchmark results'])
    await tick()
    expect(h.controller.text()).toBe('Show partial benchmark results')
  }
})

test('polls and elapsed-minute changes sample once per wait, even after an empty result', async () => {
  for (const candidates of [[], ['Show progress']]) {
    const h = harness()
    h.poll()
    h.requests[0]!.resolve(candidates)
    await tick()
    for (let i = 0; i < 8; i++) { h.advanceMinutes(); h.poll() }
    expect(h.requests).toHaveLength(1)
    h.input.blockingWaits = 0
    h.poll()
    expect(h.controller.text()).toBe('')
    h.input.blockingWaits = 1
    h.poll()
    expect(h.requests).toHaveLength(2)
  }
})

test('leaving a wait aborts speculative work and discards late results', async () => {
  const h = harness()
  h.poll()
  h.input.blockingWaits = 0
  h.poll()
  expect(h.requests[0]!.aborted).toBe(true)
  h.requests[0]!.resolve(['stale result'])
  await tick()
  expect(h.controller.text()).toBe('')
  expect(h.controller.feedback()).toBeUndefined()
})

test('foreground work, queued steering, log mode, overlays and drafts suppress automatic sampling', () => {
  const cases = [
    (h: ReturnType<typeof harness>) => { h.input.foregroundTasks = 1 },
    (h: ReturnType<typeof harness>) => { h.input.blockingWaits = 0 },
    (h: ReturnType<typeof harness>) => h.setQueued(1),
    (h: ReturnType<typeof harness>) => h.setMode('log'),
    (h: ReturnType<typeof harness>) => h.setEligible(false),
    (h: ReturnType<typeof harness>) => h.setDraft('Instead, '),
  ]
  for (const suppress of cases) {
    const h = harness()
    suppress(h)
    h.poll()
    expect(h.requests).toHaveLength(0)
    h.input.foregroundTasks = 0
    h.input.blockingWaits = 1
    h.setQueued(0); h.setMode('normal'); h.setEligible(true); h.setDraft('')
    h.poll()
    expect(h.requests).toHaveLength(1)
  }
})

test('explicit Tab assistance survives both entry into and exit from a task wait', async () => {
  const h = harness()
  h.controller.complete('')
  h.poll()
  expect(h.requests).toHaveLength(1)
  expect(h.requests[0]!.aborted).toBe(false)
  h.input.blockingWaits = 0
  h.poll()
  expect(h.requests[0]!.aborted).toBe(false)
  h.requests[0]!.resolve(['Show partial results'])
  await tick()
  expect(h.controller.isExplicit()).toBe(true)
  expect(h.controller.text()).toBe('Show partial results')
})

test('dismissal is respected for the rest of a wait and Tab-promoted suggestions survive resuming', async () => {
  for (const promote of [false, true]) {
    const h = harness()
    h.poll()
    h.requests[0]!.resolve(['Show progress'])
    await tick()
    if (promote) expect(h.controller.next()).toBe(true)
    else expect(h.controller.dismiss()).toBe(true)
    h.advanceMinutes()
    h.poll()
    expect(h.requests).toHaveLength(1)
    expect(h.controller.text()).toBe(promote ? 'Show progress' : '')
    h.input.blockingWaits = 0
    h.poll()
    expect(h.controller.text()).toBe(promote ? 'Show progress' : '')
  }
})

test('stale pending calls do not qualify when idle background work or a parked loop also reads as waiting', () => {
  const source = new SuggestionContext()
  source.user('Run the benchmark')
  source.observe({ kind: 'assistant_completed', payload: { stop_reason: 'toolUse', content: [
    { type: 'tool_call', id: 'wait', name: 'task_output', input: {} },
  ] } })
  source.interrupt()
  const waiting: WorkflowRuntime = { execution: 'waiting', mode: 'normal', queued: 0, background: 1 }
  expect(source.snapshot(waiting).workflow.pending_tools).toBe(1)
  expect(source.snapshot(waiting).automatic).toBe(false)
  expect(source.snapshot({ ...waiting, toolWait: true }).automatic).toBe(true)
  // The host-only flag never reaches the wire contract.
  expect(JSON.stringify(source.snapshot({ ...waiting, toolWait: true }).workflow)).not.toContain('toolWait')
})

test('leaving a wait withdraws only the wait trigger, not suggestions from other triggers', () => {
  const cancelled: (string | undefined)[] = []
  const starts: string[] = []
  const wait = new TaskWaitSuggestion({
    start: trigger => { starts.push(trigger); return true },
    cancelAutomatic: trigger => { cancelled.push(trigger) },
  })
  wait.sync(false)
  expect(cancelled).toEqual([])
  wait.sync(true)
  wait.sync(true)
  wait.sync(false)
  wait.sync(false)
  expect(starts).toEqual(['task_waiting'])
  expect(cancelled).toEqual(['task_waiting'])

  const h = harness()
  h.input.active = false
  h.input.blockingWaits = 0
  h.source.observe({ kind: 'tool_finished', payload: { tool_call_id: 'wait', tool_name: 'task_output' } })
  h.source.observe({ kind: 'assistant_completed', payload: { stop_reason: 'stop', content: [{ type: 'text', text: 'Done.' }] } })
  h.controller.start('answer')
  h.controller.cancelAutomatic('task_waiting')
  expect(h.requests[0]!.aborted).toBe(false)
  h.controller.cancelAutomatic()
  expect(h.requests[0]!.aborted).toBe(true)
})

test('the first poll after run completion does not cancel a newly generated answer suggestion', async () => {
  const h = harness()
  h.poll()
  h.source.observe({ kind: 'tool_finished', payload: { tool_call_id: 'wait', tool_name: 'task_output' } })
  h.source.observe({ kind: 'assistant_completed', payload: { stop_reason: 'stop', content: [{ type: 'text', text: 'Benchmark complete.' }] } })
  h.input.active = false
  h.input.blockingWaits = 0
  h.input.backgroundTasks = 0
  h.controller.start('answer')
  expect(h.requests).toHaveLength(2)
  h.poll()
  expect(h.requests[1]!.aborted).toBe(false)
  h.requests[1]!.resolve(['Compare with the baseline'])
  await tick()
  expect(h.controller.text()).toBe('Compare with the baseline')
})
