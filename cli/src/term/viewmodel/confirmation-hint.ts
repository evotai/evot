import { getTheme } from '../../ui/theme/index.js'
import { line, styledLineToAnsi, type StyledSpan } from './types.js'

/** Shared two-step confirmation treatment. Only foreground changes: never
 * bold, dim, flash, add a glyph, or change the caller's text/geometry. */
export function confirmationHint(text: string, pending: boolean): StyledSpan {
  const theme = getTheme()
  return { text, hex: pending ? theme.accentHex : theme.mutedHex }
}

/** Adapter for the spinner's ANSI output. Clear inherited dim/bold first so
 * the pending hint is not muted by the surrounding status line. */
export function confirmationHintAnsi(text: string, pending: boolean): string {
  if (!text) return ''
  return `\x1b[22m${styledLineToAnsi(line(confirmationHint(text, pending)))}\x1b[0m`
}
