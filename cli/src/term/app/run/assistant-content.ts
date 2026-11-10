import { toolArgsRecord } from '../../../session/tool-args.js'
import type { UIAssistantBlock, UIMessage, UIToolCall } from '../../../render/message-types.js'

export interface AssistantDeltaPayload {
  content_index?: unknown
  content_type?: unknown
  delta?: unknown
}

/** Apply a text/thinking delta to the block identified by provider content index. */
export function appendAssistantDelta(
  content: UIAssistantBlock[],
  payload: AssistantDeltaPayload,
): UIAssistantBlock[] {
  const contentIndex = payload.content_index
  const type = payload.content_type
  const delta = payload.delta
  if (!Number.isInteger(contentIndex) || typeof delta !== 'string' || !delta) return content
  if (type !== 'text' && type !== 'thinking') return content

  const index = content.findIndex(block => block.contentIndex === contentIndex)
  if (index < 0) {
    return sorted([...content, { type, contentIndex: contentIndex as number, text: delta }])
  }

  const existing = content[index]
  if (!existing || existing.type !== type) return content
  const next = [...content]
  next[index] = { ...existing, text: existing.text + delta }
  return next
}

/** Insert or replace the tool block at its provider content index. */
export function upsertAssistantToolCall(
  content: UIAssistantBlock[],
  contentIndex: number,
  toolCall: UIToolCall,
): UIAssistantBlock[] {
  return sorted([
    ...content.filter(block => block.contentIndex !== contentIndex),
    { type: 'tool_call', contentIndex, toolCall },
  ])
}

export function assistantToolCalls(content: UIAssistantBlock[]): UIToolCall[] {
  return sorted(content)
    .filter((block): block is Extract<UIAssistantBlock, { type: 'tool_call' }> => block.type === 'tool_call')
    .map(block => block.toolCall)
}

export function findAssistantToolCall(content: UIAssistantBlock[], id: string): UIToolCall | undefined {
  return content.find(
    (block): block is Extract<UIAssistantBlock, { type: 'tool_call' }> =>
      block.type === 'tool_call' && block.toolCall.id === id,
  )?.toolCall
}

export function updateAssistantToolCall(
  content: UIAssistantBlock[],
  id: string,
  update: (toolCall: UIToolCall) => UIToolCall,
): UIAssistantBlock[] {
  let changed = false
  const next = content.map(block => {
    if (block.type !== 'tool_call' || block.toolCall.id !== id) return block
    changed = true
    return { ...block, toolCall: update(block.toolCall) }
  })
  return changed ? next : content
}

/** Replace streamed blocks with the provider's authoritative completed message. */
export function completedAssistantContent(
  completed: unknown[] | undefined,
  streamed: UIAssistantBlock[],
): UIAssistantBlock[] {
  if (!completed) return streamed
  return completed.map((raw, contentIndex): UIAssistantBlock => {
    const block = raw as Record<string, unknown>
    if (block.type === 'thinking') {
      return { type: 'thinking', contentIndex, text: String(block.text ?? '') }
    }
    if (block.type === 'tool_call') {
      const id = String(block.id ?? '')
      const current = findAssistantToolCall(streamed, id)
      return {
        type: 'tool_call',
        contentIndex,
        toolCall: current ?? {
          id,
          name: String(block.name ?? ''),
          args: toolArgsRecord(block.input) ?? {},
          status: 'queued',
        },
      }
    }
    return { type: 'text', contentIndex, text: String(block.text ?? '') }
  })
}

export function updateToolCallInMessages(
  messages: UIMessage[],
  toolCallId: string,
  finished: UIToolCall,
): UIMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message?.content || !findAssistantToolCall(message.content, toolCallId)) continue
    const next = [...messages]
    next[i] = {
      ...message,
      content: updateAssistantToolCall(message.content, toolCallId, () => finished),
    }
    return next
  }
  return messages
}

function sorted<T extends { contentIndex: number }>(content: T[]): T[] {
  return [...content].sort((a, b) => a.contentIndex - b.contentIndex)
}
