import { stripVTControlCharacters } from 'node:util'
import type { RemoteBlock, RemoteMessage } from '../../../features/remote/protocol.js'
import type { UIAssistantBlock, UIMessage } from '../../../render/message-types.js'
import { assistantContentToOutputLines } from '../../../render/assistant.js'
import { hasReasoningContent } from '../../../render/output.js'
import { isLegacyContextSummary } from '../../../session/user-input.js'

const MAX_ROWS = 32
const MAX_TEXT = 8192
function boundedText(text: string, limit = MAX_TEXT): string {
  return text.length <= limit ? text : '…' + text.slice(1 - limit)
}
export const displayText = (text: string) =>
  stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')

// One immutable block, two TUI layouts. Cache the bounded display projection,
// not arguments/results. Polls of unchanged blocks do no formatting work.
const cards = [
  new WeakMap<UIAssistantBlock, RemoteBlock | null>(),
  new WeakMap<UIAssistantBlock, RemoteBlock | null>(),
] as const
function toolCard(block: UIAssistantBlock, expanded: boolean): RemoteBlock | null {
  const cache = cards[expanded ? 1 : 0],
    cached = cache.get(block)
  if (cached !== undefined) return cached
  const lines = assistantContentToOutputLines([block], expanded),
    state = lines[0]?.toolCard?.state
  // ask_user, for example, owns its question UI instead of a card.
  const text = lines.map((l) => displayText(l.text)).join('\n')
  const card: RemoteBlock | null = state
    ? { kind: 'tool', state, text: text.length <= MAX_TEXT ? text : text.slice(0, 3072) + '\n…\n' + text.slice(-5115) }
    : null
  cache.set(block, card)
  return card
}
export function assistantRow(content: readonly UIAssistantBlock[], expanded = false): RemoteMessage | null {
  const blocks: RemoteBlock[] = [],
    budget = { text: MAX_TEXT, thinking: MAX_TEXT, tool: MAX_TEXT * 2 }
  for (const b of [...content].sort((a, b) => b.contentIndex - a.contentIndex)) {
    if (blocks.length === 32) break
    if (b.type === 'tool_call') {
      if (budget.tool <= 0) continue
      const card = toolCard(b, expanded)
      if (card) {
        blocks.push(card)
        budget.tool -= card.text.length
      }
    } else if (budget[b.type] > 1 && (b.type === 'thinking' ? hasReasoningContent(b.text) : b.text.trim())) {
      const text = boundedText(b.text, budget[b.type])
      budget[b.type] -= text.length
      blocks.push({ kind: b.type, text })
    }
  }
  if (!blocks.length) return null
  blocks.reverse()
  const text = blocks.flatMap((b) => (b.kind === 'text' ? [b.text] : [])).join('\n')
  return blocks.some((b) => b.kind !== 'text') ? { role: 'assistant', text, blocks } : { role: 'assistant', text }
}

export class ConversationTail {
  updatedAt = Date.now()
  outcome: 'Completed' | 'Stopped' | 'Run failed · see the TUI' | null = null
  offset = 0
  private rows: { compact: RemoteMessage; expanded: RemoteMessage }[] = []
  get messages() {
    return this.view(false)
  }
  view(expanded: boolean): readonly RemoteMessage[] {
    return this.rows.map((r) => (expanded ? r.expanded : r.compact))
  }
  private push(compact: RemoteMessage, expanded = compact) {
    this.updatedAt = Date.now()
    this.rows.push({ compact, expanded })
    if (this.rows.length > MAX_ROWS) {
      this.rows.shift()
      this.offset++
    }
  }
  append(role: RemoteMessage['role'], text: string): void {
    if (text.trim()) this.push({ role, text: boundedText(text) })
  }
  appendAssistant(content: readonly UIAssistantBlock[]) {
    const row = assistantRow(content)
    if (row) this.push(row, row.blocks?.some((b) => b.kind === 'tool') ? assistantRow(content, true) ?? row : row)
  }
  replace(messages: readonly UIMessage[]): void {
    this.updatedAt = Date.now()
    this.offset += this.rows.length + 1
    this.rows = []
    this.outcome = null
    for (let index = messages.length - 1; index >= 0; index--) {
      const m = messages[index]!
      // Only format the visible tail, not every old tool result on /resume.
      if (m.role === 'user' && !isLegacyContextSummary(m)) this.append('user', m.text)
      else if (m.role === 'assistant' && !m.compaction) {
        if (m.content?.length) this.appendAssistant(m.content)
        else this.append('assistant', m.text)
      }
      if (this.rows.length === MAX_ROWS) break
    }
    this.rows.reverse()
  }
}
