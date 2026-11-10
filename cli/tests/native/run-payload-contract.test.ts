import { describe, expect, test } from 'bun:test'
import { decodeQueryEvent, isHostToolEvent, isKnownRunEvent } from '../../src/native/contracts/query-event.js'
import { runPayloadSchemas } from '../../src/native/contracts/run-payload.js'
import { object, oneOf } from '../../src/native/contracts/schema.js'
import compactionProgress from '../fixtures/contracts/compaction-progress.json'
import rich from '../fixtures/contracts/run-payloads-rich.json'
import current from '../fixtures/contracts/run-payloads-current.json'
import fixtures from '../fixtures/contracts/run-payloads.json'

const envelope = { event_id: 'e', run_id: 'r', session_id: 's', turn: 1, created_at: '2026-01-01T00:00:00Z' }
function decode(kind: string, payload: unknown) {
  return decodeQueryEvent(JSON.stringify({ ...envelope, kind, payload }))
}

describe('known run payload contracts', () => {
  test('all Rust event kinds have a fixture and a reader', () => {
    expect([...new Set(fixtures.map(f => f.kind))].sort()).toEqual(Object.keys(runPayloadSchemas).sort())
    for (const fixture of [...fixtures, ...current, ...rich]) expect(decode(fixture.kind, fixture.payload)).toEqual({ ...envelope, ...fixture })
  })

  test('compaction activity is additive and retains the legacy phase vocabulary', () => {
    const legacyReader = object({ phase: oneOf('pruning', 'planning', 'remote', 'local_fallback', 'local', 'complete') })
    const historical = fixtures.find(f => f.kind === 'context_compaction_phase')!
    expect(decode(historical.kind, historical.payload).payload).not.toHaveProperty('activity')
    for (const fixture of compactionProgress) {
      const written = decode(fixture.kind, fixture.payload).payload
      expect(written).toEqual(fixture.payload)
      expect(legacyReader.read(written, '$')).toEqual(fixture.payload)
    }
    expect(() => decode('context_compaction_phase', { phase: 'local', activity: 'invalid' })).toThrow('$.payload.activity')
  })

  test('the discriminated payload follows the event kind', () => {
    const event = decode('assistant_delta', { content_index: 0, content_type: 'thinking', delta: 'text' })
    if (isHostToolEvent(event) || !isKnownRunEvent(event)) throw new Error('expected known run event')
    if (event.kind === 'assistant_delta') {
      const text: string = event.payload.delta
      const index: number = event.payload.content_index
      expect([text, index]).toEqual(['text', 0])
    }
  })

  test('malformed known payloads fail with field paths only', () => {
    const cases: Array<[string, unknown, string]> = [
      ['assistant_delta', { content_index: -1, content_type: 'text', delta: 'secret' }, 'content_index'],
      ['assistant_delta', { content_index: 0, content_type: 'invalid', delta: 'secret' }, 'content_type'],
      ['assistant_delta', { content_index: 0, content_type: 'text', delta: [] }, 'delta'],
      ['assistant_completed', { content: [null], stop_reason: 'stop' }, 'content[0]'],
      ['assistant_completed', { content: [{ type: 'text', text: {} }], stop_reason: 'stop' }, 'content[0].text'],
      ['tool_finished', { tool_call_id: 'id', tool_name: 'bash', content: 'secret', is_error: 'false' }, 'is_error'],
      ['llm_call_completed', { turn: 1, attempt: 0, usage: { input: '5', output: 3 } }, 'usage.input'],
      ['context_compaction_completed', { reason: 'manual', result: { type: 'compacted' } }, 'result.before_message_count'],
      ['error', { message: { secret: 'value' } }, 'message'],
    ]
    for (const [kind, payload, path] of cases) expect(() => decode(kind, payload)).toThrow(`Invalid query event at $.payload.${path}`)
  })

  test('optional defaults stay absent and tool JSON is not constrained to objects', () => {
    const payload = { tool_call_id: 'id', tool_name: 'custom', content: '', is_error: false, details: ['opaque', null] }
    const event = decode('tool_finished', payload)
    expect(event.payload).toEqual(payload)
    expect(event.payload).not.toHaveProperty('duration_ms')
    expect(() => decode('tool_started', { tool_call_id: 'id', tool_name: 'custom', args: false })).not.toThrow()
  })

  test('unknown kinds pass through and cannot borrow prototype schema names', () => {
    for (const kind of ['future_event', 'constructor', '__proto__']) {
      const event = decode(kind, { future: true })
      expect(event.payload).toEqual({ future: true })
      expect(isHostToolEvent(event)).toBe(false)
      if (!isHostToolEvent(event)) expect(isKnownRunEvent(event)).toBe(false)
    }
  })

  test('nested stats, metrics and history reject malformed known fields', () => {
    const start = rich[0]!
    const completed = rich[1]!
    const finished = rich[3]!
    expect(() => decode(start.kind, { ...start.payload, message_stats: { ...start.payload.message_stats, tool_details: [['bash', 'five']] } })).toThrow('$.payload.message_stats.tool_details[0][1]')
    expect(() => decode(completed.kind, { ...completed.payload, metrics: { ...completed.payload.metrics, streaming_ms: -1 } })).toThrow('$.payload.metrics.streaming_ms')
    expect(() => decode(finished.kind, { ...finished.payload, compact_history: [{ level: 3, from_tokens: 10, to_tokens: 1, action_map: [] }] })).toThrow('$.payload.compact_history[0].action_map')
  })

  test('optional nullable fields accept null while numeric defaults reject null', () => {
    expect(() => decode('assistant_completed', { content: [], stop_reason: 'stop', usage: null, error_message: null })).not.toThrow()
    expect(() => decode('tool_finished', { tool_call_id: 'id', tool_name: 'bash', content: '', is_error: false, duration_ms: null })).toThrow('duration_ms')
  })
})
