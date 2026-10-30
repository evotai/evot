import { expect, test } from 'bun:test'
import { SuggestionContext, type WorkflowRuntime } from '../src/term/app/suggestion/context.js'
import { PromptSuggestion } from '../src/term/app/suggestion/controller.js'
import { checklistTasks } from '../src/term/app/suggestion/tasks.js'
import type { TranscriptItem } from '../src/native/contracts/results.js'
import interruptedExecution from './fixtures/suggestion-interrupted-execution.json'
import { SuggestionProgressLedger } from '../src/term/app/suggestion/progress.js'

const idle: WorkflowRuntime = { execution: 'idle', mode: 'normal', background: 0, queued: 0 }
const user = { type: 'user', text: 'Finish the login changes' }
const reply = (text: string, reason = 'stop'): TranscriptItem => ({ type: 'assistant', stop_reason: reason, content: [{ type: 'text', text }] })
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

test('resume replays outcome evidence without treating old workers or turn completion as task completion', () => {
  for (const [reason, expected] of [['aborted', 'interrupted'], ['error', 'failed'], ['length', 'unfinished'], ['stop', 'answered']]) {
    const flow = new SuggestionContext()
    flow.restore([user, reply('- [x] Edit\n- [ ] Test\n- [-] Review', reason)])
    expect(flow.snapshot(idle).workflow).toMatchObject({ session: 'resumed', last_turn: expected, pending_tools: 0,
      runtime: { execution: 'idle', background_tasks: 0 },
      tasks: { pending: 1, in_progress: 1, completed: 1, next: [{ text: 'Test', status: 'pending' }, { text: 'Review', status: 'in_progress' }] },
    })
  }
  const flow = new SuggestionContext()
  flow.restore([user, { type: 'assistant', stop_reason: 'toolUse', content: [
    { type: 'tool_call', id: 'old', name: 'bash', input: { run_in_background: true, command: 'private command' } },
  ] }, { type: 'tool_result', tool_call_id: 'old', content: 'Background task old-process is running' }])
  expect(flow.snapshot(idle).workflow).toMatchObject({ last_turn: 'unfinished', pending_tools: 0, runtime: { background_tasks: 0 } })
  expect(JSON.stringify(flow.snapshot(idle).workflow)).not.toContain('private command')
  expect(JSON.stringify(flow.snapshot(idle).workflow)).not.toContain('old-process')
  flow.restore([user, { type: 'assistant', content_blocks: [{ type: 'text', text: 'Legacy reply without an outcome' }] }])
  expect(flow.snapshot(idle).workflow.last_turn).toBe('unknown')
})

test('live events and replay yield equivalent workflow facts, independent of how the session was entered', () => {
  const live = new SuggestionContext()
  live.user('Finish the login changes')
  live.begin()
  live.observe({ kind: 'assistant_completed', payload: { stop_reason: 'toolUse', content: [
    { type: 'text', text: '- [ ] Validate changes' }, { type: 'tool_call', id: 't', name: 'bash', input: {} },
  ] } })
  live.observe({ kind: 'tool_finished', payload: { tool_call_id: 't', is_error: true } })
  const restored = new SuggestionContext()
  restored.restore([user, { type: 'assistant', stop_reason: 'toolUse', content: [
    { type: 'text', text: '- [ ] Validate changes' }, { type: 'tool_call', id: 't', name: 'bash', input: {} },
  ] }, { type: 'tool_result', tool_call_id: 't', is_error: true }], 'active')
  expect(live.snapshot(idle)).toEqual(restored.snapshot(idle))
  live.interrupt()
  expect(live.snapshot(idle).workflow.last_turn).toBe('interrupted')
  live.user('Finish the login changes')
  expect(live.snapshot(idle).workflow).toMatchObject({ last_turn: 'unfinished', pending_tools: 0 })
  expect(live.snapshot(idle).workflow.tasks).toBeUndefined()
  live.clear()
  expect(live.snapshot(idle).workflow).toMatchObject({ session: 'new', last_turn: 'none' })
})

test('checklists ignore examples and quotes, retain completed counts, and bound labels', () => {
  const tasks = checklistTasks('```markdown\n- [ ] Example\n```\n> - [ ] Quoted\n    - [ ] Code\n- [x] Done\n- [ ] ' + 'x'.repeat(500))
  expect(tasks).toMatchObject({ pending: 1, in_progress: 0, completed: 1 })
  expect(tasks?.next).toEqual([{ text: 'x'.repeat(120), status: 'pending' }])
  expect(checklistTasks('1. Ordinary prose\nNo checklist')).toBeUndefined()
  const flow = new SuggestionContext()
  flow.restore([user, reply('- [ ] Old work'), reply('- [x] Old work')])
  expect(flow.snapshot(idle).workflow.tasks).toMatchObject({ completed: 1, pending: 0, next: [] })
  flow.restore([user, reply('- [ ] Old work'), { type: 'marker', kind: 'clear' }])
  expect(flow.snapshot(idle).workflow.tasks).toBeUndefined()
})

test('execution facts come from the current runtime, not saved task wording', () => {
  const flow = new SuggestionContext()
  flow.restore([user, reply('A worker was running yesterday', 'aborted')])
  expect(flow.snapshot(idle).workflow.runtime.background_tasks).toBe(0)
  const active = flow.snapshot({ ...idle, execution: 'waiting', queued: 2, background: 1 }).workflow
  expect(active.runtime).toEqual({ execution: 'waiting', mode: 'normal', queued_inputs: 2, background_tasks: 1 })
  expect(active.tasks).toBeUndefined()
  expect(flow.snapshot(idle).workflow.tasks).toBeUndefined()
})

test('automatic recovery accepts a trailing user or incomplete tools, while manual draft still wins', async () => {
  for (const items of [[user], [user, reply('Still working', 'aborted')], [user, { type: 'assistant', stop_reason: 'toolUse', content: [{ type: 'tool_call', id: 't', name: 'read', input: {} }] }]]) {
    const flow = new SuggestionContext()
    flow.restore(items)
    const requests: unknown[] = []
    let draft = ''
    const controller = new PromptSuggestion({
      key: () => 'session', eligible: () => true, context: () => flow.snapshot(idle), draft: () => draft, changed: () => {},
      start: (_messages, hints) => { requests.push(hints); return { result: async () => 'Resume remaining work', abort: () => {} } },
    })
    controller.start('resume')
    await tick()
    expect(requests).toHaveLength(1)
    expect(controller.text()).toBe('Resume remaining work')
    controller.cancel()
    draft = 'Instead, review '
    controller.complete(draft)
    expect(requests.at(-1)).toMatchObject({ explicit: true, draft: 'Instead, review ', workflow: { session: 'resumed' } })
  }
})

test('tool-only and reasoning-only execution survives an empty abort without reviving a stale proposal', () => {
  const flow = new SuggestionContext()
  flow.restore(interruptedExecution)
  const facts = flow.snapshot(idle).workflow
  expect(facts).toMatchObject({ last_turn: 'interrupted', pending_tools: 0, progress: {
    calls: 3, executed: 3, completed: 2, failed: 1, since_last_reply: 3, awaiting_input: false,
    recent: [
      { name: 'bash', status: 'completed', description: 'Apply inline crop controls' },
      { name: 'bash', status: 'failed', description: 'Validate crop geometry' },
      { name: 'bash', status: 'completed', description: 'Inspect the remaining layout mismatch' },
    ],
  } })
  const serialized = JSON.stringify(facts)
  expect(serialized).not.toContain('DO_NOT_SEND')
  expect(flow.snapshot(idle).messages.at(-1)?.text).toContain('Shall I implement that?')

  const live = new SuggestionContext()
  for (const item of interruptedExecution as TranscriptItem[]) {
    if (item.type === 'user') live.user('Finish the login changes')
    else if (item.type === 'assistant') live.observe({ kind: 'assistant_completed', payload: { content: item.content, stop_reason: item.stop_reason } })
    else live.observe({ kind: 'tool_finished', payload: item })
  }
  expect(live.snapshot(idle).workflow.progress).toEqual(facts.progress)

  flow.observe({ kind: 'assistant_completed', payload: { stop_reason: 'stop', content: [{ type: 'text', text: 'Tests pass. Review the diff or commit?' }] } })
  expect(flow.snapshot(idle).workflow).toMatchObject({ last_turn: 'answered', progress: { since_last_reply: 0 } })
  flow.user('Finish the login changes')
  expect(flow.snapshot(idle).workflow.progress).toBeUndefined()
})

test('the ledger bounds metadata, deduplicates live events and preserves real input requests', () => {
  const ledger = new SuggestionProgressLedger()
  ledger.reply()
  ledger.call({ id: 'one', name: 'bash', description: 'x'.repeat(500), requiresInput: false })
  ledger.started({ id: 'one', name: 'bash', requiresInput: false })
  ledger.finished('one', 'bash', false)
  ledger.finished('one', 'bash', false)
  expect(ledger.snapshot()).toMatchObject({ calls: 1, executed: 1, completed: 1, since_last_reply: 1 })
  expect(ledger.snapshot()?.recent[0]?.description?.length).toBe(160)
  ledger.reply()
  ledger.call({ id: 'ask', name: 'ask_user', requiresInput: true })
  expect(ledger.snapshot()).toMatchObject({ since_last_reply: 0, awaiting_input: true })
  ledger.finished('ask', 'ask_user', false)
  expect(ledger.snapshot()?.awaiting_input).toBe(false)
  for (let i = 0; i < 1000; i++) ledger.finished(`extra-${i}`, 'read', false)
  expect(ledger.snapshot()?.recent).toHaveLength(6)
  expect(ledger.snapshot()?.completed).toBe(1002)
  expect(JSON.stringify(ledger.snapshot())).not.toContain('DO_NOT_SEND')
  ledger.clear()
  expect(ledger.snapshot()).toBeUndefined()
})

test('late background results do not displace a newer unanswered question', () => {
  const ledger = new SuggestionProgressLedger()
  ledger.reply()
  ledger.call({ id: 'old', name: 'bash', description: 'Earlier work', requiresInput: false })
  ledger.started({ id: 'old', name: 'bash', requiresInput: false })
  ledger.reply()
  ledger.finished('old', 'bash', false)
  expect(ledger.snapshot()?.since_last_reply).toBe(0)
  ledger.call({ id: 'new', name: 'bash', description: 'Later work', requiresInput: false })
  ledger.finished('new', 'bash', false)
  expect(ledger.snapshot()?.since_last_reply).toBe(1)
})

test('a request captures prose and workflow atomically from one snapshot', async () => {
  const source = new SuggestionContext()
  source.user('Finish the tests')
  source.interrupt()
  let reads = 0
  let recorded: unknown
  const controller = new PromptSuggestion({
    key: () => 's', eligible: () => true, changed: () => {},
    context: () => { reads++; return source.snapshot(idle) },
    start: (messages, hints) => {
      recorded = { messages, workflow: hints?.workflow }
      return { result: async () => 'Continue the tests', abort: () => {} }
    },
  })
  controller.start('resume')
  source.user('A different task')
  await tick()
  expect(reads).toBe(1)
  expect(recorded).toMatchObject({ messages: [{ role: 'user', text: 'Finish the tests' }], workflow: { last_turn: 'interrupted' } })
})

test('workflow changes isolate the cache but do not replace a displayed explicit candidate batch', async () => {
  const flow = new SuggestionContext()
  flow.restore([user, reply('Working', 'aborted')])
  let calls = 0
  const controller = new PromptSuggestion({
    key: () => 'same', eligible: () => true, changed: () => {}, context: () => flow.snapshot(idle),
    start: () => { calls++; return { result: async () => 'Next action', abort: () => {} } },
  })
  controller.complete('')
  await tick()
  flow.restore([user, reply('- [x] All work finished')])
  controller.reconcile()
  expect(controller.text()).toBe('Next action')
  controller.cancel()
  controller.complete('')
  await tick()
  expect(calls).toBe(2)
})
