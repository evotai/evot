/**
 * Memoized resume rows.
 *
 * Typing `/sessions` rekeys the mounted command window on every keystroke, and
 * the idle load that follows reformats the catalog. Rebuilding produced fresh
 * `SelectorItem` objects each time, which mattered more than the formatting
 * itself: the selector caches lowercased search text in a WeakMap keyed on the
 * item, so new identities threw that cache away and the next filter keystroke
 * re-lowercased every transcript.
 *
 * Reusing the previous rows when the inputs have not changed keeps both the
 * formatting and that lowercase cache alive, so a keystroke costs a repaint
 * instead of a rebuild.
 */

import type { SessionMeta, SessionWithText } from '../../../native/index.js'
import { formatSessionItems, isInteractiveSession } from '../../../session/resume.js'
import type { SelectorItem } from '../../../ui/selector.js'

export interface ResumeItemInputs {
  sessions: SessionMeta[]
  cwd: string
  /** Bumped whenever known session text changes, invalidating memoized rows. */
  textVersion: number
  /** Row cap for the bounded first paint, or undefined for the whole catalog. */
  limit?: number
  /** The session this REPL is in, marked `● open` in the list. */
  openSessionId?: string | null
}

interface Entry {
  sessions: SessionMeta[]
  cwd: string
  textVersion: number
  openSessionId: string | null
  items: SelectorItem[]
}

export class ResumeItemCache {
  /**
   * One entry per row cap.
   *
   * A single slot would thrash: each keystroke applies the bounded 20-row
   * preview and then the full catalog, so the two caps would evict each other
   * and neither would ever hit.
   */
  private readonly entries = new Map<number | 'all', Entry>()

  /**
   * Rows for these inputs, reusing the previous array when nothing changed.
   *
   * `sessions` is compared by identity: the cache and its callers pass the
   * stored snapshot array, which is replaced rather than mutated whenever the
   * catalog changes.
   */
  format(
    inputs: ResumeItemInputs,
    sessionText: (sessionId: string) => SessionWithText | undefined,
  ): SelectorItem[] {
    const slot = inputs.limit ?? 'all'
    const previous = this.entries.get(slot)
    if (
      previous
      && previous.sessions === inputs.sessions
      && previous.cwd === inputs.cwd
      && previous.textVersion === inputs.textVersion
      && previous.openSessionId === (inputs.openSessionId ?? null)
    ) {
      return previous.items
    }
    // Task runs never consume the bounded first paint's row budget.
    const interactive = inputs.sessions.filter(isInteractiveSession)
    const visible = inputs.limit === undefined
      ? interactive
      : interactive.slice(0, inputs.limit)
    const items = formatSessionItems(visible, inputs.cwd, sessionText, inputs.openSessionId)
    this.entries.set(slot, {
      sessions: inputs.sessions,
      cwd: inputs.cwd,
      textVersion: inputs.textVersion,
      openSessionId: inputs.openSessionId ?? null,
      items,
    })
    return items
  }

  /** Drop memoized rows; the next format rebuilds them. */
  clear(): void {
    this.entries.clear()
  }
}
