/** Log mode drives a forked agent, so name it at the composer and use its own placeholder. */
import { getTheme } from '../../render/theme/index.js'
import { MODE_HINTS } from '../app/composer-guidance.js'

export type PromptMode = 'default' | 'log'

export interface PromptModeStyle {
  /** Hue of the mode label on the top rule. Unused in the default mode, which has no label. */
  hex: string
  /** Full-width placeholder. */
  hint: string
  /** Narrow-terminal placeholder, roughly half the full width. */
  shortHint: string
}

export function promptMode(input: { logMode: boolean }): PromptMode {
  return input.logMode ? 'log' : 'default'
}

export function promptModeLabels(input: { logMode: boolean }): string[] {
  return input.logMode ? ['log'] : []
}

export function promptModeStyle(mode: PromptMode): PromptModeStyle {
  const theme = getTheme()
  return mode === 'log'
    ? { hex: theme.accentHex, ...MODE_HINTS.log }
    : { hex: theme.brandHex, ...MODE_HINTS.normal }
}
