import type { SuggestionFeedback, SuggestionPosition } from '../app/suggestion/types.js'
import stringWidth from 'string-width'
import { wrapTextByWidth } from './width.js'
import { line, dim, type StyledLine, type StyledSpan } from './types.js'

interface SuggestionDisplay {
  suggestionStatus?: SuggestionFeedback
  suggestionFrame?: number
  suggestionPosition?: SuggestionPosition
  suggestionReplacing?: boolean
}

const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✽', '✻', '✶', '✳', '✢', '·']

/** Presentation only: request state and candidate selection live in app/. */
export function suggestionStatusText(input: SuggestionDisplay): string {
  switch (input.suggestionStatus) {
    case 'pending': return `  ${FRAMES[(input.suggestionFrame ?? 0) % FRAMES.length]} suggesting…`
    case 'none': return '  · nothing to suggest · ⇥ retry'
    case 'failed': return '  · suggestion failed · ⇥ retry'
    case 'timed_out': return '  · suggestion timed out · ⇥ retry'
    case 'unavailable': return '  · suggestions unavailable · ⇥ retry'
    default: return ''
  }
}

/** Append a ghost replacement while keeping the real caret on the prefix.
 * Only the first ghost row shares space with the prefix; subsequent rows use
 * the full width. Never split a grapheme or let a wide glyph cross the frame. */
export function appendCompletionLines(rows: StyledLine[], prefix: StyledSpan[], prefixText: string, ghost: string, width: number): void {
  const parts = ghost.split('\n')
  const first = parts.shift() ?? ''
  const room = Math.max(0, width - stringWidth(prefixText))
  const chunk = room ? wrapTextByWidth(first, room)[0] : undefined
  const initial = chunk ? first.slice(0, chunk.end) : ''
  const fits = stringWidth(initial) <= room
  const consumed = fits ? initial.length : 0
  rows.push(line(...prefix, ...(consumed ? [dim(initial)] : [])))
  const remainder = first.slice(consumed)
  if (remainder) parts.unshift(remainder)
  for (const part of parts) {
    for (const chunk of wrapTextByWidth(part, width)) {
      rows.push(line(dim(part.slice(chunk.start, chunk.end) || ' ')))
    }
  }
}

/** Tab cycles the same three candidates; Right inserts, never submits. */
export function suggestionAcceptHint(input: SuggestionDisplay): string {
  if (input.suggestionStatus) return `${suggestionStatusText(input)} · → accept`
  const position = input.suggestionPosition
  const action = input.suggestionReplacing ? 'replace rest' : 'accept'
  return position && position.total > 1
    ? `  ${position.current}/${position.total} ⇥ next · → ${action}`
    : `  ⇥ next · → ${action}`
}
