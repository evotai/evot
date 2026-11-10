import chalk from 'chalk'

import { formatElapsed, formatWallClock } from '../ui/format.js'
import type { OutputLine } from './output.js'
import { SECTION_MUTED } from '../ui/section.js'
import { thinkingDuration } from './run-thinking.js'

const MIN_FOOTER_MS = 1000

const FOOTER_GLYPH = '✳'

function turnSegment(turns: number): string {
  if (!Number.isFinite(turns) || turns < 1) return ''
  const whole = Math.floor(turns)
  return ` · ${whole} ${whole === 1 ? 'turn' : 'turns'}`
}

export function runFooterText(startedAt: number, finishedAt: number, turns = 0, thinkingMs: number | null = null): string | null {
  const elapsed = finishedAt - startedAt
  if (!Number.isFinite(elapsed) || elapsed < MIN_FOOTER_MS) return null
  const thought = thinkingMs !== null && Number.isFinite(thinkingMs) && thinkingMs >= 0
    ? ` · thought ${thinkingDuration(thinkingMs)}`
    : ''
  return `${FOOTER_GLYPH} Ran for ${formatElapsed(elapsed)}${turnSegment(turns)}${thought} · done ${formatWallClock(finishedAt)}`
}

export function buildRunFooterLine(
  startedAt: number,
  finishedAt: number,
  turns = 0,
  thinkingMs: number | null = null,
): OutputLine | null {
  const text = runFooterText(startedAt, finishedAt, turns, thinkingMs)
  if (!text) return null
  return {
    id: 'run-footer',
    kind: 'system',
    text: `  ${chalk.hex(SECTION_MUTED)(text)}`,
    preStyled: true,
  }
}
