/**
 * Shared formatting utilities.
 */

import stringWidth from 'string-width'

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  const message = (err as { message?: unknown } | null)?.message
  return typeof message === 'string' ? message : String(err)
}

function repeatCount(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0
}

/** Standards-backed grapheme segmentation for safe Unicode truncation. */
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

const CLUSTER_SENSITIVE = /[\p{Mark}\p{Extended_Pictographic}\p{Regional_Indicator}\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Surrogate}\u200d\u1100-\u11ff\ufe00-\ufe0f]/v

const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3000, 0x3029],
  [0x3030, 0x303e],
  [0x3041, 0x3096],
  [0x30a0, 0x30ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xff01, 0xff60],
  [0xffe0, 0xffe6],
]

const NARROW_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0020, 0x007e],
  [0x00a1, 0x00ac],
  [0x00ae, 0x00ff],
  [0x0100, 0x017f],
  [0x2010, 0x2029],
  [0x202f, 0x205e],
]

function inRanges(cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  for (const [lo, hi] of ranges) {
    if (cp < lo) return false
    if (cp <= hi) return true
  }
  return false
}

function simpleCodePointWidth(cp: number): number | null {
  if (cp >= 0x20 && cp <= 0x7e) return 1
  if (inRanges(cp, WIDE_RANGES)) return 2
  if (inRanges(cp, NARROW_RANGES)) return 1
  return null
}

export function displayWidth(s: string): number {
  if (CLUSTER_SENSITIVE.test(s)) return stringWidth(s)
  let width = 0
  for (const char of s) {
    const cp = char.codePointAt(0)
    if (cp === undefined) return stringWidth(s)
    const w = simpleCodePointWidth(cp)
    if (w === null) return stringWidth(s)
    width += w
  }
  return width
}

function truncateToWidth(s: string, budget: number): string {
  let out = ''
  let used = 0
  for (const { segment } of graphemeSegmenter.segment(s)) {
    const size = displayWidth(segment)
    if (used + size > budget) break
    out += segment
    used += size
  }
  return out
}

export function relativeTime(iso: string): string {
  try {
    const date = new Date(iso)
    if (isNaN(date.getTime())) return iso
    const ms = Date.now() - date.getTime()
    const mins = Math.floor(ms / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    return `${days}d ago`
  } catch {
    return iso
  }
}

export function humanTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
  return `${n}`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * Wall-clock runtime as `2s` / `1m 34s` / `1h 30m`.
 *
 * Distinct from `formatDuration`, which is for sub-second tool latency. This is
 * for long-lived work, and one definition is shared by the background panel and
 * the task tool cards so a task reads the same in both places.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`
}

export function formatWallClock(timestamp: number): string {
  const at = new Date(timestamp)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
}

export function renderBar(value: number, max: number, width: number): string {  width = repeatCount(width)
  if (width === 0) return ''
  if (max <= 0 || !Number.isFinite(max) || !Number.isFinite(value)) return '░'.repeat(width)
  const filled = repeatCount(Math.round((value / max) * width))
  return '█'.repeat(Math.min(filled, width)) + '░'.repeat(Math.max(0, width - filled))
}

export function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\n/g, ' ').trim()
  if (oneLine.length <= max) return oneLine
  return oneLine.slice(0, max - 1) + '…'
}

export function truncateHeadTail(s: string, max: number): string {
  const SEP = ' ... '
  if (s.length <= max || max < SEP.length + 6) return truncate(s, max)
  const budget = max - SEP.length
  const headLen = Math.floor(budget / 2)
  const tailLen = budget - headLen
  return s.slice(0, headLen).trimEnd() + SEP + s.slice(s.length - tailLen).trimStart()
}

export function summarizeInline(value: string, maxChars: number): string {
  const collapsed = value.split(/\s+/).join(' ')
  return truncate(collapsed, maxChars)
}

export function clipDisplayText(text: string, columns: number): string {
  const width = Math.max(0, Math.floor(columns))
  if (displayWidth(text) <= width) return text
  if (width === 0) return ''
  return truncateToWidth(text, width - 1) + '…'
}

/** Max visible columns for the first line of a collapsed bash command. */
const BASH_CMD_FIRST_LINE_MAX = 120

/**
 * Shared expand/collapse copy. The expand hint is short because it rides on
 * a row that already carries the line count (a tool status row, a progress
 * header, a thinking summary); it never gets a row of its own.
 */
export const EXPAND_HINT = '(ctrl+o)'
export function expandLinesHint(n: number): string {
  return `+${n} lines ${EXPAND_HINT}`
}

export const COLLAPSE_HINT = '(ctrl+o to collapse)'

export interface BashCommandDisplay {
  /** Text after `⌘ bash  ` on the card header. Empty means header is just the tool name. */
  headline: string
  /** Extra indented lines under the header (expanded multi-line commands only). */
  detailLines: string[]
}

/**
 * Format a bash tool command for the tool card.
 *
 * Collapsed: keep short one-liners; multi-line / huge heredocs become
 * `first line … (+N lines, ctrl+o to expand)` so the transcript is not a
 * wrapped wall of text and the expand shortcut matches tool-result cards.
 * Expanded: multi-line commands are shown in full under the header (newlines
 * preserved), matching readable shell transcript style rather than flattening.
 */
export function formatBashCommandDisplay(command: unknown, expanded = false, fitToCard = false): BashCommandDisplay {
  if (typeof command !== 'string') return { headline: '', detailLines: [] }
  const normalized = command.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const trimmed = normalized.replace(/\n+$/, '')
  if (!trimmed) return { headline: '', detailLines: [] }

  const lines = trimmed.split('\n')
  const multi = lines.length > 1
  const first = (lines[0] ?? '').trimEnd()

  if (expanded && multi) {
    // Header carries the first line; remaining lines sit indented underneath.
    return {
      headline: first.trimEnd(),
      detailLines: lines.slice(1).map((line) => `  ${line}`),
    }
  }

  if (!multi) {
    const one = first.trim()
    return { headline: expanded || fitToCard ? one : clipDisplayText(one, BASH_CMD_FIRST_LINE_MAX), detailLines: [] }
  }

  // Collapsed multi-line: first non-empty-ish line + shared expand hint.
  const headRaw = first.trim() || lines.find((l) => l.trim())?.trim() || ''
  const head = fitToCard ? headRaw : clipDisplayText(headRaw, BASH_CMD_FIRST_LINE_MAX)
  return { headline: `${head} … ${expandLinesHint(lines.length)}`, detailLines: [] }
}

export function toolResultLines(content: string, isError: boolean, _toolName?: string, expanded?: boolean): string[] {
  const MAX_LINE_WIDTH = 256

  const capLine = (l: string) => l.length <= MAX_LINE_WIDTH ? l : truncateHeadTail(l, MAX_LINE_WIDTH)

  const summarize = (): string => {
    if (!content.trim()) {
      return isError ? 'tool returned an error' : 'completed'
    }
    return summarizeInline(content, 160)
  }

  const normalized = content.replace(/\r\n/g, '\n')
  if (normalized.includes('\n')) {
    const trimmed = normalized.replace(/\n+$/, '')
    if (!trimmed) return [summarize()]
    const allLines = trimmed.split('\n')
    if (expanded) return allLines.map(capLine)
    // Collapsed view: don't preview any content lines. A tool result (bash,
    // read, search, ...) is often long and noisy, so the default card shows
    // only a single hint with the full line count; ctrl+o expands it. A
    // single-line result has nothing to collapse, so it's shown inline.
    if (allLines.length > 1) {
      return [`... ${expandLinesHint(allLines.length)}`]
    }
    return allLines.map(capLine)
  }
  return [summarize()]
}
