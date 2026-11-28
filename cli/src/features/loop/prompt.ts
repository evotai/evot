import type { LoopMode } from './parser.js'
import { formatDuration } from './parser.js'
import type { LoopSnapshot } from './controller.js'
import { CACHE_LEAD_SECONDS, CACHE_WINDOW_SECONDS } from './controller.js'
import { buildCommandPrompt } from '../../session/command-envelope.js'

/** A background shell the host is still tracking at wakeup time. */
export interface RunningBackgroundTask {
  taskId: string
  command: string
  elapsedMs: number
}

/** Largest delay that resumes on a warm cache; `clampDelaySeconds` snaps
 *  anything inside the lead window down to this value. */
const CACHE_SAFE_SECONDS = CACHE_WINDOW_SECONDS - CACHE_LEAD_SECONDS

/** The first loop turn. `input` is what the user typed (`/loop 5m …`); the
 *  rules live inside the command envelope so replays and shares show the
 *  user's line and fold the host's instructions. `background` is what the
 *  host sees running right now: a loop started after a restart must not
 *  inherit watchers from the old process's transcript. */
export function buildLoopStartPrompt(
  mode: LoopMode,
  prompt: string,
  input = `/loop ${prompt}`,
  background: readonly RunningBackgroundTask[] = [],
): string {
  const header = mode.kind === 'fixed'
    ? `The host wakes you every ${formatDuration(mode.intervalMs)}; you do not schedule the next wakeup yourself.`
    : `End each loop turn with \`schedule_wakeup\`. Use ${CACHE_SAFE_SECONDS}s unless the user requests another pace.`

  const instructions = [
    header,
    '',
    'Task:',
    prompt,
    '',
    'If there is work to repeat, use `loop_plan` to show the steps and relevant checks established in this conversation. Update it as the work progresses.',
    'Use the live background list below rather than restarting a watcher that is already running. Report what changed.',
    'When the goal is met or no useful pass remains, account for any unfinished items and call `schedule_wakeup` with `stop: true`.',
    '',
    `${describeBackground(background)} Start now: perform the first pass of the task.`,
  ].join('\n')

  return buildCommandPrompt({ name: 'loop', input, instructions })
}

/** Which background shells are still running, as the host sees them. The
 *  model must not assert a watcher exists unless it appears here. */
function describeBackground(tasks: readonly RunningBackgroundTask[]): string {
  if (tasks.length === 0) return 'No background shell is running.'
  const noun = tasks.length === 1 ? 'shell' : 'shells'
  const items = tasks.map(task => `${task.taskId.slice(0, 8)} (${formatDuration(task.elapsedMs)}) ${oneLine(task.command)}`)
  return `Background ${noun} still running: ${items.join('; ')}.`
}

/** `HH:MM` in local time: the wakeup header is a reminder, not a log line. */
function hourMinute(timestamp: number): string {
  return new Date(timestamp).toTimeString().slice(0, 5)
}

function oneLine(command: string, max = 80): string {
  const flat = command.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function buildLoopWakeupPrompt(
  snapshot: LoopSnapshot,
  now = Date.now(),
  background: readonly RunningBackgroundTask[] = [],
): string {
  const time = hourMinute(now)
  const streak = snapshot.noopStreak > 0 && snapshot.streakStartedAt !== null
    ? ` · ${snapshot.noopStreak} no-op tick${snapshot.noopStreak === 1 ? '' : 's'} since ${hourMinute(snapshot.streakStartedAt)}`
    : ''
  const tail = snapshot.mode.kind === 'dynamic'
    ? ' End with schedule_wakeup.'
    : ''
  return buildCommandPrompt({
    name: 'loop-wakeup',
    input: `loop wakeup #${snapshot.tick} (${time})${streak}`,
    instructions: `/loop wakeup #${snapshot.tick} (${time})${streak}. ${describeBackground(background)} Continue: ${snapshot.task.label}. Resume from the last result.${tail}`,
  })
}
