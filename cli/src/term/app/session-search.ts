/**
 * `/sessions <query>` on the TUI side.
 *
 * The search itself is an ordinary agent turn: the app prepares compact
 * session evidence and loads the session-search skill for semantic ranking.
 * This module only reads the answer back — the `- <id> — …` lines —
 * so the REPL can open the resume selector on what the agent found.
 */

import type { UIMessage } from './types.js'

/** Session ids from `- <id> — <title> — <reason>` lines, in answer order. */
export function parseSessionSearchResults(text: string): string[] {
  const ids: string[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*[-*]\s*`?([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})`?\s+[—–-]\s+/i.exec(line)
    if (match && !ids.includes(match[1]!)) ids.push(match[1]!)
  }
  return ids
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
