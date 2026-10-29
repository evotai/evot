/**
 * `/sessions <query>` on the TUI side.
 *
 * The search itself is an ordinary agent turn: the app loads the
 * session-search skill and attaches the run-scoped `session_search` tool; the
 * model reads the time range from the request and pages through the archive.
 * This module only reads the answer back — the `- <id> — …` lines —
 * so the REPL can open the resume selector on what the agent found.
 */

import type { UIMessage } from './types.js'

export interface SessionSearchResult {
  sessionId: string
  /** What the session roughly did; the line its result row shows. */
  summary: string
}

/** Keep the search explanation, not just the id, in the agent's ranked order. */
export function parseSessionSearchResults(text: string): SessionSearchResult[] {
  const results: SessionSearchResult[] = []
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    const match = /^\s*[-*]\s*`?([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|ch_[0-9a-f]{32})`?\s+[—–-]\s+(.+)$/i.exec(line)
    if (!match) continue
    const sessionId = match[1]!
    if (seen.has(sessionId)) continue
    // `<date> — <summary>`. Answers from older prompts put a title before
    // the date; the summary is still what follows the date.
    const parts = match[2]!.trim().split(/\s+[—–-]\s+/)
    const date = parts.findIndex(part => /^\d{4}-\d{2}-\d{2}$/.test(part.trim()))
    const tail = date >= 0 && date < parts.length - 1 ? parts.slice(date + 1) : parts.filter((_, at) => at !== date)
    // A list row reads as a phrase; a closing period only takes width.
    const summary = tail.join(' — ').trim().replace(/[。.]$/, '')
    if (!summary) continue
    seen.add(sessionId)
    results.push({ sessionId, summary })
  }
  return results
}

/** Text of the last assistant message, or '' when the run produced none. */
export function lastAssistantText(messages: UIMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role !== 'assistant') continue
    if (!message.content) return message.text
    return message.content
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('\n')
  }
  return ''
}
