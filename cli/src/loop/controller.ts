import type { LoopMode, LoopTask } from './parser.js'

export const MIN_DELAY_SECONDS = 60
export const MAX_DELAY_SECONDS = 3600
export const CACHE_WINDOW_SECONDS = 300
export const CACHE_LEAD_SECONDS = 30
export const KEEPALIVE_SECONDS = 1200
export const MAX_KEEPALIVES = 1
/** A loop expires after a week, as Claude Code's recurring tasks do. */
export const MAX_AGE_MS = 7 * 24 * 3_600_000
export const MAX_CONSECUTIVE_ERRORS = 3

export interface LoopSnapshot {
  active: boolean
  mode: LoopMode
  task: LoopTask
  startedAt: number
  nextFireAt: number | null
  reason: string | null
  tick: number
  /** Consecutive ticks the agent reported as `noop: true`. */
  noopStreak: number
  /** When the current quiet streak began; null while it is zero. */
  streakStartedAt: number | null
}

export interface ScheduleInput {
  delaySeconds: number
  reason: string
  noop: boolean
}

export type StopCause =
  | 'user'
  | 'model'
  | 'max_age'
  | 'errors'
  | 'no_reschedule'
  | 'session_switch'

export type RunOutcome = 'ok' | 'error' | 'interrupted'

export interface LoopEvents {
  stopped: (cause: StopCause, snapshot: LoopSnapshot) => void
}

export function clampDelaySeconds(seconds: number): number {
  const rounded = Math.round(seconds)
  const bounded = Math.min(MAX_DELAY_SECONDS, Math.max(MIN_DELAY_SECONDS, rounded))
  const lower = CACHE_WINDOW_SECONDS - CACHE_LEAD_SECONDS
  const upper = CACHE_WINDOW_SECONDS + CACHE_LEAD_SECONDS
  return bounded >= lower && bounded <= upper ? lower : bounded
}

export class LoopController {
  #state: LoopSnapshot | null = null
  #keepalivesUsed = 0
  #rescheduledThisRun = false
  #consecutiveErrors = 0
  #events: LoopEvents

  constructor(events: LoopEvents) {
    this.#events = events
  }

  get active(): boolean {
    return this.#state?.active === true
  }

  get snapshot(): LoopSnapshot | null {
    return this.#state ? { ...this.#state } : null
  }

  get isDynamic(): boolean {
    return this.#state?.mode.kind === 'dynamic'
  }

  start(mode: LoopMode, task: LoopTask, now = Date.now()): void {
    this.#state = {
      active: true,
      mode,
      task,
      startedAt: now,
      nextFireAt: null,
      reason: null,
      tick: 0,
      noopStreak: 0,
      streakStartedAt: null,
    }
    this.#keepalivesUsed = 0
    this.#rescheduledThisRun = false
    this.#consecutiveErrors = 0
  }

  stop(cause: StopCause): LoopSnapshot | null {
    const state = this.#state
    if (!state?.active) return null
    const snapshot = { ...state, active: false, nextFireAt: null }
    this.#state = null
    this.#events.stopped(cause, snapshot)
    return snapshot
  }

  beginRun(now = Date.now()): void {
    const state = this.#state
    if (!state?.active) return
    state.tick += 1
    state.nextFireAt = null
    this.#rescheduledThisRun = false
    if (now - state.startedAt > MAX_AGE_MS) this.stop('max_age')
  }

  /** Set the next wakeup. On a fixed-interval loop this also becomes the new
   *  interval, so "make it hourly" said mid-loop changes the pace for good
   *  rather than for one tick. */
  schedule(input: ScheduleInput, now = Date.now()): number {
    const state = this.#state
    if (!state?.active) return 0
    const delay = clampDelaySeconds(input.delaySeconds)
    state.nextFireAt = now + delay * 1000
    if (state.mode.kind === 'fixed') state.mode = { kind: 'fixed', intervalMs: delay * 1000 }
    state.reason = input.reason
    if (input.noop) {
      state.noopStreak += 1
      state.streakStartedAt ??= now
    } else {
      state.noopStreak = 0
      state.streakStartedAt = null
    }
    this.#rescheduledThisRun = true
    return delay
  }

  endRun(outcome: RunOutcome, now = Date.now()): void {
    const state = this.#state
    if (!state?.active) return

    // Interrupting a turn is not a request to cancel the recurring task and
    // must not spend the missing-wakeup/error budget. Retain a scheduled wakeup,
    // or retry after a short delay so the user has time to amend the task.
    if (outcome === 'interrupted') {
      if (state.nextFireAt === null) {
        const delay = state.mode.kind === 'fixed' ? state.mode.intervalMs : MIN_DELAY_SECONDS * 1000
        state.nextFireAt = now + delay
        state.reason = 'current turn interrupted; loop will resume'
      }
      return
    }

    if (outcome === 'error') {
      this.#consecutiveErrors += 1
      if (this.#consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        this.stop('errors')
        return
      }
    } else {
      this.#consecutiveErrors = 0
    }

    if (state.mode.kind === 'fixed') {
      state.nextFireAt = now + state.mode.intervalMs
      return
    }
    if (this.#rescheduledThisRun) return
    if (this.#keepalivesUsed >= MAX_KEEPALIVES) {
      this.stop('no_reschedule')
      return
    }
    this.#keepalivesUsed += 1
    state.nextFireAt = now + KEEPALIVE_SECONDS * 1000
    state.reason = 'keepalive: no wakeup was scheduled'
  }

  due(now = Date.now()): boolean {
    const state = this.#state
    return state?.active === true && state.nextFireAt !== null && now >= state.nextFireAt
  }

  remainingMs(now = Date.now()): number | null {
    const state = this.#state
    if (!state?.active || state.nextFireAt === null) return null
    return Math.max(0, state.nextFireAt - now)
  }
}
