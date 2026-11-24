import { providerFailurePresentation, type ProviderFailureKind } from '../../../render/provider-error.js'
import { parsePrivacyStop, type PrivacyDetail } from '../../../render/privacy-notice.js'
import { formatLongWaitError } from '../../../render/verbose.js'
import { readSavedPrivacyCard } from '../../../native/contracts/privacy.js'
import { buildError, buildPrivacyCard, buildSavedPrivacyCard, buildSystem, buildVerboseEvent, buildEventCard, isVisibleEvent, withoutRedundantErrorTail, type OutputLine } from '../../../render/output.js'
import { formatDuration } from '../../../ui/format.js'
import { compactionToolName, recordStreamDelta, resetStreamStats, setLongWait, setRetryWait, setSpinnerPhase, type SpinnerState } from '../../widgets/spinner.js'
import { assistantToolCalls } from './assistant-content.js'
import { MODEL_SWITCH_TOOL } from '../../../render/model-switch.js'
import { observeModelSwitch, type PendingModelSwitch } from './model-switch.js'
import { assistantMessageToOutputLines } from '../../../render/assistant.js'
import { applyEvent } from './reducer.js'
import type { AppState } from './state.js'
import { isKnownRunEvent, type KnownRunEvent, type RunEvent } from '../../../native/contracts/query-event.js'
import type { ModelSwitchOutcome, UIAssistantBlock } from '../../../render/message-types.js'

export interface StreamMachineState {
  appState: AppState
  spinnerState: SpinnerState
  activeLlmCall: boolean
  /** Hold the previous assistant message in the live region until the switch settles. */
  pendingSwitch?: PendingModelSwitch & { content: UIAssistantBlock[] }
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
  /** Cards for a failed attempt the engine is retrying, held until the next
   *  attempt settles. See `holdsDeferredRetry`. */
  deferredRetry: DeferredRetry | null
}

/** Scrollback for one failed-and-retried attempt: the `✗` card, the discarded
 *  partial reply notice and the `↻` card, in emission order. */
interface DeferredRetry {
  commit: OutputLine[]
  notice: OutputLine[]
  /** The engine announced a retry; until then only that announcement holds. */
  retrying: boolean
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
  /** Ordered assistant messages finalized in this update, before terminal formatting. */
  committedContent: UIAssistantBlock[][]
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
    deferredRetry: null,
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

const PERMANENT_FAILURES: ReadonlySet<ProviderFailureKind> = new Set<ProviderFailureKind>([
  'authentication', 'invalid-request', 'cyber-policy', 'context-overflow', 'configuration', 'backend-version',
  'model-not-found', 'not-found', 'privacy-blocked', 'privacy-unavailable', 'quota',
])

/**
 * Release held cards only at a request boundary that can settle the failure.
 * For example, a diagnostic or privacy card between attempts says nothing
 * about whether the retry recovered. Never let it leak the held warning.
 */
function holdsDeferredRetry(event: RunEvent, known: KnownRunEvent | null, retrying: boolean): boolean {
  if (known?.kind === 'llm_call_retry') return known.payload.attempt <= 1
  if (event.kind === 'api_retry') return legacyRetry(event.payload ?? {}).attempt <= 1
  switch (known?.kind) {
    case 'llm_call_started': return known.payload.attempt > 0
    // A completed error message before any retry means the engine gave up.
    case 'assistant_completed': return retrying
    case 'llm_call_completed':
    case 'quota_waiting':
    case 'outage_waiting':
    case 'context_compaction_started':
    case 'run_finished':
    case 'error':
      return false
    default:
      return true
  }
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

  const committedContent: UIAssistantBlock[][] = []
  function mergeFlushExpanded(flushed: { expandedLines?: OutputLine[]; committedContent?: UIAssistantBlock[][] }) {
    if (flushed.committedContent) committedContent.push(...flushed.committedContent)
    if (flushed.expandedLines) {
      if (!expandedCommitLines) expandedCommitLines = []
      expandedCommitLines.push(...flushed.expandedLines)
    }
  }

  let deferred = prev.deferredRetry
  if (deferred) {
    if (known?.kind === 'llm_call_completed' && !known.payload.error) {
      // The retry recovered. The held error is no longer news, and must not
      // swallow a later `error` event that happens to carry the same text.
      deferred = null
      capturedLlmError = null
    } else if (!holdsDeferredRetry(event, known, deferred.retrying)) {
      commitLines.push(...deferred.commit)
      noticeLines.push(...deferred.notice)
      deferred = null
    }
  }
  const hold = (): DeferredRetry => (deferred ??= { commit: [], notice: [], retrying: false })

  let switchPrefix: ReturnType<typeof settleModelSwitch> | undefined
  let rejectedSwitch = false
  if (known && prev.pendingSwitch) {
    const next = observeModelSwitch(prev.pendingSwitch, known)
    if (typeof next === 'string') {
      switchPrefix = settleModelSwitch(state, next)
      committedContent.push(...switchPrefix.committedContent)
      state = switchPrefix.state
      rerenderStatus = true
      rejectedSwitch = next === 'rejected'
    } else if (next !== prev.pendingSwitch) {
      state = { ...state, pendingSwitch: { ...next, content: prev.pendingSwitch.content } }
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
    const activeLlmCall = event.kind === 'llm_call_started' || event.kind === 'llm_call_retry' || event.kind === 'api_retry'
    const isRetryEvent = event.kind === 'llm_call_retry' || event.kind === 'api_retry'
    // The first retry of a call joins the held failure; once a storm has been
    // released, later attempts report directly (and mostly stay silent).
    const held = isRetryEvent && (deferred !== null || !prev.retryCardShown)
    if (held) hold().retrying = true
    const target = held ? hold() : { commit: commitLines, notice: noticeLines }
    if (abandonsPartial) target.notice.push(...flushed.lines)
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
    target.commit.push(...flushed.lines)
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
        { commit: target.commit, write: writeLines },
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
      const model = state.appState.lastCallModel?.model ?? state.appState.model
      const lines = buildEventCard(formatLongWaitError(model, quotaError, waitDelayMs))
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

  if (known?.kind === 'privacy_card') {
    const card = readSavedPrivacyCard(known.payload.card)
    if (card) {
      const lines = buildSavedPrivacyCard(card)
      commitLines.push(...lines)
      if (expandedCommitLines) expandedCommitLines.push(...lines)
    }
  }

  if (known?.kind === 'llm_call_completed') {
    // LLM accounting completes before tool execution and is not an assistant
    // content boundary. Keep any tool-bearing ordered message live.
    state = { ...state, activeLlmCall: false }
    // The other half of the doubling: a failed attempt emits its own `✗` card
    // beside the `↻` retry card, so each attempt printed the same error twice.
    // Once a storm has announced itself, the failures are what the countdown is
    // already reporting — keep them in the verbose stream instead.
    const error = known.payload.error ?? ''
    const failed = error.length > 0
    const failedInsideStorm = state.retryCardShown && failed
    // Only a failure the engine could retry is worth holding; a permanent one
    // (auth, overflow, privacy, ...) is the news and reports at once.
    const mayRetry = failed && !PERMANENT_FAILURES.has(providerFailurePresentation({ error }).kind)
    const newEvents = state.appState.verboseEvents.slice(prev.appState.verboseEvents.length)
    for (const evt of newEvents) {
      const switchRejection = state.pendingSwitch?.failure === 'rejected'
      if (revokedEvent || failedInsideStorm || switchRejection) writeLines.push(...buildVerboseEvent(evt.text))
      // A failure is held until the next event says whether it is retried.
      else routeVerbose(evt.text, { commit: mayRetry ? hold().commit : commitLines, write: writeLines })
    }
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
      const call = toolCalls.find(call => call.name === MODEL_SWITCH_TOOL && call.status === 'done')
      if (call) {
        state = { ...state,
          pendingSwitch: { call, content: state.appState.currentAssistantContent },
          appState: { ...state.appState, currentAssistantContent: [] },
        }
      } else {
        const flushed = flushStreaming(state)
        state = flushed.state
        commitLines.push(...flushed.lines)
        mergeFlushExpanded(flushed)
      }
    }
    rerenderStatus = true
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
      if (alreadyShown || rejectedSwitch) writeLines.push(...buildError(message))
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
    state: { ...state, lastLlmErrorMessage: capturedLlmError, deferredRetry: deferred },
    committedContent,
    commitLines: switchPrefix ? [...switchPrefix.lines, ...commitLines] : commitLines,
    expandedCommitLines: switchPrefix
      ? [...(switchPrefix.expandedLines ?? switchPrefix.lines), ...(expandedCommitLines ?? commitLines)]
      : expandedCommitLines,
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

function settleModelSwitch(state: StreamMachineState, outcome: ModelSwitchOutcome) {
  const pending = state.pendingSwitch
  if (!pending) return { state, lines: [], committedContent: [] }
  const content = pending.content.map(block => block.type === 'tool_call' && block.toolCall.id === pending.call.id
    ? { ...block, toolCall: { ...block.toolCall, modelSwitchOutcome: outcome } }
    : block)
  return {
    state: { ...state, pendingSwitch: undefined },
    committedContent: [content],
    lines: assistantMessageToOutputLines(content),
    expandedLines: assistantMessageToOutputLines(content, true),
  }
}

/** Final stream flush, including a switch that never reached a response. */
export function finishStreaming(state: StreamMachineState, interrupted = false): ReturnType<typeof flushStreaming> {
  // Esc during a quiet connection retry is a user stop, not proof of an
  // outage. An unexpected stream end still flushes unresolved errors.
  const stoppedQuietRetry = interrupted && state.deferredRetry?.retrying
    && providerFailurePresentation({ error: state.spinnerState.retryError }).kind === 'connection'
  const held = stoppedQuietRetry ? [] : state.deferredRetry?.commit ?? []
  const settled = settleModelSwitch({ ...state, deferredRetry: null }, interrupted ? 'interrupted' : state.pendingSwitch?.failure ?? 'unconfirmed')
  const final = flushStreaming(settled.state)
  if (settled.lines.length === 0 && held.length === 0) return final
  return {
    state: final.state,
    committedContent: [...settled.committedContent, ...final.committedContent],
    lines: [...held, ...settled.lines, ...final.lines],
    expandedLines: [...held, ...(settled.expandedLines ?? settled.lines), ...(final.expandedLines ?? final.lines)],
  }
}

export function flushStreaming(state: StreamMachineState): { state: StreamMachineState; committedContent: UIAssistantBlock[][]; lines: OutputLine[]; expandedLines?: OutputLine[] } {
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
  if (lines.length === 0) return { state: resetState, committedContent: [], lines: [] }

  return { state: resetState, committedContent: [content], lines, expandedLines }
}
