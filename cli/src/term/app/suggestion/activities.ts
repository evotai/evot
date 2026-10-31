import type { BackgroundProcess } from '../../../native/contracts/results.js'
import type { SuggestionActivity } from '../../../native/contracts/suggestion.js'
import type { LoopSnapshot } from '../../../loop/controller.js'
import { taskLabel } from './tasks.js'

const COMMAND_LINES = 12
const COMMAND_CHARS = 600
const TAIL_LINES = 8
const TAIL_LINE_CHARS = 160

/** Head of the launched command. For a heredoc script the body is the plan
 * (which steps run, in what order, what it greps for), so keep its first
 * lines rather than only `python3 - <<'EOF'`. Blank lines and comments-only
 * noise are dropped; the bound is on the joined text. */
export function commandLabel(command: string): string | undefined {
  const lines = command.split('\n').map(line => line.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim()).filter(line => line.length > 0)
  if (!lines.length) return undefined
  const text = lines.slice(0, COMMAND_LINES).join('\n')
  return Array.from(text).slice(0, COMMAND_CHARS).join('')
}

/** Bounded trailing output; empty while a compile or sleep loop stays silent. */
export function outputTail(lines: readonly string[] | undefined): string[] {
  if (!lines?.length) return []
  return lines.slice(-TAIL_LINES)
    .map(line => Array.from(line.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim()).slice(0, TAIL_LINE_CHARS).join(''))
    .filter(line => line.length > 0)
}

/** Project current runtime metadata plus what each background task is (its
 * command) and where it is (a bounded output tail already kept by the engine).
 * No extra polling or file reads. Minute buckets keep elapsed/quiet stable;
 * the tail changes only when the task prints, which is exactly when a fresh
 * suggestion is worth asking for. */
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
    const command = commandLabel(process.command)
    const tail = outputTail(process.recent_output)
    activities.push({
      kind: 'background', id: process.task_id,
      ...(process.description?.trim() ? { goal: taskLabel(process.description) } : {}),
      ...(command !== undefined ? { command } : {}),
      ...(tail.length ? { output_tail: tail } : {}),
      phase: 'running', elapsed_minutes: Math.floor(process.elapsed_ms / 60_000),
      ...(process.quiet_for_ms !== undefined ? { quiet_minutes: Math.floor(process.quiet_for_ms / 60_000) } : {}),
    })
  }
  return activities
}
