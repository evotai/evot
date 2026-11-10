/**
 * Dark/light theme for terminal rendering.
 *
 *   types.ts  — the `Theme` contract
 *   dark.ts   — dark palette
 *   light.ts  — light palette
 *   scheme.ts — scheme detection + cached active theme
 */

export type { Style, Theme, ThemeScheme } from './types.js'
export { darkTheme } from './dark.js'
export { lightTheme } from './light.js'
export {
  getChalk,
  getTheme,
  getThemeScheme,
  resetDetectedThemeScheme,
  resetThemeCache,
  setDetectedThemeScheme,
} from './scheme.js'
