import { describe, expect, test } from 'bun:test'
import * as r from '../src/native/contracts/results.js'
import { array, boolean, nullable, object, oneOf, text, uint } from '../src/native/contracts/schema.js'
import legacy from './fixtures/contracts/native-results-legacy.json'
import backgroundWithPurpose from './fixtures/contracts/background-with-purpose.json'
import { campaignContent } from '../src/term/app/campaigns.js'
import deniedLegacy from '../../src/app/tests/fixtures/schema/auth-poll-denied-v0.json'
import deniedCurrent from '../../src/app/tests/fixtures/schema/auth-poll-denied-v1.json'

describe('native result contracts', () => {
  test('historical results retain missing fields and opaque content', () => {
    for (const [schema, value] of [
      [r.sessionMeta, legacy.session], [r.queuedPrompt, legacy.queue],
      [r.backgroundProcess, legacy.background], [r.compactionOutcome, legacy.compaction],
      [r.cloudUser, legacy.user], [r.loginCode, legacy.login],
    ] as const) {
      expect(schema.read(value, '$')).toBe(value)
    }
    expect(r.decodeResult(JSON.stringify(legacy.session), r.sessionMeta)).not.toHaveProperty('provider')
    const opaque = { ...legacy.queue, message: { future: [null, false, { input: 12 }] }, extension: true }
    expect(r.decodeResult(JSON.stringify(opaque), r.queuedPrompt)).toEqual(opaque)
    expect(r.decodeResult('[{"future_item":{"anything":[false]}}]', r.transcript)).toEqual([{ future_item: { anything: [false] } }])
  })

  test('user-named session metadata remains compatible with the legacy addon contract', () => {
    const current = { ...legacy.session, schema_version: 1, custom_title: 'Production alerts' }
    expect(r.sessionMeta.read(current, '$')).toBe(current)
    const legacyReader = object({
      session_id: text, cwd: text, model: text, title: nullable(text),
      turns: uint, created_at: text, updated_at: text,
    })
    expect(legacyReader.read(current, '$').title).toBe(legacy.session.title)
    expect(() => r.sessionMeta.read({ ...current, custom_title: 123 }, '$')).toThrow()
  })

  test('session text keeps the legacy shape readable in both directions', () => {
    const old = legacy.sessionWithText
    expect(r.sessionWithText.read(old, '$')).toBe(old)
    expect(old).not.toHaveProperty('first_prompt')
    const current = { ...old, first_prompt: 'fixture ask', changed_paths: ['src/a.ts'] }
    expect(r.sessionWithText.read(current, '$')).toBe(current)
    // The pre-extension reader validates all its published fields and permits
    // additive keys, just like the historical addon result contract.
    const legacyReader = object({
      session_id: text, cwd: text, model: text, title: nullable(text),
      turns: uint, created_at: text, updated_at: text,
      search_text: text, user_prompts: array(text),
    })
    expect(legacyReader.read(current, '$')).toBe(current)
    expect(() => legacyReader.read({ ...current, user_prompts: [3] }, '$')).toThrow()
    expect(() => r.sessionWithText.read({ ...current, changed_paths: [3] }, '$')).toThrow()
  })

  test('background purpose and quiet time are additive across native versions', () => {
    expect(r.backgroundProcess.read(legacy.background, '$')).not.toHaveProperty('description')
    expect(r.backgroundProcess.read(backgroundWithPurpose, '$')).toBe(backgroundWithPurpose)
    const oldReader = object({
      task_id: text, command: text, cwd: text, output_path: text,
      status: oneOf('running_foreground', 'running', 'completed', 'failed', 'killed'),
      exit_code: nullable({ read: (value, path) => {
        if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`Invalid integer at ${path}`)
        return value
      } }),
      elapsed_ms: uint, output_file_truncated: boolean, stopped_by_user: boolean,
    })
    expect(oldReader.read(backgroundWithPurpose, '$')).toBe(backgroundWithPurpose)
    expect(() => r.backgroundProcess.read({ ...backgroundWithPurpose, quiet_for_ms: -1 }, '$')).toThrow('quiet_for_ms')
    expect(() => r.backgroundProcess.read({ ...backgroundWithPurpose, description: 1 }, '$')).toThrow('description')
  })

  test('bad fields fail at their path without private values', () => {
    for (const [schema, value, path] of [
      [r.sessions, [{ ...legacy.session, turns: 'private-token' }], '$[0].turns'],
      [r.queuedPrompt, { ...legacy.queue, version: -1 }, '$.version'],
      [r.backgroundProcess, { ...legacy.background, exit_code: 0.5 }, '$.exit_code'],
      [r.compactionOutcome, { ...legacy.compaction, summary: { secret: 'private-token' } }, '$.summary'],
      [r.variables, [{ key: 'private-token', value: null }], '$[0].value'],
    ] as const) {
      try { schema.read(value, '$'); throw new Error('expected rejection') }
      catch (error) {
        expect(String(error)).toContain(path)
        expect(String(error)).not.toContain('private-token')
      }
    }
    expect(() => r.decodeResult('{"private-token":', r.sessionMeta)).toThrow('Invalid native result at $')
    expect(() => r.decodeResult('[null]', r.transcript)).toThrow('$[0]')
  })

  test('current optional compaction fields and status alternatives are accepted', () => {
    expect(r.compactionOutcome.read({ ...legacy.compaction, method: 'remote', remote_blob_bytes: 12, fallback_reason: 'fixture' }, '$').status).toBe('compacted')
    for (const status of ['nothing_to_compact', 'cancelled']) expect(r.compactionOutcome.read({ status }, '$')).toEqual({ status })
    expect(r.backgroundProcess.read({ ...legacy.background, exit_code: -1 }, '$').exit_code).toBe(-1)
  })

  test('cloud status unions retain extension data and unknown notices are not displayed', () => {
    for (const status of ['pending', 'expired', 'denied']) expect(r.authPoll.read({ status }, '$')).toEqual({ status })
    const success = { status: 'success', state: { user: legacy.user }, models: { future: true } }
    expect(r.authPoll.read(success, '$')).toBe(success)
    expect(r.authRefresh.read({ status: 'login_required', user: null }, '$').user).toBeNull()
    const notices = r.cloudNotices.read([legacy.notice, { ...legacy.notice, kind: 'future' }], '$')
    expect(notices).toHaveLength(2)
    expect(campaignContent(notices)).toHaveLength(1)
  })

  test('denial diagnostics are additive and readable across native versions', () => {
    expect(r.authPoll.read(deniedLegacy, '$')).toBe(deniedLegacy)
    expect(deniedLegacy).not.toHaveProperty('reason_code')
    const legacyDeniedReader = object({ status: oneOf('denied') })
    for (const current of [
      deniedCurrent,
      { status: 'denied', reason: null, reason_code: null },
      { status: 'denied', reason: 'Sign-in refused' },
      { status: 'denied', reason_code: 'future_server_reason' },
    ]) {
      expect(r.authPoll.read(current, '$')).toBe(current)
      expect(legacyDeniedReader.read(current, '$')).toBe(current)
    }
    for (const field of ['reason', 'reason_code']) {
      expect(() => r.authPoll.read({ ...deniedCurrent, [field]: 42 }, '$')).toThrow(`$.${field}`)
    }
  })

  test('native wrappers cannot assert JSON into domain types', async () => {
    for (const file of ['index', 'query-stream']) {
      const source = await Bun.file(new URL(`../src/native/${file}.ts`, import.meta.url)).text()
      expect(source).not.toMatch(/JSON\.parse\([^\n]+\) as /)
      expect(source).not.toMatch(/parseJsonOrThrow\([^\n]+\) as /)
      expect(source).not.toMatch(/:\s*any\b|=\s*any\b/)
    }
  })
})
