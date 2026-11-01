/**
 * Collapsing transient status lines in place.
 *
 * A status line is current state, not history, so a newer line replaces the
 * previous one. Lines collapse only within their own slot, and only while
 * trailing: any later output freezes the prior status into history.
 */

import type { OutputLine } from '../../render/output.js'

const STATUS_SLOTS = new Map<string, string>([
  ['sys-model', 'selection'],
  ['sys-think', 'selection'],
  ['sys-cloud-session', 'cloud-session'],
])

/** Which slot an id occupies, or undefined when it is not a status line. */
export function statusLineSlot(id: string): string | undefined {
  return STATUS_SLOTS.get(id)
}

/** Replace the trailing status line in the same slot, or append. */
export function replaceOrPushStatusLine(lines: OutputLine[], line: OutputLine): boolean {
  const last = lines.length > 0 ? lines[lines.length - 1] : undefined
  const slot = statusLineSlot(line.id)
  if (last && slot !== undefined && statusLineSlot(last.id) === slot) {
    lines[lines.length - 1] = line
    return true
  }
  lines.push(line)
  return false
}
