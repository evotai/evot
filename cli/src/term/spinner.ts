/**
 * Spinner — ANSI-based animated loading indicator.
 * Pure logic: returns the string to display, no React.
 */

import { providerFailurePresentation } from '../provider/error-presentation.js'
import { formatCacheHitPercent } from '../render/cache.js'
import { truncateAnsiToWidth, visibleWidth } from '../render/wrap.js'
import { resolveRunInteraction, type RunInteractionState } from './app/run-interaction.js'
import { runStatusPresentation } from './viewmodel/run-status.js'
import { confirmationHintAnsi } from './viewmodel/confirmation-hint.js'

function getSpinnerChars(): string[] {
  if (process.env.TERM === 'xterm-ghostty') {
    return ['·', '✢', '✳', '✶', '✻', '*']
  }
  return process.platform === 'darwin'
    ? ['·', '✢', '✳', '✶', '✻', '✽']
    : ['·', '✢', '*', '✶', '✻', '✽']
}

const SPINNER_CHARS = getSpinnerChars()
const SPINNER_FRAMES = [...SPINNER_CHARS, ...[...SPINNER_CHARS].reverse()]
const SLOW_THRESHOLD_MS = 8000
// Actions that legitimately run long get wider thresholds so routine
// execution is not painted red as "slow": bash commands regularly outlive 8s
// (builds, test suites), and compaction includes a potentially long LLM
// summarization pass. These are display thresholds, not execution deadlines.
const SLOW_THRESHOLD_BY_TOOL_MS: Record<string, number> = {
  bash: 30_000,
  compact: 30_000,
  compact_prune: 30_000,
  compact_remote: 30_000,
  compact_local: 30_000,
  compact_local_fallback: 30_000,
  compact_waiting: 30_000,
  compact_generating: 30_000,
  log_shot_render: 30_000,
  log_shot_chrome: 30_000,
  log_shot_capture: 30_000,
  log_shot_open: 30_000,
  ask_user: Number.POSITIVE_INFINITY,
  askuser: Number.POSITIVE_INFINITY,
}

function slowThresholdMs(state: SpinnerState): number {
  if (state.phase === 'executing' && state.toolName) {
    return SLOW_THRESHOLD_BY_TOOL_MS[state.toolName.toLowerCase()] ?? SLOW_THRESHOLD_MS
  }
  return SLOW_THRESHOLD_MS
}

/**
 * Run phases surfaced on the spinner line. `preparing` covers local work
 * (context assembly between tool results and the next provider request),
 * `waiting` is a request in flight with no content yet, `thinking` /
 * `responding` distinguish reasoning deltas from answer/tool-call deltas, and
 * `executing` is tool execution.
 */
export type SpinnerPhase = 'preparing' | 'waiting' | 'quota_waiting' | 'outage_waiting' | 'retrying' | 'thinking' | 'responding' | 'executing' | 'awaiting_background'

/**
 * Waits that carry a countdown and a retry target.
 *
 * `retrying` is the bounded-retry storm (an overloaded upstream, a 529): it is
 * many attempts against one wall, so it belongs here rather than being painted
 * as a fresh request each time. Sharing this predicate is what keeps elapsed
 * time from being read as slowness and keeps token counts off the line — in all
 * three phases nothing is being generated.
 */
export type LongWaitPhase = 'quota_waiting' | 'outage_waiting' | 'retrying'

export function isLongWaitPhase(phase: SpinnerPhase): phase is LongWaitPhase {
  return phase === 'quota_waiting' || phase === 'outage_waiting' || phase === 'retrying'
}

/**
 * True while nothing is being computed and no key applies to the wait.
 *
 * Kept separate from `isLongWaitPhase` rather than folded into it: that type
 * narrows to the two cancellable retry phases, which carry a countdown and a
 * retry target. A background wait has neither — it ends when a detached task
 * reports back. What the two share is only that elapsed time says nothing about
 * health, so each caller opts in explicitly.
 */
export function isPassiveWaitPhase(phase: SpinnerPhase): boolean {
  return phase === 'awaiting_background'
}

/** Share compaction phase/activity presentation between automatic and manual runs. */
export function compactionToolName(phase: string | null, activity?: string | null): string {
  if (phase === 'local' || phase === 'local_fallback') {
    if (activity === 'waiting') return 'compact_waiting'
    if (activity === 'generating') return 'compact_generating'
  }
  switch (phase) {
    case 'pruning': return 'compact_prune'
    case 'remote': return 'compact_remote'
    case 'local_fallback': return 'compact_local_fallback'
    case 'local': return 'compact_local'
    default: return 'compact'
  }
}

/**
 * Map a tool name to a human action label shown on the spinner while it runs.
 * Grouped into verbs that mirror the tool-card glyphs (read/search/edit/...).
 * Unknown tools fall back to a generic "Working".
 */
export function toolActionLabel(toolName: string): string {
  switch (toolName.toLowerCase()) {
    case 'read': case 'read_code': return 'Reading'
    case 'grep': case 'glob': case 'find': case 'search': case 'semantic_code_search': return 'Searching'
    case 'edit': case 'file_edit': return 'Applying changes'
    case 'write': case 'file_write': return 'Writing file'
    case 'bash': return 'Running command'
    case 'web_fetch': case 'webfetch': return 'Fetching'
    case 'plan': return 'Planning'
    case 'skill': return 'Loading skill'
    case 'compact': return 'Compacting'
    case 'compact_prune': return 'Asking judge which tool calls still matter'
    case 'compact_remote': return 'Compacting remote'
    case 'compact_local': return 'Compacting local'
    case 'compact_local_fallback': return 'Compacting local fallback'
    case 'compact_waiting': return 'Compacting · waiting for summary'
    case 'compact_generating': return 'Compacting · generating summary'
    case 'log_shot_render': return 'Rendering shot'
    case 'log_shot_chrome': return 'Starting Chrome'
    case 'log_shot_capture': return 'Capturing PNG'
    case 'log_shot_open': return 'Opening shot'
    case 'ask_user': case 'askuser': return 'Waiting for you'
    default: return 'Working'
  }
}

export interface SpinnerState {
  frame: number
  phase: SpinnerPhase
  phaseStartedAt: number
  lastTokenAt: number | null
  streaming: boolean
  toolName: string | null
  waitRetryAt: number | null
  /** Raw diagnostics are not displayed; the shared provider presenter maps them. */
  retryError?: string
  recoveryStartedAt?: number
  /** Which attempt the current retry storm is on, and its ceiling.
   *
   *  Held on the spinner rather than emitted as a card per attempt: the counter
   *  is the only part that changes between attempts, and the spinner is the one
   *  region that can be repainted. Null outside a retry storm. */
  retryAttempt: number | null
  retryMaxAttempts: number | null
  tokenCount: number
  streamStartedAt: number | null
  glimmerPos: number
}

export function createSpinnerState(): SpinnerState {
  return {
    frame: 0,
    phase: 'preparing',
    phaseStartedAt: Date.now(),
    lastTokenAt: null,
    streaming: false,
    toolName: null,
    waitRetryAt: null,
    retryAttempt: null,
    retryMaxAttempts: null,
    tokenCount: 0,
    streamStartedAt: null,
    glimmerPos: -2,
  }
}

export function advanceSpinner(state: SpinnerState): SpinnerState {
  return {
    ...state,
    frame: (state.frame + 1) % SPINNER_FRAMES.length,
    glimmerPos: state.glimmerPos + 1 > 30 ? -2 : state.glimmerPos + 1,
  }
}

export function setSpinnerPhase(state: SpinnerState, phase: SpinnerPhase, toolName?: string | null): SpinnerState {
  if (state.phase === phase && state.toolName === (toolName ?? null)) return state
  const staysInWait = isLongWaitPhase(phase)
  return {
    ...state,
    phase,
    phaseStartedAt: Date.now(),
    toolName: toolName ?? null,
    waitRetryAt: staysInWait ? state.waitRetryAt : null,
    // Leaving a wait clears the counter, so a later storm cannot inherit a
    // stale `attempt 4/10` from the previous one.
    retryAttempt: staysInWait ? state.retryAttempt : null,
    retryMaxAttempts: staysInWait ? state.retryMaxAttempts : null,
  }
}

export function setLongWait(state: SpinnerState, phase: LongWaitPhase, delayMs: number, now = Date.now(), error?: string): SpinnerState {
  return {
    ...resetStreamStats(state),
    phase,
    recoveryStartedAt: state.recoveryStartedAt ?? now,
    retryError: error ?? state.retryError,
    phaseStartedAt: now,
    toolName: null,
    waitRetryAt: now + Math.max(0, delayMs),
    retryAttempt: null,
    retryMaxAttempts: null,
  }
}

/**
 * Enter (or advance) a bounded-retry storm.
 *
 * Distinct from `setLongWait` only in carrying the attempt counter: quota and
 * outage waits probe indefinitely and have no attempt to report, while a
 * bounded retry does and it is the one thing worth watching. Calling this again
 * on a later attempt updates the counter and the countdown in place, which is
 * the whole point — the alternative was a fresh pair of cards per attempt.
 */
export function setRetryWait(
  state: SpinnerState,
  delayMs: number,
  attempt: number,
  maxAttempts: number,
  now = Date.now(),
  error?: string,
): SpinnerState {
  return {
    ...resetStreamStats(state),
    phase: 'retrying',
    recoveryStartedAt: state.recoveryStartedAt ?? now,
    retryError: error ?? state.retryError,
    phaseStartedAt: now,
    toolName: null,
    waitRetryAt: now + Math.max(0, delayMs),
    retryAttempt: attempt > 0 ? attempt : null,
    retryMaxAttempts: maxAttempts > 0 ? maxAttempts : null,
  }
}

export function recordStreamDelta(state: SpinnerState, textDelta: string, now = Date.now()): SpinnerState {
  const tokens = estimateTokens(textDelta)
  return {
    ...state,
    lastTokenAt: now,
    streaming: true,
    tokenCount: state.tokenCount + tokens,
    streamStartedAt: state.streamStartedAt ?? now,
  }
}

export function resetStreamStats(state: SpinnerState): SpinnerState {
  return {
    ...state,
    lastTokenAt: null,
    streaming: false,
    tokenCount: 0,
    streamStartedAt: null,
  }
}

export function isSlow(state: SpinnerState, now: number): boolean {
  if (isLongWaitPhase(state.phase)) return false
  // A detached task may legitimately run for minutes. Reddening the line would
  // report a fault where there is none.
  if (isPassiveWaitPhase(state.phase)) return false
  const threshold = slowThresholdMs(state)
  // While the model is emitting, health is measured from the last token:
  // a flowing stream is never slow, and a stalled one is surfaced instead of
  // being hidden behind the streaming flag forever.
  if ((state.phase === 'thinking' || state.phase === 'responding') && state.lastTokenAt != null) {
    return now - state.lastTokenAt > threshold
  }
  if (state.streaming) return false
  return now - state.phaseStartedAt > threshold
}

export interface SpinnerStats {
  /** Uncached prompt tokens from completed provider usage. */
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface SpinnerFormatOptions {
  /** Shared capabilities from the run interaction controller. */
  interaction?: RunInteractionState
  hideInteractionHint?: boolean
  /** A status row is single-line; preserve its action hint before optional metrics. */
  columns?: number
  /** Requested model, used to identify long quota waits. */
  model?: string
}

export function formatSpinnerLine(
  state: SpinnerState,
  now: number,
  stats?: SpinnerStats,
  options: SpinnerFormatOptions = {},
): string {
  const elapsed = now - state.phaseStartedAt
  const presentation = runStatusPresentation(options.interaction ?? resolveRunInteraction({
    active: state.phase !== 'awaiting_background', owner: state,
    phase: state.phase, backgroundTasks: 1,
  }))
  const slow = presentation.allowSlowWarning && isSlow(state, now)
  const char = SPINNER_FRAMES[state.frame]!

  const action = state.toolName ? toolActionLabel(state.toolName) : 'Working'
  let label: string
  switch (state.phase) {
    case 'executing':
      label = slow ? `${action} slow…` : `${action}…`
      break
    case 'waiting':
      label = slow ? 'LLM slow…' : 'Waiting for model…'
      break
    case 'quota_waiting': {
      const seconds = Math.max(0, Math.ceil(((state.waitRetryAt ?? now) - now) / 1000))
      const subject = providerFailurePresentation({ kind: 'quota' }).label
      label = seconds > 0
        ? `${subject} · retrying in ${formatWaitCountdown(seconds)}`
        : `${subject} · retrying…`
      break
    }
    case 'outage_waiting': {
      const seconds = Math.max(0, Math.ceil(((state.waitRetryAt ?? now) - now) / 1000))
      label = `${providerFailurePresentation({ error: state.retryError, sustained: true }).label} · retrying in ${seconds}s`
      break
    }
    case 'retrying': {
      // The line the storm repaints: countdown ticks down, attempt ticks up.
      // Both live here rather than in scrollback, so ten attempts cost one row.
      const seconds = Math.max(0, Math.ceil(((state.waitRetryAt ?? now) - now) / 1000))
      const attempt = state.retryAttempt
      const max = state.retryMaxAttempts
      const counter = attempt !== null
        ? max !== null ? ` · attempt ${attempt}/${max}` : ` · attempt ${attempt}`
        : ''
      const subject = state.retryError ? providerFailurePresentation({ error: state.retryError }).label : 'Retrying'
      label = seconds > 0
        ? `${subject}${state.retryError ? ' · retrying' : ''} in ${seconds}s${counter}`
        : `${subject}${state.retryError ? ' · retrying' : ''}…${counter}`
      break
    }
    case 'thinking':
      label = slow ? 'Stream stalled…' : 'Thinking…'
      break
    case 'responding':
      label = slow ? 'Stream stalled…' : 'Responding…'
      break
    case 'awaiting_background':
      // Not "Working": nothing is being computed here. The agent is parked
      // until a detached task reports back, and it will resume on its own.
      label = '' // Run-status presentation supplies the passive-wait label.
      break
    default:
      label = slow ? 'Preparing slow…' : 'Preparing…'
  }

  const status = state.recoveryStartedAt !== undefined && isLongWaitPhase(state.phase)
    ? `waiting ${humanDuration(Math.max(0, now - state.recoveryStartedAt))}` : humanDuration(elapsed)
  label = presentation.label ?? label
  const tokenSuffix = presentation.showUsage ? formatSpinnerTokenSuffix(state, now, stats) : ''
  const interruptHint = options.hideInteractionHint ? '' : confirmationHintAnsi(presentation.hint, presentation.confirmationPending)

  const content = slow
    ? `\x1b[31m${char}\x1b[0m \x1b[31m${label}\x1b[0m\x1b[2m (${status}${tokenSuffix})`
    : `\x1b[36m${char}\x1b[0m ${glimmerText(label, state.glimmerPos)}\x1b[2m (${status}${tokenSuffix})`
  if (options.columns === undefined) return `${content}${interruptHint}\x1b[0m`
  const columns = Number.isFinite(options.columns) ? Math.max(1, Math.floor(options.columns)) : 80
  const hintWidth = visibleWidth(interruptHint)
  // Keep the complete action whenever there is still room for a status glyph.
  // Metrics may shorten, but must not move the editor on every digit change.
  if (interruptHint && hintWidth + 2 < columns) {
    return `${truncateAnsiToWidth(content, columns - hintWidth)}${interruptHint}\x1b[0m`
  }
  return truncateAnsiToWidth(`${content}${interruptHint}\x1b[0m`, columns)
}

function glimmerText(text: string, pos: number): string {
  const start = pos - 1
  const end = pos + 1
  let result = ''
  for (let i = 0; i < text.length; i++) {
    if (i >= start && i <= end) {
      result += `\x1b[1;37m${text[i]}\x1b[0m`
    } else {
      result += `\x1b[2m${text[i]}\x1b[0m`
    }
  }
  return result
}

function formatWaitCountdown(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h${minutes > 0 ? `${minutes}m` : ''}`
  return `${minutes}m${seconds > 0 ? `${seconds}s` : ''}`
}

function humanDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const secs = Math.floor(ms / 100) / 10
  if (secs < 60) return `${secs.toFixed(1)}s`
  const totalSecs = Math.floor(ms / 1000)
  const mins = Math.floor(totalSecs / 60)
  const rem = totalSecs % 60
  return rem > 0 ? `${mins}m${rem}s` : `${mins}m`
}

function formatSpinnerTokenSuffix(state: SpinnerState, now: number, stats?: SpinnerStats): string {
  const inputTokens = stats?.inputTokens ?? 0
  const outputTokens = stats?.outputTokens ?? 0
  const cacheReadTokens = stats?.cacheReadTokens ?? 0
  const cacheWriteTokens = stats?.cacheWriteTokens ?? 0
  const liveRate = formatLiveTokPerSec(state, now)
  if (inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0 || cacheWriteTokens > 0) {
    const parts: string[] = []
    if (inputTokens > 0) parts.push(`↑${formatTokens(inputTokens)}`)
    if (outputTokens > 0) parts.push(`↓${formatTokens(outputTokens)}`)
    const cacheLabel = formatCacheLabel(inputTokens, cacheReadTokens, cacheWriteTokens)
    if (cacheLabel) parts.push(cacheLabel)
    return ` · ${parts.join(' ')}${liveRate ? ` · ${liveRate}` : ''}`
  }
  const tokenSuffix = state.tokenCount > 0 ? ` · ↓ ${formatTokens(state.tokenCount)} tokens` : ''
  return `${tokenSuffix}${liveRate ? ` · ${liveRate}` : ''}`
}

function formatLiveTokPerSec(state: SpinnerState, now: number): string {
  const emitting = state.phase === 'thinking' || state.phase === 'responding'
  if (!state.streaming || !emitting || !state.streamStartedAt || state.tokenCount <= 0) return ''
  const elapsedMs = Math.max(0, now - state.streamStartedAt)
  if (elapsedMs < 500) return ''
  const rate = state.tokenCount / (elapsedMs / 1000)
  if (!Number.isFinite(rate) || rate <= 0) return ''
  return `~${Math.round(rate)} tok/s`
}

/**
 * Compact spinner cache segment: read amount + hit percent + newly written
 * tokens (`+write` — the cache-billed part not served from cache this call).
 */
export function formatCacheLabel(
  inputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens = 0,
): string | null {
  if (cacheReadTokens <= 0 && cacheWriteTokens <= 0) return null
  if (cacheReadTokens <= 0) return `cache write ${formatTokens(cacheWriteTokens)}`
  const pct = formatCacheHitPercent(inputTokens, cacheReadTokens, cacheWriteTokens)
  const writeSuffix = cacheWriteTokens > 0 ? ` +${formatTokens(cacheWriteTokens)}` : ''
  return `cache ${formatTokens(cacheReadTokens)} ${pct}%${writeSuffix}`
}

/**
 * Pick spinner token stats from completed provider usage.
 * While an LLM call is active, its usage buckets are not known yet, so only
 * show the live output estimate instead of mixing it with the previous call.
 */
export function spinnerStatsFromLastUsage(
  last: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
  } | null | undefined,
  liveOutputTokens = 0,
  activeLlmCall = false,
): SpinnerStats {
  const completedUsage = activeLlmCall ? null : last
  return {
    inputTokens: completedUsage?.inputTokens ?? 0,
    outputTokens: liveOutputTokens > 0 ? liveOutputTokens : (completedUsage?.outputTokens ?? 0),
    cacheReadTokens: completedUsage?.cacheReadTokens ?? 0,
    cacheWriteTokens: completedUsage?.cacheWriteTokens ?? 0,
  }
}

function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.round(text.length / 4))
}

function formatTokens(count: number): string {
  if (count < 1000) return `${count}`
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1000000) return `${Math.round(count / 1000)}k`
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`
  return `${Math.round(count / 1000000)}M`
}
