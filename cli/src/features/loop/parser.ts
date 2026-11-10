import { BUILTIN_LOOP_TASK } from './builtin-task.js'

export type LoopMode =
  | { kind: 'fixed'; intervalMs: number }
  | { kind: 'dynamic' }

/**
 * What a loop repeats. `label` is how the transcript, the wakeup reminders
 * and `/loop status` name it: the user's own words for a user prompt, a fixed
 * short name for the built-in task, whose prompt is a page long.
 */
export interface LoopTask {
  prompt: string
  label: string
}

export type LoopCommand =
  | { kind: 'stop' }
  | { kind: 'status' }
  | { kind: 'start'; mode: LoopMode; task: LoopTask }
  | { kind: 'invalid'; reason: string }

const LABEL_CHARS = 120

export function userTask(prompt: string): LoopTask {
  const label = prompt.length > LABEL_CHARS ? `${prompt.slice(0, LABEL_CHARS)}…` : prompt
  return { prompt, label }
}

export const MIN_INTERVAL_MS = 60_000
export const MAX_INTERVAL_MS = 3_600_000

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 }
const LEADING = /^(\d+)(s|m|h)\b\s*/i
const TRAILING = /\s*\bevery\s+(\d+)(s|m|h)\s*$/i

export function parseDuration(text: string): number | null {
  const match = /^(\d+)(s|m|h)$/i.exec(text.trim())
  if (!match) return null
  const unit = UNIT_MS[match[2]!.toLowerCase()]
  if (unit === undefined) return null
  return Number(match[1]) * unit
}

export function parseLoopArgs(args: string): LoopCommand {
  const trimmed = args.trim()
  const lower = trimmed.toLowerCase()
  if (lower === 'stop' || lower === 'cancel') return { kind: 'stop' }
  if (lower === 'status') return { kind: 'status' }

  let prompt = trimmed
  let intervalMs: number | null = null

  const leading = LEADING.exec(prompt)
  if (leading) {
    intervalMs = parseDuration(`${leading[1]}${leading[2]}`)
    prompt = prompt.slice(leading[0].length)
  } else {
    const trailing = TRAILING.exec(prompt)
    if (trailing) {
      intervalMs = parseDuration(`${trailing[1]}${trailing[2]}`)
      prompt = prompt.slice(0, trailing.index)
    }
  }

  prompt = prompt.trim()
  // Bare `/loop` (with or without an interval) carries on with whatever the
  // conversation is doing; `/loop status` is the explicit way to look at it.
  const task = prompt ? userTask(prompt) : BUILTIN_LOOP_TASK

  if (intervalMs === null) return { kind: 'start', mode: { kind: 'dynamic' }, task }
  if (intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
    return { kind: 'invalid', reason: 'Interval must be between 1m and 1h.' }
  }
  return { kind: 'start', mode: { kind: 'fixed', intervalMs }, task }
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`
  if (m > 0) return s > 0 ? `${m}m${s}s` : `${m}m`
  return `${s}s`
}
