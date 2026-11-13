import { describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import { getTheme, darkTheme, lightTheme } from '../../src/ui/theme/index.js'
import { dim, line, styledLineToAnsi } from '../../src/term/viewmodel/types.js'

describe('semantic muted text token', () => {
  test('both palettes explicitly own secondary interface text', () => {
    expect(darkTheme().mutedHex).toBe('#777777')
    expect(lightTheme().mutedHex).toBe('#777777')
  })

  test('diff hunk metadata has distinct ink and fill in both palettes', () => {
    for (const theme of [darkTheme(), lightTheme()]) {
      expect(theme.diffHeaderFg).not.toBe(theme.diffContextFg)
      expect(theme.diffHeaderFg).not.toBe(theme.diffGutterFg)
      expect(theme.diffHeaderBg).not.toBe(theme.toolCardBg)
      expect(theme.diffHeaderBg).not.toBe(theme.diffAddedBg)
      expect(theme.diffHeaderBg).not.toBe(theme.diffRemovedBg)
    }
  })

  test('span rendering resolves the active token lazily, not a literal color', () => {
    const theme = getTheme()
    const before = theme.mutedHex
    const level = chalk.level
    try {
      chalk.level = 3
      theme.mutedHex = '#123456'
      expect(styledLineToAnsi(line(dim('hint')))).toBe(chalk.hex('#123456')('hint'))
      theme.mutedHex = '#654321'
      expect(styledLineToAnsi(line(dim('hint')))).toBe(chalk.hex('#654321')('hint'))
    } finally {
      theme.mutedHex = before
      chalk.level = level
    }
  })
})
