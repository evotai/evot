import { describe, test, expect } from 'bun:test'
import stripAnsi from 'strip-ansi'
import { buildOverlayBlocks } from '../../../src/term/viewmodel/overlays.js'
import { blocksToLines } from '../../../src/term/viewmodel/types.js'

/**
 * The help panel is a two-column table. Its readability depends on every
 * command starting in the same column and every description starting in the
 * same column, with only the title and footer centred.
 */
function helpRows(columns = 80): string[] {
  return blocksToLines(buildOverlayBlocks({ kind: 'help' }, columns)).map(stripAnsi)
}

/** Rows listing a command or key binding: everything but title, section
 *  labels, footer and blanks. */
function entryRows(rows: string[]): string[] {
  return rows.filter(row => /^\s{2}\S/.test(row) && !/^\s{2}(Keys|Commands)$/.test(row) && !row.includes('esc close'))
}

function descColumn(row: string): number {
  const afterKey = row.slice(2).search(/\s\s+\S/)
  const gapStart = 2 + afterKey + 1
  return gapStart + row.slice(gapStart).search(/\S/)
}

describe('help overlay layout', () => {
  test('commands all start in the same column', () => {
    const entries = entryRows(helpRows())
    expect(entries.length).toBeGreaterThan(10)
    const indents = new Set(entries.map(row => row.length - row.trimStart().length))
    expect([...indents]).toEqual([2])
  })

  test('descriptions share one column within each section', () => {
    const rows = helpRows()
    const keys = rows.indexOf('  Keys')
    const commands = rows.indexOf('  Commands')
    expect(keys).toBeGreaterThan(0)
    expect(commands).toBeGreaterThan(keys)
    const keyEntries = entryRows(rows.slice(keys, commands))
    const commandEntries = entryRows(rows.slice(commands))
    expect(keyEntries.length).toBeGreaterThan(10)
    expect(commandEntries.length).toBeGreaterThan(10)
    expect(new Set(keyEntries.map(descColumn)).size).toBe(1)
    expect(new Set(commandEntries.map(descColumn)).size).toBe(1)
    // The long `/share` signature widens only its own section.
    expect(descColumn(keyEntries[0]!)).toBeLessThan(descColumn(commandEntries[0]!))
  })

  test('title and close hint are centred over the table, not left-aligned', () => {
    const rows = helpRows()
    const title = rows.find(row => row.includes('Keyboard Shortcuts'))
    const footer = rows.find(row => row.includes('esc close'))
    expect(title).toBeDefined()
    expect(footer).toBeDefined()

    const blockWidth = Math.max(...rows.map(row => row.length))
    for (const row of [title!, footer!]) {
      const text = row.trim()
      const indent = row.length - row.trimStart().length
      const expected = Math.floor((blockWidth - text.length) / 2)
      // Centring is measured against the table's own width, so it survives the
      // renderer centring the block again inside the viewport.
      expect(Math.abs(indent - expected)).toBeLessThanOrEqual(1)
    }
  })

  test('advertises the /sessions alias next to /resume without showing /restart', () => {
    const rows = helpRows()
    const resumeRow = rows.find(row => row.includes('/resume'))
    expect(resumeRow).toContain('/sessions')
    expect(rows.some(row => row.includes('/restart'))).toBe(false)
  })
})
