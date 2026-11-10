import { beforeAll, describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import { getTheme } from '../../../src/ui/theme/index.js'
import { buildSelectorRow } from '../../../src/term/viewmodel/selector-row.js'
import { styledLineToAnsi } from '../../../src/term/viewmodel/types.js'

beforeAll(() => { chalk.level = 3 })

describe('buildSelectorRow', () => {
  test('renders the current item as one pointer, foreground, and background state', () => {
    const row = buildSelectorRow(
      { label: 'GPT 5.6 Sol', detail: '(Fast)', selected: true },
      { highlighted: true, detailGap: ' ' },
    )

    expect(row.bg).toBe(getTheme().selectionBgHex)
    expect(row.spans.every(span => span.bg === getTheme().selectionBgHex)).toBe(true)
    expect(row.spans[0]?.text).toBe('· ')
    expect(row.spans[0]?.hex).toBe(getTheme().brandHex)
    expect(row.spans[1]?.hex).toBe(getTheme().brandHex)
    expect(styledLineToAnsi(row)).toContain('·')
  })

  test('uses the same palette for model and generic rows', () => {
    const model = buildSelectorRow(
      { label: 'GPT 5.6 Sol', selected: true },
      { highlighted: true, idleMarker: true, detailGap: ' ' },
    )
    const generic = buildSelectorRow(
      { label: '01a06b6f', detail: 'repl' },
      { highlighted: true },
    )

    expect(model.bg).toBe(generic.bg)
    expect(model.spans[0]).toEqual(generic.spans[0])
    expect(model.spans[1]?.hex).toBe(generic.spans[1]?.hex)
    expect(model.spans[1]?.bold).toBe(true)
    expect(generic.spans[1]?.bold).toBe(true)
  })

  test('keeps idle rows free of selection styling', () => {
    const row = buildSelectorRow(
      { label: 'Claude Opus 5', detail: 'Premium' },
      { highlighted: false, idleMarker: true, detailGap: ' ' },
    )

    expect(row.bg).toBeUndefined()
    // The `·` gutter marks it as a choice; the selection band and pointer stay
    // exclusive to the current row.
    expect(row.spans[0]?.text).toBe('· ')
    expect(row.spans.every(span => span.bg === undefined)).toBe(true)
  })

  test('every row carries the same gutter marker, current or not', () => {
    // The marker no longer signals selection: one glyph on every row, so the
    // gutter column cannot differ in width between a row and its neighbours.
    const idle = buildSelectorRow({ label: '01a06b6f', detail: 'repl' }, { highlighted: false })
    const current = buildSelectorRow({ label: '01a06b6f', detail: 'repl' }, { highlighted: true })

    expect(idle.spans[0]?.text).toBe('· ')
    expect(current.spans[0]?.text).toBe('· ')
    expect(idle.bg).toBeUndefined()
    // Only colour, weight and band mark the current row.
    expect(current.bg).toBe(getTheme().selectionBgHex)
    expect(current.spans[0]?.hex).toBe(getTheme().brandHex)
    expect(idle.spans[0]?.hex).toBe(getTheme().mutedHex)
  })
})
