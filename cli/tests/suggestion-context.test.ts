import { expect, test } from 'bun:test'
import { SuggestionContext } from '../src/term/app/suggestion/context.js'
import { COMPACT_SUMMARY_PREFIX } from '../src/term/app/resume.js'

const answer = (text: string, stop_reason = 'stop') => ({ kind: 'assistant_completed', payload: { stop_reason, content: [{ type: 'text', text }] } })

test('one read model retains canonical users and answers without reasoning, tool arguments or notices', () => {
  const source = new SuggestionContext()
  source.user('Fix the tests')
  source.observe({ kind: 'assistant_completed', payload: { stop_reason: 'toolUse', content: [
    { type: 'thinking', text: 'private reasoning' },
    { type: 'tool_call', id: 'tool', name: 'bash', input: { command: 'secret' } },
  ] } })
  expect(source.hasAnswer).toBe(false)
  expect(source.snapshot().messages).toEqual([{ role: 'user', text: 'Fix the tests' }])
  source.observe({ kind: 'tool_finished', payload: { tool_call_id: 'tool' } })
  source.observe(answer('Unit tests or integration tests?'))
  expect(source.hasAnswer).toBe(true)
  expect(source.snapshot().messages).toEqual([
    { role: 'user', text: 'Fix the tests' }, { role: 'assistant', text: 'Unit tests or integration tests?' },
  ])
  expect(source.snapshot().workflow.pending_tools).toBe(0)
})

test('long tool-only tails do not evict the user goal; prose and execution share the same snapshot', () => {
  const source = new SuggestionContext()
  source.restore([{ type: 'user', text: 'Finish the current task' },
    { type: 'assistant', content: [{ type: 'text', text: 'I will make the changes.' }], stop_reason: 'toolUse' },
    ...Array.from({ length: 200 }, (_, i) => ({ type: 'assistant', stop_reason: 'toolUse', content: [
      { type: 'thinking', text: 'private reasoning' }, { type: 'tool_call', id: String(i), name: 'bash', input: { command: 'secret' } },
    ] })),
  ])
  const snapshot = source.snapshot()
  expect(snapshot.messages.map(message => message.text)).toEqual(['Finish the current task', 'I will make the changes.'])
  expect(snapshot.workflow.progress?.calls).toBe(200)
  expect(snapshot.automatic).toBe(true)
})

test('restored and live text retain the latest question within bounds', () => {
  const source = new SuggestionContext()
  source.user('Review the change')
  source.observe(answer('Details\n' + 'x'.repeat(50000) + '\nCommit or revise?'))
  const snapshot = source.snapshot()
  expect(snapshot.messages.at(-1)?.text).toEndWith('Commit or revise?')
  expect(snapshot.messages.at(-1)?.text.length).toBeLessThan(21000)
  source.user('Revise')
  expect(source.hasAnswer).toBe(false)
  expect(source.snapshot().messages.at(-1)?.text).toBe('Revise')
  source.clear()
  expect(source.snapshot().messages).toEqual([])
})

test('compaction replaces only history and does not erase interruption or execution evidence', () => {
  const source = new SuggestionContext()
  source.user('Finish this work')
  source.observe({ kind: 'tool_started', payload: { tool_call_id: 't', tool_name: 'bash', args: { description: 'Run checks' } } })
  source.interrupt()
  const before = source.snapshot().workflow
  source.replaceHistory([{ type: 'user', text: `${COMPACT_SUMMARY_PREFIX} is summarized` }, { type: 'user', text: 'Keep going' }])
  expect(source.snapshot().workflow).toEqual(before)
  expect(source.snapshot().messages).toEqual([{ role: 'user', text: 'Keep going' }])
})

test('explicit user text is not confused with a legacy compaction envelope', () => {
  const source = new SuggestionContext()
  const text = `${COMPACT_SUMMARY_PREFIX} is an example to analyze`
  source.restore([{ type: 'user', text, display_parts: [{ kind: 'user', text }] }])
  expect(source.snapshot().messages).toEqual([{ role: 'user', text }])
})

test('answer boundaries come from the same reducer, not a second event classifier', () => {
  const source = new SuggestionContext()
  source.user('Finish')
  source.observe(answer('Done'))
  expect(source.hasAnswer).toBe(true)
  source.observe({ kind: 'assistant_delta', payload: {} })
  expect(source.hasAnswer).toBe(true)
  source.observe({ kind: 'turn_started', payload: {} })
  expect(source.hasAnswer).toBe(false)
  for (const reason of ['length', 'error', 'toolUse', 'aborted']) {
    source.observe(answer('Partial', reason))
    expect(source.hasAnswer).toBe(false)
  }
  source.observe(answer(''))
  expect(source.hasAnswer).toBe(false)
})

test('closed exchanges form a bounded thread index with outcome, tool and failure counts', () => {
  const source = new SuggestionContext()
  source.user('Add a size limit to the uploader.\n\nSecond paragraph with details that must not appear.')
  source.observe({ kind: 'assistant_completed', payload: { stop_reason: 'toolUse', content: [
    { type: 'tool_call', id: 'a', name: 'edit', input: {} }, { type: 'tool_call', id: 'b', name: 'bash', input: { command: 'secret' } },
  ] } })
  source.observe({ kind: 'tool_finished', payload: { tool_call_id: 'a' } })
  source.observe({ kind: 'tool_finished', payload: { tool_call_id: 'b', is_error: true } })
  source.observe(answer('Added a 50MB limit.\n\nMore prose.'))
  // The open exchange is not in the thread.
  expect(source.snapshot().workflow.thread).toBeUndefined()
  source.user('Show me the diff.')
  source.observe(answer('Here it is.'))
  source.user('Commit it.')
  source.interrupt()
  // A huge latest exchange pushes everything earlier out of the verbatim window,
  // so the thread must carry it.
  source.user('Try again. ' + 'x'.repeat(20_000))
  source.observe(answer('y'.repeat(20_000)))
  const snapshot = source.snapshot()
  expect(snapshot.messages.filter(m => m.role === 'user')).toHaveLength(1)
  const thread = snapshot.workflow.thread
  expect(thread).toEqual([
    { user: 'Add a size limit to the uploader.', assistant: 'Added a 50MB limit.', tools: 2, failed: 1, outcome: 'answered', from: { stage: 'fresh' } },
    { user: 'Show me the diff.', assistant: 'Here it is.', tools: 0, failed: 0, outcome: 'answered', from: { reply: 'Added a 50MB limit.', stage: 'answered' } },
    { user: 'Commit it.', tools: 0, failed: 0, outcome: 'interrupted', from: { reply: 'Here it is.', stage: 'answered' } },
  ])
  expect(JSON.stringify(thread)).not.toContain('secret')
  expect(JSON.stringify(thread)).not.toContain('Second paragraph')
})

test('thread omits exchanges already present verbatim, survives compaction and is bounded', () => {
  const source = new SuggestionContext()
  for (let i = 0; i < 60; i++) { source.user(`Task ${i}`); source.observe(answer(`Done ${i}`)) }
  source.user('Final task')
  source.observe(answer('Final done'))
  const snapshot = source.snapshot()
  const verbatim = snapshot.messages.filter(m => m.role === 'user').map(m => m.text)
  const thread = snapshot.workflow.thread ?? []
  expect(thread.length).toBeGreaterThan(0)
  expect(thread.length).toBeLessThanOrEqual(48)
  expect(thread.at(-1)?.user).not.toBe('Final task')
  expect(thread[0]?.user).toBe('Task 0') // the opening ask is pinned
  for (const exchange of thread) expect(verbatim).not.toContain(exchange.user)
  expect(verbatim).toContain(thread.length ? `Task ${Number(thread.at(-1)!.user.slice(5)) + 1}` : 'Final task')
  // Compaction rewrites prose but keeps the observed history index.
  source.replaceHistory([{ type: 'user', text: `${COMPACT_SUMMARY_PREFIX} is summarized` }, { type: 'user', text: 'Keep going' }])
  expect(source.snapshot().workflow.thread).toEqual(thread.length ? expect.arrayContaining([thread[0]!]) : undefined)
  source.clear()
  expect(source.snapshot().workflow.thread).toBeUndefined()
})

test('restore and live events produce the same thread', () => {
  const live = new SuggestionContext()
  live.user('One'); live.observe(answer('A'))
  live.user('Two'); live.observe({ kind: 'assistant_completed', payload: { stop_reason: 'error', content: [{ type: 'text', text: 'B' }] } })
  live.user('Three'); live.observe(answer('C'))
  live.user('Four')
  const restored = new SuggestionContext()
  restored.restore([
    { type: 'user', text: 'One' }, { type: 'assistant', content: [{ type: 'text', text: 'A' }], stop_reason: 'stop' },
    { type: 'user', text: 'Two' }, { type: 'assistant', content: [{ type: 'text', text: 'B' }], stop_reason: 'error' },
    { type: 'user', text: 'Three' }, { type: 'assistant', content: [{ type: 'text', text: 'C' }], stop_reason: 'stop' },
    { type: 'user', text: 'Four' },
  ], 'active')
  // All of these fit the verbatim window, so the thread adds nothing yet.
  expect(live.snapshot().workflow.thread).toBeUndefined()
  expect(restored.snapshot().workflow).toEqual(live.snapshot().workflow)
})

test('each trajectory step records the state the user moved from', () => {
  const source = new SuggestionContext()
  source.user('One')                                   // from: fresh, no reply
  source.observe(answer('Reply one.\n\nDetails.'))
  source.user('Two')                                   // from: answered after "Reply one."
  source.observe({ kind: 'assistant_completed', payload: { stop_reason: 'error', content: [{ type: 'text', text: 'Partial.' }] } })
  source.user('Three', { execution: 'idle', mode: 'normal', queued: 0, background: 0 })   // from: recovering
  source.observe(answer('Reply three.'))
  source.user('Four', { execution: 'waiting', mode: 'normal', queued: 0, background: 1,
    activities: [{ kind: 'background', id: 'b', phase: 'running', goal: 'build' }] })    // from: background
  source.observe(answer('Reply four.'))
  source.user('Five', { execution: 'waiting', mode: 'normal', queued: 0, background: 0,
    activities: [{ kind: 'loop', id: 'l', phase: 'waiting', goal: 'watch', iteration: 2 }] }) // from: loop
  source.observe(answer('Reply five.'))
  // Push all of the above out of the verbatim window.
  source.user('Six ' + 'x'.repeat(20_000)); source.observe(answer('y'.repeat(20_000)))
  const thread = source.snapshot().workflow.thread ?? []
  expect(thread.map(step => [step.user, step.from])).toEqual([
    ['One', { stage: 'fresh' }],
    ['Two', { reply: 'Reply one.', stage: 'answered' }],
    ['Three', { reply: 'Partial.', stage: 'recovering' }],
    ['Four', { reply: 'Reply three.', stage: 'background' }],
    ['Five', { reply: 'Reply four.', stage: 'loop' }],
  ])
})
