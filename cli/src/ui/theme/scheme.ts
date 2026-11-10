/**
 * Scheme resolution and the cached active theme.
 *
 * Priority: explicit `EVOT_THEME` → measured background (OSC 11) → reported
 * color scheme (DSR / mode 2031) → `COLORFGBG` heuristic → dark.
 * A reported scheme can follow the OS appearance rather than the terminal's
 * configured palette, so it must not override a measured background.
 */

import chalk, { type ChalkInstance } from 'chalk'
import { darkTheme } from './dark.js'
import { lightTheme } from './light.js'
import type { Theme, ThemeScheme } from './types.js'

let detectedScheme: ThemeScheme | null = null
let backgroundScheme: ThemeScheme | null = null

function envThemeOverride(): ThemeScheme | null {
  const override = process.env.EVOT_THEME?.toLowerCase()
  if (override === 'light') return 'light'
  if (override === 'dark') return 'dark'
  return null
}

function detectSchemeFromEnv(): ThemeScheme {
  const colorfgbg = process.env.COLORFGBG
  if (colorfgbg) {
    const parts = colorfgbg.split(';')
    const bg = parts[parts.length - 1]
    // Only the conventional white slots are a light-background hint.
    // Slot 8 is bright black, not white; higher indices are not necessarily
    // light either. Unknown/custom palette indices keep the dark fallback.
    if (bg === '7' || bg === '15') return 'light'
  }
  return 'dark'
}

function resolveScheme(): ThemeScheme {
  return envThemeOverride() ?? backgroundScheme ?? detectedScheme ?? detectSchemeFromEnv()
}

let cached: Theme | null = null
let cachedScheme: ThemeScheme | null = null

export function getTheme(): Theme {
  const scheme = resolveScheme()
  if (cached && cachedScheme === scheme) return cached
  cachedScheme = scheme
  cached = scheme === 'dark' ? darkTheme() : lightTheme()
  return cached
}

export function getThemeScheme(): ThemeScheme {
  return resolveScheme()
}

/**
 * Apply a scheme detected from the terminal. Background measurements take
 * precedence over scheme reports regardless of response order.
 * Returns true when the effective theme changed (callers should rebuild
 * committed ANSI history). EVOT_THEME overrides suppress effective changes.
 */
export function setDetectedThemeScheme(
  scheme: ThemeScheme,
  source: 'color-scheme' | 'osc11-background' = 'color-scheme',
): boolean {
  const previous = resolveScheme()
  if (source === 'osc11-background') backgroundScheme = scheme
  else detectedScheme = scheme
  if (previous === resolveScheme()) return false
  resetThemeCache()
  return true
}

/** Reset cached theme (for tests). */
export function resetThemeCache(): void {
  cached = null
  cachedScheme = null
}

/** Reset runtime detection + cache (for tests). */
export function resetDetectedThemeScheme(): void {
  detectedScheme = null
  backgroundScheme = null
  resetThemeCache()
}

/** Exported for code that only needs the chalk instance. */
export function getChalk(): ChalkInstance {
  return chalk
}
