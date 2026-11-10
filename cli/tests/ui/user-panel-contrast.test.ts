import { afterEach, describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import { darkTheme, lightTheme, getTheme, resetThemeCache } from '../../src/ui/theme/index.js'
import { getRgbColorLuminance } from '../../src/ui/terminal-colors.js'
import { buildOutputBlocks } from '../../src/term/viewmodel/output.js'
import { styledLineToAnsi } from '../../src/term/viewmodel/types.js'

const previousTheme = process.env.EVOT_THEME
const previousLevel = chalk.level
afterEach(() => {
  if (previousTheme === undefined) delete process.env.EVOT_THEME
  else process.env.EVOT_THEME = previousTheme
  chalk.level = previousLevel
  resetThemeCache()
})

function luminance(hex: string): number {
  return getRgbColorLuminance({
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  })
}
function contrast(a: string, b: string): number {
  const left = luminance(a)
  const right = luminance(b)
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05)
}

describe('issue #43: user panels own their foreground and background', () => {
  test('both palettes provide readable body and timestamp contrast', () => {
    for (const theme of [darkTheme(), lightTheme()]) {
      expect(contrast(theme.panelFg, theme.panelBg)).toBeGreaterThanOrEqual(7)
      expect(contrast(theme.panelMutedFg, theme.panelBg)).toBeGreaterThanOrEqual(4.5)
    }
  })

  for (const scheme of ['light', 'dark'] as const) {
    test(`${scheme} panel never inherits terminal foreground, including wrapped and multiline input`, () => {
      process.env.EVOT_THEME = scheme
      resetThemeCache()
      chalk.level = 3
      const theme = getTheme()
      for (const columns of [undefined, 18, 80]) {
        const blocks = buildOutputBlocks([
          { id: 'user', kind: 'user', text: 'test message\n中文换行 text\n\nlong text that wraps on narrow terminals', timestamp: 0 },
        ], { columns })
        let textSpans = 0
        let clocks = 0
        for (const block of blocks) {
          for (const row of block.lines) {
            expect(row.bg).toBe(theme.panelBg)
            const rendered = styledLineToAnsi(row)
            for (const span of row.spans) {
              if (!span.text.trim() || span.text === '┃') continue
              if (span.text.startsWith('[')) {
                clocks++
                expect(span.hex).toBe(theme.panelMutedFg)
                expect(span.dim).toBeUndefined()
                expect(rendered).toContain(chalk.hex(theme.panelMutedFg)(span.text))
              } else {
                textSpans++
                expect(span.hex).toBe(theme.panelFg)
                expect(rendered).toContain(chalk.hex(theme.panelFg)(span.text))
              }
            }
          }
        }
        expect(clocks).toBe(1)
        expect(textSpans).toBeGreaterThanOrEqual(3)
      }
    })
  }

  test('unfilled assistant prose still inherits terminal foreground', () => {
    const blocks = buildOutputBlocks([{ id: 'assistant', kind: 'assistant', text: 'Hello' }])
    const row = blocks[0]?.lines[0]
    expect(row?.bg).toBeUndefined()
    expect(row?.spans.find(span => span.text === 'Hello')?.hex).toBeUndefined()
  })
})
