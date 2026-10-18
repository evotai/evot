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
