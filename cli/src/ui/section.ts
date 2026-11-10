import chalk from 'chalk'
import stringWidth from 'string-width'

import { getTheme } from './theme/index.js'

export const SECTION_INDENT = 2
export const SECTION_CONTENT_INDENT = 4
export const SECTION_MUTED = '#808080'

/** Shared bracketed heading used by banner blocks and detailed inventories. */
export function sectionHeaderLines(
  title: string,
  columns: number,
  meta?: string,
): string[] {
  const theme = getTheme()
  const heading = theme.accent.paint(`${' '.repeat(SECTION_INDENT)}[${title}]`)
  if (!meta) return [heading]

  const plainHeading = `${' '.repeat(SECTION_INDENT)}[${title}]  `
  const styledMeta = chalk.hex(SECTION_MUTED)(meta)
  if (stringWidth(plainHeading) + stringWidth(meta) <= columns) {
    return [`${heading}  ${styledMeta}`]
  }
  return [heading, `${' '.repeat(SECTION_CONTENT_INDENT)}${styledMeta}`]
}

/**
 * Pack complete items left-to-right with a compact separator, wrapping only
 * between items. Items may already contain ANSI styling.
 */
export function inlineItemLines(
  items: string[],
  columns: number,
  indent = SECTION_CONTENT_INDENT,
  separator = chalk.hex(SECTION_MUTED)(' | '),
): string[] {
  if (items.length === 0) return []

  const prefix = ' '.repeat(indent)
  const available = Math.max(1, columns - indent)
  const lines: string[] = []
  let line = ''

  for (const item of items) {
    const candidate = line ? `${line}${separator}${item}` : item
    if (line && stringWidth(candidate) > available) {
      lines.push(`${prefix}${line}`)
      line = item
    } else {
      line = candidate
    }
  }
  if (line) lines.push(`${prefix}${line}`)
  return lines
}
