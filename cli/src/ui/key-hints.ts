/**
 * Keyboard hint formatting for overlay footers.
 *
 * One place owns how a chord is spelled, so every surface that advertises a key
 * reads the same way: `↑↓ select · ↵ confirm · x stop · esc close`.
 *
 * Verb vocabulary, shared by every footer:
 * - `select`  ↑↓ moves the highlight
 * - `confirm` ↵ acts on the highlighted row
 * - `close`   esc leaves the surface without acting
 * - `cancel`  esc also abandons an edit in progress
 * - `search`  typing filters the list
 */

/** Separator between hint entries. */
export const HINT_SEPARATOR = ' · '

/**
 * Display names for named keys. Bare characters (`x`, `f`) are shown as typed,
 * so only keys whose names differ from their glyphs are listed.
 */
const KEY_LABELS: Record<string, string> = {
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  enter: '↵',
  escape: 'esc',
  tab: 'tab',
  space: 'space',
  backspace: 'backspace',
  delete: 'delete',
}

/** Arrow pairs fuse (`↑↓`, `←→`); other alternatives keep a slash (`j/k`). */
const FUSED = new Set(['↑', '↓', '←', '→'])

/** Spell one key, or a set of interchangeable keys. */
export function formatChord(keys: string | string[]): string {
  const list = (typeof keys === 'string' ? [keys] : keys).map(key => KEY_LABELS[key] ?? key)
  return list.every(key => FUSED.has(key)) ? list.join('') : list.join('/')
}

export interface Hint {
  /** Explicit armed confirmation, never inferred from action wording. */
  confirmationPending?: boolean
  /** The key, or interchangeable keys, that trigger the action. */
  keys: string | string[]
  /** Verb phrase completing "<key> to …". */
  action: string
}

/**
 * How to spell the background chord for the terminal we are running in.
 *
 * Ctrl+B is tmux's own default prefix, so inside tmux a single press is
 * swallowed by tmux and never reaches us. Pressing it twice is what tmux's
 * `send-prefix` forwards as a literal 0x02, so the binding does work there --
 * only the advertised spelling was wrong, which is worse than no hint at all: a
 * user who presses once sees nothing happen and concludes the feature is broken.
 *
 * Assumes tmux's default prefix, the same assumption Claude Code makes. A user
 * who rebound the prefix has already made ctrl+b arrive directly, so the plain
 * spelling would be the correct one and this hint overstates it. Harmless in
 * that direction: pressing twice still backgrounds, once.
 */
export function backgroundChord(env: NodeJS.ProcessEnv = process.env): string {
  return insideTmux(env) ? 'ctrl+b ctrl+b (twice)' : 'ctrl+b'
}

/**
 * The same chord in the help overlay's title case.
 *
 * Separate spelling, one source for the condition: the overlay lists keys as
 * `Ctrl+B` alongside `Ctrl+G` and `Esc`, so lowercasing one row to share a
 * string would read as a typo.
 */
export function backgroundChordLabel(env: NodeJS.ProcessEnv = process.env): string {
  return insideTmux(env) ? 'Ctrl+B Ctrl+B (twice)' : 'Ctrl+B'
}

function insideTmux(env: NodeJS.ProcessEnv): boolean {
  return env.TMUX !== undefined && env.TMUX !== ''
}
