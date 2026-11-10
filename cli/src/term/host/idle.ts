import type { LoopSession } from '../../features/loop/session.js'
import type { BackgroundProcess } from '../../native/index.js'
import type { UIToolCall } from '../../render/message-types.js'
import { taskTitle } from '../../render/task-label.js'
import { awaitedTaskIds } from '../app/background/background-panel.js'
import type { BackgroundTerminals } from '../app/background/background-terminals.js'
import type { RunInteraction, RunInteractionInput } from '../app/run/run-interaction.js'
import type { TaskWaitSuggestion } from '../app/suggestion/index.js'
import type { ReplState } from './state.js'
import { LOOP_TITLE_CLOCK, SPINNER_INTERVAL_MS, TITLE_INTERVAL_FRAMES } from './timing.js'
import type { TermRenderer } from '../screen/renderer.js'
import type { TerminalTitle } from '../screen/title.js'
import type { AwaitedTasks } from '../viewmodel/run-status.js'
import { advanceSpinner } from '../widgets/spinner.js'

/** What this controller needs from the host. Looked up lazily on every use. */
export interface IdleDeps {
  readonly backgroundTerminals: BackgroundTerminals
  readonly loopSession: LoopSession
  readonly renderer: TermRenderer
  readonly runInteraction: RunInteraction
  readonly runInteractionInput: () => RunInteractionInput
  readonly setTerminalTitle: (suffix?: string | undefined, force?: boolean) => void
  readonly suggestionTaskWait: TaskWaitSuggestion
  readonly terminalTitle: TerminalTitle
}

export interface IdleController {
  awaitedTaskSummary(calls: UIToolCall[]): AwaitedTasks | undefined
  readonly idleWaitTitle: () => string
  refreshBackgroundProcesses(): void
  readonly startIdleWaitTimer: () => () => void
  readonly unfreezeTerminalTitle: () => void
}

/** What the REPL shows while no turn runs: the idle tab title, background-wait tracking and its animation. */
export function createIdleController(st: ReplState, deps: IdleDeps): IdleController {
  // Releasing a '?' freeze must also repaint — unfreeze() only clears the
  // flag, so the glyph would linger on the tab until the next title write.
  // An in-flight run repaints its own frames; otherwise restore the idle
  // marker the same way overlays like /sessions leave it.
  // The tab bar is drawn in the system UI font, where U+25CC `◌` (used in
  // the transcript) often falls back to a bare dot; the clock faces are in
  // every UI font, and the wait timer below animates them while parked.
  const idleWaitTitle = (): string => {
    if (deps.loopSession.waiting) return `${LOOP_TITLE_CLOCK[0]} loop`
    if (st.backgroundWaitSince !== null) return '○ bg'
    return '✳'
  }
  const unfreezeTerminalTitle = () => {
    deps.terminalTitle.unfreeze()
    if (!st.isLoading) deps.setTerminalTitle(idleWaitTitle())
  }

  /** Name and runtime of the tasks a blocking wait holds the turn for. */
  function awaitedTaskSummary(calls: UIToolCall[]): AwaitedTasks | undefined {
    const tasks = awaitedTaskIds(calls)
      .map(id => deps.backgroundTerminals.liveTask(id))
      .filter((task): task is BackgroundProcess => task !== undefined)
    if (tasks.length === 0) return undefined
    return {
      titles: tasks.map(task => taskTitle(task)),
      elapsedMs: Math.max(...tasks.map(task => task.elapsed_ms)),
    }
  }

  function refreshBackgroundProcesses(): void {
    deps.backgroundTerminals.refresh()
    // The native blocking-wait count is already polled here. Entering a wait
    // offers steering without a final answer; leaving it cancels only that
    // wait's automatic request, never explicit Tab assistance.
    deps.suggestionTaskWait.sync(deps.runInteraction.snapshot(deps.runInteractionInput()).kind === 'waiting-task')
    // Track the idle wait alongside the poll that discovers it. A live
    // background task will wake the agent when it finishes, so while one is
    // running the agent is genuinely parked rather than done.
    const waiting = deps.backgroundTerminals.runningCount() > 0
    if (waiting && st.backgroundWaitSince === null) {
      st.backgroundWaitSince = Date.now()
      deps.renderer.requestRender()
    } else if (!waiting && st.backgroundWaitSince !== null) {
      st.backgroundWaitSince = null
      if (!st.isLoading) deps.setTerminalTitle(idleWaitTitle())
      deps.renderer.requestRender()
    }
  }

  // Animates the idle wait row. The spinner timer only runs during a turn, and
  // the ad-slot ticker stops whenever an overlay owns the screen, so neither can
  // be relied on to keep this glyph moving.
  function startIdleWaitTimer(): () => void {
    const timer = setInterval(() => {
      if (st.isLoading) return
      const loopWaiting = deps.loopSession.waiting
      if (!loopWaiting && st.backgroundWaitSince === null) return
      st.backgroundWaitSpinner = advanceSpinner(st.backgroundWaitSpinner)
      if (st.backgroundWaitSpinner.frame % TITLE_INTERVAL_FRAMES === 0) {
        // A running turn blinks two braille dots in the tab. A parked loop is a
        // different state, waiting for a clock, so it gets a clock: the hand
        // sweeps a quarter turn per tick and is unmistakable next to the dots.
        // A background wait keeps the dots: the agent is waiting on work.
        const frame = st.titleFrame++
        if (loopWaiting) {
          deps.setTerminalTitle(`${LOOP_TITLE_CLOCK[frame % LOOP_TITLE_CLOCK.length]} loop`)
        } else {
          deps.setTerminalTitle(`${['⠂', '⠐'][frame % 2]} bg ${deps.backgroundTerminals.runningCount()}`)
        }
      }
      deps.renderer.requestRender()
    }, SPINNER_INTERVAL_MS)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    return () => clearInterval(timer)
  }

  return { awaitedTaskSummary, idleWaitTitle, refreshBackgroundProcesses, startIdleWaitTimer, unfreezeTerminalTitle }
}
