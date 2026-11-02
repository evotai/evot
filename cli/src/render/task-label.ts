/**
 * Short names for background tasks.
 *
 * A launched shell is usually `cd <repo> && <the real command>`, or a script
 * that first sets variables (`S="-o BatchMode=yes …"; ssh $S host …`). Shown
 * raw, the setup fills the row and the part that says what the task does is
 * truncated away. The panel, the status row and the task cards all name a
 * task through this module, so the same task reads the same everywhere.
 */
import { resolve } from 'node:path'

export interface TaskCommand {
  /** The command from its first meaningful step; may span several lines. */
  command: string
  /** Directory of the last leading `cd`, unquoted, when there was one. */
  dir?: string
}

interface Segment {
  start: number
  text: string
}

/**
 * Leading top-level steps of a shell command, split at `&&`, `;` and newlines
 * outside quotes. Only the leading steps matter, so `||` and pipes end the
 * scan instead of being split: `cd x || exit` is not plain setup.
 */
function leadingSegments(command: string): Segment[] {
  const segments: Segment[] = []
  let quote: '"' | "'" | null = null
  let start = 0
  const push = (end: number, next: number) => {
    segments.push({ start, text: command.slice(start, end) })
    start = next
  }
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!
    if (quote === "'") {
      if (char === "'") quote = null
      continue
    }
    if (char === '\\') {
      i++
      continue
    }
    if (quote === '"') {
      if (char === '"') quote = null
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '&' && command[i + 1] === '&') {
      push(i, i + 2)
      i++
    } else if (char === ';' || char === '\n') push(i, i + 1)
  }
  segments.push({ start, text: command.slice(start) })
  return segments
}

const ASSIGNMENT = String.raw`[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"(?:\\.|[^"\\])*"|[^\s'";&|]*)`
/** `A=1`, `export A=1 B="x y"`: sets variables and runs nothing. */
const ASSIGNMENTS_ONLY = new RegExp(String.raw`^(?:export\s+)?${ASSIGNMENT}(?:\s+${ASSIGNMENT})*$`)
/** `set -e`, `set -euo pipefail`: shell options, not the task. */
const SET_OPTIONS = /^set\s+[-+][A-Za-z]+(?:\s+[A-Za-z]+)*$/
const CD = /^cd(?:\s+(.+))?$/

function unquote(text: string): string {
  const trimmed = text.trim()
  const quoted = /^(["'])(.*)\1$/.exec(trimmed)
  return quoted ? quoted[2]! : trimmed
}

/** The command from its first step that is not `cd`, a variable or `set`. */
export function stripTaskSetup(command: string): TaskCommand {
  const normalized = command.replace(/\r\n?/g, '\n').trim()
  let dir: string | undefined
  for (const segment of leadingSegments(normalized)) {
    const step = segment.text.trim()
    if (!step) continue
    const cd = CD.exec(step)
    if (cd) {
      dir = cd[1] ? unquote(cd[1]) : '~'
      continue
    }
    if (ASSIGNMENTS_ONLY.test(step) || SET_OPTIONS.test(step)) continue
    const rest = normalized.slice(segment.start).trim()
    return dir === undefined ? { command: rest } : { command: rest, dir }
  }
  // Nothing but setup: the setup is the task, show it as written.
  return { command: normalized }
}

/**
 * One-line name for a task's command. A script that is still several lines
 * after its setup reads as `script (N lines)`: its first line is not
 * necessarily what is running now.
 */
export function taskCommandLabel(command: string): string {
  const lines = stripTaskSetup(command).command.split('\n').filter(line => line.trim())
  if (lines.length > 1) return `script (${lines.length} lines)`
  return lines[0]?.trim() || '(empty)'
}

/** What the task is for: its launch description, else its command label. */
export function taskTitle(task: { command: string; description?: string | null }): string {
  const description = task.description?.replace(/\s+/g, ' ').trim()
  return description || taskCommandLabel(task.command)
}

/**
 * The `cd` target worth showing beside a task: only when it leaves the task's
 * own working directory, which every row would otherwise repeat.
 */
export function taskDirectory(command: string, cwd: string): string | undefined {
  const { dir } = stripTaskSetup(command)
  if (!dir) return undefined
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const expanded = dir === '~' ? home : dir.startsWith('~/') ? `${home}${dir.slice(1)}` : dir
  // `$VAR` or `$(…)` cannot be resolved here; show it as written.
  if (/[$`]/.test(expanded)) return dir
  const absolute = resolve(cwd || '/', expanded)
  if (absolute === resolve(cwd || '/')) return undefined
  if (home && absolute === home) return '~'
  return home && absolute.startsWith(`${home}/`) ? `~${absolute.slice(home.length)}` : absolute
}
