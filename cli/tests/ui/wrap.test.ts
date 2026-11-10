import { describe, test, expect } from 'bun:test'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'
import { wrapTextWithAnsi, sliceVisibleAnsi, splitAnsiIntoCells, truncateAnsiToWidth, visibleGraphemeCount } from '../../src/ui/wrap.js'

// Visible width per wrapped line, measured with the independent string-width
// library so the assertion doesn't depend on wrap.ts's own width logic.
function width(line: string): number {
  return stringWidth(stripAnsi(line))
}

describe('wrapTextWithAnsi', () => {
  test('wraps on word boundaries', () => {
    const lines = wrapTextWithAnsi('the quick brown fox jumps', 10)
    expect(lines).toEqual(['the quick', 'brown fox', 'jumps'])
  })

  test('never exceeds the target width', () => {
    const lines = wrapTextWithAnsi('the quick brown fox jumps over the lazy dog', 12)
    for (const l of lines) expect(width(l)).toBeLessThanOrEqual(12)
  })

  test('breaks a single over-long token by grapheme', () => {
    const lines = wrapTextWithAnsi('a'.repeat(20), 8)
    expect(lines).toEqual(['aaaaaaaa', 'aaaaaaaa', 'aaaa'])
  })

  test('wraps CJK per character and never exceeds width', () => {
    const lines = wrapTextWithAnsi('这是一段很长的中文文本需要换行', 10)
    for (const l of lines) expect(width(l)).toBeLessThanOrEqual(10)
    expect(stripAnsi(lines.join(''))).toBe('这是一段很长的中文文本需要换行')
  })

  test('preserves ANSI color across wrap boundaries', () => {
    const styled = `\x1b[31mhello world this is red text\x1b[39m`
    const lines = wrapTextWithAnsi(styled, 10)
    // Every wrapped line should still carry the red SGR code.
    for (const l of lines) expect(l).toContain('\x1b[31m')
    expect(stripAnsi(lines.join(' '))).toBe('hello world this is red text')
  })

  test('preserves OSC 8 hyperlinks without counting them as width', () => {
    const link = '\x1b]8;;https://example.com\x07clickable link text here\x1b]8;;\x07'
    const lines = wrapTextWithAnsi(link, 10)
    for (const l of lines) expect(width(l)).toBeLessThanOrEqual(10)
    expect(stripAnsi(lines.join(' '))).toContain('clickable link text here')
  })

  test('honors embedded newlines as hard breaks', () => {
    const lines = wrapTextWithAnsi('line one\nline two', 40)
    expect(lines).toEqual(['line one', 'line two'])
  })

  test('handles LF, CRLF, and CR as hard breaks', () => {
    const lines = wrapTextWithAnsi('first\nsecond\r\nthird\rfourth', 40)
    expect(lines).toEqual(['first', 'second', 'third', 'fourth'])
  })

  test('normalizes visible tabs without changing tabs inside control sequences', async () => {
    const { normalizeTerminalOutput } = await import('../../src/ui/wrap.js')
    const control = '\x1b]8;;https://example.test/a\tb\x07'
    expect(normalizeTerminalOutput(`${control}label\ttext`)).toBe(`${control}label   text`)
  })

  test('empty input returns a single empty line', () => {
    expect(wrapTextWithAnsi('', 10)).toEqual([''])
  })

  test('closes underline at line end so it does not bleed', () => {
    const styled = `\x1b[4munderlined text that will wrap onto lines\x1b[24m`
    const lines = wrapTextWithAnsi(styled, 12)
    // All but the last line should emit the underline-off reset.
    for (let i = 0; i < lines.length - 1; i++) {
      expect(lines[i]).toContain('\x1b[24m')
    }
  })
})

describe('sliceVisibleAnsi', () => {
  test('keeps the first n visible graphemes and drops the rest', () => {
    const styled = '\x1b[31mhello world\x1b[39m'
    expect(stripAnsi(sliceVisibleAnsi(styled, 5))).toBe('hello')
    expect(visibleGraphemeCount(sliceVisibleAnsi(styled, 5))).toBe(5)
  })

  test('ignores ANSI when counting graphemes', () => {
    const styled = '\x1b[1m**\x1b[22mabc'
    expect(visibleGraphemeCount(styled)).toBe(5)
    expect(stripAnsi(sliceVisibleAnsi(styled, 2))).toBe('**')
  })
})

describe('truncateAnsiToWidth', () => {
  test('keeps short text unchanged', () => {
    expect(truncateAnsiToWidth('hello', 10)).toBe('hello')
  })

  test('truncates to width with an ellipsis and preserves ANSI', () => {
    const styled = '\x1b[31mhello world this is long\x1b[39m'
    const cut = truncateAnsiToWidth(styled, 10)
    expect(width(cut)).toBeLessThanOrEqual(10)
    expect(stripAnsi(cut)).toBe('hello wor…')
    expect(cut).toContain('\x1b[31m')
  })
})

describe('splitAnsiIntoCells', () => {
  test('one entry per column, so callers can style each cell', () => {
    expect(splitAnsiIntoCells('abc')).toEqual(['a', 'b', 'c'])
    expect(splitAnsiIntoCells('')).toEqual([])
  })

  test('escapes ride the next visible cell rather than becoming cells', () => {
    // Colour state flows through the row in terminal order: nothing re-emits
    // the foreground per cell, so a background fill can wrap each one.
    expect(splitAnsiIntoCells('a\x1b[1mB\x1b[22mc')).toEqual(['a', '\x1b[1mB', '\x1b[22mc'])
  })

  test('wide glyphs get a filler entry so indices stay aligned to columns', () => {
    expect(splitAnsiIntoCells('中x')).toEqual(['中', '', 'x'])
    expect(splitAnsiIntoCells('🎉!')).toEqual(['🎉', '', '!'])
  })

  test('trailing codes attach to the last cell, keeping the count honest', () => {
    const cells = splitAnsiIntoCells('\x1b]8;;https://x\x07link\x1b]8;;\x07')
    expect(cells).toHaveLength(4)
    expect(cells[0]).toBe('\x1b]8;;https://x\x07l')
    expect(cells[3]).toBe('k\x1b]8;;\x07')
  })

  test('cell count matches visible width across mixed content', () => {
    for (const text of ['abc', 'a\x1b[1mB\x1b[22mc', '中文x', 'hi 🎉 ok', '\x1b]8;;u\x07lnk\x1b]8;;\x07']) {
      expect(splitAnsiIntoCells(text)).toHaveLength(width(text))
    }
  })

  test('pure escapes survive as a zero-width entry', () => {
    // Nothing to attach to, and dropping it would lose the colour state.
    expect(splitAnsiIntoCells('\x1b[1m')).toEqual(['\x1b[1m'])
  })
})
