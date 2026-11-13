import { describe, expect, test } from 'bun:test'
import { formatQueuedMessageLines } from '../../../src/term/viewmodel/queued-messages.js'

describe('formatQueuedMessageLines', () => {
  test('returns empty when there is nothing queued', () => {
    expect(formatQueuedMessageLines([])).toEqual([])
    expect(formatQueuedMessageLines(['', '  '])).toEqual([])
  })

  test('labels each message by position and adds management hints', () => {
    expect(formatQueuedMessageLines(['fix the layout', 'then ship'])).toEqual([
      '#1 fix the layout',
      '#2 then ship',
      '↳ esc pull back · ctrl+g manage',
    ])
  })

  test('collapses whitespace and truncates long lines', () => {
    const long = 'word '.repeat(40).trim()
    const lines = formatQueuedMessageLines([`  multi\nline\tmsg  `, long], { maxChars: 40 })
    expect(lines[0]).toBe('#1 multi line msg')
    expect(lines[1]!.startsWith('#2 ')).toBe(true)
    expect(lines[1]!.endsWith('…')).toBe(true)
    expect(lines[1]!.length).toBeLessThanOrEqual(40)
    expect(lines[2]).toBe('↳ esc pull back · ctrl+g manage')
  })

  test('shows only the first three prompts and reports hidden rows', () => {
    expect(formatQueuedMessageLines(['one', 'two', 'three', 'four'])).toEqual([
      '#1 one',
      '#2 two',
      '#3 three',
      '↓ 1 more queued',
      '↳ esc pull back · ctrl+g manage',
    ])
  })

  test('a paused backlog names the key that continues it', () => {
    expect(formatQueuedMessageLines(['[paused] one', '[paused] two'], { paused: 2 }).at(-1))
      .toBe('↳ 2 paused · ctrl+g resume · esc pull back')
  })
})
