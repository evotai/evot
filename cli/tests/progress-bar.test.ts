import { describe, expect, test } from 'bun:test'

import { createProgressBar, formatProgressCount, renderProgressBar } from '../src/term/progress-bar.js'
import type { ProgressLine } from '../src/term/progress-line.js'

const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '')

function recordingLine(): { line: ProgressLine; updates: string[]; finished: string[] } {
  const updates: string[] = []
  const finished: string[] = []
  return {
    updates, finished,
    line: { update: text => { updates.push(strip(text)) }, finish: text => { finished.push(strip(text)) } },
  }
}

describe('formatProgressCount', () => {
  test('counts with thousands separators, unit and a floored percentage', () => {
    expect(formatProgressCount(12000, 32000, 'entries')).toBe('12,000 / 32,000 entries · 37%')
    expect(formatProgressCount(3, 3)).toBe('3 / 3 · 100%')
    expect(formatProgressCount(0, 0, 'files')).toBe('0 / 0 files · 0%')
  })
})

describe('renderProgressBar', () => {
  test('shows the pending phrase before the first count and hides sub-second elapsed', () => {
    const row = strip(renderProgressBar({ label: 'Sharing', pending: 'preparing…' }, null, 400))
    expect(row).toContain('⋯ Sharing  preparing…')
    expect(row).not.toContain(' · 0s')
  })

  test('draws a bar sized to the ratio, then the count and elapsed time', () => {
    const row = strip(renderProgressBar({ label: 'Sharing', unit: 'entries', width: 10 }, { done: 5, total: 10 }, 14_000))
    expect(row).toContain('█████░░░░░  5 / 10 entries · 50% · 14s')
  })
})

describe('createProgressBar', () => {
  test('paints once on creation, on every set, and finishes with the outcome', () => {
    const { line, updates, finished } = recordingLine()
    let now = 1_000
    const bar = createProgressBar(line, { label: 'Upload', unit: 'entries', width: 4, now: () => now, tickMs: 0 })
    now += 2_000
    bar.set(1, 4)
    now += 3_000
    bar.set(4, 4)
    bar.finish('done')
    expect(updates).toEqual([
      '  ⋯ Upload  preparing…',
      '  ⋯ Upload  █░░░  1 / 4 entries · 25% · 2s',
      '  ⋯ Upload  ████  4 / 4 entries · 100% · 5s',
    ])
    expect(finished).toEqual(['done'])
  })

  test('the clock keeps the row moving between counts and stops at finish', async () => {
    const { line, updates } = recordingLine()
    let now = 0
    const bar = createProgressBar(line, { label: 'Upload', now: () => now, tickMs: 5 })
    now = 1_000
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(updates.at(-1)).toBe('  ⋯ Upload  preparing… · 1s')
    bar.finish('ok')
    const painted = updates.length
    now = 9_000
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(updates.length).toBe(painted)
  })
})
