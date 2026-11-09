/**
 * Shared verbose event text formatters.
 *
 * Used by both reducer.ts (real-time streaming) and transcript.ts (history replay)
 * to produce identical output from stats event data.
 */
import { formatDuration, humanTokens, renderBar } from './format.js'
import { formatCacheHitPercent } from './cache.js'
import { streamTokenRate } from '../provider/stream-rate.js'

interface MessageStats {
  user_count?: number
  assistant_count?: number
  tool_result_count?: number
  image_count?: number
  image_path_count?: number
  image_base64_count?: number
  user?: number
  assistant?: number
  tool?: number
  image?: number
  system?: number
  system_tokens?: number
  user_tokens?: number
  assistant_tokens?: number
  tool_result_tokens?: number
  image_tokens?: number
  tool_details?: [string, number][]
}

function msgBreakdown(ms: MessageStats | undefined): string {
  if (!ms) return ''
  const parts: string[] = []
  if ((ms.user_count ?? 0) > 0) parts.push(`user ${ms.user_count}`)
  if ((ms.assistant_count ?? 0) > 0) parts.push(`asst ${ms.assistant_count}`)
  if ((ms.tool_result_count ?? 0) > 0) parts.push(`tool ${ms.tool_result_count}`)
  if ((ms.image_count ?? 0) > 0) {
    const pathCount = ms.image_path_count ?? 0
    const base64Count = ms.image_base64_count ?? 0
    const imgParts: string[] = []
    if (pathCount > 0) imgParts.push(`path ${pathCount}`)
    if (base64Count > 0) imgParts.push(`b64 ${base64Count}`)
    parts.push(imgParts.length > 0 ? `img ${ms.image_count} (${imgParts.join(' / ')})` : `img ${ms.image_count}`)
  }
  return parts.length > 0 ? ` · ${parts.join(' / ')}` : ''
}

function contextLine(used: number, contextWindow: number, saved?: number): string | undefined {
  if (contextWindow <= 0 || used <= 0) return undefined
  const pct = ((used / contextWindow) * 100).toFixed(0)
  const suffix = saved && saved > 0 ? `  (−${humanTokens(saved)})` : ''
  return `    context   ${renderBar(used, contextWindow, 20)}   ${humanTokens(used)} / ${humanTokens(contextWindow)} · ${pct}%${suffix}`
}

function roleTokensLine(parts: string[]): string | undefined {
  return parts.length > 0 ? `    tokens    ${parts.join(' · ')}` : undefined
}

function roleTokenParts(ms: MessageStats, sysTok: number, toolDefTok: number): string[] {
  const parts: string[] = []
  if (sysTok > 0) parts.push(`sys ${humanTokens(sysTok)}`)
  if (toolDefTok > 0) parts.push(`tools ${humanTokens(toolDefTok)}`)
  const uTok = ms.user_tokens ?? 0
  const aTok = ms.assistant_tokens ?? 0
  const trTok = ms.tool_result_tokens ?? 0
  if (uTok > 0) parts.push(`user ${humanTokens(uTok)}`)
  if (aTok > 0) parts.push(`asst ${humanTokens(aTok)}`)
  if (trTok > 0) parts.push(`tool ${humanTokens(trTok)}`)
  const imgTok = ms.image_tokens ?? 0
  const totalTokens = sysTok + toolDefTok + uTok + aTok + trTok + imgTok
  if (imgTok > 0) {
    const pct = totalTokens > 0 ? ` (${((imgTok / totalTokens) * 100).toFixed(0)}%)` : ''
    parts.push(`img ${humanTokens(imgTok)}${pct}`)
  }
  return parts
}

function toolTokensLine(ms: MessageStats): string | undefined {
  const rawDetails = ms.tool_details as [string, number][] | undefined
  if (!rawDetails || rawDetails.length < 2) return undefined

  const agg = new Map<string, number>()
  for (const [name, tokens] of rawDetails) {
    agg.set(name, (agg.get(name) ?? 0) + tokens)
  }

  const sorted = [...agg.entries()].sort((a, b) => b[1] - a[1])
  const total = (ms.tool_result_tokens as number) || sorted.reduce((sum, [, tokens]) => sum + tokens, 0) || 1
  const TOP = 3
  const shown = sorted.length <= TOP + 2 ? sorted : sorted.slice(0, TOP)
  const parts = shown.map(([name, tokens]) => {
    const pct = total > 0 ? ((tokens / total) * 100).toFixed(0) : '0'
    return `${name} ${humanTokens(tokens)} (${pct}%)`
  })

  if (shown.length < sorted.length) {
    const omitted = sorted.slice(shown.length)
    const omittedTokens = omitted.reduce((sum, [, tokens]) => sum + tokens, 0)
    const pct = total > 0 ? ((omittedTokens / total) * 100).toFixed(0) : '0'
    parts.push(`+${omitted.length} more ${humanTokens(omittedTokens)} (${pct}%)`)
  }

  return `    by tool   ${parts.join(' · ')}`
}

function compactRoleTokenParts(cms: MessageStats, sysTok: number, toolDefTok: number): string[] {
  const uTok = cms.user_tokens ?? cms.user ?? 0
  const aTok = cms.assistant_tokens ?? cms.assistant ?? 0
  const trTok = cms.tool_result_tokens ?? cms.tool ?? 0
  const imgTok = cms.image_tokens ?? cms.image ?? 0
  const effectiveSysTok = sysTok || cms.system_tokens || cms.system || 0
  const parts: string[] = []
  if (effectiveSysTok > 0) parts.push(`sys ${humanTokens(effectiveSysTok)}`)
  if (toolDefTok > 0) parts.push(`tools ${humanTokens(toolDefTok)}`)
  if (uTok > 0) parts.push(`user ${humanTokens(uTok)}`)
  if (aTok > 0) parts.push(`asst ${humanTokens(aTok)}`)
  if (trTok > 0) parts.push(`tool ${humanTokens(trTok)}`)
  const totalTokens = effectiveSysTok + toolDefTok + uTok + aTok + trTok + imgTok
  if (imgTok > 0) {
    const pct = totalTokens > 0 ? ` (${((imgTok / totalTokens) * 100).toFixed(0)}%)` : ''
    parts.push(`img ${humanTokens(imgTok)}${pct}`)
  }
  return parts
}

function compactMsgBreakdown(cms: MessageStats | undefined): string {
  if (!cms) return ''
  const normalized = {
    user_count: cms.user_count ?? 0,
    assistant_count: cms.assistant_count ?? 0,
    tool_result_count: cms.tool_result_count ?? 0,
    image_count: cms.image_count ?? 0,
    image_path_count: cms.image_path_count ?? 0,
    image_base64_count: cms.image_base64_count ?? 0,
  }
  return msgBreakdown(normalized)
}

// ---------------------------------------------------------------------------
// LLM call started
// ---------------------------------------------------------------------------

export function formatLlmCallStarted(data: Record<string, unknown>): string {
  const model = (data.model as string) ?? '?'
  const turn = (data.turn as number) ?? 0
  const attempt = (data.attempt as number) ?? 0
  const msgCount = (data.message_count as number) ?? 0
  const injectedCount = (data.injected_count as number) ?? 0
  const sysTok = (data.system_prompt_tokens as number) ?? 0
  const toolDefTok = (data.tool_definition_tokens as number) ?? 0
  const retryStr = attempt > 0 ? ` · retry ${attempt}` : ''
  const injectedStr = injectedCount > 0 ? ` · ${injectedCount} injected` : ''

  const ms = data.message_stats as MessageStats | undefined
  const lines: string[] = [`[LLM] ● · ${model} · turn ${turn} · ${msgCount} msgs${msgBreakdown(ms)}${retryStr}${injectedStr}`]

  const contextWindow = (data.context_window as number) ?? 0
  const estimatedContextTokens = (data.estimated_context_tokens as number) ?? 0
  if (contextWindow > 0) {
    const total = estimatedContextTokens > 0
      ? estimatedContextTokens
      : ms
        ? sysTok + toolDefTok + (ms.user_tokens ?? 0) + (ms.assistant_tokens ?? 0) + (ms.tool_result_tokens ?? 0) + (ms.image_tokens ?? 0)
        : 0
    const line = contextLine(total, contextWindow)
    if (line) lines.push(line)
  }

  if (ms) {
    const line = roleTokensLine(roleTokenParts(ms, sysTok, toolDefTok))
    if (line) lines.push(line)
    const tools = toolTokensLine(ms)
    if (tools) lines.push(tools)
  } else {
    const bytes = (data.message_bytes as number) ?? 0
    const kb = bytes >= 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${bytes} B`
    lines.push(`    tokens    ${msgCount} msgs · ${kb} · sys ${humanTokens(sysTok)} · tools ${humanTokens(toolDefTok)}`)
  }

  return lines.join('\n')
}

export function formatLlmCallRetry(data: Record<string, unknown>): string {
  const attempt = (data.attempt as number) ?? 0
  const maxRetries = (data.max_retries as number) ?? 0
  const delayMs = (data.retry_delay_ms as number) ?? (data.delay_ms as number) ?? 0
  const error = (data.error as string) ?? ''
  const seconds = Math.max(0, Math.round(delayMs / 1000))
  const unit = seconds === 1 ? 'second' : 'seconds'
  const attemptStr = maxRetries > 0 ? ` · attempt ${attempt}/${maxRetries}` : ` · attempt ${attempt}`
  const lines = [`[LLM] ↻ · retrying in ${seconds} ${unit}${attemptStr}`]
  if (error) lines.push(`    error     ${error}`)
  return lines.join('\n')
}

export function formatLongWaitError(model: string, error: string, delayMs: number): string {
  const requestedModel = sanitizeProviderText(model, 80) || 'unknown'
  const reason = sanitizeProviderText(error, 400) || 'Rate limit exceeded.'
  const seconds = Math.max(0, Math.ceil(delayMs / 1000))
  return `[LLM] ⚠ · ${requestedModel} · quota unavailable · retry in ${formatWaitDuration(seconds)}\n    error     ${reason}`
}

function sanitizeProviderText(value: string, maxChars: number): string {
  const cleaned = value
    .replace(/\u001b(?:\[[0-9;?]*[ -/]*[@-~]|].*?(?:\u0007|\u001b\\)|.)/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length <= maxChars) return cleaned
  return `${cleaned.slice(0, Math.max(0, maxChars - 1))}…`
}

function formatWaitDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h${minutes > 0 ? ` ${minutes}m` : ''}`
  return `${minutes}m${seconds > 0 ? ` ${seconds}s` : ''}`
}

// ---------------------------------------------------------------------------
// LLM call completed
// ---------------------------------------------------------------------------

export function formatLlmCallCompleted(data: Record<string, unknown>): { text: string; expandedText?: string } {
  const model = data.model as string | undefined
  // Model that actually served the response (e.g. Anthropic server-side
  // fallback claude-fable-5 → claude-opus-4-8). Only surfaced when it
  // differs from the requested model.
  const responseModel = data.response_model as string | undefined
  const servedByFallback = responseModel != null && responseModel !== '' && model != null && responseModel !== model
  const turn = data.turn as number | undefined
  const error = data.error as string | undefined
  const usage = data.usage as Record<string, number> | undefined
  const metrics = data.metrics as Record<string, number> | undefined
  const durationMs = (data.duration_ms as number) ?? metrics?.duration_ms ?? 0

  if (error) {
    return { text: `[LLM] ✗ · ${model ?? 'unknown'}${turn != null ? ` · turn ${turn}` : ''} · ${formatDuration(durationMs)}\n    error     ${error}` }
  }

  const inputTok = usage?.input ?? (data.input_tokens as number) ?? 0
  const outputTok = usage?.output ?? (data.output_tokens as number) ?? 0
  const cacheReadTok = usage?.cache_read ?? (data.cache_read as number) ?? 0
  const cacheWriteTok = usage?.cache_write ?? (data.cache_write as number) ?? 0
  const cacheHitRate = formatCacheHitPercent(inputTok, cacheReadTok, cacheWriteTok)
  const ttfbMs = (data.time_to_first_byte_ms as number) ?? metrics?.ttfb_ms ?? 0
  const streamingMs = metrics?.streaming_ms
  const tokPerSec = streamTokenRate(outputTok, streamingMs)
  const rateLabel = tokPerSec == null ? '' : ` · ${tokPerSec.toFixed(0)} tok/s (received)`
  const dur = durationMs || 1
  const ttfbPct = ((ttfbMs / dur) * 100).toFixed(0)
  const streamTiming = streamingMs != null && Number.isFinite(streamingMs) && streamingMs >= 0
    ? `${(streamingMs / 1000).toFixed(1)}s (${((streamingMs / dur) * 100).toFixed(0)}%)`
    : 'unavailable'

  const lines: string[] = []
  lines.push(`[LLM] ✓ · ${model ?? 'unknown'}${servedByFallback ? ` → ${responseModel}` : ''}${turn != null ? ` · turn ${turn}` : ''} · ${formatDuration(durationMs)}${rateLabel}`)
  if (servedByFallback) {
    lines.push(`    fallback  served by ${responseModel} (requested ${model})`)
  }
  lines.push(`    tokens    ${humanTokens(inputTok)} in → ${humanTokens(outputTok)} out`)
  if (cacheReadTok > 0 || cacheWriteTok > 0) {
    lines.push(`    cache     ${humanTokens(cacheReadTok)} read · ${humanTokens(cacheWriteTok)} write · ${cacheHitRate}% hit`)
  }
  lines.push(`    timing    ttfb ${(ttfbMs / 1000).toFixed(1)}s (${ttfbPct}%) · stream ${streamTiming}`)

  const toolCalls = data.tool_calls as { id: string; name: string; arguments: Record<string, unknown> }[] | undefined
  if (toolCalls && toolCalls.length > 0) {
    lines.push(`    tools     ${toolCalls.map(tc => tc.name).join(' · ')}`)
  }

  return { text: lines.join('\n') }
}

// ---------------------------------------------------------------------------
// Context compaction started
// ---------------------------------------------------------------------------

export function formatCompactionStarted(data: Record<string, unknown>): string {
  const msgCount = ((data.message_count as number) ?? (data.messages_count as number)) ?? 0
  const estTokens = (data.estimated_tokens as number) ?? 0
  const contextWindow = (data.context_window as number) ?? 0
  const sysTok = (data.system_prompt_tokens as number) ?? 0
  const toolDefTok = (data.tool_definition_tokens as number) ?? 0
  const cms = (data.message_stats as MessageStats | undefined) ?? (data.token_breakdown as MessageStats | undefined)
  const lines: string[] = [`[COMPACT] ● · ${msgCount} msgs${compactMsgBreakdown(cms)}`]

  const ctx = contextLine(estTokens, contextWindow)
  if (ctx) lines.push(ctx)

  if (cms) {
    const line = roleTokensLine(compactRoleTokenParts(cms, sysTok, toolDefTok))
    if (line) lines.push(line)
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Context compaction completed
// ---------------------------------------------------------------------------

export function formatCompactionCompleted(data: Record<string, unknown>): string {
  const result = data.result as Record<string, unknown> | undefined

  if (!result) return '[COMPACT] ✓ · done'

  const type = (result.type as string) ?? 'done'

  switch (type) {
    case 'no_op': {
      const contextWindow = (data.context_window as number) ?? 0
      const estTokens = (data.estimated_tokens as number) ?? 0
      if (contextWindow > 0 && estTokens > 0) {
        const pct = ((estTokens / contextWindow) * 100).toFixed(0)
        return `[COMPACT] ✓ · skipped · within budget · ${humanTokens(estTokens)} / ${humanTokens(contextWindow)} · ${pct}%`
      }
      return '[COMPACT] ✓ · skipped · within budget'
    }

    case 'run_once_cleared': {
      const saved = (result.saved_tokens as number) ?? 0
      const before = (result.before_estimated_tokens as number) ?? 0
      const after = (result.after_estimated_tokens as number) ?? 0
      const savedPct = before > 0 ? ((saved / before) * 100).toFixed(0) : '0'
      const contextWindow = (data.context_window as number) ?? 0

      const lines: string[] = []
      lines.push(`[COMPACT] ✓ · cleared · ${humanTokens(before)} → ${humanTokens(after)} · saved ${humanTokens(saved)} (${savedPct}%)`)

      const ctx = contextLine(after, contextWindow, saved)
      if (ctx) lines.push(ctx)

      return lines.join('\n')
    }

    case 'compacted': {
      const beforeMsgs = (result.before_message_count as number) ?? 0
      const afterMsgs = (result.after_message_count as number) ?? 0
      const before = (result.before_tokens as number) ?? 0
      const after = (result.after_tokens as number) ?? 0
      const saved = before - after
      const savedPct = before > 0 ? ((saved / before) * 100).toFixed(0) : '0'
      const evicted = (result.messages_evicted as number) ?? 0
      const reclaimed = (result.current_run_reclaimed as number) ?? 0
      const contextWindow = ((data.context_window as number) ?? 0)
      const method = (result.method as string | undefined) ?? 'local'
      const remoteBlobBytes = (result.remote_blob_bytes as number | undefined) ?? 0
      const blobLabel = remoteBlobBytes > 0
        ? ` · blob ${remoteBlobBytes >= 1024 ? `${(remoteBlobBytes / 1024).toFixed(1)} KB` : `${remoteBlobBytes} B`}`
        : ''
      const reason = (data.reason as string | undefined) ?? 'threshold'
      const reasonLabel = reason === 'overflow'
        ? 'overflow recovery'
        : reason === 'refusal'
          ? 'refusal recovery'
          : reason

      // Preserve the meaning of historical pruning records without an active capability.
      const methodLabel = method === 'prune'
        ? 'legacy prune · no summary'
        : method === 'remote'
          ? 'remote'
          : method === 'remote_failed_local'
            ? 'remote failed → local'
            : 'local'
      const summary = method === 'prune'
        ? `removed ${evicted} stale tool msgs`
        : `evicted ${evicted} msgs · reclaimed ${reclaimed}`

      const lines: string[] = []
      lines.push(`[COMPACT] ✓ · ${methodLabel} · ${reasonLabel} · ${beforeMsgs} → ${afterMsgs} msgs · ${humanTokens(before)} → ${humanTokens(after)} · saved ${humanTokens(saved)} (${savedPct}%)${blobLabel}`)

      const ctx = contextLine(after, contextWindow, saved)
      if (ctx) lines.push(ctx)
      const fallbackReason = typeof result.fallback_reason === 'string'
        ? result.fallback_reason.replace(/\s+/g, ' ').trim().slice(0, 240)
        : ''
      if (fallbackReason) lines.push(`    fallback  ${fallbackReason}`)
      lines.push(`    summary   ${summary}`)

      return lines.join('\n')
    }

    default:
      return `[COMPACT] ✓ · ${type}`
  }
}
