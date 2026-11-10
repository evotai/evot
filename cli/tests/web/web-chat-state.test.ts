import { expect, test } from 'bun:test'
import { ChatStreamState } from '../../../src/app/assets/console/ui/chat-stream-state.js'
import { ChatState } from '../../../src/app/assets/console/ui/chat-state.js'

test('streamed content keeps block order and resets across compaction', () => {
  const state = new ChatStreamState()
  state.delta({ content_index: 0, blocks: [{ kind: 'thinking', text: 'reason' }] })
  state.delta({ content_index: 1, blocks: [{ kind: 'text', text: 'answer' }] })
  state.delta({ content_index: 1, blocks: [{ kind: 'text', text: ' more' }] })
  expect([...state.buffers]).toEqual([['thinking:0', 'reason'], ['text:1', 'answer more']])
  state.settle({ stop_reason: 'aborted' })
  expect(state.buffers.size).toBe(0)
  expect(state.acceptTail({ status: 'run', stop_reason: 'stop' })).toBe(false)
  state.resetAssistant()
  expect(state.acceptTail({ status: 'run', stop_reason: 'stop' })).toBe(true)
  expect(state.delta({})).toBe(false)
})

test('inactive steering responses do not overwrite a draft or newer conversation', () => {
  const state = new ChatState()
  const run = state.begin('session')
  const generation = state.generation
  expect(state.canRestoreSubmission(generation, '')).toBe(true)
  expect(state.canRestoreSubmission(generation, 'new draft')).toBe(false)
  state.finish(run)
  expect(state.canRestoreSubmission(generation, '')).toBe(true)
  state.beginNavigation()
  expect(state.canRestoreSubmission(generation, '')).toBe(false)
})

test('run identity owns stop and late completion cannot reset a newer run', () => {
  const state = new ChatState()
  const first = state.begin(null)
  if (!first) throw new Error('missing run')
  expect(state.begin('overlap')).toBeNull()
  state.bind('session')
  expect(state.sessionId).toBe('session')
  expect(state.requestStop()).toBe(first)
  expect(state.requestStop()).toBeNull()
  expect(state.stopping).toBe(true)
  expect(state.finish(first)).toBe(true)
  const next = state.begin('new')
  first.controller.abort()
  expect(next?.controller.signal.aborted).toBe(false)
  expect(state.finish(first)).toBe(false)
  expect(state.streaming).toBe(true)
})

test('late session reads cannot override newer navigation or live execution', () => {
  const state = new ChatState()
  const first = state.beginNavigation()
  const second = state.beginNavigation()
  expect(state.ownsNavigation(first)).toBe(false)
  expect(state.ownsNavigation(second)).toBe(true)
  state.invalidateNavigation()
  expect(state.ownsNavigation(second)).toBe(false)
  const third = state.beginNavigation()
  state.begin('session')
  expect(state.ownsNavigation(third)).toBe(false)
  expect(state.beginNavigation()).toBeNull()
})
