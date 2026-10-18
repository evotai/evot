import type { TranscriptItem } from '../../../native/contracts/results.js'
import type { SuggestionTurn } from '../../../native/contracts/suggestion.js'
import { isLegacyContextSummary, replayUserInput } from '../../../session/user-input.js'

export interface ToolEvidence { id: string; name: string; description?: string; requiresInput: boolean }
export type ContextEvent =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; turn: SuggestionTurn; tools: ToolEvidence[] }
  | { kind: 'tool_started'; tool: ToolEvidence }
  | { kind: 'tool_finished'; id: string; name: string; failed: boolean }
  | { kind: 'begin' | 'interrupt' | 'error' | 'clear' }

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function tool(id: string, name: string, args: unknown): ToolEvidence {
  const description = record(args).description
  const kind = name.toLowerCase()
  // Protocol metadata only: never infer an intent from command text, file
  // content, tool output or reasoning. Other tool contracts can opt in here.
  return { id, name, requiresInput: kind === 'ask_user' || kind === 'askuser',
    ...(kind === 'bash' && typeof description === 'string' ? { description } : {}),
  }
}

function assistant(content: unknown, reason: unknown): ContextEvent {
  const blocks = Array.isArray(content) ? content.map(record) : []
  const text = blocks.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
  const tools = blocks.filter(block => block.type === 'tool_call' && typeof block.id === 'string')
    .map(block => tool(String(block.id), typeof block.name === 'string' ? block.name : 'unknown', block.input))
  const hasTools = blocks.some(block => block.type === 'tool_call')
  const turn = reason === 'aborted' ? 'interrupted' : reason === 'error' ? 'failed'
    : hasTools || ['length', 'toolUse', 'tool_calls'].includes(String(reason)) ? 'unfinished'
    : reason === 'stop' ? 'answered' : 'unknown'
  return { kind: 'assistant', text, turn, tools }
}

/** Both replay and live events enter the same reducer after this boundary. */
export function runContextEvent(event: { kind: string; payload: Record<string, unknown> }): ContextEvent | undefined {
  const p = event.payload
  if (event.kind === 'assistant_completed') return assistant(p.content, p.stop_reason)
  if (event.kind === 'turn_started') return { kind: 'begin' }
  if (event.kind === 'error') return { kind: 'error' }
  if (event.kind === 'tool_started' && typeof p.tool_call_id === 'string' && typeof p.tool_name === 'string') {
    return { kind: 'tool_started', tool: tool(p.tool_call_id, p.tool_name, p.args) }
  }
  if (event.kind === 'tool_finished' && typeof p.tool_call_id === 'string') {
    return { kind: 'tool_finished', id: p.tool_call_id, name: typeof p.tool_name === 'string' ? p.tool_name : 'unknown', failed: p.is_error === true }
  }
}

export function* transcriptContextEvents(items: readonly TranscriptItem[]): Generator<ContextEvent> {
  for (const item of items) {
    if (item.type === 'marker' && item.kind === 'clear') yield { kind: 'clear' }
    else if (item.type === 'user' && !isLegacyContextSummary(item)) {
      for (const part of replayUserInput(item)) {
        if (part.kind === 'user' && part.text.trim()) yield { kind: 'user', text: part.text }
      }
    } else if (item.type === 'assistant') yield assistant(item.content ?? item.content_blocks, item.stop_reason)
    else if (item.type === 'tool_result' && typeof item.tool_call_id === 'string') {
      yield { kind: 'tool_finished', id: item.tool_call_id, name: typeof item.tool_name === 'string' ? item.tool_name : 'unknown', failed: item.is_error === true }
    }
  }
}
