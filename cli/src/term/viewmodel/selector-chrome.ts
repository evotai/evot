import stringWidth from 'string-width'
import { getTheme } from '../../render/theme/index.js'
import type { Hint } from '../design/key-hints.js'
import { formatChord, HINT_SEPARATOR } from '../design/key-hints.js'
import { CURSOR_MARKER } from '../render-frame.js'
import { confirmationHint } from './confirmation-hint.js'
import { bold, dim, line, plain, type StyledLine, type StyledSpan } from './types.js'
import { spansWidth, truncateSpansToWidth, truncateToWidth } from './width.js'

/** Shared title hierarchy: count is never substituted for transient status. */
export function selectorTitle(title: string, count: string, width: number): StyledLine {
  return line(bold(truncateToWidth(title, Math.max(1, width - stringWidth(count) - 2))), dim(`  ${count}`))
}

/** Bounded search input. Keep the tail and the hardware cursor on screen. */
export function selectorSearch(query: string, width: number, focused: boolean, placeholder: string, label = 'Search  '): StyledLine {
  const prefix = truncateToWidth(label, Math.max(0, width - (focused ? 1 : 0)))
  const room = Math.max(0, width - stringWidth(prefix) - (focused ? 1 : 0))
  let tail = ''
  for (const char of [...query].reverse()) {
    if (stringWidth(char + tail) > room) break
    tail = char + tail
  }
  return line(label === '> ' ? plain(prefix) : { text: prefix, hex: getTheme().brandHex },
    ...(query ? [plain(tail)] : []),
    ...(focused ? [plain(CURSOR_MARKER), plain(' ')] : []),
    ...(!query ? [dim(truncateToWidth(placeholder, room))] : []))
}

/** Pack whole gestures onto rows; never silently clip the last actions. */
export function selectorHints(hints: Hint[], width: number, lowercase = false): StyledLine[] {
  const result: StyledLine[] = []
  let spans: StyledSpan[] = []
  for (const hint of hints) {
    const key = lowercase ? formatChord(hint.keys).toLowerCase() : formatChord(hint.keys)
    const entry = hint.confirmationPending
      ? [confirmationHint(`${key} ${hint.action}`, true)]
      : [{ text: key, hex: getTheme().brandHex }, dim(` ${hint.action}`)]
    const gap = spans.length ? [dim(HINT_SEPARATOR)] : []
    if (spans.length && spansWidth([...spans, ...gap, ...entry]) > width) {
      result.push(line(...spans))
      spans = []
    }
    spans.push(...(spans.length ? gap : []), ...truncateSpansToWidth(entry, width))
  }
  if (spans.length) result.push(line(...spans))
  return result
}

/** Layout must not repaint a selected band over the neighbouring details. */
export function selectorColumns(left: StyledLine[], right: StyledLine[], listWidth: number, divider = '  │ '): StyledLine[] {
  return Array.from({ length: Math.max(left.length, right.length) }, (_, index) => {
    const source = left[index]
    const spans = truncateSpansToWidth(source?.spans ?? [], listWidth)
    const padding: StyledSpan = { text: ' '.repeat(Math.max(0, listWidth - spansWidth(spans))), ...(source?.bg ? { bg: source.bg } : {}) }
    return line(...spans, padding, dim(divider), ...(right[index]?.spans ?? []))
  })
}
