import { describe, expect, test } from 'bun:test'
import stringWidth from 'string-width'
import stripAnsi from 'strip-ansi'
import { browseWindow } from '../src/term/app/browse-window.js'
import { createAppSelectorState } from '../src/term/app/selector-identity.js'
import { createResumeWindow } from '../src/term/app/selector-windows.js'
import { handleSelectorControl } from '../src/term/app/selector-control.js'
import { handleTaskKey } from '../src/task/control.js'
import { buildSelectorRegionLines } from '../src/term/viewmodel/selector.js'
import { buildBrowseRow } from '../src/term/viewmodel/selector-row.js'
import { selectorHints, selectorSearch } from '../src/term/viewmodel/selector-chrome.js'
import { styledLineToAnsi } from '../src/term/viewmodel/types.js'
import { CURSOR_MARKER } from '../src/term/render-frame.js'
import type { SelectorState } from '../src/term/selector.js'

const hints = [
  { keys: ['up', 'down'], action: 'select' },
  { keys: 'tab', action: 'details' },
  { keys: 'enter', action: 'open' },
  { keys: '/', action: 'search' },
  { keys: 'e', action: 'edit' },
  { keys: 'd', action: 'delete' },
  { keys: 'escape', action: 'close' },
]
const items = Array.from({ length: 30 }, (_, index) => ({
  id: `entry-${index}`, label: `中文项目 ${index} ${'long title '.repeat(8)}`,
  detail: `secondary ${index} ${'metadata '.repeat(10)}`,
  status: { text: 'Running', tone: 'active' as const },
  preview: [`Title ${index}`, '', ...Array.from({ length: 50 }, (_, row) => `body-${row}`)],
  searchText: index === 0 ? 'edited' : `entry ${index}`,
  hints,
}))

const render = (state: SelectorState, columns: number, rows = 24) => buildSelectorRegionLines(state, columns, rows).map(stripAnsi)

describe('shared browse surface', () => {
  test('title and status have separate budgets; secondary text stays secondary', () => {
    const rows = buildBrowseRow(items[0]!, { highlighted: true }, 46)
    expect(rows).toHaveLength(2)
    expect(stripAnsi(styledLineToAnsi(rows[0]!))).toContain('Running')
    expect(stripAnsi(styledLineToAnsi(rows[0]!))).toContain('中文项目')
    expect(stripAnsi(styledLineToAnsi(rows[1]!))).toContain('secondary')
    expect(rows[0]?.bg).toBeDefined()
    expect(rows[1]?.bg).toBeUndefined()
    expect(rows.every(row => stringWidth(stripAnsi(styledLineToAnsi(row))) <= 46)).toBe(true)
  })

  test('every focus remains visible, all lines fit, and window height stays stable', () => {
    const state = browseWindow(createAppSelectorState('task', 'Tasks', items), true)
    for (const width of [40, 60, 90, 120, 180]) {
      const height = render(state, width).length
      for (let focusIndex = 0; focusIndex < items.length; focusIndex++) {
        const lines = render({ ...state, focusIndex }, width)
        expect(lines.length).toBe(height)
        expect(lines.some(row => row.includes(`中文项目 ${focusIndex} `))).toBe(true)
        expect(lines.every(row => stringWidth(row) <= width)).toBe(true)
      }
      const detail = render({ ...state, previewPane: { ...state.previewPane!, focused: true } }, width)
      expect(detail.length).toBe(height)
      expect(detail.join('\n')).not.toContain('d delete')
      expect(detail.join('\n')).toContain('scroll')
    }
  })

  test('group headings never strand the focused entry or show alone at the bottom', () => {
    const grouped = Array.from({ length: 10 }, (_, index) => [
      { label: `Group ${index}`, header: true, focusable: false, group: `g${index}` },
      { ...items[index]!, group: `g${index}` },
    ]).flat()
    const state = browseWindow(createAppSelectorState('shares', 'Shared links', grouped), true)
    for (const columns of [40, 60, 90, 120]) {
      for (let index = 0; index < 10; index++) {
        const lines = render({ ...state, focusIndex: index * 2 + 1 }, columns)
        expect(lines.some(row => row.includes(`中文项目 ${index} `))).toBe(true)
      }
    }
  })

  test('whole shortcut hints wrap without losing delete/close on small terminals', () => {
    const rows = selectorHints(hints, 32).map(styledLineToAnsi).map(stripAnsi)
    expect(rows.length).toBeGreaterThan(1)
    expect(rows.every(row => stringWidth(row) <= 32)).toBe(true)
    expect(rows.join('\n')).toContain('d delete')
    expect(rows.join('\n')).toContain('Esc close')
  })

  test('long CJK search keeps the cursor and tail inside its width budget', () => {
    const text = styledLineToAnsi(selectorSearch('中文'.repeat(100) + 'tail', 30, true, ''))
    expect(text).toContain(CURSOR_MARKER)
    expect(stripAnsi(text)).toContain('tail')
    expect(stringWidth(stripAnsi(text.replace(CURSOR_MARKER, '')))).toBeLessThanOrEqual(30)
  })

  test('tasks, sessions and shares use the same search ownership and escape contract', () => {
    for (const owner of ['task', 'resume', 'shares'] as const) {
      let state = owner === 'resume' ? createResumeWindow(items, undefined, true)
        : browseWindow(createAppSelectorState(owner, owner, items), true)
      const apply = (event: Parameters<typeof handleTaskKey>[1]) => {
        const action = owner === 'task' ? handleTaskKey(state, event) : handleSelectorControl(state, event)
        if (action.kind === 'update') state = action.state
        return action
      }
      apply({ type: 'char', char: '/' })
      expect(state.listFocused).toBe(false)
      for (const char of 'edited') {
        expect(apply({ type: 'char', char }).kind).toBe('update')
        expect(state.pendingDeleteId).toBeUndefined()
        expect(state.rename).toBeUndefined()
      }
      expect(state.query).toBe('edited')
      expect(state.items).toHaveLength(1)
      apply({ type: 'escape' })
      expect(state.query).toBe('')
      expect(state.listFocused).toBe(true)
      expect(state.items).toHaveLength(30)
    }
  })
})
