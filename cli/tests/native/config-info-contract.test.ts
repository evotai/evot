import { describe, expect, test } from 'bun:test'
import { decodeConfigInfo } from '../../src/native/contracts/config-info.js'
import legacy from '../fixtures/contracts/config-info-legacy.json'
import current from '../fixtures/contracts/config-info-current.json'
import hookFixture from '../fixtures/contracts/config-info-hook.json'

// Frozen shape from native/index.ts at c922f341. Independent of the production
// decoder so a future field removal/type change cannot update both unnoticed.
function legacyReader(json: string): void {
  const value = JSON.parse(json)
  // Top-level additive-optional fields a c922f341 reader simply ignored.
  const additive = ['judge', 'defaultModel', 'sessionHook']
  expect(Object.keys(value).filter(key => !additive.includes(key)).sort()).toEqual([
    'availableModels', 'baseUrl', 'envPath', 'hasApiKey', 'protocol', 'provider', 'thinkingLevel',
  ])
  if (value.defaultModel !== undefined) expect(typeof value.defaultModel).toBe('string')
  for (const key of ['provider', 'envPath', 'thinkingLevel']) expect(typeof value[key]).toBe('string')
  expect(['anthropic', 'openai', 'openai_responses']).toContain(value.protocol)
  expect(typeof value.hasApiKey).toBe('boolean')
  expect(value.baseUrl === null || typeof value.baseUrl === 'string').toBe(true)
  expect(Array.isArray(value.availableModels)).toBe(true)
  for (const model of value.availableModels) {
    for (const key of ['provider', 'model', 'spec']) expect(typeof model[key]).toBe('string')
    for (const key of Object.keys(model)) {
      expect([
        'provider', 'protocol', 'model', 'spec', 'group_label', 'group_order', 'sort_order',
        // Additive-optional: absent for models with no selectable reasoning, so
        // a reader that predates them sees exactly what it saw before.
        'thinking_levels', 'thinking_level',
        'free',
      ]).toContain(key)
    }
    if (model.thinking_levels !== undefined) {
      expect(Array.isArray(model.thinking_levels)).toBe(true)
      for (const level of model.thinking_levels) expect(typeof level).toBe('string')
      // A published starting tier must be a member of the published ladder;
      // otherwise the picker would have to invent a position for it.
      if (model.thinking_level !== undefined) {
        expect(model.thinking_levels).toContain(model.thinking_level)
      }
    }
    if (model.protocol !== undefined) expect(['anthropic', 'openai', 'openai_responses']).toContain(model.protocol)
    if (model.free !== undefined) {
      for (const key of Object.keys(model.free)) expect(['display_name', 'tagline', 'is_new', 'tier']).toContain(key)
    }
  }
}

describe('ConfigInfo boundary', () => {
  test('session hook is optional, validated, and backward-readable', () => {
    expect(decodeConfigInfo(JSON.stringify(legacy)).sessionHook).toBeUndefined()
    expect(decodeConfigInfo(JSON.stringify(hookFixture))).toEqual(hookFixture)
    legacyReader(JSON.stringify(hookFixture))
    expect(() => decodeConfigInfo(JSON.stringify({ ...legacy, sessionHook: 7 }))).toThrow('$.sessionHook')
  })
  test('legacy optional metadata remains absent, not fabricated', () => {
    const decoded = decodeConfigInfo(JSON.stringify(legacy))
    expect(decoded).toEqual(legacy)
    expect(decoded.availableModels[0]?.protocol).toBeUndefined()
    // A model with no selectable reasoning carries no ladder at all, so the
    // picker shows no effort control rather than an invented one.
    expect(decoded.availableModels[0]?.thinking_levels).toBeUndefined()
    expect(decoded.availableModels[0]?.thinking_level).toBeUndefined()
  })

  test('per-model effort ladders survive the boundary in published order', () => {
    const decoded = decodeConfigInfo(JSON.stringify(current))
    expect(decoded.availableModels[0]?.thinking_levels).toEqual(['off', 'low', 'medium', 'high'])
    expect(decoded.availableModels[0]?.thinking_level).toBe('high')
  })

  test('current shape round trips through a strict historical reader', () => {
    const json = JSON.stringify(current)
    legacyReader(json)
    expect(decodeConfigInfo(json)).toEqual(current)
    expect(decodeConfigInfo(json).defaultModel).toBe('fixture-model')
  })

  test('legacy payloads carry no account default and none is fabricated', () => {
    expect(decodeConfigInfo(JSON.stringify(legacy)).defaultModel).toBeUndefined()
    expect(() => decodeConfigInfo(JSON.stringify({ ...current, defaultModel: 7 }))).toThrow('$.defaultModel')
  })

  test('empty cloud metadata and nullable base URL are valid', () => {
    expect(decodeConfigInfo(JSON.stringify({ ...legacy, baseUrl: null, availableModels: [{ ...legacy.availableModels[0], free: {} }] })).baseUrl).toBeNull()
  })

  test('unknown additive fields are retained', () => {
    const payload = { ...current, future: true }
    expect(decodeConfigInfo(JSON.stringify(payload))).toEqual(payload)
  })

  test('known malformed fields fail with paths, not raw values', () => {
    for (const [payload, path] of [
      [null, '$'],
      [{ ...current, protocol: 'secret-protocol' }, '$.protocol'],
      [{ ...current, hasApiKey: 'secret-value' }, '$.hasApiKey'],
      [{ ...current, availableModels: {} }, '$.availableModels'],
      [{ ...current, availableModels: [null] }, '$.availableModels[0]'],
      [{ ...current, availableModels: [{ ...current.availableModels[0], sort_order: 'secret' }] }, '$.availableModels[0].sort_order'],
      [{ ...current, availableModels: [{ ...current.availableModels[0], free: { is_new: 'secret' } }] }, '$.availableModels[0].free.is_new'],
      [{ ...current, availableModels: [{ ...current.availableModels[0], thinking_levels: 'secret' }] }, '$.availableModels[0].thinking_levels'],
      [{ ...current, availableModels: [{ ...current.availableModels[0], thinking_levels: ['off', 7] }] }, '$.availableModels[0].thinking_levels[1]'],
      [{ ...current, availableModels: [{ ...current.availableModels[0], thinking_level: 7 }] }, '$.availableModels[0].thinking_level'],
    ] as const) {
      expect(() => decodeConfigInfo(JSON.stringify(payload))).toThrow(`Invalid ConfigInfo at ${path}`)
    }
    expect(() => decodeConfigInfo('{"secret-token":')).toThrow('Invalid ConfigInfo at $ (JSON)')
  })

  test('missing required fields fail instead of reaching presentation', () => {
    for (const key of Object.keys(current)) {
      const payload: Record<string, unknown> = { ...current }
      delete payload[key]
      // The account default is additive-optional: absent means "no pin".
      if (key === 'defaultModel') {
        expect(decodeConfigInfo(JSON.stringify(payload)).defaultModel).toBeUndefined()
        continue
      }
      expect(() => decodeConfigInfo(JSON.stringify(payload))).toThrow(`$.${key}`)
    }
  })
})
