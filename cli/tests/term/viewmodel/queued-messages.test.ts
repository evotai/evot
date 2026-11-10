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
      '↳ ctrl+g manage · esc pull last',
    ])
  })

  test('collapses whitespace and truncates long lines', () => {
    const long = 'word '.repeat(40).trim()
    const lines = formatQueuedMessageLines([`  multi\nline\tmsg  `, long], { maxChars: 40 })
    expect(lines[0]).toBe('#1 multi line msg')
    expect(lines[1]!.startsWith('#2 ')).toBe(true)
    expect(lines[1]!.endsWith('…')).toBe(true)
    expect(lines[1]!.length).toBeLessThanOrEqual(40)
    expect(lines[2]).toBe('↳ ctrl+g manage · esc pull last')
  })

  test('shows only the first three prompts and reports hidden rows', () => {
    expect(formatQueuedMessageLines(['one', 'two', 'three', 'four'])).toEqual([
      '#1 one',
      '#2 two',
      '#3 three',
      '↓ 1 more queued',
      '↳ ctrl+g manage · esc pull last',
    ])
  })
})
