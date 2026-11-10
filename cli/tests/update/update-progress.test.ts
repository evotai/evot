import { describe, expect, test } from 'bun:test'
import { formatInstallerProgress } from '../../src/update/progress.js'

describe('installer progress', () => {
  test('renders curl percentages as a compact bar', () => {
    expect(formatInstallerProgress('################ 67.4%')).toBe(
      '[████████████████░░░░░░░░] 67%',
    )
  })

  test('converts curl’s legacy meter format from the update screenshot', () => {
    expect(formatInstallerProgress('1 36.3M 1 684k 0 0 48481 0 0:13:05 0:00:14 0:12:51 42783')).toBe(
      '[░░░░░░░░░░░░░░░░░░░░░░░░] 1%',
    )
    expect(formatInstallerProgress('40 36.3M 40 14.7M 0 0 66619 0 0:09:31 0:03:51 0:05:40 70186')).toBe(
      '[██████████░░░░░░░░░░░░░░] 40%',
    )
  })

  test('does not leak curl redraw chunks into update output', () => {
    expect(formatInstallerProgress('################')).toBe('')
  })

  test('keeps installer phase messages readable', () => {
    expect(formatInstallerProgress('verifying checksum...')).toBe('verifying checksum...')
  })
})
