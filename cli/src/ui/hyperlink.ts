/**
 * OSC 8 terminal hyperlinks.
 *
 * Format: \x1b]8;;URL\x07 TEXT \x1b]8;;\x07
 * Falls back to plain text when the terminal doesn't support hyperlinks.
 */

import chalk from 'chalk'

const OSC8_START = '\x1b]8;;'
const OSC8_END = '\x07'

/**
 * Terminals that advertise themselves via TERM_PROGRAM or LC_TERMINAL and
 * support OSC 8. LC_TERMINAL is important because tmux overwrites
 * TERM_PROGRAM to "tmux" but many terminals (e.g. iTerm2) preserve their
 * identity in LC_TERMINAL. Kept in sync with claudecode's detection list.
 */
const ADDITIONAL_HYPERLINK_TERMINALS = new Set([
  'ghostty',
  'Hyper',
  'kitty',
  'alacritty',
  'iTerm.app',
  'iTerm2',
  'WezTerm',
  'vscode',
  'zed',
])

/**
 * Detect OSC 8 hyperlink support.
 * Most modern terminals (iTerm2, WezTerm, Ghostty, kitty, alacritty, zed,
 * Windows Terminal, VTE ≥ 0.50) support it. We mirror claudecode's logic so
 * behavior matches across the same terminal — including tmux sessions where
 * TERM_PROGRAM is overwritten but LC_TERMINAL survives.
 */
export function supportsHyperlinks(): boolean {
  const env = process.env
  // Force override
  if (env.FORCE_HYPERLINK === '1') return true
  if (env.FORCE_HYPERLINK === '0') return false
  // CI / dumb terminals — no
  if (env.CI || env.TERM === 'dumb') return false
  // Explicit non-supporters
  // macOS Terminal.app does NOT support OSC 8
  if (env.TERM_PROGRAM === 'Apple_Terminal') return false
  // WarpTerminal does NOT support OSC 8 (warpdotdev/Warp#4194)
  // but it auto-detects file paths in plain text — see isWarpTerminal()
  if (env.TERM_PROGRAM === 'WarpTerminal') return false
  // Windows Terminal
  if (env.WT_SESSION) return true
  // Known supporting terminals by TERM_PROGRAM
  if (env.TERM_PROGRAM && ADDITIONAL_HYPERLINK_TERMINALS.has(env.TERM_PROGRAM)) {
    return true
  }
  // LC_TERMINAL survives tmux where TERM_PROGRAM is overwritten to "tmux"
  if (env.LC_TERMINAL && ADDITIONAL_HYPERLINK_TERMINALS.has(env.LC_TERMINAL)) {
    return true
  }
  // Kitty sets TERM=xterm-kitty
  if (env.TERM && env.TERM.includes('kitty')) return true
  // Alacritty sets TERM=alacritty
  if (env.TERM === 'alacritty') return true
  // Legacy env var — some older kitty builds set KITTY_PID without TERM
  if (env.KITTY_PID) return true
  // VTE-based terminals (GNOME Terminal, Tilix, etc.) — v0.50+
  if (env.VTE_VERSION) {
    const v = parseInt(env.VTE_VERSION, 10)
    if (!isNaN(v) && v >= 5000) return true
  }
  // Default: off (safe fallback)
  return false
}

/**
 * Warp Terminal auto-detects file paths in plain text and makes them clickable,
 * but ANSI color codes break this detection. Use this to skip coloring file paths.
 */
export function isWarpTerminal(): boolean {
  return process.env.TERM_PROGRAM === 'WarpTerminal'
}

/**
 * Create a clickable hyperlink using OSC 8 escape sequences.
 * Falls back to showing link text + URL when the terminal doesn't support
 * hyperlinks, so the URL is never lost.
 *
 * @param url - The URL to link to
 * @param text - Display text (shown as clickable link when supported).
 *               When not supported, shows "text (url)" or just the URL.
 */
export function createHyperlink(url: string, text?: string): string {
  if (!supportsHyperlinks()) {
    // Show both link text and URL so nothing is lost.
    // Format: "text (url)" when text differs from url, otherwise just the url.
    if (text && text !== url) {
      return `${text} (${chalk.blue(url)})`
    }
    return chalk.blue(url)
  }
  const display = text ?? url
  const colored = chalk.blue(display)
  return `${OSC8_START}${url}${OSC8_END}${colored}${OSC8_START}${OSC8_END}`
}

/**
 * Wrap pre-styled text in an OSC 8 hyperlink without changing its color.
 * Falls back to the original text when the terminal doesn't support hyperlinks.
 */
export function wrapHyperlink(url: string, styledText: string): string {
  if (!supportsHyperlinks()) {
    return styledText
  }
  return `${OSC8_START}${url}${OSC8_END}${styledText}${OSC8_START}${OSC8_END}`
}
