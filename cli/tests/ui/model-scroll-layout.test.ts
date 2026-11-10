import { expect, test } from 'bun:test'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'
import { createSelectorState } from '../../src/ui/selector.js'
import type { SelectorItem } from '../../src/ui/selector.js'
import { buildSelectorRegionLines } from '../../src/term/viewmodel/selector.js'
import { createTaskModelWindow } from '../../src/features/task/model-picker.js'
import { selectorDown } from '../../src/ui/selector.js'

const items: SelectorItem[] = [
  { label: 'Policy', header: true, focusable: false },
  { id: 'default', label: 'Device default at run time', detail: 'Follow this device when the task runs' },
  ...Array.from({ length: 4 }, (_, group) => [
    { label: `Provider ${group}`, header: true, focusable: false },
    ...Array.from({ length: 4 }, (_, row) => ({
      id: `${group}:${row}`, label: `Model ${group}-${row}`,
      effort: { levels: ['off', 'low', 'medium', 'high', 'max'], index: 3 },
    })),
  ]).flat(),
]

test('task model picker retains its own heading while navigating', () => {
  const state = createTaskModelWindow(undefined, 'test-model')
  for (const current of [state, selectorDown(state)]) {
    const rendered = buildSelectorRegionLines(current, 120, 40, true).map(stripAnsi).join('\n')
    expect(rendered).toContain('Choose for this task')
    expect(rendered).not.toContain('Run /login')
  }
})

for (const width of [80, 160]) {
  test(`model scroll keeps gauge column, search and footer geometry at width ${width}`, () => {
    const base = { ...createSelectorState('Models', items), presentation: 'model' as const, listFocused: true }
    const heights = new Set<number>()
    const columns = new Set<number>()
    const searchRows = new Set<number>()
    const footerRows = new Set<number>()
    for (let focusIndex = 0; focusIndex < items.length; focusIndex++) {
      if (items[focusIndex]?.header) continue
      const lines = buildSelectorRegionLines({ ...base, focusIndex }, width, 40, true).map(stripAnsi)
      heights.add(lines.length)
      searchRows.add(lines.findIndex(row => row.startsWith('>')))
      footerRows.add(lines.findIndex(row => row.includes('Model:')))
      for (const row of lines) {
        const gauge = row.indexOf('◼')
        if (gauge >= 0) columns.add(stringWidth(row.slice(0, gauge)))
      }
    }
    expect(heights.size).toBe(1)
    expect(searchRows.size).toBe(1)
    expect(footerRows.size).toBe(1)
    expect(columns.size).toBe(1)
    expect([...columns][0]).toBeLessThan(40)
  })
}
