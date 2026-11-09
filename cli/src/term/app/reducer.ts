/**
 * Reducer-style state updates from RunEvents.
 */

import { isKnownRunEvent, type RunEvent } from '../../native/contracts/query-event.js'
import { formatLlmCallStarted, formatLlmCallRetry, formatLlmCallCompleted, formatCompactionStarted, formatCompactionCompleted } from '../../render/verbose.js'
import { emptyRunStats, type AppState } from './state.js'
import { streamTokenRate } from '../../provider/stream-rate.js'
import type { MessageStats, UIAssistantBlock, UIMessage, UIToolCall } from './types.js'
import { appendAssistantDelta, assistantToolCalls, completedAssistantContent, findAssistantToolCall, updateAssistantToolCall, updateToolCallInMessages, upsertAssistantToolCall } from './assistant-content.js'
import { compactRecordFromResult } from './compaction-record.js'
import { parseStreamingToolArgs, toolArgsRecord } from './tool-args.js'
import { usageIsPlausible } from './usage-plausibility.js'

/**
 * Newest messages kept in `AppState.messages`. The UI reads back only the
 * last assistant text and patches tool calls on the message in flight; the
 * transcript itself lives in the session. Keeping every message — each with
 * its full tool results — grew without bound over a long session.
 */
export const MAX_RETAINED_MESSAGES = 32

function appendRetained(messages: UIMessage[], message: UIMessage): UIMessage[] {
  const next = messages.length >= MAX_RETAINED_MESSAGES
    ? messages.slice(messages.length - MAX_RETAINED_MESSAGES + 1)
    : messages.slice()
  next.push(message)
  return next
}

export function applyEvent(state: AppState, event: RunEvent): AppState {
  const rawPayload = event.payload
  // Legacy retry notifications are not part of the current Rust union.
  if (event.kind === 'api_retry') {
    return {
      ...state,
      verboseEvents: [...state.verboseEvents, { kind: 'llm_retry', text: formatLlmCallRetry(rawPayload) }],
    }
  }
  if (!isKnownRunEvent(event)) return state

  switch (event.kind) {
    case 'run_started':
      return {
        ...state,
        isLoading: true,
        sessionId: event.session_id,
        error: null,
        currentAssistantContent: [],
        currentRunStats: emptyRunStats(),
        runStartTime: Date.now(),
        verboseEvents: [],
      }

    case 'turn_started':
      return {
        ...state,
        currentRunStats: {
          ...state.currentRunStats,
          turnCount: state.currentRunStats.turnCount + 1,
        },
      }

    case 'assistant_delta': {
      const p = event.payload
      const delta = p.delta
      if (!Number.isInteger(p.content_index) || !delta || (p.content_type !== 'text' && p.content_type !== 'thinking')) {
        return state
      }
      return {
        ...state,
        currentAssistantContent: appendAssistantDelta(state.currentAssistantContent, p),
        lastTokenAt: Date.now(),
      }
    }

    case 'assistant_tool_call': {
      const p = event.payload
      const id = p.tool_call_id
      const contentIndex = p.content_index
      if (!id || !Number.isInteger(contentIndex)) return state
      const current = findAssistantToolCall(state.currentAssistantContent, id)
      const phase = p.phase
      const delta = p.delta
      const partialArgs = phase === 'start'
        ? ''
        : `${current?.partialArgs ?? ''}${delta ?? ''}`
      const finalArgs = toolArgsRecord(p.args)
      const toolCall: UIToolCall = {
        ...current,
        id,
        name: p.tool_name || current?.name || '',
        args: finalArgs ?? (delta !== undefined ? parseStreamingToolArgs(partialArgs) : current?.args ?? {}),
        status: current?.status ?? 'queued',
        partialArgs: phase === 'end' ? undefined : partialArgs,
        argsComplete: phase === 'end' || current?.argsComplete,
      }
      return {
        ...state,
        currentAssistantContent: upsertAssistantToolCall(
          state.currentAssistantContent,
          contentIndex,
          toolCall,
        ),
      }
    }

    case 'assistant_completed': {
      const p = event.payload
      const completed = p.content
      const streamedContent = state.currentAssistantContent
      let content = completedAssistantContent(completed, streamedContent)
      for (const toolCall of assistantToolCalls(content)) {
        content = updateAssistantToolCall(content, toolCall.id, current => ({
          ...current,
          argsComplete: true,
          partialArgs: undefined,
        }))
      }
      const text = content
        .filter((block): block is Extract<UIAssistantBlock, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('')
      const msg: UIMessage = {
        id: event.event_id,
        role: 'assistant',
        text,
        timestamp: Date.now(),
        content,
        verboseEvents: state.verboseEvents.length > 0 ? [...state.verboseEvents] : undefined,
      }

      return {
        ...state,
        messages: appendRetained(state.messages, msg),
        currentAssistantContent: content,
        verboseEvents: [],
      }
    }

    case 'tool_started': {
      const p = event.payload
      const id = p.tool_call_id
      if (!id) return state
      return {
        ...state,
        currentAssistantContent: updateAssistantToolCall(state.currentAssistantContent, id, current => ({
          ...current,
          name: p.tool_name ?? current.name,
          args: toolArgsRecord(p.args) ?? current.args,
          status: 'running',
          argsComplete: true,
          partialArgs: undefined,
          startedAt: current.startedAt ?? Date.now(),
          previewCommand: p.preview_command ?? current.previewCommand,
        })),
      }
    }

    case 'tool_progress': {
      const p = event.payload
      const id = p.tool_call_id
      if (!id || !findAssistantToolCall(state.currentAssistantContent, id)) return state
      const text = p.text
      return {
        ...state,
        currentAssistantContent: updateAssistantToolCall(state.currentAssistantContent, id, current => ({
          ...current,
          // Heartbeats carry no information the UI lacks — the spinner already
          // renders an elapsed clock — so they must not displace streamed
          // partial output. `bash` says "Running", `task_output` says "Waiting".
          progress: text && !/^(Running|Waiting)\.\.\. \d+s$/.test(text.trim()) ? text : current.progress,
          details: mergeToolDetails(current.details, p.details),
        })),
      }
    }

    case 'tool_finished': {
      const p = event.payload
      const id = p.tool_call_id
      const isError = !!p.is_error
      const current = findAssistantToolCall(state.currentAssistantContent, id)
      const toolName = p.tool_name ?? current?.name ?? 'unknown'
      const durationMs = p.duration_ms ?? 0

      const finalDetails = mergeToolDetails(current?.details, p.details)
      const finished: UIToolCall = {
        id,
        name: toolName,
        args: current?.args ?? toolArgsRecord(rawPayload.args) ?? {},
        status: isError ? 'error' : 'done',
        result: p.content,
        details: finalDetails,
        previewCommand: current?.previewCommand,
        durationMs,
      }

      const stats = { ...state.currentRunStats }
      stats.toolCallCount++
      if (isError) stats.toolErrorCount++

      const breakdown = stats.toolBreakdown.map((e) =>
        e.name === toolName
          ? { ...e, count: e.count + 1, totalDurationMs: e.totalDurationMs + durationMs, errors: e.errors + (isError ? 1 : 0) }
          : e,
      )
      if (!breakdown.some((e) => e.name === toolName)) {
        breakdown.push({
          name: toolName,
          count: 1,
          totalDurationMs: durationMs,
          errors: isError ? 1 : 0,
        })
      }
      stats.toolBreakdown = breakdown

      return {
        ...state,
        currentAssistantContent: updateAssistantToolCall(
          state.currentAssistantContent,
          id,
          () => finished,
        ),
        messages: updateToolCallInMessages(state.messages, id, finished),
        currentRunStats: stats,
      }
    }

    case 'llm_call_started': {
      const p = event.payload
      const model = p.model ?? state.model
      const turn = event.turn
      const sysTok = p.system_prompt_tokens ?? 0
      const toolDefTok = p.tool_definition_tokens ?? 0

      // Pre-computed message stats from Rust side (always present)
      const ms = p.message_stats
      const msgStats: MessageStats | null = ms
        ? {
            userCount: ms.user_count ?? 0,
            assistantCount: ms.assistant_count ?? 0,
            toolResultCount: ms.tool_result_count ?? 0,
            imageCount: ms.image_count ?? 0,
            userTokens: ms.user_tokens ?? 0,
            assistantTokens: ms.assistant_tokens ?? 0,
            toolResultTokens: ms.tool_result_tokens ?? 0,
            imageTokens: ms.image_tokens ?? 0,
            toolDetails: ms.tool_details ?? [],
          }
        : null

      const data: Record<string, unknown> = {
        ...p,
        model,
        turn,
        // The event carries the window for this request; the previous state
        // is only a fallback (it is 0 on the first call of a process).
        context_window: p.context_window ?? state.currentRunStats.contextWindow,
      }
      const text = formatLlmCallStarted(data)

      // Accumulate cumulative stats across all LLM calls
      const prev = state.currentRunStats.cumulativeStats
      const cumulative: MessageStats = msgStats
        ? {
            userCount: prev.userCount + msgStats.userCount,
            assistantCount: prev.assistantCount + msgStats.assistantCount,
            toolResultCount: prev.toolResultCount + msgStats.toolResultCount,
            imageCount: prev.imageCount + msgStats.imageCount,
            userTokens: prev.userTokens + msgStats.userTokens,
            assistantTokens: prev.assistantTokens + msgStats.assistantTokens,
            toolResultTokens: prev.toolResultTokens + msgStats.toolResultTokens,
            imageTokens: prev.imageTokens + msgStats.imageTokens,
            toolDetails: [...prev.toolDetails, ...msgStats.toolDetails],
          }
        : prev

      return {
        ...state,
        currentRunStats: {
          ...state.currentRunStats,
          contextTokens: p.estimated_context_tokens ?? state.currentRunStats.contextTokens,
          contextWindow: p.context_window ?? state.currentRunStats.contextWindow,
          lastMessageStats: msgStats,
          cumulativeStats: cumulative,
          systemPromptTokens: sysTok + toolDefTok,
        },
        sessionTokens: {
          ...state.sessionTokens,
          contextTokens: p.estimated_context_tokens ?? state.sessionTokens.contextTokens,
          contextWindow: p.context_window ?? state.sessionTokens.contextWindow,
        },
        verboseEvents: [...state.verboseEvents, { kind: 'llm_call', text }],
      }
    }

    case 'llm_call_retry': {
      const p = event.payload
      const text = formatLlmCallRetry(p)
      return {
        ...state,
        verboseEvents: [...state.verboseEvents, { kind: 'llm_retry', text }],
      }
    }

    case 'llm_call_completed': {
      const p = event.payload
      const usage = p.usage
      const metrics = p.metrics
      const stats = { ...state.currentRunStats }
      stats.llmCalls++
      const inputTok = usage?.input ?? 0
      const outputTok = usage?.output ?? 0
      const durationMs = metrics?.duration_ms ?? 0
      const ttfbMs = metrics?.ttfb_ms ?? 0
      const ttftMs = metrics?.ttft_ms ?? 0
      // Preserve the existing numeric stats field; zero denotes unavailable.
      const tokPerSec = streamTokenRate(outputTok, metrics?.streaming_ms) ?? 0

      const cacheReadTok = usage?.cache_read ?? 0
      const cacheWriteTok = usage?.cache_write ?? 0
      const model = typeof rawPayload.model === 'string' ? rawPayload.model : state.model

      if (usage) {
        stats.inputTokens += inputTok
        stats.outputTokens += outputTok
        stats.cacheReadTokens += cacheReadTok
        stats.cacheWriteTokens += cacheWriteTok
        stats.lastLlmUsage = {
          inputTokens: inputTok,
          outputTokens: outputTok,
          cacheReadTokens: cacheReadTok,
          cacheWriteTokens: cacheWriteTok,
        }

        // Provider usage buckets are disjoint. `contextTokens` currently holds
        // the engine's estimate from `llm_call_started`; a provider count that
        // cannot describe that request keeps the estimate.
        const realContextTokens =
          inputTok + cacheReadTok + cacheWriteTok + outputTok
        const hasEstimate = stats.contextTokens > 0
        if (realContextTokens > 0 && (!hasEstimate || usageIsPlausible(realContextTokens, stats.contextTokens))) {
          stats.contextTokens = realContextTokens
        }
      }

      stats.llmCallDetails = [...stats.llmCallDetails, {
        model,
        durationMs,
        inputTokens: inputTok,
        outputTokens: outputTok,
        cacheReadTokens: cacheReadTok,
        cacheWriteTokens: cacheWriteTok,
        ttfbMs,
        ttftMs,
        tokPerSec,
      }]

      const data: Record<string, unknown> = {
        ...p,
        model,
        turn: event.turn,
        estimated_context_tokens: state.currentRunStats.contextTokens,
        context_window: state.currentRunStats.contextWindow,
      }
      const result = formatLlmCallCompleted(data)

      return {
        ...state,
        currentRunStats: stats,
        sessionTokens: {
          inputTokens: state.sessionTokens.inputTokens + inputTok,
          outputTokens: state.sessionTokens.outputTokens + outputTok,
          cacheReadTokens: state.sessionTokens.cacheReadTokens + cacheReadTok,
          cacheWriteTokens: state.sessionTokens.cacheWriteTokens + cacheWriteTok,
          contextTokens: stats.contextTokens,
          contextWindow: stats.contextWindow,
        },
        verboseEvents: [...state.verboseEvents, {
          kind: 'llm_completed',
          text: result.text,
          expandedText: result.expandedText,
        }],
      }
    }

    case 'context_compaction_started': {
      const p = event.payload
      const data: Record<string, unknown> = {
        ...p,
        context_window: state.currentRunStats.contextWindow,
      }
      const text = formatCompactionStarted(data)

      return {
        ...state,
        currentRunStats: { ...state.currentRunStats, contextTokens: p.estimated_tokens ?? 0, contextWindow: p.context_window ?? 0 },
        sessionTokens: { ...state.sessionTokens, contextTokens: p.estimated_tokens ?? state.sessionTokens.contextTokens, contextWindow: p.context_window ?? state.sessionTokens.contextWindow },
        verboseEvents: [...state.verboseEvents, { kind: 'compact_call', text }],
      }
    }

    case 'context_compaction_completed': {
      const p = rawPayload
      const data: Record<string, unknown> = {
        ...p,
        context_window: state.currentRunStats.contextWindow,
      }
      const text = formatCompactionCompleted(data)
      const compactRecord = compactRecordFromResult(p.result, state.currentRunStats.contextTokens)

      // Auto compaction rewrote the model's context: the footer must drop to
      // the post-compaction size instead of keeping the pre-compaction (or
      // provider-reported) number until the next LLM call reports usage.
      const afterTokens = compactRecord?.afterTokens ?? 0
      const contextWindow = typeof p.context_window === 'number' && p.context_window > 0
        ? p.context_window
        : state.sessionTokens.contextWindow
      const updatedStats = compactRecord
        ? {
            ...state.currentRunStats,
            compactHistory: [...state.currentRunStats.compactHistory, compactRecord],
            contextTokens: afterTokens > 0 ? afterTokens : state.currentRunStats.contextTokens,
          }
        : state.currentRunStats

      return {
        ...state,
        currentRunStats: updatedStats,
        sessionTokens: afterTokens > 0
          ? { ...state.sessionTokens, contextTokens: afterTokens, contextWindow }
          : state.sessionTokens,
        verboseEvents: [...state.verboseEvents, { kind: 'compact_done', text }],
      }
    }

    case 'run_finished': {
      const p = event.payload
      const serverDuration = p.duration_ms ?? 0
      const stats = {
        ...state.currentRunStats,
        durationMs: serverDuration || (Date.now() - state.runStartTime),
        turnCount: p.turn_count ?? state.currentRunStats.turnCount,
      }

      return {
        ...state,
        isLoading: false,
        currentRunStats: stats,
      }
    }

    case 'error':
      return {
        ...state,
        isLoading: false,
        error: event.payload.message ?? 'Unknown error',
      }

    default:
      return state
  }
}

function mergeToolDetails(current: unknown, next: unknown): unknown {
  const currentRecord = asToolDetails(current)
  const nextRecord = asToolDetails(next)
  if (currentRecord && nextRecord) return { ...currentRecord, ...nextRecord }
  return next ?? current
}

function asToolDetails(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
