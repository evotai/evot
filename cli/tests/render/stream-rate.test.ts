import { expect, test } from 'bun:test'
import { streamTokenRate } from '../../src/render/stream-rate.js'
import { formatLlmCallCompleted } from '../../src/render/verbose.js'

test('rate requires a positive output and a measured window of at least one second', () => {
  for (const ms of [undefined, 0, -1, 100, 999, NaN, Infinity]) {
    expect(streamTokenRate(4000, ms)).toBeUndefined()
  }
  for (const tokens of [0, -1, NaN, Infinity]) {
    expect(streamTokenRate(tokens, 3000)).toBeUndefined()
  }
  expect(streamTokenRate(600, 3000)).toBe(200)
  expect(streamTokenRate(600, 1000)).toBe(600)
})

test('buffered and legacy responses retain duration and usage without fabricated speed', () => {
  for (const streaming_ms of [undefined, 0, 100]) {
    const { text } = formatLlmCallCompleted({
      model: 'test', usage: { output: 4000 },
      metrics: { duration_ms: 139900, ttfb_ms: 16200, streaming_ms },
    })
    expect(text).not.toContain('tok/s')
    expect(text).toContain('4k out')
    expect(text).toContain('[LLM] ✓')
  }
})

test('valid rate is labelled as reception, not generation speed', () => {
  const { text } = formatLlmCallCompleted({
    usage: { output: 600 }, metrics: { duration_ms: 15000, streaming_ms: 3000 },
  })
  expect(text).toContain('200 tok/s (received)')
})
