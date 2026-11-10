/**
 * Shared markdown/terminal primitives.
 *
 * Low-level helpers used by the ANSI renderer, the viewmodel, and the
 * streaming commit-point splitter: terminal width math, ANSI-aware wrapping,
 * and a few fence-detection predicates.
 *
 * Broader markdown glue-normalization lives in `normalize/fences/` and is
 * limited to fence-boundary repairs (glued opens / stray closes / unclosed).
 */

import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'
import { wrapTextWithAnsi } from '../ui/wrap.js'

export const EOL = '\n'
export const SAFETY_MARGIN = 4

// Fenced code block opener/closer, e.g. ```lang or ~~~.
export const CODE_FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/
// Box-drawing characters used in tree/diagram structures (U+2500–U+257F).
export const BOX_DRAWING_RE = /[\u2500-\u257f]/

export function terminalDisplayWidth(text: string): number {
  return stringWidth(stripAnsi(text))
}

function safeTerminalColumns(): number {
  const columns = process.stdout.columns
  return Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 80
}

export function terminalContentWidth(): number {
  const columns = safeTerminalColumns()
  return Math.max(20, columns - SAFETY_MARGIN)
}

export function wrapDisplayTextWithIndent(
  text: string,
  firstIndent: string,
  restIndent: string,
  width = terminalContentWidth(),
): string {
  const firstInnerWidth = Math.max(1, width - terminalDisplayWidth(firstIndent))
  const restInnerWidth = Math.max(1, width - terminalDisplayWidth(restIndent))
  return text
    .split(EOL)
    .flatMap((line, lineIndex) => {
      const innerWidth = lineIndex === 0 ? firstInnerWidth : restInnerWidth
      if (!line || BOX_DRAWING_RE.test(stripAnsi(line))) return [line]
      return wrapTextWithAnsi(line, innerWidth)
    })
    .map((line, index) => `${index === 0 ? firstIndent : restIndent}${line}`)
    .join(EOL)
}

/**
 * Soft-wrap a paragraph to fit the terminal width via the shared ANSI-aware
 * primitive. Skips lines containing Unicode box-drawing characters — those are
 * structural tree/diagram art and must not be reflowed.
 */
export function wrapParagraph(text: string, width = terminalContentWidth()): string {
  return text
    .split(EOL)
    .flatMap(line => {
      if (!line || BOX_DRAWING_RE.test(stripAnsi(line))) return [line]
      if (terminalDisplayWidth(line) <= width) return [line]
      return wrapTextWithAnsi(line, width)
    })
    .join(EOL)
}
