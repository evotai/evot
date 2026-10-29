import { describe, expect, test } from 'bun:test'
import stripAnsi from 'strip-ansi'
import { formatRankedSessionItems, formatSessionItems, sessionAge } from '../src/term/app/resume.js'
import { createResumeWindow } from '../src/term/app/selector-windows.js'
import { buildSelectorRegionLines } from '../src/term/viewmodel/selector.js'
import type { SessionMeta } from '../src/native/index.js'

const ID = (n: number) => `0000000${n}-0000-7000-8000-00000000000${n}`

describe('session age', () => {
  const now = new Date('2026-10-29T12:00:00')
  test('recent sessions read as an age, older ones as a date', () => {
    expect(sessionAge('2026-10-29T09:00:00', now)).toBe('3h ago')
    expect(sessionAge('2026-10-24T12:00:00', now)).toBe('5d ago')
    expect(sessionAge('2026-10-21T08:00:00', now)).toBe('10-21')
    expect(sessionAge('2025-12-30T08:00:00', now)).toBe('2025-12-30')
    expect(sessionAge('not a date', now)).toBe('')
  })
})

describe('one-line session rows', () => {
  const now = new Date().toISOString()
  const session = (n: number, extra: Partial<SessionMeta> = {}): SessionMeta =>
    ({ session_id: ID(n), title: `first prompt ${n}`, cwd: '/work', model: 'm', turns: 3, created_at: now, updated_at: now, ...extra }) as SessionMeta

  test('rows show the chosen name or the automatic title, nothing else', () => {
    const items = formatSessionItems(
      [session(1), session(2, { custom_title: 'My name' }), session(3)],
      '/work', undefined, ID(3),
    ).filter(item => !item.header)
    expect(items.map(item => item.label)).toEqual(['first prompt 1', 'My name', 'first prompt 3'])
    expect(items.map(item => item.id)).toEqual([ID(1), ID(2), ID(3)])
    expect(items.every(item => !item.preview && !item.detail)).toBe(true)
    expect(items[2]!.status?.text).toBe('● open')
    expect(items[0]!.status?.text).toBe('just now')
    expect(items[0]!.hints?.some(hint => hint.keys === 'tab')).toBe(false)

  })

  test('search results show the search summary in ranked order', () => {
    const items = formatRankedSessionItems(
      [session(2), session(1, { custom_title: 'My name' })],
      undefined, null, undefined,
      new Map([[ID(1), 'Search line one'], [ID(2), 'Search line two']]),
    )
    expect(items.map(item => item.label)).toEqual(['Search line two', 'Search line one'])
    expect(items[1]!.searchText).toContain('Search line one')
  })

  test('renders full ids in an aligned column with one line per session', () => {
    const rows = [
      session(1, { title: '重写 Databend README 与 quickstart' }),
      { ...session(2, { title: 'Triage tracelake alerts' }), session_id: 'ch_cad508a39f2fcee5c9d9abadf6bc6d37' },
      // A longer id must not push every other label right.
      session(3, { session_id: `task-${'x'.repeat(50)}`, title: 'Long id row' }),
    ]
    const state = createResumeWindow(formatSessionItems(rows, '/work'), undefined, true)
    const lines = buildSelectorRegionLines(state, 120, 40).map(line => stripAnsi(line))
    const first = lines.find(line => line.includes(ID(1)))
    const second = lines.find(line => line.includes('ch_cad508a39f2fcee5c9d9abadf6bc6d37'))
    expect(first).toContain('重写 Databend README')
    expect(second).toContain('Triage tracelake alerts')
    // Labels start in the same column after the longest id.
    expect(first!.indexOf('重写')).toBe(second!.indexOf('Triage'))
    // The age closes the row.
    expect(first!.trimEnd().endsWith('just now')).toBe(true)
    expect(first!.indexOf('重写')).toBeLessThan(45)
    expect(lines.join('\n')).toContain('Long id row')
    expect(lines.join('\n')).not.toContain('tab details')
    expect(lines.join('\n')).not.toContain('│')
  })

  test('search summaries wrap to two aligned lines; the plain list keeps one', () => {
    const long = '实现全文检索 TopK 下推 PR，附边界与 sqllogic 测试，用 turbopuffer 测试集对比新旧策略性能收益，并处理 review 中测试文件放哪的争议，后续还要补充更多的边界场景与回归测试并整理成文档发布'
    const items = formatRankedSessionItems([session(1), session(2)], undefined, null, undefined,
      new Map([[ID(1), long], [ID(2), 'Short one']]))
    const lines = buildSelectorRegionLines({ ...createResumeWindow(items, undefined, true), labelLines: 2 }, 120, 40)
      .map(line => stripAnsi(line))
    const at = lines.findIndex(line => line.includes(ID(1)))
    const column = lines[at]!.indexOf('实现')
    // The second line continues under the label, not under the id.
    expect(lines[at + 1]!.slice(0, column).trim()).toBe('')
    expect(lines[at + 1]!.trim().length).toBeGreaterThan(0)
    // Two lines at most: the rest is cut, and the next row follows directly.
    expect(lines[at + 1]!.trimEnd().endsWith('…')).toBe(true)
    expect(lines[at + 2]).toContain(ID(2))
    expect(lines[at + 2]).toContain('Short one')

    const plain = buildSelectorRegionLines(createResumeWindow(items, undefined, true), 120, 40).map(line => stripAnsi(line))
    const row = plain.findIndex(line => line.includes(ID(1)))
    expect(plain[row]).toContain('…')
    expect(plain[row]!.trimEnd().endsWith('just now')).toBe(true)
    expect(plain[row + 1]).toContain(ID(2))
  })

  test('a narrow list moves the summary under the id instead of cutting the id', () => {
    const state = createResumeWindow(formatSessionItems([session(1, { title: 'A long summary that cannot share the line' })], '/work'),
      undefined, true)
    const lines = buildSelectorRegionLines(state, 56, 40).map(line => stripAnsi(line))
    const at = lines.findIndex(line => line.includes(ID(1)))
    expect(at).toBeGreaterThan(-1)
    expect(lines[at + 1]).toContain('A long summary')
  })

  test('the shared list keeps its details pane', () => {
    const items = formatSessionItems([session(1)], '/work', undefined, null, () => '⇡ public', { cloudFirst: true })
    const state = createResumeWindow(items, undefined, true, true)
    expect(state.rowLayout).toBeUndefined()
    expect(items.find(item => !item.header)?.preview?.length).toBeGreaterThan(0)
  })
})
