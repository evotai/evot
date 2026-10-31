import type { LoopMode } from './parser.js'
import { formatDuration } from './parser.js'
import type { LoopSnapshot } from './controller.js'
import { CACHE_LEAD_SECONDS, CACHE_WINDOW_SECONDS, MIN_DELAY_SECONDS, MAX_DELAY_SECONDS } from './controller.js'
import { buildCommandPrompt } from '../session/command-envelope.js'

/** A background shell the host is still tracking at wakeup time. */
export interface RunningBackgroundTask {
  taskId: string
  command: string
  elapsedMs: number
}

const SHARED_RULES = [
  'On the first pass, before doing anything else, call `loop_plan` with the checklist of what "done" means for this task. Read the task text broadly, not literally: include every kind of verification this conversation already established for this work (for example, if earlier rounds ran correctness tests and a performance comparison, both are items), and name each one. The user reads this card to correct the scope early, so record it before the first action.',
  'Call `loop_plan` again, with the whole list, whenever an item changes state (todo, doing, done, blocked, deferred) or a new item appears from a review finding or a failure. Never silently drop an item; mark it deferred with a one-line note the user can see. Do not repeat the checklist in your reply: the card shows it.',
  'Prefer event-driven waiting over polling: when something external must happen (CI, a review, a deploy), start one background shell command that blocks until the condition changes and exits. Its completion wakes you immediately, so you never need a short wakeup to check on it.',
  'Arm a watcher once. Each wakeup lists the background shells still running; trust that list, not your memory. Never report a watcher as running unless it appears there, and do not start a second one for the same condition.',
  'When woken by a background shell finishing, handle that event first, then decide whether to keep waiting.',
  'When nothing actionable happened, reply in one short line; do not restate the checks you performed.',
  'Keep a running cursor (last review id, last commit, last timestamp) in your reply so later wakeups can compare against it.',
  'Tell the user in one line when the loop is newly blocked on a decision only they can make, or when something landed that they would want to act on now.',
  'Before `stop: true`, re-read the `loop_plan` checklist. Stop only when every item is done or deferred with its note shown; if any item is still todo or doing, keep working on it or keep waiting. If you are unsure whether an item belongs in scope, ask the user in one line and wait rather than stop. Never stop with a summary that admits something was left undone.',
]

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
    ? [
        `You are running a recurring loop. The host wakes you every ${formatDuration(mode.intervalMs)} with a short reminder; you do not schedule the next wakeup yourself.`,
        'The loop runs until the user stops it or a week passes. When the task\'s goal is reached, call `schedule_wakeup` with `stop: true` as your final action so it does not keep firing.',
      ].join(' ')
    : [
        'You are running a self-paced loop. Every turn: do the work, write a short status line (with your cursor), then call `schedule_wakeup` exactly once as the final action; the turn ends when it returns.',
        'Call it with `stop: true` when the goal is reached or the loop cannot move further without the user. Quiet ticks while a watcher you armed is still running are expected and do not count; otherwise, on the third straight tick with nothing to do, stop and say so in one line rather than keep waking.',
      ].join(' ')

  const dynamicRules = mode.kind === 'dynamic'
    ? [
        `\`delay_seconds\` is clamped to [${MIN_DELAY_SECONDS}, ${MAX_DELAY_SECONDS}]. Use ${CACHE_SAFE_SECONDS}s (about 5 minutes) every time, including long waits such as a CI pipeline, a human review or a multi-hour benchmark; a watcher finishing wakes you sooner anyway. Do not lengthen the delay on your own because the wait looks long or because recent ticks were quiet; only the user changes the pace.`,
        `The prompt cache lives ${formatDuration(CACHE_WINDOW_SECONDS * 1000)}: delays up to ${CACHE_SAFE_SECONDS}s resume on a warm cache, longer ones pay one miss. Do not choose ${CACHE_WINDOW_SECONDS}s exactly; stay at ${CACHE_SAFE_SECONDS}s.`,
        '`noop` is required: true when this turn changed nothing and found nothing new; false when you edited files, pushed, commented, or surfaced a finding. Consecutive quiet ticks are counted and shown to you at the next wakeup.',
        'The `reason` must be one specific sentence about what you are waiting for.',
      ]
    : []

  const instructions = [
    header,
    '',
    'Task:',
    prompt,
    '',
    'Rules:',
    ...[...SHARED_RULES, ...dynamicRules].map(rule => `- ${rule}`),
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
    instructions: `/loop wakeup #${snapshot.tick} (${time})${streak}. ${describeBackground(background)} Continue: ${snapshot.task.label}. Pick up from your last checklist; do not narrow it.${tail}`,
  })
}
