import { replayUserText, type ReplayTextPart } from './task-notification.js'

/** Legacy compaction envelope; explicit authored projections always win. */
export const COMPACT_SUMMARY_PREFIX = 'The conversation history before this'
export function isLegacyContextSummary(item: { text?: unknown; display_parts?: unknown }): boolean {
  return typeof item.text === 'string' && item.text.startsWith(COMPACT_SUMMARY_PREFIX)
    && !(Array.isArray(item.display_parts) && item.display_parts.some(part => part?.kind === 'user'))
}

/** The application publishes one shared display projection for CLI, browser
 * and recognition. Do not inspect runtime wording or strip XML here. */
export function replayUserInput(item: { text?: unknown; display_parts?: unknown }): ReplayTextPart[] {
  if (!Array.isArray(item.display_parts)) return replayUserText(typeof item.text === 'string' ? item.text : '')
  const result: ReplayTextPart[] = []
  for (const part of item.display_parts) {
    if (!part || typeof part !== 'object' || typeof part.text !== 'string') throw new Error('Invalid transcript display part')
    switch (part.kind) {
      case 'user': result.push({ kind: 'user', text: part.text }); break
      case 'notice': result.push({ kind: 'command-notice', text: part.text }); break
      case 'legacy': result.push(...replayUserText(part.text)); break
      default: throw new Error(`Unsupported transcript display part: ${String(part.kind)}`)
    }
  }
  return result
}
