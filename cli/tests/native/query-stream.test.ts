import { describe, expect, test } from 'bun:test'
import { QueryStream, type NativeRun } from '../../src/native/query-stream.js'
import events from '../fixtures/contracts/query-events.json'

function fixture(values = events.map(event => JSON.stringify(event))) {
  let aborts = 0
  const raw: NativeRun = {
    sessionId: 'session', next: async () => values.shift() ?? null, abort: () => { aborts++ },
    steer: () => '{}', followUp: () => '{}', queuedPrompts: () => '[]', updateQueuedPrompt: () => '{}',
    removeQueuedPrompt: () => '{}', sendQueuedPromptNow: () => '{}', moveQueuedPrompt: () => '{}',
    clearQueuedPrompts: () => {}, respondHostTool: async () => {},
  }
  return { raw, stream: new QueryStream(raw), aborts: () => aborts }
}

describe('query stream ownership', () => {
  test('natural completion does not cancel and keeps both event shapes', async () => {
    const f = fixture()
    const received = []
    for await (const event of f.stream) received.push(event)
    expect(received).toEqual(events)
    expect(f.aborts()).toBe(0)
    expect(await f.stream.next()).toBeNull()
  })

  test('early break cancels exactly once', async () => {
    const f = fixture()
    for await (const _event of f.stream) break
    f.stream.abort()
    expect(f.aborts()).toBe(1)
    expect(await f.stream.next()).toBeNull()
  })

  test('consumer failure and malformed events both cancel', async () => {
    const f = fixture()
    await expect((async () => {
      for await (const _event of f.stream) throw new Error('consumer')
    })()).rejects.toThrow('consumer')
    expect(f.aborts()).toBe(1)
    const bad = fixture(['{}'])
    await expect(bad.stream.next()).rejects.toThrow('Invalid query event')
    expect(bad.aborts()).toBe(1)
  })

  test('known malformed payload aborts before delivery to the consumer', async () => {
    const malformed = { ...events[0], kind: 'assistant_delta', payload: { content_index: 0, content_type: 'text', delta: 42 } }
    const f = fixture([JSON.stringify(malformed)])
    await expect(f.stream.next()).rejects.toThrow('$.payload.delta')
    expect(f.aborts()).toBe(1)
    expect(await f.stream.next()).toBeNull()
  })

  test('pending event is discarded if abort wins the race', async () => {
    const f = fixture()
    const pending = Promise.withResolvers<string | null>()
    f.raw.next = () => pending.promise
    const next = f.stream.next()
    f.stream.abort()
    pending.resolve(JSON.stringify(events[0]))
    expect(await next).toBeNull()
    expect(f.aborts()).toBe(1)
  })

  test('queue responses are validated without cancelling or retrying mutations', () => {
    const f = fixture()
    let calls = 0
    f.raw.steer = () => { calls++; return '{"id":"q","version":"private-token","message":{}}' }
    expect(() => f.stream.steer('hello')).toThrow('$.version')
    expect(calls).toBe(1)
    expect(f.aborts()).toBe(0)
    f.raw.queuedPrompts = () => '[{"id":"q","version":1,"message":{"future":[null]}}]'
    expect(f.stream.queuedPrompts('steering')).toEqual([{ id: 'q', version: 1, message: { future: [null] } }])
  })

  test('native read errors cancel before propagating', async () => {
    const f = fixture()
    f.raw.next = async () => { throw new Error('native failure') }
    await expect(f.stream.next()).rejects.toThrow('native failure')
    expect(f.aborts()).toBe(1)
  })
})
