import { stripVTControlCharacters } from 'node:util'
import type { RemoteBlock, RemoteDiffRow, RemoteMessage } from '../../../features/remote/protocol.js'
import { colorizeUnifiedDiffRows } from '../../../render/diff.js'
import { markdownToHtml } from '../../../markdown/render/html.js'
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
const MAX_DIFF_ROWS = 400
// SGR 48 opens a background (the word-level fill), 49 or a reset closes it.
function codeSegments(styled: string): RemoteDiffRow['code'] {
  const out: RemoteDiffRow['code'] = []
  let word = false
  const parts = styled.split(/\x1b\[([\d;]*)m/)
  parts.forEach((part, index) => {
    if (index % 2) {
      const codes = part.split(';')
      if (codes[0] === '48') word = true
      else if (codes.includes('49') || codes.includes('0') || part === '') word = false
      return
    }
    const text = displayText(part.replace(/\t/g, '    '))
    if (!text) return
    const last = out.at(-1)
    if (last && !!last.word === word) last.text += text
    else out.push(word ? { text, word: true } : { text })
  })
  return out
}
/** The TUI's own unified rows (no signs, as on a narrow pane), bounded for the wire. */
export function diffRows(patch: string, gutter = 0): RemoteDiffRow[] {
  const rows = colorizeUnifiedDiffRows(patch, false, gutter)
  const shown = rows.slice(0, MAX_DIFF_ROWS).map((row): RemoteDiffRow => {
    const num = row.gutter ? displayText(row.gutter).trimEnd() : undefined
    const code = codeSegments(row.code ?? row.text)
    // Header and separator rows carry the TUI's two-column indent; the phone's grid supplies its own.
    if ((row.kind === 'header' || row.kind === 'ellipsis') && code[0]) code[0].text = code[0].text.trimStart()
    return { kind: row.kind, ...(num !== undefined ? { num } : {}), code }
  })
  if (rows.length > shown.length) shown.push({ kind: 'ellipsis', code: [{ text: `… ${rows.length - shown.length} more lines in the TUI` }] })
  return shown
}
function toolCard(block: UIAssistantBlock, expanded: boolean): RemoteBlock | null {
  const cache = cards[expanded ? 1 : 0],
    cached = cache.get(block)
  if (cached !== undefined) return cached
  const lines = assistantContentToOutputLines([block], expanded),
    state = lines[0]?.toolCard?.state
  // ask_user, for example, owns its question UI instead of a card. A Write/Edit
  // patch travels as rows, so the phone can lay it out the way the TUI does.
  const text = lines.filter((l) => l.diffText === undefined).map((l) => displayText(l.text)).join('\n')
  const diff = lines.flatMap((l) => (l.diffText !== undefined ? diffRows(l.diffText, l.diffGutter) : []))
  const card: RemoteBlock | null = state
    ? { kind: 'tool', state, text: text.length <= MAX_TEXT ? text : text.slice(0, 3072) + '\n…\n' + text.slice(-5115),
        ...(diff.length ? { diff } : {}) }
    : null
  cache.set(block, card)
  return card
}
export function assistantRow(content: readonly UIAssistantBlock[], expanded = false): RemoteMessage | null {
  const blocks: RemoteBlock[] = [],
    budget = { text: MAX_TEXT, thinking: MAX_TEXT, tool: MAX_TEXT * 2, diff: MAX_TEXT * 3 }
  for (const b of [...content].sort((a, b) => b.contentIndex - a.contentIndex)) {
    if (blocks.length === 32) break
    if (b.type === 'tool_call') {
      if (budget.tool <= 0) continue
      const card = toolCard(b, expanded)
      if (card?.kind === 'tool') {
        // Patches have their own budget; past it, older cards keep their header only.
        const size = card.diff ? JSON.stringify(card.diff).length : 0
        if (size && size > budget.diff) { const { diff: _, ...bare } = card; blocks.push(bare) }
        else { blocks.push(card); budget.diff -= size }
        budget.tool -= card.text.length
      }
    } else if (budget[b.type] > 1 && (b.type === 'thinking' ? hasReasoningContent(b.text) : b.text.trim())) {
      const text = boundedText(b.text, budget[b.type])
      budget[b.type] -= text.length
      // Reasoning is Markdown too: the TUI renders it with the same renderer (renderThinkingMarkdown).
      blocks.push({ kind: b.type, text, html: markdownToHtml(text) })
    }
  }
  if (!blocks.length) return null
  blocks.reverse()
  const text = blocks.flatMap((b) => (b.kind === 'text' ? [b.text] : [])).join('\n')
  return { role: 'assistant', text, blocks }
}

// Match the single-prompt metadata title until the first save publishes it.
function openingTitle(text: string): string {
  // At most 80 Unicode code points; don't allocate an array for an entire pasted file.
  const head = displayText(text).trim().replace(/\s+/g, ' ').slice(0, 162)
  const chars = Array.from(head)
  return chars.length > 80 ? chars.slice(0, 80).join('') + '...' : head
}

export class ConversationTail {
  openingTitle = ''
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
  append(role: RemoteMessage['role'], text: string, photoId?: string): void {
    if (role === 'user' && !this.openingTitle) this.openingTitle = openingTitle(text)
    if (text.trim()) this.push({ role, text: boundedText(text), ...(photoId ? {photoId} : {}) })
  }
  appendNoticeCard(full: string, card: { state: 'error' | 'success'; summary: string }) {
    // Old phones render notice.text. New ones can fold long command/output rows
    // using the normal tool-view toggle. Never send the process object or raw args.
    const text = boundedText(displayText(full)), summary = boundedText(displayText(card.summary))
    const row = (body: string): RemoteMessage => ({role:'notice', text, blocks:[{kind:'tool', state:card.state, text:body}]})
    this.push(row(summary), row(text))
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
    const first = messages.find(m => m.role === 'user' && m.text.trim() && !isLegacyContextSummary(m))
    this.openingTitle = first ? openingTitle(first.text) : ''
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
