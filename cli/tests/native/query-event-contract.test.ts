import { describe, expect, test } from 'bun:test'
import { decodeQueryEvent, isHostToolEvent } from '../../src/native/contracts/query-event.js'
import fixtures from '../fixtures/contracts/query-events.json'

describe('query stream contracts', () => {
  test('run and host events retain their actual published shapes', () => {
    for (const fixture of fixtures) expect(decodeQueryEvent(JSON.stringify(fixture))).toEqual(fixture)
    const host = decodeQueryEvent(JSON.stringify(fixtures[2]))
    expect(isHostToolEvent(host)).toBe(true)
    expect(host).not.toHaveProperty('run_id')
  })

  test('unknown run kinds are forward-readable without changing the envelope', () => {
    const future = { ...fixtures[0], kind: 'future_event', payload: { unknown: 1 } }
    expect(decodeQueryEvent(JSON.stringify(future))).toEqual(future)
  })

  test('invalid run routing fields fail before reaching reducers', () => {
    for (const key of ['event_id', 'run_id', 'session_id', 'turn', 'kind', 'created_at', 'payload']) {
      const value: Record<string, unknown> = { ...fixtures[0] }
      delete value[key]
      expect(() => decodeQueryEvent(JSON.stringify(value))).toThrow(`$.${key}`)
    }
    for (const turn of [-1, 1.5, 2 ** 32, '1']) {
      expect(() => decodeQueryEvent(JSON.stringify({ ...fixtures[0], turn }))).toThrow('$.turn')
    }
  })

  test('host arguments and correlation id are validated without fabricating defaults', () => {
    for (const payload of [{}, { tool_name: 'ask_user', tool_call_id: '', arguments: {} }, { tool_name: 'ask_user', tool_call_id: 'id', arguments: [] }]) {
      expect(() => decodeQueryEvent(JSON.stringify({ kind: 'host_tool_call', payload }))).toThrow('Invalid query event')
    }
  })

  test('malformed JSON and arrays have safe diagnostics', () => {
    expect(() => decodeQueryEvent('{"secret":')).toThrow('Invalid query event at $ (JSON)')
    let caught: unknown
    try { decodeQueryEvent('{"api_key":"fixture-secret"') } catch (error) { caught = error }
    expect(String(caught)).not.toContain('fixture-secret')
    expect(() => decodeQueryEvent('[]')).toThrow('Invalid query event at $')
    expect(() => decodeQueryEvent(JSON.stringify({ ...fixtures[0], payload: null }))).toThrow('$.payload')
  })
})
