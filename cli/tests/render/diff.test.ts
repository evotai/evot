import { beforeAll, describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { applyPatch, parsePatch } from 'diff'
import chalk from 'chalk'
import { formatDiff, colorizeUnifiedDiffRows, parseDiffHunks } from '../../src/render/diff.js'
import { getTheme } from '../../src/ui/theme/index.js'
import stripAnsi from 'strip-ansi'

// Colour assertions below need truecolor SGR; bun test has no TTY.
beforeAll(() => { chalk.level = 3 })

describe('formatDiff', () => {
  test('detects added lines', () => {
    const result = formatDiff('a\nb\n', 'a\nb\nc\n')
    expect(result.linesAdded).toBe(1)
    expect(result.linesRemoved).toBe(0)
    const plain = stripAnsi(result.text)
    expect(plain).toContain('+c')
  })

  test('detects removed lines', () => {
    const result = formatDiff('a\nb\nc\n', 'a\nc\n')
    expect(result.linesRemoved).toBe(1)
    const plain = stripAnsi(result.text)
    expect(plain).toContain('-b')
  })

  test('detects changed lines', () => {
    const result = formatDiff('hello\n', 'world\n')
    expect(result.linesAdded).toBe(1)
    expect(result.linesRemoved).toBe(1)
    const plain = stripAnsi(result.text)
    expect(plain).toContain('-hello')
    expect(plain).toContain('+world')
  })

  test('returns empty for identical text', () => {
    const result = formatDiff('same\n', 'same\n')
    expect(result.linesAdded).toBe(0)
    expect(result.linesRemoved).toBe(0)
  })

  test('shows line numbers', () => {
    const result = formatDiff('a\nb\n', 'a\nc\n')
    const plain = stripAnsi(result.text)
    // Line 2 should appear as a number in the gutter
    expect(plain).toMatch(/2\s*[-+]/)
  })

  test('shows ellipsis between hunks', () => {
    // Create a diff with two separate hunks (changes far apart)
    const oldLines = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n') + '\n'
    const newLines = oldLines.replace('line1', 'changed1').replace('line18', 'changed18')
    const result = formatDiff(oldLines, newLines)
    const plain = stripAnsi(result.text)
    expect(plain).toContain('…')
  })
})

describe('hunk sections', () => {
  test('engine fixture is readable by the CLI and strict standard patch readers', () => {
    const patch = readFileSync(new URL('../../../src/engine/tests/fixtures/diff/function.patch', import.meta.url), 'utf8')
    expect(parseDiffHunks(patch)[0]?.section).toBe('fn load() {')
    expect(parsePatch(patch, { strict: true })).toHaveLength(1)
    expect(applyPatch('fn load() {\n    old();\n}\n', patch)).toBe('fn load() {\n    new();\n}\n')
  })

  test('reads legacy bare headers and GitHub-style function headings', () => {
    const hunks = parseDiffHunks('@@ -1 +1 @@\n-old\n+new\n@@ -20,2 +20,2 @@ async fn load() -> Result<()> {\n ctx\n-old\n+new')
    expect(hunks[0]).toEqual({ oldStart: 1, newStart: 1, oldLines: 1, newLines: 1, lines: ['-old', '+new'] })
    expect(hunks[1]?.section).toBe('async fn load() -> Result<()> {')
    expect(hunks[1]?.lines).toEqual([' ctx', '-old', '+new'])
  })

  test('renders the heading once, before the code, without counting it as code', () => {
    const rows = colorizeUnifiedDiffRows('@@ -8 +8 @@ fn load() {\n-old\n+new')
    expect(rows.map(row => row.kind)).toEqual(['header', 'remove', 'add'])
    expect(stripAnsi(rows[0]!.text)).toBe('  @@ -8,1 +8,1 @@ fn load() {')
    expect(rows[0]!.text).toBe(chalk.hex(getTheme().diffHeaderFg)('  @@ -8,1 +8,1 @@ fn load() {'))
    expect(rows[0]!.gutter).toBeUndefined()
    expect(rows[0]!.code).toBeUndefined()
    expect(stripAnsi(rows[1]!.text)).toMatch(/^8 -old$/)
  })

  test('keeps partial streaming hunks and removes terminal controls from headings', () => {
    const patch = '@@ -8,2 +8,2 @@ \x1b[31mfn load() {\x1b[0m\x07\r\n-old'
    expect(parseDiffHunks(patch)[0]?.section).toBe('fn load() {')
    expect(colorizeUnifiedDiffRows(patch).map(row => row.kind)).toEqual(['header', 'remove'])
    expect(parseDiffHunks('@@ -1 +1 @@   \n-old')[0]?.section).toBeUndefined()
  })
})

describe('word-level diff', () => {
  test('highlights changed words within a line', () => {
    const result = formatDiff(
      'function oldName(param) {\n',
      'function newName(param) {\n',
    )
    // The output should contain both the old and new function names
    const plain = stripAnsi(result.text)
    expect(plain).toContain('oldName')
    expect(plain).toContain('newName')
    // Should have add and remove lines
    expect(result.linesAdded).toBe(1)
    expect(result.linesRemoved).toBe(1)
  })

  test('falls back to line-level for large changes', () => {
    // Completely different lines should not use word-level diff
    const result = formatDiff(
      'completely different content here\n',
      'nothing similar at all whatsoever\n',
    )
    expect(result.linesAdded).toBe(1)
    expect(result.linesRemoved).toBe(1)
  })
})

/** Truecolor background SGR chalk emits for a theme hex, at level 3. */
function bgSgr(hex: string): string {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
  return `\x1b[48;2;${r};${g};${b}m`
}

describe('diff row styling', () => {
  test('changed tokens carry their own fill instead of inverse video', () => {
    const theme = getTheme()
    const result = formatDiff('function oldName(param) {\n', 'function newName(param) {\n')

    // Inverse (SGR 7) flips to the terminal's own palette and tears a bright
    // hole through the card fill. Zed gives changed tokens a fill instead.
    expect(result.text).not.toContain('\x1b[7m')
    expect(result.text).toContain(bgSgr(theme.diffAddedWordBg))
    expect(result.text).toContain(bgSgr(theme.diffRemovedWordBg))
  })

  test('a whole-line change gets row ink but no word fill', () => {
    const theme = getTheme()
    // Past WORD_DIFF_THRESHOLD, so there is nothing meaningful to fill.
    const result = formatDiff('completely different here\n', 'nothing similar at all\n')
    expect(result.text).not.toContain(bgSgr(theme.diffAddedWordBg))
    expect(result.text).not.toContain(bgSgr(theme.diffRemovedWordBg))
  })

  test('the sigil stays contiguous with its code under strip-ansi', () => {
    // Card rendering asserts on the diff body as plain text, so escapes must not
    // land between the marker and the line it marks.
    const rows = colorizeUnifiedDiffRows('@@ -1,2 +1,2 @@\n line1\n-removed line\n+added line')
    const plain = rows.map(row => stripAnsi(row.text)).join('\n')
    expect(plain).toContain('-removed line')
    expect(plain).toContain('+added line')
  })
})

describe('gutter width', () => {
  // Two hunks straddling a digit boundary: hunk 1 needs one column, hunk 2 needs
  // two. Sizing per hunk jogs the columns mid-patch (`3 ` then `30 `).
  const twoHunks = [
    '@@ -1,4 +1,4 @@', ' line1', '-old2', '+new2', ' line3', ' line4',
    '@@ -30,3 +30,3 @@', ' line30', '-old31', '+new31', ' line32',
  ].join('\n')

  test('one patch keeps one gutter width across every hunk', () => {
    const widths = new Set(
      colorizeUnifiedDiffRows(twoHunks)
        .filter(row => row.kind !== 'ellipsis')
        .map(row => stripAnsi(row.text).match(/^(\s*\d+) /)?.[1]?.length),
    )
    expect(widths.size).toBe(1)
    expect([...widths][0]).toBe(2)
  })

  test('minGutter floors the width without shrinking a wider patch', () => {
    const wide = colorizeUnifiedDiffRows(twoHunks, true, 4)
      .filter(row => row.kind !== 'ellipsis')
      .map(row => stripAnsi(row.text).match(/^(\s*\d+) /)?.[1]?.length)
    expect(new Set(wide).size).toBe(1)
    expect(wide[0]).toBe(4)
  })

  test('formatDiff sizes its gutter across the whole patch too', () => {
    const base = Array.from({ length: 40 }, (_, index) => `line ${index}`)
    const next = [...base]
    next[2] = 'changed early'
    next[33] = 'changed late'
    const plain = stripAnsi(formatDiff(base.join('\n') + '\n', next.join('\n') + '\n').text)
    const widths = new Set(
      plain.split('\n')
        .map(row => row.match(/^(\s*\d+) /)?.[1]?.length)
        .filter((width): width is number => width !== undefined),
    )
    expect(widths.size).toBe(1)
  })
})

