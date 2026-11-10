import { describe, expect, test } from 'bun:test'
import {
  getRgbColorLuminance,
  parseOsc11BackgroundColor,
  parseTerminalColorSchemeReport,
  schemeFromRgbColor,
} from '../../src/ui/terminal-colors.js'

describe('terminal color detection', () => {
  test('parses OSC 11 rgb:RRRR/GGGG/BBBB responses', () => {
    expect(parseOsc11BackgroundColor('\x1b]11;rgb:0000/0000/0000\x07')).toEqual({ r: 0, g: 0, b: 0 })
    expect(parseOsc11BackgroundColor('\x1b]11;rgb:ffff/ffff/ffff\x1b\\')).toEqual({ r: 255, g: 255, b: 255 })
    expect(parseOsc11BackgroundColor('\x1b]11;#112233\x07')).toEqual({ r: 0x11, g: 0x22, b: 0x33 })
  })

  test('rejects malformed OSC 11 responses', () => {
    expect(parseOsc11BackgroundColor('\x1b]11;not-a-color\x07')).toBeUndefined()
    expect(parseOsc11BackgroundColor('\x1b]10;rgb:0000/0000/0000\x07')).toBeUndefined()
  })

  test('parses color-scheme DSR reports', () => {
    expect(parseTerminalColorSchemeReport('\x1b[?997;1n')).toBe('dark')
    expect(parseTerminalColorSchemeReport('\x1b[?997;2n')).toBe('light')
    expect(parseTerminalColorSchemeReport('\x1b[?997;3n')).toBeUndefined()
  })

  test('classifies luminance into dark/light', () => {
    expect(schemeFromRgbColor({ r: 0, g: 0, b: 0 })).toBe('dark')
    expect(schemeFromRgbColor({ r: 255, g: 255, b: 255 })).toBe('light')
    expect(getRgbColorLuminance({ r: 255, g: 255, b: 255 })).toBeGreaterThan(0.5)
  })
})
