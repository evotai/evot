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
import { selectorColumns, selectorHints, selectorSearch } from '../src/term/viewmodel/selector-chrome.js'
import { line, plain, styledLineToAnsi } from '../src/term/viewmodel/types.js'
import { CURSOR_MARKER } from '../src/term/render-frame.js'
import { getTheme } from '../src/render/theme/index.js'
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
    expect(rows[1]?.bg).toBe(rows[0]?.bg)
    expect(rows[1]?.spans[0]?.text).toBe('│ ')
    expect(rows[1]?.spans.every(span => span.bg === rows[0]?.bg)).toBe(true)
    expect(rows.every(row => stringWidth(stripAnsi(styledLineToAnsi(row))) <= 46)).toBe(true)
  })

  test('both themes bind metadata and muted status to the whole selected entry', () => {
    const previous = process.env.EVOT_THEME
    try {
      for (const scheme of ['dark', 'light']) {
        process.env.EVOT_THEME = scheme
        const theme = getTheme()
        const item = { label: 'Shared notes', detail: 'https://evot.ai/share/notes', status: { text: '2h ago', tone: 'muted' as const } }
        const selected = buildBrowseRow(item, { highlighted: true }, 46)
        expect(selected.every(row => row.bg === theme.selectionBgHex)).toBe(true)
        expect(selected[1]?.spans[1]?.hex).toBe(theme.selectionMutedHex)
        expect(selected[1]?.spans[1]?.dim).toBeUndefined()
        expect(selected[0]?.spans.at(-1)?.hex).toBe(theme.selectionMutedHex)
        const idle = buildBrowseRow(item, { highlighted: false }, 46)
        expect(idle.every(row => row.bg === undefined && row.spans.every(span => span.bg === undefined))).toBe(true)
        expect(idle[1]?.spans[0]?.hex).toBe(theme.subtleHex)
        expect(idle[1]?.spans[1]?.hex).toBe(theme.mutedHex)
        expect(idle[0]?.spans.at(-1)?.hex).toBe(theme.mutedHex)
      }
    } finally {
      if (previous === undefined) delete process.env.EVOT_THEME
      else process.env.EVOT_THEME = previous
    }
  })

  test('metadata search matches keep emphasis and selection fill within narrow widths', () => {
    for (const highlighted of [true, false]) {
      for (const width of [1, 2, 8, 20, 46]) {
        const rows = buildBrowseRow({ label: '中文标题', detail: '中文 metadata matches long text' }, { highlighted, query: 'metadata' }, width)
        expect(rows.every(row => stringWidth(stripAnsi(styledLineToAnsi(row))) <= width)).toBe(true)
        if (width >= 20) {
          const match = rows[1]?.spans.find(span => span.text === 'metadata')
          expect(match?.bold).toBe(true)
          expect(match?.fg).toBe('yellow')
          expect(match?.bg).toBe(highlighted ? getTheme().selectionBgHex : undefined)
        }
      }
    }
  })

  test('two-line selection stops at the list edge rather than painting the preview', () => {
    const rows = buildBrowseRow(items[0]!, { highlighted: true }, 46)
    const joined = selectorColumns(rows, [line(plain('preview title')), line(plain('preview body'))], 46)
    for (const row of joined) {
      expect(row.bg).toBeUndefined()
      expect(row.spans.at(-1)?.bg).toBeUndefined()
      expect(row.spans.at(-2)?.bg).toBeUndefined()
      expect(row.spans.slice(0, -2).filter(span => span.text.trim()).every(span => span.bg === getTheme().selectionBgHex)).toBe(true)
    }
  })

  test('missing metadata preserves row geometry without drawing an orphan rail', () => {
    const rows = buildBrowseRow({ label: 'Title only' }, { highlighted: true }, 30)
    expect(rows).toHaveLength(2)
    expect(stripAnsi(styledLineToAnsi(rows[1]!))).toBe(' '.repeat(30))
    expect(rows[1]?.bg).toBe(getTheme().selectionBgHex)
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
