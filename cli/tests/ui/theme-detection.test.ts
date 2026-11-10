import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { parseTerminalControlSequence } from '../../src/ui/keys.js'
import { schemeFromRgbColor } from '../../src/ui/terminal-colors.js'
import { buildOutputBlocks } from '../../src/term/viewmodel/output.js'
import {
  getTheme,
  getThemeScheme,
  resetDetectedThemeScheme,
  setDetectedThemeScheme,
} from '../../src/ui/theme/index.js'

const prevTheme = process.env.EVOT_THEME
const prevColorfgbg = process.env.COLORFGBG

beforeEach(() => {
  delete process.env.EVOT_THEME
  delete process.env.COLORFGBG
  resetDetectedThemeScheme()
})

afterEach(() => {
  if (prevTheme === undefined) delete process.env.EVOT_THEME
  else process.env.EVOT_THEME = prevTheme
  if (prevColorfgbg === undefined) delete process.env.COLORFGBG
  else process.env.COLORFGBG = prevColorfgbg
  resetDetectedThemeScheme()
})

describe('theme detection priority', () => {
  test('EVOT_THEME override wins over detected scheme', () => {
    process.env.EVOT_THEME = 'dark'
    expect(setDetectedThemeScheme('light')).toBe(false)
    expect(getThemeScheme()).toBe('dark')
    // Dark theme headings use the gold accent.
    expect(getTheme().h1.paint('x')).toContain('x')
  })

  test('detected scheme applies when no override is set', () => {
    delete process.env.EVOT_THEME
    delete process.env.COLORFGBG
    expect(setDetectedThemeScheme('light')).toBe(true)
    expect(getThemeScheme()).toBe('light')
    expect(setDetectedThemeScheme('light')).toBe(false)
    expect(setDetectedThemeScheme('dark')).toBe(true)
    expect(getThemeScheme()).toBe('dark')
  })

  for (const [value, scheme] of [
    ['0;15', 'light'], ['0;7', 'light'], ['0;default;15', 'light'],
    ['15;0', 'dark'], ['15;8', 'dark'], ['15;16', 'dark'],
    ['15;232', 'dark'], ['0;15garbage', 'dark'], ['0;', 'dark'],
  ] as const) {
    test(`COLORFGBG=${value} falls back to ${scheme}`, () => {
      process.env.COLORFGBG = value
      expect(getThemeScheme()).toBe(scheme)
    })
  }

  for (const background of ['dark', 'light'] as const) {
    for (const backgroundFirst of [true, false]) {
      test(`issue #44: ${background} background wins over conflicting reports (background first: ${backgroundFirst})`, () => {
        const rgb = background === 'dark' ? '1919/1919/1919' : 'ffff/ffff/ffff'
        const osc = `\x1b]11;rgb:${rgb}\x07`
        const dsr = `\x1b[?997;${background === 'dark' ? 2 : 1}n`
        process.env.COLORFGBG = background === 'dark' ? '0;15' : '15;0'
        getTheme() // Prime the cache with the wrong environment hint.
        for (const sequence of backgroundFirst ? [osc, dsr] : [dsr, osc]) {
          const event = parseTerminalControlSequence(sequence)
          if (event?.type === 'osc11-background') {
            setDetectedThemeScheme(schemeFromRgbColor(event.rgb), event.type)
          } else if (event?.type === 'color-scheme') {
            setDetectedThemeScheme(event.scheme, event.type)
          } else {
            throw new Error('Expected a terminal color response')
          }
        }
        expect(getThemeScheme()).toBe(background)
        const theme = getTheme()
        expect(theme.panelBg).toBe(background === 'dark' ? '#2a2e44' : '#eceef8')
        const blocks = buildOutputBlocks([{ id: 'user', kind: 'user', text: 'star' }])
        const row = blocks.flatMap(block => block.lines).find(line =>
          line.spans.some(span => span.text === 'star'))
        expect(row?.bg).toBe(theme.panelBg)
        expect(row?.spans.find(span => span.text === 'star')?.hex).toBe(theme.panelFg)
      })
    }
  }

  test('background changes replace previous measurements; reports remain a fallback', () => {
    expect(setDetectedThemeScheme('dark', 'osc11-background')).toBe(false)
    const dark = getTheme()
    expect(setDetectedThemeScheme('light', 'color-scheme')).toBe(false)
    expect(getTheme()).toBe(dark)
    expect(setDetectedThemeScheme('light', 'osc11-background')).toBe(true)
    expect(getThemeScheme()).toBe('light')
    expect(setDetectedThemeScheme('dark', 'osc11-background')).toBe(true)
    expect(getThemeScheme()).toBe('dark')
    resetDetectedThemeScheme()
    expect(setDetectedThemeScheme('light', 'color-scheme')).toBe(true)
    expect(getThemeScheme()).toBe('light')
  })

  test('explicit overrides win over both detection sources', () => {
    for (const override of ['light', 'dark'] as const) {
      process.env.EVOT_THEME = override
      const opposite = override === 'light' ? 'dark' : 'light'
      expect(setDetectedThemeScheme(opposite, 'osc11-background')).toBe(false)
      expect(setDetectedThemeScheme(opposite, 'color-scheme')).toBe(false)
      expect(getThemeScheme()).toBe(override)
    }
  })
})
