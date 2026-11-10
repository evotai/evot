import { describe, expect, test } from 'bun:test'
import {
  QUEUE_SELECTOR_TITLE,
  createQueueSelectorState,
  decideQueueSelectorAction,
  formatQueuePreview,
  formatQueueSelectorItems,
  isQueueManageShortcut,
  parseQueueSelectorItem,
  type ManagedQueuedPrompt,
} from '../../../src/term/app/queue/queue-manage.js'

const entries: ManagedQueuedPrompt[] = [
  { queue: 'follow_up', id: 'p1', version: 2, text: 'fix the layout' },
  { queue: 'steering', id: 'p2', version: 0, text: 'run\nnow' },
]

describe('queue manager', () => {
  test('formats numbered rows without queue-internal labels', () => {
    const items = formatQueueSelectorItems(entries)
    expect(items[0]).toMatchObject({ label: '#1 fix the layout' })
    expect(items[1]).toMatchObject({ label: '#2 run (+1 line)' })
    expect(items[0]!.detail).toBeUndefined()
    expect(items[1]!.detail).toBeUndefined()
    expect(parseQueueSelectorItem(items[0]!)).toEqual(entries[0])
    expect(items).toHaveLength(2)
  })

  test('builds the grok-style queue selector', () => {
    const state = createQueueSelectorState(entries)
    expect(state.title).toBe(QUEUE_SELECTOR_TITLE)
    expect(state.subtitle).toBe('2 queued')
  })

  test('maps enter and delete actions', () => {
    const items = formatQueueSelectorItems(entries)
    expect(decideQueueSelectorAction(items[0]!, 'enter')).toEqual({ kind: 'edit', entry: entries[0] })
    expect(decideQueueSelectorAction(items[1]!, 'delete')).toEqual({ kind: 'remove', entry: entries[1] })
  })

  test('recognizes only ctrl+g as the queue shortcut', () => {
    expect(isQueueManageShortcut({ type: 'ctrl', key: 'g' })).toBe(true)
    // Ctrl+B is the background chord now, so it must not open the queue pane.
    expect(isQueueManageShortcut({ type: 'ctrl', key: 'b' })).toBe(false)
    expect(isQueueManageShortcut({ type: 'ctrl', key: ';' })).toBe(false)
    expect(isQueueManageShortcut({ type: 'ctrl', key: '4' })).toBe(false)
    expect(isQueueManageShortcut({ type: 'ctrl', key: 'o' })).toBe(false)
    expect(isQueueManageShortcut({ type: 'char', char: 'g' })).toBe(false)
  })

  test('shows first-line previews, multiline counts, and truncation', () => {
    expect(formatQueuePreview(' one\n two ')).toBe('one (+1 line)')
    expect(formatQueuePreview('one\ntwo\nthree')).toBe('one (+2 lines)')
    expect(formatQueuePreview('1234567890', 5)).toBe('1234…')
  })
})
