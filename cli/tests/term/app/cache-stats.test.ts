import { describe, test, expect } from 'bun:test'
import { formatCacheHitPercent } from '../../../src/render/cache.js'
import { applyEvent } from '../../../src/term/app/run/reducer.js'
import { createInitialState, type AppState } from '../../../src/term/app/run/state.js'
import type { RunEvent } from '../../../src/native/index.js'

// ---------------------------------------------------------------------------
// formatCacheHitPercent
// ---------------------------------------------------------------------------

describe('formatCacheHitPercent', () => {
  test('zero prompt or zero read shows 0', () => {
    expect(formatCacheHitPercent(0, 0, 0)).toBe('0')
    expect(formatCacheHitPercent(5000, 0, 1000)).toBe('0')
  })

  test('integer percent below 99', () => {
    expect(formatCacheHitPercent(408_000, 89_000, 0)).toBe('18')
    expect(formatCacheHitPercent(10_000, 80_000, 10_000)).toBe('80')
  })

  test('one decimal in [99, 100) so a near-hit is not rounded to 100', () => {
    // 200000 / 200504 = 99.7487…% — Math.round would show a fake 100%.
    expect(formatCacheHitPercent(4, 200_000, 500)).toBe('99.7')
    // 200000 / 200004 = 99.998% — still not a full hit.
    expect(formatCacheHitPercent(4, 200_000, 0)).toBe('99.9')
  })

  test('100 only when every billed prompt token was a cache read', () => {
    expect(formatCacheHitPercent(0, 150_000, 0)).toBe('100')
  })
})

// ---------------------------------------------------------------------------
// Reducer token accounting
// ---------------------------------------------------------------------------

function llmCompleted(usage: { input: number; cache_read: number; cache_write: number; output?: number }): RunEvent {
  return {
    kind: 'llm_call_completed',
    session_id: 's',
    event_id: 'e',
    turn: 1,
    payload: { model: 'claude-fable-5', usage: { output: 100, ...usage } },
  } as unknown as RunEvent
}

describe('reducer token accounting', () => {
  test('accumulates disjoint usage buckets into session totals', () => {
    let state: AppState = createInitialState('claude-fable-5', '/tmp')
    state = applyEvent(state, llmCompleted({ input: 10_000, cache_read: 0, cache_write: 40_000 }))
    expect(state.sessionTokens.cacheWriteTokens).toBe(40_000)
    expect(state.sessionTokens.inputTokens).toBe(10_000)

    state = applyEvent(state, llmCompleted({ input: 4, cache_read: 50_000, cache_write: 900 }))
    expect(state.sessionTokens.cacheWriteTokens).toBe(40_900)
    expect(state.sessionTokens.cacheReadTokens).toBe(50_000)
  })

  test('a re-billed prompt is accounted without a transcript notice', () => {
    let state: AppState = createInitialState('claude-fable-5', '/tmp')
    state = applyEvent(state, llmCompleted({ input: 4, cache_read: 100_000, cache_write: 900 }))
    state = applyEvent(state, llmCompleted({ input: 4, cache_read: 0, cache_write: 101_000 }))
    expect(state.verboseEvents.some(e => e.text.includes('cache miss'))).toBe(false)
    expect(state.verboseEvents.some(e => e.text.includes('re-billed'))).toBe(false)
  })
})
