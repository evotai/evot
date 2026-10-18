import type { BackgroundProcess } from '../../../native/contracts/results.js'
import type { SuggestionActivity } from '../../../native/contracts/suggestion.js'
import type { LoopSnapshot } from '../../../loop/controller.js'
import { taskLabel } from './tasks.js'

/** Project only current runtime metadata. No process commands, output reads,
 * transcript inference, or extra polling. Minute buckets keep cache keys stable. */
export function activeWork(background: readonly BackgroundProcess[], loop: LoopSnapshot | null, loopRunning: boolean): SuggestionActivity[] {
  const activities: SuggestionActivity[] = []
  if (loop?.active) {
    const next = loop.nextFireAt === null ? undefined : new Date(loop.nextFireAt)
    activities.push({
      kind: 'loop', id: `loop:${loop.startedAt}`, goal: taskLabel(loop.task.label),
      phase: loopRunning ? 'running' : 'waiting', iteration: loop.tick,
      cadence: loop.mode.kind,
      ...(loop.mode.kind === 'fixed' ? { interval_ms: loop.mode.intervalMs } : {}),
      ...(next && Number.isFinite(next.getTime()) ? { next_check_at: next.toISOString() } : {}),
      ...(loop.reason ? { wait_reason: taskLabel(loop.reason) } : {}),
      unchanged_iterations: loop.noopStreak,
    })
  }
  for (const process of background.filter(process => process.status === 'running').slice(0, 6)) {
    activities.push({
      kind: 'background', id: process.task_id,
      ...(process.description?.trim() ? { goal: taskLabel(process.description) } : {}),
      phase: 'running', elapsed_minutes: Math.floor(process.elapsed_ms / 60_000),
      ...(process.quiet_for_ms !== undefined ? { quiet_minutes: Math.floor(process.quiet_for_ms / 60_000) } : {}),
    })
  }
  return activities
}
