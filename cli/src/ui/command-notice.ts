import chalk from 'chalk'
import { SECTION_INDENT, SECTION_CONTENT_INDENT, SECTION_MUTED } from './section.js'
import { getTheme } from './theme/index.js'

export interface CommandNotice {
  message: string
  state?: 'info' | 'progress' | 'success' | 'error'
  label?: string
  /** Unindented detail rows; empty rows retain paragraph spacing. */
  details?: string[]
}

/**
 * Shared presentation for command status and results. Commit as pre-styled.
 *
 * An error notice spends its colour on the `✗` alone; the message stays in
 * the terminal's default ink so it reads as text, not as an alarm.
 */
export function renderCommandNotice(notice: CommandNotice): string {
  const muted = (text: string): string => chalk.hex(SECTION_MUTED)(text)
  const state = notice.state ?? 'info'
  const marker = state === 'progress' ? muted('⋯')
    : state === 'success' ? chalk.green('✓')
      : state === 'error' ? chalk.hex(getTheme().errorHex)('✗') : ''
  const label = notice.label ? `${getTheme().brandBold.paint(notice.label)}  ` : ''
  const message = state === 'error' ? notice.message : muted(notice.message)
  return [
    `${' '.repeat(SECTION_INDENT)}${marker ? `${marker} ` : ''}${label}${message}`,
    ...(notice.details ?? []).map(row => row ? `${' '.repeat(SECTION_CONTENT_INDENT)}${muted(row)}` : ''),
  ].join('\n')
}

/** A one-line failure notice: `  ✗ <message>`. The only way to paint an error row. */
export function renderErrorNotice(message: string): string {
  return renderCommandNotice({ state: 'error', message })
}
