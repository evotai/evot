import type { RunInteractionState } from '../app/run/run-interaction.js'
import { backgroundChord } from '../../ui/key-hints.js'
import { truncateAnsiToWidth } from '../../ui/wrap.js'
import { clipDisplayText } from '../../ui/format.js'
import type { ViewBlock } from './types.js'
import { finiteSize } from './width.js'

/** Animated metrics must never add/remove rows beneath the transcript. */
export function buildRunStatusBlock(text: string, columns: number): ViewBlock {
  return {
    lines: [{ spans: [{ text: truncateAnsiToWidth(text.replace(/[\r\n]+/g, ' '), finiteSize(columns, 80)) }] }],
    marginTop: 1,
  }
}

/** Tasks a blocking `task_output` wait is holding the turn for. */
export interface AwaitedTasks {
  /** Titles of the awaited tasks, in call order. */
  titles: string[]
  /** Runtime of the longest-running awaited task. */
  elapsedMs: number
}

/** Title room on the status row; the action hint keeps the rest. */
const AWAITED_TITLE_MAX = 48

/** `Waiting on <task>…`, or a count when several tasks are awaited. */
function waitingTaskLabel(awaited?: AwaitedTasks): string {
  const titles = awaited?.titles.filter(Boolean) ?? []
  if (titles.length === 0) return 'Waiting for task result…'
  if (titles.length > 1) return `Waiting on ${titles.length} tasks…`
  return `Waiting on ${clipDisplayText(titles[0]!, AWAITED_TITLE_MAX)}…`
}

/** Copy and display policy only. Never reads native state or handles keys. */
export function runStatusPresentation(state: RunInteractionState, awaited?: AwaitedTasks): {
  label?: string
  hint: string
  confirmationPending: boolean
  showUsage: boolean
  allowSlowWarning: boolean
} {
  // Show the next useful action, not every supported key. Confirmation wins
  // over backgrounding; hiding Esc here never disables its actual binding.
  let hint = ''
  const target = state.interruptTarget === 'compaction' ? ' compaction' : ''
  if (state.interruptTarget === 'background') {
    hint = state.interruptPending
      ? `esc again to stop all ${state.backgroundTasks ?? 0} background tasks`
      : 'esc twice to stop all background tasks'
  } else if (state.interruptTarget === 'loop') {
    hint = state.interruptPending ? 'esc again to stop the loop' : 'esc twice to stop the loop'
  } else if (state.interruptTarget && state.interruptPending) {
    hint = `esc again to interrupt${target}`
  } else if (state.backgroundAction) {
    hint = `${backgroundChord()} to ${state.backgroundAction === 'background-shell' ? 'background' : 'release wait'}`
  } else if (state.interruptTarget) {
    hint = `esc twice to interrupt${target}`
  }
  return {
    label: state.kind === 'waiting-task' ? waitingTaskLabel(awaited)
      : state.kind === 'waiting-background'
        ? state.backgroundStopping ? 'Stopping background tasks…' : 'Background task running · resumes when finished'
      : state.kind === 'waiting-loop' ? 'Loop waiting for the next wakeup'
        : undefined,
    hint: hint ? ` · ${hint}` : '',
    confirmationPending: Boolean(state.interruptTarget && state.interruptPending),
    showUsage: state.showUsage,
    allowSlowWarning: state.allowSlowWarning,
  }
}
