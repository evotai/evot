/**
 * Parse raw transcript items (from NAPI loadTranscript) into UIMessages
 * with ordered assistant content and completed tool results.
 */

import { replayUserInput } from './user-input.js'
import { toolArgsRecord } from '../term/app/tool-args.js'
import type { TranscriptItem } from '../native/index.js'
import type { UIAssistantBlock, UIMessage } from '../term/app/types.js'

// ---------------------------------------------------------------------------
// Raw transcript item shapes (from Rust TranscriptItem serialization)
// ---------------------------------------------------------------------------

type RawAssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }

interface RawItem {
  type: string
  // User
  text?: string
  display_parts?: unknown
  // Assistant content uses an array; tool results use a string.
  content?: RawAssistantBlock[] | string
  // Transcripts written before the canonical content migration.
  content_blocks?: RawAssistantBlock[]
  stop_reason?: string
  // ToolResult
  tool_call_id?: string
  tool_name?: string
  is_error?: boolean
  details?: unknown
  // Stats
  kind?: string
  data?: Record<string, unknown>
  // Compact
  reason?: 'threshold' | 'overflow' | 'manual' | 'prune' | 'refusal'
  summary?: string
  tokens_before?: number
  tokens_after?: number
  messages_before?: number
  messages_after?: number
}

// ---------------------------------------------------------------------------
// Main conversion
// ---------------------------------------------------------------------------

export function transcriptToMessages(items: TranscriptItem[]): UIMessage[] {
  const rawItems = items as unknown as RawItem[]
  const messages: UIMessage[] = []
  const toolResults = collectToolResults(rawItems)
  let idx = 0

  for (const item of rawItems) {
    const t = item.type
    if (t === 'user') {
      for (const part of replayUserInput(item)) {
        // Model-facing runtime context has no user-facing form; the addon's
        // display projection hides it too.
        if (part.kind === 'runtime-context') continue
        messages.push({
          id: `transcript-${part.kind}-${idx++}`,
          role: part.kind === 'user' ? 'user' : 'system',
          text: part.text,
          timestamp: 0,
        })
      }
    } else if (t === 'assistant') {
      const canonical = Array.isArray(item.content) ? item.content : undefined
      const content = buildAssistantContent(canonical ?? item.content_blocks ?? [], toolResults)
      const text = content
        .filter((block): block is Extract<UIAssistantBlock, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('')

      messages.push({
        id: `transcript-assistant-${idx++}`,
        role: 'assistant',
        text,
        timestamp: 0,
        content,
      })
    } else if (t === 'compact') {
      const details = item.details && typeof item.details === 'object' && !Array.isArray(item.details)
        ? item.details as Record<string, unknown>
        : undefined
      messages.push({
        id: `transcript-compact-${idx++}`,
        role: 'assistant',
        text: '',
        timestamp: 0,
        compaction: {
          reason: item.reason ?? 'threshold',
          summary: item.summary ?? '',
          tokensBefore: item.tokens_before ?? 0,
          tokensAfter: item.tokens_after ?? 0,
          messagesBefore: item.messages_before ?? 0,
          messagesAfter: item.messages_after ?? 0,
          method: typeof details?.method === 'string' ? details.method : undefined,
          remoteBlobBytes: typeof details?.remote_blob_bytes === 'number' ? details.remote_blob_bytes : undefined,
          fallbackReason: typeof details?.fallback_reason === 'string' ? details.fallback_reason : undefined,
        },
      })
    }
    // stats, tool_result, system, extension, marker — skipped
  }

  return messages
}

function buildAssistantContent(
  persisted: RawAssistantBlock[],
  toolResults: Map<string, { content: string; isError: boolean; details?: unknown }>,
): UIAssistantBlock[] {
  return persisted.map((block, contentIndex): UIAssistantBlock => {
    switch (block.type) {
      case 'thinking':
        return { type: 'thinking', contentIndex, text: block.text }
      case 'tool_call': {
        const result = toolResults.get(block.id)
        const args = toolArgsRecord(block.input) ?? {}
        return {
          type: 'tool_call',
          contentIndex,
          toolCall: {
            id: block.id,
            name: block.name,
            args,
            status: result ? (result.isError ? 'error' : 'done') : 'queued',
            result: result?.content,
            details: result?.details,
            previewCommand: inferPreviewCommand(block.name, args),
          },
        }
      }
      case 'text':
        return { type: 'text', contentIndex, text: block.text }
    }
  })
}

// ---------------------------------------------------------------------------
// Tool results
// ---------------------------------------------------------------------------

function collectToolResults(items: RawItem[]): Map<string, { content: string; isError: boolean; details?: unknown }> {
  const map = new Map<string, { content: string; isError: boolean; details?: unknown }>()
  for (const item of items) {
    if (item.type === 'tool_result' && item.tool_call_id) {
      map.set(item.tool_call_id, {
        content: typeof item.content === 'string' ? item.content : '',
        isError: item.is_error ?? false,
        details: item.details,
      })
    }
  }
  return map
}

/** Re-derive previewCommand from tool name + args (mirrors engine preview_command logic). */
function inferPreviewCommand(name: string, args: Record<string, unknown>): string | undefined {
  const n = name.toLowerCase()
  if (n === 'bash') {
    const cmd = args.command as string | undefined
    return cmd || undefined
  }
  if (n === 'read') {
    const path = args.path as string | undefined
    if (!path) return undefined
    const offset = args.offset as number | undefined
    const limit = args.limit as number | undefined
    if (offset || limit) return `read ${path} [${offset ?? 1}:${(offset ?? 1) + (limit ?? 0) - 1}]`
    return `read ${path}`
  }
  if (n === 'write') {
    const path = args.path as string | undefined
    return path ? `write ${path}` : undefined
  }
  if (n === 'edit') {
    const path = args.path as string | undefined
    const edits = args.edits as unknown[] | undefined
    const count = edits?.length ?? 1
    return path ? `edit ${path} (${count} replacement(s))` : undefined
  }
  return undefined
}
