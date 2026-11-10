import { describe, expect, test } from 'bun:test'
import { decodeTaskNativeResult } from '../../src/features/task/native-result.js'

describe('Task native result decoding', () => {
  test('decodes valid JSON results', () => {
    expect(decodeTaskNativeResult<{ ok: boolean }>('{"ok":true}', 'Create task')).toEqual({ ok: true })
  })

  test('preserves native error text instead of masking it as a JSON parse error', () => {
    expect(() => decodeTaskNativeResult('Error: /v1/tasks: invalid schedule', 'Create task'))
      .toThrow('Error: /v1/tasks: invalid schedule')
  })

  test('preserves Error objects and rejects unrelated malformed native output', () => {
    const native = new Error('/v1/tasks: invalid schedule')
    expect(() => decodeTaskNativeResult(native, 'Create task')).toThrow(native.message)
    expect(() => decodeTaskNativeResult('not-json', 'Create task'))
      .toThrow('Create task: invalid native result')
  })
})
