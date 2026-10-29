/**
 * Terminal background / color-scheme detection helpers.
 *
 * Ported from pi-tui's terminal-colors + coding-agent theme detection:
 *   ~/github/pi/packages/tui/src/terminal-colors.ts
 *   ~/github/pi/packages/coding-agent/src/modes/interactive/theme/theme.ts
 */

export interface RgbColor {
  r: number
  g: number
  b: number
}

export type TerminalColorScheme = 'dark' | 'light'

const OSC11_BACKGROUND_COLOR_RESPONSE_PATTERN = /^\x1b\]11;([^\x07\x1b]*)(?:\x07|\x1b\\)$/i
const COLOR_SCHEME_REPORT_PATTERN = /^\x1b\[\?997;(1|2)n$/

function hexToRgb(hex: string): RgbColor {
  const normalized = hex.startsWith('#') ? hex.slice(1) : hex
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  }
}

function parseOscHexChannel(channel: string): number | undefined {
  if (!/^[0-9a-f]+$/i.test(channel)) return undefined
  const max = 16 ** channel.length - 1
  if (max <= 0) return undefined
  return Math.round((parseInt(channel, 16) / max) * 255)
}

export function parseOsc11BackgroundColor(data: string): RgbColor | undefined {
  const match = data.match(OSC11_BACKGROUND_COLOR_RESPONSE_PATTERN)
  if (!match) return undefined

  const value = match[1]!.trim()
  if (value.startsWith('#')) {
    const hex = value.slice(1)
    if (/^[0-9a-f]{6}$/i.test(hex)) return hexToRgb(value)
    if (/^[0-9a-f]{12}$/i.test(hex)) {
      const r = parseOscHexChannel(hex.slice(0, 4))
      const g = parseOscHexChannel(hex.slice(4, 8))
      const b = parseOscHexChannel(hex.slice(8, 12))
      return r !== undefined && g !== undefined && b !== undefined ? { r, g, b } : undefined
    }
    return undefined
  }

  const rgbValue = value.replace(/^rgba?:/i, '')
  const [red, green, blue] = rgbValue.split('/')
  if (red === undefined || green === undefined || blue === undefined) return undefined
  const r = parseOscHexChannel(red)
  const g = parseOscHexChannel(green)
  const b = parseOscHexChannel(blue)
  return r !== undefined && g !== undefined && b !== undefined ? { r, g, b } : undefined
}

export function parseTerminalColorSchemeReport(data: string): TerminalColorScheme | undefined {
  const match = data.match(COLOR_SCHEME_REPORT_PATTERN)
  if (!match) return undefined
  return match[1] === '2' ? 'light' : 'dark'
}

/** Relative luminance (0–1). Higher = lighter. */
export function getRgbColorLuminance({ r, g, b }: RgbColor): number {
  const toLinear = (channel: number) => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

export function schemeFromRgbColor(rgb: RgbColor): TerminalColorScheme {
  return getRgbColorLuminance(rgb) >= 0.5 ? 'light' : 'dark'
}
