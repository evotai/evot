import stripAnsi from 'strip-ansi'
import { wrapTextWithAnsi } from '../../ui/wrap.js'
import { ansi, block, dim, line, type ViewBlock } from './types.js'

/** Shared layout for system notices, including pre-styled command output. */
export function buildSystemBlock(
  text: string,
  options: { columns?: number; prevKind?: string; preStyled?: boolean } = {},
): ViewBlock {
  const rows = options.columns
    ? wrapTextWithAnsi(text, Math.max(1, options.columns))
    : text.split(/\r\n|\r|\n/)
  // Separate notices from conversation output, but keep consecutive notices
  // compact and respect command blocks that supply their own leading blank.
  const needsGap = options.prevKind !== undefined && options.prevKind !== 'system'
    && stripAnsi(rows[0] ?? '').trim().length > 0
  return block(rows.map(row => line(options.preStyled ? ansi(row) : dim(row))), needsGap ? 1 : 0)
}
