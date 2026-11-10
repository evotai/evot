import { describe, test, expect, beforeAll } from 'bun:test'
import chalk from 'chalk'
import stripAnsi from 'strip-ansi'

import { buildRunFooterLine, runFooterText } from '../../../src/render/run-footer.js'
import { formatWallClock } from '../../../src/ui/format.js'
import { buildOutputBlocks } from '../../../src/term/viewmodel/output.js'
import { blocksToLines } from '../../../src/term/viewmodel/types.js'
import { formatClock } from '../../../src/term/viewmodel/output.js'

beforeAll(() => {
  chalk.level = 3
})

function at(hour: number, minute: number): number {
  const date = new Date(2026, 0, 15, hour, minute, 0, 0)
  return date.getTime()
}

describe('formatWallClock', () => {
  test('renders a padded 24-hour local clock with seconds', () => {
    expect(formatWallClock(at(8, 58))).toBe('08:58:00')
    expect(formatWallClock(at(18, 11))).toBe('18:11:00')
    expect(formatWallClock(at(0, 5))).toBe('00:05:00')
    expect(formatWallClock(at(12, 0))).toBe('12:00:00')
  })

  test('the bracketed message header is the same clock', () => {
    expect(formatClock(at(8, 58))).toBe('[08:58:00]')
  })
})

describe('runFooterText', () => {
  test('reports total elapsed time and the finishing clock', () => {
    const finished = at(8, 58)
    expect(runFooterText(finished - 9_000, finished)).toBe('✳ Ran for 9s · done 08:58:00')
  })

  test('counts the model round-trips a run took', () => {
    const finished = at(8, 58)
    expect(runFooterText(finished - 9_000, finished, 4)).toBe('✳ Ran for 9s · 4 turns · done 08:58:00')
  })

  test('a single round-trip is not pluralised', () => {
    const finished = at(8, 58)
    expect(runFooterText(finished - 9_000, finished, 1)).toBe('✳ Ran for 9s · 1 turn · done 08:58:00')
  })

  test('a run that never reached the model omits the segment entirely', () => {
    const finished = at(8, 58)
    expect(runFooterText(finished - 9_000, finished, 0)).toBe('✳ Ran for 9s · done 08:58:00')
    expect(runFooterText(finished - 9_000, finished, -3)).toBe('✳ Ran for 9s · done 08:58:00')
    expect(runFooterText(finished - 9_000, finished, Number.NaN)).toBe('✳ Ran for 9s · done 08:58:00')
  })

  test('long runs read in minutes, not raw seconds', () => {
    const finished = at(14, 3)
    expect(runFooterText(finished - 94_000, finished)).toBe('✳ Ran for 1m 34s · done 14:03:00')
  })

  test('a sub-second run reports nothing rather than 0s', () => {
    const finished = at(8, 58)
    expect(runFooterText(finished - 400, finished)).toBeNull()
    expect(runFooterText(finished, finished)).toBeNull()
  })

  test('a non-finite span is refused instead of rendering NaN', () => {
    expect(runFooterText(Number.NaN, at(8, 58))).toBeNull()
    expect(runFooterText(0, Number.POSITIVE_INFINITY)).toBeNull()
  })

  test('a clock that went backwards produces no line', () => {
    const finished = at(8, 58)
    expect(runFooterText(finished + 5_000, finished)).toBeNull()
  })
})

describe('buildRunFooterLine', () => {
  test('carries its own styling so the system treatment cannot flatten it', () => {
    const finished = at(8, 58)
    const line = buildRunFooterLine(finished - 9_000, finished)
    expect(line).not.toBeNull()
    expect(line?.kind).toBe('system')
    expect(line?.preStyled).toBe(true)
    expect(line?.text).not.toBe(stripAnsi(line?.text ?? ''))
  })

  test('a short run yields no line to commit', () => {
    const finished = at(8, 58)
    expect(buildRunFooterLine(finished - 100, finished)).toBeNull()
  })

  test('renders through the viewmodel indented like every other system row', () => {
    const finished = at(8, 58)
    const line = buildRunFooterLine(finished - 9_000, finished, 3)
    const rendered = blocksToLines(buildOutputBlocks(line ? [line] : []))
    expect(stripAnsi(rendered.join('\n'))).toContain('  ✳ Ran for 9s · 3 turns · done 08:58:00')
  })
})
