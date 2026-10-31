import { providerFailurePresentation } from '../../provider/error-presentation.js'
import { parsePrivacyStop, type PrivacyDetail } from '../../privacy/notice.js'
import { formatLongWaitError, reviewNotice } from '../../render/verbose.js'
import { buildError, buildPrivacyCard, buildSystem, buildVerboseEvent, buildEventCard, isVisibleEvent, withoutRedundantErrorTail, type OutputLine } from '../../render/output.js'
import { formatDuration } from '../../render/format.js'
import { compactionToolName, recordStreamDelta, resetStreamStats, setLongWait, setRetryWait, setSpinnerPhase, type SpinnerState } from '../spinner.js'
import { assistantToolCalls } from './assistant-content.js'
import { assistantMessageToOutputLines } from '../../render/assistant.js'
import { applyEvent } from './reducer.js'
import type { AppState } from './state.js'
import { isKnownRunEvent, type KnownRunEvent, type RunEvent } from '../../native/contracts/query-event.js'
import type { UIAssistantBlock } from './types.js'

export interface StreamMachineState {
  appState: AppState
  spinnerState: SpinnerState
  activeLlmCall: boolean
  /** Whether this logical LLM call already committed a quota-wait card.
   *  Re-probes update the countdown without appending another warning. */
  quotaWaitShown: boolean
  /** Whether this logical LLM call already committed a bounded-retry card.
   *
   *  Same shape as `quotaWaitShown`, for the same reason: a retry storm is one
   *  wait state, not one event per attempt. The first attempt earns a card; the
   *  rest advance the attempt counter on the spinner, which repaints in place.
   *  Reset on `llm_call_started` so the next logical call announces itself. */
  retryCardShown: boolean
  /** Last error message surfaced via an LLM error card, so a following
   *  `error` event carrying the same text doesn't render it twice. */
  lastLlmErrorMessage: string | null
  /** Prevent duplicate sign-in prompts when the provider error is emitted as
   *  both an LLM completion and a terminal error event. */
  sessionRevokedHandled: boolean
}

export interface StreamContext {
  termRows: number
  /** True only for a server-pushed evot cloud provider. */
  cloudProvider?: boolean
  /** What the privacy record knows about the request that was just blocked
   * (model, where the values sat, which rules); the error text has kinds only. */
  privacyDetail?: () => PrivacyDetail | undefined
}

export interface StreamUpdate {
  state: StreamMachineState
  commitLines: OutputLine[]
  expandedCommitLines?: OutputLine[]
  writeLines: OutputLine[]
  /** Visible client-only lines: persisted separately, never rendered twice. */
  noticeLines: OutputLine[]
  rerenderStatus: boolean
  /** The evot cloud gateway rejected this session after an admin sign-out. */
  sessionRevoked: boolean
}

function parseSpillProgress(text: string): Record<string, unknown> | undefined {
  const prefix = '__evot_spill_event__ '
  if (!text.startsWith(prefix)) return undefined
  try {
    const parsed = JSON.parse(text.slice(prefix.length))
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function buildSpillEventLines(event: Record<string, unknown>, toolName?: string): OutputLine[] {
  const kind = event.kind === 'read' ? 'read' : 'write'
  const path = typeof event.path === 'string' ? event.path : ''
  const sizeBytes = typeof event.size_bytes === 'number' ? event.size_bytes : 0
  const previewBytes = typeof event.preview_bytes === 'number' ? event.preview_bytes : undefined
  const durationMs = typeof event.duration_ms === 'number' ? event.duration_ms : undefined
  const bits = [`${humanBytes(sizeBytes)} ${kind === 'read' ? 'read' : 'written'}`]
  if (previewBytes !== undefined) bits.push(`${humanBytes(previewBytes)} preview`)
  if (durationMs !== undefined) bits.push(formatDuration(durationMs))
  if (toolName) bits.push(toolName)
  return [
    { id: `spill-${Date.now()}-0`, kind: 'verbose', text: `  ${kind === 'read' ? '↩' : '↪'} ${bits.join(' · ')}` },
    ...(path ? [{ id: `spill-${Date.now()}-1`, kind: 'verbose' as const, text: `    ${path}` }] : []),
  ]
}

function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function createStreamMachineState(appState: AppState, spinnerState: SpinnerState): StreamMachineState {
  return {
    appState,
    spinnerState,
    activeLlmCall: false,
    quotaWaitShown: false,
    retryCardShown: false,
    lastLlmErrorMessage: null,
    sessionRevokedHandled: false,
  }
}

function isSessionRevokedError(message: unknown): message is string {
  return typeof message === 'string' && /(?:^|\b)session_revoked(?:\b|:)/i.test(message)
}

/** Legacy `api_retry` events predate the typed union; read them by narrowing. */
function legacyRetry(payload: Record<string, unknown>): { attempt: number; maxRetries: number; delayMs: number } {
  const num = (...names: string[]): number | undefined => {
    for (const name of names) {
      const value = payload[name]
      if (typeof value === 'number' && Number.isFinite(value)) return value
    }
    return undefined
  }
  return { attempt: num('attempt') ?? 0, maxRetries: num('max_retries') ?? 0, delayMs: num('retry_delay_ms', 'delay_ms') ?? 0 }
}

export function reduceRunEvent(prev: StreamMachineState, event: RunEvent, ctx: StreamContext): StreamUpdate {
  const known: KnownRunEvent | null = isKnownRunEvent(event) ? event : null
  const legacyPayload = event.payload ?? {}
  let state = event.kind === 'host_tool_call' ? prev : { ...prev, appState: applyEvent(prev.appState, event) }
  const commitLines: OutputLine[] = []
  const writeLines: OutputLine[] = []
  const noticeLines: OutputLine[] = []
  let expandedCommitLines: OutputLine[] | undefined
  let rerenderStatus = false
  let sessionRevoked = false
  // Tracks an LLM error message surfaced as a card this tick (or carried from a
  // prior tick via state), so a following `error` event won't duplicate it.
  let capturedLlmError: string | null = prev.lastLlmErrorMessage
  const revokedMessage = known?.kind === 'llm_call_completed'
    ? known.payload.error
    : known?.kind === 'error'
      ? known.payload.message
      : undefined
  const revokedEvent = isSessionRevokedError(revokedMessage)
    && (ctx.cloudProvider === true || prev.sessionRevokedHandled)
  if (revokedEvent && !prev.sessionRevokedHandled) {
    // Signal only: the REPL owns the recovery narrative in one status line.
    state = { ...state, sessionRevokedHandled: true }
    sessionRevoked = true
  }

  function mergeFlushExpanded(flushed: { expandedLines?: OutputLine[] }) {
    if (flushed.expandedLines) {
      if (!expandedCommitLines) expandedCommitLines = []
      expandedCommitLines.push(...flushed.expandedLines)
    }
  }

  // LLM / COMPACT / SPILL stats are always produced. LLM errors/retries and
  // completed compactions that changed context render as visible cards; all
  // remaining observability detail belongs in screen.log.
  const routeVerbose = (text: string, target: { commit: OutputLine[]; write: OutputLine[] }) => {
    if (isVisibleEvent(text)) {
      target.commit.push(...buildEventCard(text, ctx.privacyDetail))
      // Customer copy is intentionally shorter; retain raw provider diagnostics
      // in the log-only stream instead of losing them during presentation.
      target.write.push(...buildVerboseEvent(text))
      // Remember the error message (the `    error     <msg>` tail) so a
      // following `error` event with the same text isn't rendered twice.
      const m = text.match(/\n\s*error\s+(.+)$/s)
      if (text.includes('✗') && m) capturedLlmError = m[1]!.trim()
    } else {
      target.write.push(...buildVerboseEvent(text))
    }
  }

  if (event.kind === 'llm_call_started' || event.kind === 'llm_call_retry' || event.kind === 'api_retry' || event.kind === 'context_compaction_started') {
    const abandonsPartial = event.kind === 'llm_call_started'
      || (known?.kind === 'context_compaction_started' && known.payload.will_retry === true)
      || event.kind === 'llm_call_retry'
      || event.kind === 'api_retry'
    const flushed = abandonsPartial
      ? {
          state: {
            ...state,
            appState: { ...state.appState, currentAssistantContent: [] },
          },
          // Text the user has already read is about to vanish from the live
          // region. Say so in place: without it, "the reply disappeared" is
          // indistinguishable from a rendering bug in both the terminal and
          // the screen log.
          lines: discardedPartialNotice(state.appState.currentAssistantContent, event.kind),
          expandedLines: undefined,
        }
      : flushStreaming(state)
    if (abandonsPartial) noticeLines.push(...flushed.lines)
    const activeLlmCall = event.kind === 'llm_call_started' || event.kind === 'llm_call_retry' || event.kind === 'api_retry'
    const isRetryEvent = event.kind === 'llm_call_retry' || event.kind === 'api_retry'
    // A bounded retry re-emits `llm_call_started` for every attempt — only a
    // long wait suppresses it. So the reset keys off `attempt`, not the event
    // kind: keying off the kind would clear the flag on attempt 2 and bring
    // back the card-per-attempt storm this is meant to collapse.
    const startsFreshCall = known?.kind === 'llm_call_started' && known.payload.attempt === 0
    const retry = known?.kind === 'llm_call_retry'
      ? { attempt: known.payload.attempt, maxRetries: known.payload.max_retries, delayMs: known.payload.delay_ms }
      : event.kind === 'api_retry' ? legacyRetry(legacyPayload) : null
    state = {
      ...flushed.state,
      activeLlmCall,
      quotaWaitShown: startsFreshCall ? false : flushed.state.quotaWaitShown,
      retryCardShown: startsFreshCall ? false : flushed.state.retryCardShown,
      // Compaction execution is driven by the real-time phase event. The
      // started event is an observability snapshot and may be delivered beside
      // completion, so it must not overwrite the method-specific phase label.
      spinnerState: retry
        ? setRetryWait(
            flushed.state.spinnerState,
            retry.delayMs,
            retry.attempt,
            retry.maxRetries,
            Date.now(),
            known?.kind === 'llm_call_retry' ? known.payload.error : undefined,
          )
        : activeLlmCall
          ? setSpinnerPhase(resetStreamStats(flushed.state.spinnerState), 'waiting')
          : flushed.state.spinnerState,
    }
    if (startsFreshCall) state = { ...state, spinnerState: { ...state.spinnerState, recoveryStartedAt: undefined, retryError: undefined } }
    commitLines.push(...flushed.lines)
    mergeFlushExpanded(flushed)
    const newEvents = state.appState.verboseEvents.slice(prev.appState.verboseEvents.length)
    for (const evt of newEvents) {
      // The countdown and attempt counter now live on the spinner, which
      // repaints. Committing a card per attempt printed the same 529 ten times
      // and buried whatever came before it.
      if (isRetryEvent && state.retryCardShown) {
        writeLines.push(...buildVerboseEvent(evt.text))
        continue
      }
      // Even the first attempt said it twice: the failed call's `✗` card and
      // the `↻` card carry the same provider sentence. Keep what only the
      // retry line knows.
      routeVerbose(
        isRetryEvent ? withoutRedundantErrorTail(evt.text, capturedLlmError) : evt.text,
        { commit: commitLines, write: writeLines },
      )
    }
    if (isRetryEvent) state = { ...state, retryCardShown: true }
    rerenderStatus = true
  }

  if (known?.kind === 'context_compaction_phase') {
    const phase = known.payload.phase
    if (phase === 'complete') {
      state = {
        ...state,
        spinnerState: setSpinnerPhase(resetStreamStats(state.spinnerState), 'preparing'),
      }
    } else {
      const toolName = compactionToolName(phase, known.payload.activity)
      state = {
        ...state,
        spinnerState: setSpinnerPhase(resetStreamStats(state.spinnerState), 'executing', toolName),
      }
    }
    rerenderStatus = true
  }

  if (known?.kind === 'quota_waiting' || known?.kind === 'outage_waiting') {
    const flushed = {
      state: {
        ...state,
        appState: { ...state.appState, currentAssistantContent: [] },
      },
      lines: [] as OutputLine[],
      expandedLines: undefined,
    }
    const waitDelayMs = known.payload.delay_ms
    const quotaError = known.payload.error?.trim() ?? ''
    const quotaWaitAlreadyShown = known.kind === 'quota_waiting' && prev.quotaWaitShown
    writeLines.push(...buildVerboseEvent(`[LLM] wait · ${known.kind}\n    error     ${quotaError}`))
    state = {
      ...flushed.state,
      activeLlmCall: false,
      quotaWaitShown: known.kind === 'quota_waiting'
        ? true
        : flushed.state.quotaWaitShown,
      spinnerState: setLongWait(
        flushed.state.spinnerState,
        known.kind === 'outage_waiting' ? 'outage_waiting' : 'quota_waiting',
        waitDelayMs,
        Date.now(),
        quotaError,
      ),
    }
    commitLines.push(...flushed.lines)
    if (known.kind === 'quota_waiting' && !quotaWaitAlreadyShown) {
      const lines = buildEventCard(formatLongWaitError(state.appState.model, quotaError, waitDelayMs))
      commitLines.push(...lines)
      noticeLines.push(...buildSystem(lines.map(line => line.text).join('\n')))
    }
    rerenderStatus = true
  }

  if (known?.kind === 'assistant_delta') {
    if (known.payload.content_type === 'text') {
      const textDelta = known.payload.delta
      if (textDelta) {
        state = {
          ...state,
          activeLlmCall: true,
          spinnerState: setSpinnerPhase(recordStreamDelta(state.spinnerState, textDelta), 'responding'),
        }
        rerenderStatus = true
      }
    } else {
      const thinkingDelta = known.payload.delta
      if (thinkingDelta) {
        state = {
          ...state,
          activeLlmCall: true,
          spinnerState: setSpinnerPhase(recordStreamDelta(state.spinnerState, thinkingDelta, Date.now()), 'thinking'),
        }
        rerenderStatus = true
      }
    }
  }

  if (known?.kind === 'assistant_tool_call') {
    // Tool argument events are model output, including the final decoded call.
    // Do not claim execution has started until the engine emits tool_started —
    // but do treat them as live stream activity so the spinner leaves the
    // waiting phase and stall detection stays anchored to the last delta.
    state = {
      ...state,
      activeLlmCall: true,
      spinnerState: setSpinnerPhase(
        recordStreamDelta(state.spinnerState, known.payload.delta ?? ''),
        'responding',
      ),
    }
    rerenderStatus = true
  }

  if (known?.kind === 'assistant_completed') {
    // applyEvent has already replaced streamed blocks with the provider's
    // authoritative completed content. A tool-bearing assistant message stays
    // live while its tools execute, then repl commits the entire ordered block
    // atomically. Text-only messages can commit immediately.
    const hasToolCalls = state.appState.currentAssistantContent.some(block => block.type === 'tool_call')
    const flushed = hasToolCalls
      ? { state, lines: [] as OutputLine[], expandedLines: undefined }
      : flushStreaming(state)
    state = {
      ...flushed.state,
      activeLlmCall: false,
      spinnerState: { ...flushed.state.spinnerState, streaming: false },
    }
    commitLines.push(...flushed.lines)
    mergeFlushExpanded(flushed)
    // Surface an output-token truncation so a response cut off mid-sentence is
    // not mistaken for a clean finish. Mirrors pi's assistant-message length
    // notice. `resolved_max_tokens` clamps the budget to the window, so this
    // only fires on a genuine max-output-tokens stop.
    if (known.payload.stop_reason === 'length') {
      const reason = known.payload.error_message ?? ''
      const message = reason.startsWith('response incomplete:')
        ? `Provider returned an incomplete response (${reason.slice('response incomplete:'.length).trim()}). Context recovery may compact and retry.`
        : 'Model stopped because it reached the maximum output token limit. The response may be incomplete.'
      const notice = buildError(message)
      commitLines.push(...notice)
      if (!expandedCommitLines) expandedCommitLines = []
      expandedCommitLines.push(...notice)
    }
    rerenderStatus = true
  }

  if (event.kind === 'turn_started') {
    // A normal turn starts after the previous assistant_completed flush. This
    // is only a fallback for interrupted or synthetic event sequences.
    const flushed = flushStreaming(state)
    state = {
      ...flushed.state,
      spinnerState: { ...flushed.state.spinnerState, streaming: false },
    }
    commitLines.push(...flushed.lines)
    mergeFlushExpanded(flushed)
    rerenderStatus = true
  }

  if (known?.kind === 'llm_call_completed') {
    // LLM accounting completes before tool execution and is not an assistant
    // content boundary. Keep any tool-bearing ordered message live.
    state = { ...state, activeLlmCall: false }
    // The other half of the doubling: a failed attempt emits its own `✗` card
    // beside the `↻` retry card, so each attempt printed the same error twice.
    // Once a storm has announced itself, the failures are what the countdown is
    // already reporting — keep them in the verbose stream instead.
    const failedInsideStorm = state.retryCardShown && (known.payload.error?.length ?? 0) > 0
    const newEvents = state.appState.verboseEvents.slice(prev.appState.verboseEvents.length)
    for (const evt of newEvents) {
      if (revokedEvent || failedInsideStorm) writeLines.push(...buildVerboseEvent(evt.text))
      else routeVerbose(evt.text, { commit: commitLines, write: writeLines })
    }
  }

  if (event.kind === 'context_pruned') {
    const newEvents = state.appState.verboseEvents.slice(prev.appState.verboseEvents.length)
    for (const evt of newEvents) {
      routeVerbose(evt.text, { commit: commitLines, write: writeLines })
    }
    rerenderStatus = true
  }

  if (event.kind === 'context_compaction_completed') {
    const flushed = flushStreaming(state)
    state = {
      ...flushed.state,
      spinnerState: setSpinnerPhase(resetStreamStats(flushed.state.spinnerState), 'preparing'),
    }
    commitLines.push(...flushed.lines)
    mergeFlushExpanded(flushed)
    const newEvents = state.appState.verboseEvents.slice(prev.appState.verboseEvents.length)
    for (const evt of newEvents) {
      routeVerbose(evt.text, { commit: commitLines, write: writeLines })
    }
  }

  if (known?.kind === 'tool_started') {
    const toolName = known.payload.tool_name
    // ask_user maps to executing like any tool: its label is "Waiting for
    // you…" and its slow threshold is infinite, so it never turns red.
    state = {
      ...state,
      spinnerState: setSpinnerPhase(resetStreamStats(state.spinnerState), 'executing', toolName),
    }
    rerenderStatus = true
  }

  if (known?.kind === 'tool_progress') {
    const spill = parseSpillProgress(known.payload.text)
    if (spill) {
      const lines = buildSpillEventLines(spill, known.payload.tool_name)
      commitLines.push(...lines)
      noticeLines.push(...lines.map(line => ({ ...line, kind: 'system' as const })))
    }
    rerenderStatus = true
  }

  if (event.kind === 'tool_finished') {
    const toolCalls = assistantToolCalls(state.appState.currentAssistantContent)
    // Prefer a still-running tool. A decoded queued call has not started yet,
    // so fall back to preparing (engine-side work before the next step) rather
    // than claiming its side effect is in progress.
    const running = toolCalls.find(call => call.status === 'running' && call.startedAt !== undefined)
    state = {
      ...state,
      spinnerState: running
        ? setSpinnerPhase(resetStreamStats(state.spinnerState), 'executing', running.name)
        : setSpinnerPhase(resetStreamStats(state.spinnerState), 'preparing'),
    }
    // Tool-bearing assistant messages stay live through execution. Commit the
    // complete ordered message when the last tool settles, exactly once.
    if (toolCalls.length > 0 && toolCalls.every(call => call.status === 'done' || call.status === 'error')) {
      const flushed = flushStreaming(state)
      state = flushed.state
      commitLines.push(...flushed.lines)
      mergeFlushExpanded(flushed)
    }
    rerenderStatus = true
  }

  if (known?.kind === 'tool_calls_reviewed') {
    // One line, only when the window looks off-task. A clean window is
    // silent; its scores are in the verbose log.
    const notice = reviewNotice(known.payload.calls)
    const newEvents = state.appState.verboseEvents.slice(prev.appState.verboseEvents.length)
    for (const evt of newEvents) writeLines.push(...buildVerboseEvent(evt.text))
    if (notice) {
      const lines = buildSystem(notice)
      commitLines.push(...lines)
      noticeLines.push(...lines)
    }
  }

  if (known?.kind === 'error') {
    const flushed = flushStreaming(state)
    state = flushed.state
    commitLines.push(...flushed.lines)
    mergeFlushExpanded(flushed)
    writeLines.push(...flushed.lines)
    const message = known.payload.message
    if (revokedEvent) {
      // Keep raw gateway detail in screen.log; the TUI already has the single
      // actionable cloud-session prompt above.
      writeLines.push(...buildError(message))
    } else {
      // Skip the standalone `Error:` line if an LLM error card already showed
      // this same message (the provider error surfaces via both events).
      const alreadyShown = capturedLlmError != null &&
        (message.trim() === capturedLlmError || message.includes(capturedLlmError) || capturedLlmError.includes(message.trim()))
      if (alreadyShown) writeLines.push(...buildError(message))
      else {
        const failure = providerFailurePresentation({ error: message })
        const privacy = parsePrivacyStop(message)
        const lines = privacy ? buildPrivacyCard(privacy, ctx.privacyDetail?.()) : buildError(failure.kind === 'unknown' ? message : failure.label)
        commitLines.push(...lines)
        noticeLines.push(...lines)
        writeLines.push(...buildError(message))
      }
    }
  }

  if (event.kind === 'run_finished') {
    // Do not let applyEvent discard partial content before an abnormal run end
    // gets its final preservation flush.
    const flushed = flushStreaming(state)
    state = flushed.state
    commitLines.push(...flushed.lines)
    mergeFlushExpanded(flushed)
  }

  return {
    state: { ...state, lastLlmErrorMessage: capturedLlmError },
    commitLines,
    expandedCommitLines,
    writeLines,
    noticeLines,
    rerenderStatus,
    sessionRevoked,
  }
}

/**
 * A one-line record that a partially streamed reply was thrown away. Only
 * content the user could have seen counts: thinking or text with visible
 * characters. Attempts that fail before streaming anything stay silent so a
 * retry storm does not print a line per attempt.
 */
export function discardedPartialNotice(content: UIAssistantBlock[], cause: string): OutputLine[] {
  let visibleChars = 0
  let toolCalls = 0
  for (const block of content) {
    if (block.type === 'tool_call') toolCalls++
    else visibleChars += block.text.trim().length
  }
  if (visibleChars === 0 && toolCalls === 0) return []
  const reason = cause === 'context_compaction_started'
    ? 'compacting context and retrying'
    : cause === 'llm_call_started'
      ? 'a new request replaced it'
      : 'retrying the request'
  const what = [
    visibleChars > 0 ? `${visibleChars} chars` : null,
    toolCalls > 0 ? `${toolCalls} tool call(s)` : null,
  ].filter((part): part is string => part !== null).join(', ')
  return buildSystem(`  ↻ Discarded an incomplete reply (${what}) — ${reason}`)
}

export function flushStreaming(state: StreamMachineState): { state: StreamMachineState; lines: OutputLine[]; expandedLines?: OutputLine[] } {
  const content = state.appState.currentAssistantContent
  const lines = assistantMessageToOutputLines(content)
  const expandedLines = lines.length > 0
    ? assistantMessageToOutputLines(content, true)
    : undefined

  const resetState = {
    ...state,
    appState: {
      ...state.appState,
      currentAssistantContent: [],
    },
  }
  if (lines.length === 0) return { state: resetState, lines: [] }

  return { state: resetState, lines, expandedLines }
}
