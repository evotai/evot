import type { HostToolExtension } from '../term/host-tools.js'
import { LoopController, type LoopSnapshot, type RunOutcome, type StopCause } from './controller.js'
import { createLoopExtension } from './host-tool.js'
import { formatDuration, parseLoopArgs, type LoopCommand } from './parser.js'
import { buildLoopStartPrompt, buildLoopWakeupPrompt, type RunningBackgroundTask } from './prompt.js'
import { formatWallClock as clock } from '../render/format.js'
import { earlyWakeSentence } from './early-wake.js'

export interface LoopSessionDeps {
  runTurn: (userLine: string | null, prompt: string, extension: HostToolExtension) => void
  canWake: () => boolean
  notify: (text: string) => void
  requestRender: () => void
  waitingChanged?: (waiting: boolean) => void
  /** Background shells still running, read at each wakeup so the prompt
   *  states what is actually alive instead of what the agent remembers. */
  backgroundTasks?: () => readonly RunningBackgroundTask[]
}

const TICK_MS = 1000

const STOP_TEXT: Record<StopCause, string> = {
  user: 'stopped by you',
  model: 'done · agent reported the goal reached',
  max_age: 'stopped · 7-day limit reached',
  errors: 'stopped · 3 consecutive run errors',
  no_reschedule: 'stopped · agent did not schedule a wakeup twice',
  session_switch: 'stopped · session changed',
}


export class LoopSession {
  readonly #controller: LoopController
  readonly #extension: HostToolExtension
  readonly #deps: LoopSessionDeps
  #timer: ReturnType<typeof setInterval> | null = null
  #runBegun = false
  #pendingStopNotice: string | null = null
  #waitingReported = false

  constructor(deps: LoopSessionDeps) {
    this.#deps = deps
    this.#controller = new LoopController({
      stopped: (cause, snapshot) => this.#onStopped(cause, snapshot),
    })
    this.#extension = createLoopExtension(this.#controller, () => this.#deps.backgroundTasks?.() ?? [])
  }

  get active(): boolean {
    return this.#controller.active
  }

  get snapshot(): LoopSnapshot | null {
    return this.#controller.snapshot
  }

  get waiting(): boolean {
    return this.#controller.remainingMs() !== null
  }

  /** The `schedule_wakeup` tool, offered on every turn while a loop is
   *  active: a loop wakeup must call it, a user turn may, to change the pace
   *  or stop when asked in plain words. */
  get extension(): HostToolExtension | undefined {
    return this.#controller.active ? this.#extension : undefined
  }

  handleCommand(rawInput: string, args: string): void {
    const command: LoopCommand = parseLoopArgs(args)
    switch (command.kind) {
      case 'invalid':
        this.#deps.notify(command.reason)
        return
      case 'stop':
        if (!this.#controller.stop('user')) this.#deps.notify('No loop is running.')
        return
      case 'status':
        this.#deps.notify(this.statusLine() ?? 'No loop is running. Usage: /loop [interval] [prompt]')
        return
      case 'start': {
        if (this.#controller.active) this.#controller.stop('user')
        this.#controller.start(command.mode, command.task)
        this.#ensureTimer()
        this.#startRun()
        const background = this.#deps.backgroundTasks?.() ?? []
        this.#deps.runTurn(rawInput, buildLoopStartPrompt(command.mode, command.task.prompt, rawInput, background), this.#extension)
        return
      }
    }
  }

  /** True from the moment the loop launches a turn (start or wakeup) until
   *  the host reports it over with `endRun`. A turn the user types while the
   *  loop is parked is not a loop run: the timer keeps counting, the
   *  keepalive budget is untouched, and the next wakeup reads what happened
   *  from the transcript like any other turn. */
  get runInFlight(): boolean {
    return this.#runBegun
  }

  endRun(outcome: RunOutcome): void {
    if (!this.#runBegun) return
    this.#runBegun = false
    this.#controller.endRun(outcome)
    this.#flushStopNotice()
    this.#syncWaiting()
    this.#deps.requestRender()
  }

  /** The host abandons the run on reset, so no later endRun will arrive. */
  reset(cause: StopCause = 'session_switch'): void {
    this.#controller.stop(cause)
    this.#runBegun = false
    this.#flushStopNotice()
    this.#syncWaiting()
    this.#deps.requestRender()
  }

  /** The confirmed `Esc` while parked between ticks: same as `/loop stop`,
   *  without the typing. The two-press window lives with the host's other
   *  interrupts (`RunInteraction`), not here. False when there is nothing
   *  waiting, so the caller can let the key fall through. */
  cancelWait(): boolean {
    if (!this.waiting) return false
    this.#controller.stop('user')
    this.#flushStopNotice()
    this.#syncWaiting()
    this.#deps.requestRender()
    return true
  }

  statusLine(now = Date.now()): string | null {
    const snapshot = this.#controller.snapshot
    if (!snapshot) return null
    const remaining = this.#controller.remainingMs(now)
    const mode = snapshot.mode.kind === 'fixed' ? `every ${formatDuration(snapshot.mode.intervalMs)}` : 'self-paced'
    const next = remaining === null ? 'running now' : `next wakeup in ${formatDuration(remaining)} (${clock(now + remaining)})`
    const noop = snapshot.noopStreak > 0 ? ` · ${snapshot.noopStreak} quiet` : ''
    const early = remaining === null ? null : this.earlyWake()
    const reason = snapshot.reason ? `\n  ${snapshot.reason}` : ''
    const earlyLine = early ? `\n  ${early}` : ''
    return `◌ loop · ${snapshot.task.label} · ${mode} · tick ${snapshot.tick} · ${next}${noop} · since ${clock(snapshot.startedAt)}${reason}${earlyLine}`
  }

  /** The next wakeup as the status-line badge shows it: the `19m37s` label
   *  and the raw remaining time, so the footer can tone the final minute;
   *  null while a run is in flight or no loop is active. `earlyWake` names
   *  the running shell that would end the wait before the timer. */
  waitRemaining(now = Date.now()): { label: string; remainingMs: number; earlyWake: string | null } | null {
    const remaining = this.#controller.remainingMs(now)
    if (remaining === null) return null
    return { label: formatDuration(remaining), remainingMs: remaining, earlyWake: this.earlyWake() }
  }

  /** The sentence for a parked loop with a live background shell, or null. */
  earlyWake(): string | null {
    const tasks = this.#deps.backgroundTasks?.() ?? []
    return earlyWakeSentence(tasks.map(task => task.taskId))
  }

  dispose(): void {
    this.#clearTimer()
  }

  #ensureTimer(): void {
    if (this.#timer) return
    this.#timer = setInterval(() => this.#tick(), TICK_MS)
    ;(this.#timer as unknown as { unref?: () => void }).unref?.()
  }

  #clearTimer(): void {
    if (!this.#timer) return
    clearInterval(this.#timer)
    this.#timer = null
  }

  #tick(): void {
    if (!this.#controller.active) {
      this.#clearTimer()
      return
    }
    this.#deps.requestRender()
    if (!this.#controller.due() || !this.#deps.canWake()) return
    this.#startRun()
    const snapshot = this.#controller.snapshot
    if (!snapshot) return
    const now = Date.now()
    const quiet = snapshot.noopStreak > 0 ? ` · ${snapshot.noopStreak} quiet tick${snapshot.noopStreak === 1 ? '' : 's'} so far` : ''
    this.#deps.notify(`◌ loop wakeup #${snapshot.tick} (${clock(now)})${quiet}`)
    const background = this.#deps.backgroundTasks?.() ?? []
    this.#deps.runTurn(null, buildLoopWakeupPrompt(snapshot, now, background), this.#extension)
  }

  #startRun(): void {
    this.#runBegun = true
    this.#controller.beginRun()
    this.#syncWaiting()
  }

  #syncWaiting(): void {
    const waiting = !this.#runBegun && this.waiting
    if (waiting === this.#waitingReported) return
    this.#waitingReported = waiting
    this.#deps.waitingChanged?.(waiting)
  }

  #onStopped(cause: StopCause, snapshot: LoopSnapshot): void {
    this.#clearTimer()
    const ticks = `${snapshot.tick} tick${snapshot.tick === 1 ? '' : 's'}`
    const ran = formatDuration(Date.now() - snapshot.startedAt)
    const notice = `⏹ loop ${STOP_TEXT[cause]} · ${ticks} · ran ${ran}`
    if (this.#runBegun) {
      this.#pendingStopNotice = notice
      return
    }
    this.#deps.notify(notice)
    this.#syncWaiting()
    this.#deps.requestRender()
  }

  #flushStopNotice(): void {
    const notice = this.#pendingStopNotice
    if (!notice) return
    this.#pendingStopNotice = null
    this.#deps.notify(notice)
  }
}
