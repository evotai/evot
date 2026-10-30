import { describe, expect, test } from 'bun:test'
import { promptMode, promptModeLabels, promptModeStyle } from '../src/term/viewmodel/prompt-mode.js'
import { getTheme } from '../src/render/theme/index.js'

describe('promptMode', () => {
  test('defaults when log mode is inactive', () => {
    expect(promptMode({ logMode: false })).toBe('default')
    expect(promptModeLabels({ logMode: false })).toEqual([])
  })

  test('names the forked log conversation', () => {
    expect(promptMode({ logMode: true })).toBe('log')
    expect(promptModeLabels({ logMode: true })).toEqual(['log'])
  })
})

describe('promptModeStyle', () => {
  test('uses the accent for log mode only', () => {
    const { brandHex, accentHex } = getTheme()
    expect(promptModeStyle('default').hex).toBe(brandHex)
    expect(promptModeStyle('log').hex).toBe(accentHex)
  })

  test('every mode carries a short hint that is actually shorter', () => {
    for (const mode of ['default', 'log'] as const) {
      const { hint, shortHint } = promptModeStyle(mode)
      expect(hint.length).toBeGreaterThan(0)
      expect(shortHint.length).toBeGreaterThan(0)
      expect(shortHint.length).toBeLessThanOrEqual(hint.length)
    }
  })

  test('log mode explains how to return to the main conversation', () => {
    expect(promptModeStyle('log').hint).toContain('/done to return')
  })
})
