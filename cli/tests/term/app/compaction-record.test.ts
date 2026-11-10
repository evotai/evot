import { describe, expect, test } from 'bun:test'
import { compactRecordFromResult } from '../../../src/term/app/run/compaction-record.js'

describe('compactRecordFromResult', () => {
  test('current Rust compacted result maps to a record', () => {
    expect(compactRecordFromResult({
      type: 'compacted', before_message_count: 10, after_message_count: 4,
      before_tokens: 1000, after_tokens: 200, messages_evicted: 6, current_run_reclaimed: 0,
    }, 5000)).toEqual({ beforeTokens: 1000, afterTokens: 200 })
  })

  test('no_op, retired level shapes and unknown results add no history', () => {
    expect(compactRecordFromResult({ type: 'no_op' }, 5000)).toBeNull()
    expect(compactRecordFromResult({ type: 'level_compacted', level: 2 }, 5000)).toBeNull()
    expect(compactRecordFromResult({ type: 'something_else' }, 5000)).toBeNull()
  })

  test('opaque or malformed results never throw or fabricate numbers', () => {
    for (const value of [undefined, null, 1, 'compacted', [], { type: 42 }]) {
      expect(compactRecordFromResult(value, 5000)).toBeNull()
    }
    expect(compactRecordFromResult({ type: 'compacted', before_tokens: 'many', after_tokens: Number.NaN }, 5000))
      .toEqual({ beforeTokens: 0, afterTokens: 0 })
  })

  test('run_once_cleared derives its range from the current context', () => {
    expect(compactRecordFromResult({ type: 'run_once_cleared', saved_tokens: 40 }, 100))
      .toEqual({ beforeTokens: 100, afterTokens: 60 })
  })
})
