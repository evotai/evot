/**
 * Width measurement and truncation for styled terminal content.
 *
 * Everything here measures in terminal columns, never in code units: CJK
 * glyphs occupy two cells and escape sequences occupy none. Layout code that
 * pads to a fixed width must go through these helpers, otherwise rows drift by
 * a cell or two and framed borders stop lining up.
 */

import stringWidth from 'string-width'
import { visibleWidth } from '../../ui/wrap.js'
import { wrapEditorText } from '../input/grapheme.js'
import type { StyledSpan } from './types.js'

/**
 * Visible width of a span list. Uses `visibleWidth` rather than `stringWidth`
 * because spans may carry zero-width control sequences — most importantly
 * `CURSOR_MARKER` (an APC sequence), which `stringWidth` counts as 5 columns.
 */
export function spansWidth(spans: StyledSpan[]): number {
  return visibleWidth(spans.map(span => span.text).join(''))
}

/** Right-align `right` within `columns`; keeps a ≥1-column gap on overflow. */
export function joinLeftRight(
  left: StyledSpan[],
  right: StyledSpan[],
  columns: number,
): StyledSpan[] {
  const gap = Math.max(1, columns - spansWidth(left) - spansWidth(right))
  return [...left, { text: ' '.repeat(gap) }, ...right]
}

/** Clamp a terminal dimension, falling back when the value is not finite. */
export function finiteSize(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback
}

/** Truncate to `width` columns, marking the cut with a trailing ellipsis. */
export function truncateToWidth(text: string, width: number): string {
  if (width <= 0) return ''
  if (stringWidth(text) <= width) return text
  if (width <= 1) return '…'.slice(0, width)
  let result = ''
  let used = 0
  for (const char of text) {
    const charWidth = stringWidth(char)
    if (used + charWidth > width - 1) break
    result += char
    used += charWidth
  }
  return `${result}…`
}

/** Keep the tail instead of the head — for paths, where the leaf matters most. */
export function truncateTailToWidth(text: string, width: number): string {
  if (width <= 0) return ''
  if (stringWidth(text) <= width) return text
  if (width <= 1) return '…'.slice(0, width)
  let result = ''
  let used = 0
  for (const char of [...text].reverse()) {
    const charWidth = stringWidth(char)
    if (used + charWidth > width - 1) break
    result = char + result
    used += charWidth
  }
  return `…${result}`
}

/** Drop spans past `width`, splitting the span that straddles the boundary. */
export function truncateSpansToWidth(spans: StyledSpan[], width: number): StyledSpan[] {
  const result: StyledSpan[] = []
  let used = 0
  for (const span of spans) {
    const spanWidth = visibleWidth(span.text)
    // Zero-width spans (the cursor marker) must survive truncation: the
    // renderer needs the marker to place the hardware cursor.
    if (spanWidth === 0) {
      result.push(span)
      continue
    }
    if (used + spanWidth <= width) {
      result.push(span)
      used += spanWidth
      continue
    }
    const room = width - used
    if (room > 0) result.push({ ...span, text: truncateToWidth(span.text, room) })
    break
  }
  return result
}

/** Split text into rows that each fit `width` columns, respecting graphemes. */
export function wrapTextByWidth(text: string, width: number): { start: number; end: number }[] {
  return wrapEditorText(text, width)
}
