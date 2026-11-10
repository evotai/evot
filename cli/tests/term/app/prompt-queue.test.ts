import { expect, test } from 'bun:test'
import { queueEntryText, readPromptQueues, visibleQueueEntries, reconcilePromptQueue, type QueuedUserMessage } from '../../../src/term/app/queue/prompt-queue.js'

const entry = (id: string): QueuedUserMessage => ({ id, version: 1, message: { content: [{ type: 'text', text: `expanded ${id}` }] }, text: `visible ${id}`, queue: 'steering' })

test('opaque tool-owned queue content is narrowed without assertions', () => {
  for (const content of [null, false, 1, 'text', {}, [null, false, 1, {}, { type: 'text', text: 3 }]]) {
    expect(queueEntryText({ ...entry('a'), message: { content } })).toBe('(non-text prompt)')
  }
  expect(queueEntryText({ ...entry('a'), message: { content: [{ type: 'image' }, { type: 'text', text: ' one ' }, { type: 'text', text: 'two' }] } })).toBe('one \ntwo')
})

test('both queues share a projection but local display text wins', () => {
  const snapshot = readPromptQueues({ queuedPrompts: queue => [entry(queue)] })
  expect(snapshot.map(item => item.queue)).toEqual(['steering', 'follow_up'])
  const shown = visibleQueueEntries(snapshot, [entry('steering')])
  expect(shown.map(item => item.text)).toEqual(['visible steering', 'expanded follow_up'])
  expect(snapshot[0]?.text).toBe('expanded steering')
})

test('consumed messages are partitioned exactly once in submission order', () => {
  const visible = [entry('a'), entry('b'), entry('c')]
  const snapshot = readPromptQueues({ queuedPrompts: queue => queue === 'follow_up' ? [entry('b')] : [] })
  const result = reconcilePromptQueue(snapshot, visible)
  expect(result.consumed.map(item => item.id)).toEqual(['a', 'c'])
  expect(result.remaining.map(item => item.id)).toEqual(['b'])
  expect(reconcilePromptQueue(snapshot, result.remaining).consumed).toEqual([])
  expect(visible).toHaveLength(3)
})

test('partial native read failure is never treated as queue exhaustion', () => {
  expect(() => readPromptQueues({ queuedPrompts: queue => {
    if (queue === 'follow_up') throw new Error('read failed')
    return []
  } })).toThrow('read failed')
})
