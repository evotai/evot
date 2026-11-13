import { pendingQueueHint } from '../app/queue/queue-manage.js'

/**
 * Visible copy for mid-stream queued user messages.
 *
 * Placed above the spinner/prompt (pi-style) so a message that vanished from
 * the input box still has a clear home, plus the one-line hint for getting it
 * back (Esc) or, when the backlog is paused, continuing it.
 */
export function formatQueuedMessageLines(
  messages: string[],
  options: { maxChars?: number; maxVisible?: number; paused?: number } = {},
): string[] {
  const maxChars = Number.isFinite(options.maxChars)
    ? Math.max(16, Math.floor(options.maxChars!))
    : 120
  const maxVisible = Number.isFinite(options.maxVisible)
    ? Math.max(1, Math.floor(options.maxVisible!))
    : 3

  const previews = messages
    .map(raw => raw.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  if (previews.length === 0) return []

  const shown = previews.slice(0, maxVisible)
  const lines = shown.map((one, index) => {
    const prefix = `#${index + 1} `
    const available = Math.max(1, maxChars - prefix.length)
    const text = one.length > available ? `${one.slice(0, Math.max(1, available - 1))}…` : one
    return `${prefix}${text}`
  })
  const hidden = previews.length - shown.length
  if (hidden > 0) lines.push(`↓ ${hidden} more queued`)
  lines.push(`↳ ${pendingQueueHint(options.paused ?? 0)}`)
  return lines
}
