import { resolveCommand } from '../../commands/index.js'
import type { KeyEvent } from '../input.js'

export type CommandWindowTrigger = 'resume' | 'model' | 'skill' | 'task' | 'compute' | 'share' | 'help'

const COMMAND_WINDOW_NAMES = ['/resume', '/sessions', '/model', '/skill', '/task', '/compute', '/share', '/help'] as const

/**
 * An incomplete command-window spelling that is not unique yet. When a command
 * window is already mounted, this is a transition state rather than a reason
 * to remove it: `/re` → `/` → `/mo` can then swap content in place without an
 * empty frame between the session and model windows.
 */
export function isCommandWindowBridge(text: string): boolean {
  if (!/^\/[a-z_]*$/.test(text)) return false
  return COMMAND_WINDOW_NAMES.some(name => name.startsWith(text))
}

/**
 * Only deliberate typing may mount a command window. History navigation,
 * paste, undo and the like can also leave `/model` in the composer, but the
 * user did not spell the command just now, so the window stays down until a
 * real edit keystroke arrives. An already mounted window keeps refreshing on
 * every event so it can bridge, update, or dismiss as before.
 */
export function isCommandWindowTypingEvent(event: KeyEvent): boolean {
  return event.type === 'char'
    || event.type === 'shift-char'
    || event.type === 'backspace'
    || event.type === 'delete'
}

/**
 * Resolve an argument-free slash command or unique prefix that owns a formal
 * window. Resolution drives the live preview; the REPL still requires an
 * explicit up/down keypress before moving focus out of the composer.
 */
export function resolveCommandWindowTrigger(text: string): CommandWindowTrigger | null {
  // Whitespace means argument entry. Arrow keys must remain editor/history
  // controls rather than unexpectedly moving focus into a command window.
  if (!/^\/[a-z_]+$/.test(text)) return null

  const resolved = resolveCommand(text)
  if (resolved.kind !== 'resolved' || resolved.args) return null

  if (resolved.name === '/resume') return 'resume'
  if (resolved.name === '/model') return 'model'
  if (resolved.name === '/skill') return 'skill'
  if (resolved.name === '/task') return 'task'
  if (resolved.name === '/compute') return 'compute'
  if (resolved.name === '/share') return 'share'
  if (resolved.name === '/help') return 'help'
  return null
}
