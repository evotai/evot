/** Historical background notifications were stored as model-facing user text.
 * Recognize only the complete runtime envelope, not arbitrary XML mentions.
 * This projection is display-only; stored content and model input are untouched.
 */
import { commandDisplay, parseCommandPrompt } from './command-envelope.js'

export type ReplayTextPart = { kind: 'user' | 'task-notification' | 'command-notice' | 'runtime-context'; text: string }

/** Runtime context the host appended for the model. Mirrors the Rust legacy
 * adapter: a complete `<system-reminder>` block at a trailing line boundary,
 * never an inline mention or a quoted example inside a code fence. */
const REMINDER = 'system-reminder'

function inCodeFence(text: string): boolean {
  let open: { marker: string; count: number } | undefined
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/^ {0,3}/, '')
    const match = /^(`{3,}|~{3,})/.exec(trimmed)
    if (!match) continue
    const marker = match[1]![0]!
    const count = match[1]!.length
    if (!open) open = { marker, count }
    else if (marker === open.marker && count >= open.count && trimmed.slice(count).trim() === '') open = undefined
  }
  return open !== undefined
}

/** Split trailing runtime reminders off the authored text. The reminder
 * blocks are returned oldest first; `authored` is what the user typed. */
function stripTrailingReminders(text: string): { authored: string; reminders: string[] } {
  const reminders: string[] = []
  let prefix = text
  for (;;) {
    const trimmed = prefix.replace(/\s+$/, '')
    const close = `\n</${REMINDER}>`
    if (!trimmed.endsWith(close)) break
    const open = `<${REMINDER}>`
    // Either appended after authored text or the entire message (a nudge).
    const start = trimmed.lastIndexOf(`\n${open}`)
    const blockStart = start >= 0 ? start + 1 : trimmed.startsWith(open) ? 0 : -1
    if (blockStart < 0) break
    const before = trimmed.slice(0, Math.max(0, blockStart - 1))
    const block = trimmed.slice(blockStart).replace(/\r\n/g, '\n')
    const body = block.slice(`<${REMINDER}>\n`.length, block.length - close.length)
    if (!block.startsWith(`<${REMINDER}>\n`) || body.includes(`<${REMINDER}>`) || body.includes(`</${REMINDER}>`)) break
    // A reminder-only message is a runtime nudge; one after fenced text is a quote.
    if (before.trim() && inCodeFence(before)) break
    reminders.unshift(block)
    prefix = before
  }
  return { authored: reminders.length ? prefix.replace(/\s+$/, '') : text, reminders }
}

const envelope = /^<task-notification>\r?\n<task-id>([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})<\/task-id>\r?\n<status>(completed|failed|killed|timed_out)<\/status>\r?\n(?:<exit-code>(-?\d+)<\/exit-code>\r?\n)?(?:<output-truncated>true<\/output-truncated>\r?\n)?<summary>[^\r\n]*<\/summary>\r?\n<output-file>[^\r\n]+<\/output-file>\r?\n<\/task-notification>(?=\r?$)/gm

export function replayUserText(text: string): ReplayTextPart[] {
  // A host-expanded command: show the user's line (or a wakeup notice), never
  // the instructions the host attached for the model.
  const command = parseCommandPrompt(text)
  if (command) {
    const display = commandDisplay(command)
    return [{ kind: display.kind === 'user' ? 'user' : 'command-notice', text: display.text }]
  }
  const stripped = stripTrailingReminders(text)
  const reminders: ReplayTextPart[] = stripped.reminders.map(block => ({ kind: 'runtime-context', text: block }))
  if (stripped.reminders.length) {
    text = stripped.authored
    if (!text.trim()) return reminders
  }
  const parts: ReplayTextPart[] = []
  let cursor = 0
  for (const match of text.matchAll(envelope)) {
    const start = match.index
    // A quoted code example is still the user's text. Do not reinterpret it.
    const before = text.slice(0, start)
    let fence: string | undefined
    for (const line of before.split('\n')) {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
      if (!marker) continue
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
    }
    if (fence) continue
    if (start > cursor && text.slice(cursor, start).trim()) {
      parts.push({ kind: 'user', text: text.slice(cursor, start).trim() })
    }
    const id = match[1] ?? ''
    const status = match[2]
    const label = status === 'completed' ? '✓ Background task completed'
      : status === 'killed' ? '■ Background task cancelled'
      : status === 'timed_out' ? '✗ Background task timed out' : '✗ Background task failed'
    parts.push({ kind: 'task-notification', text: `${label} · ${id.slice(0, 8)}${match[3] !== undefined ? ` · exit ${match[3]}` : ''}` })
    cursor = start + match[0].length
  }
  if (cursor === 0) return [{ kind: 'user', text }, ...reminders]
  if (text.slice(cursor).trim()) parts.push({ kind: 'user', text: text.slice(cursor).trim() })
  return [...parts, ...reminders]
}
