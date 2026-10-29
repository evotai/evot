/**
 * One row that shows how far a long operation has got, redrawn in place.
 *
 * Builds on `progress-line.ts`, which owns the "one committed row, rewritten by
 * id" mechanics. This layer owns what the row says: a label, a bar, the
 * counted units, a percentage and the time spent, so an upload, a download or
 * an index pass all read the same way:
 *
 *     ⋯ Sharing with your team  ████████░░░░░░░░░░░░  12,000 / 32,000 entries · 37% · 14s
 *
 * Elapsed time ticks every second even between unit updates, so a slow step
 * still visibly moves. `finish` swaps the row for the outcome and stops the
 * clock. One instance per operation; nothing here is shared state.
 */

import chalk from 'chalk'

import { renderCommandNotice } from '../render/command-notice.js'
import { formatElapsed, renderBar } from '../render/format.js'
import { SECTION_MUTED } from '../render/section.js'
import type { ProgressLine } from './progress-line.js'

export interface ProgressBarOptions {
  /** What the operation is, in the imperative or progressive: "Sharing with your team". */
  label: string
  /** Unit noun shown after the count: "entries", "files". Omitted when unknown. */
  unit?: string
  /** Shown instead of the bar before the first `set`: "preparing…". */
  pending?: string
  /** Bar width in cells. */
  width?: number
  /** Clock for tests. */
  now?: () => number
  /** Elapsed-time redraw period; `0` disables the ticker. */
  tickMs?: number
}

/** How one `set` reads beyond the bar itself. */
export interface ProgressDetail {
  /** Replaces the counted units (`3.1 / 19.1 MB`); the percentage still follows. */
  count?: string
  /** What the operation is doing now, after the percentage. A function is
   *  re-read on every redraw, so a countdown keeps moving between updates. */
  note?: string | (() => string)
}

export interface ProgressBar {
  /** Report `done` of `total` units. `total <= 0` draws an empty bar. */
  set: (done: number, total: number, detail?: ProgressDetail) => void
  /** Replace the row with the result and stop the clock. */
  finish: (text: string) => void
}

/** `12,000 / 32,000 entries · 37%`; omits the unit when there is none. */
export function formatProgressCount(done: number, total: number, unit?: string, count?: string): string {
  const fmt = (n: number): string => n.toLocaleString('en-US')
  const percent = total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0
  return `${count ?? `${fmt(done)} / ${fmt(total)}${unit ? ` ${unit}` : ''}`} · ${percent}%`
}

/** The row text for one state. Exported so the rendering can be tested without a clock. */
export function renderProgressBar(
  options: Pick<ProgressBarOptions, 'label' | 'unit' | 'pending' | 'width'>,
  state: { done: number; total: number; detail?: ProgressDetail } | null,
  elapsedMs: number,
): string {
  const muted = (text: string): string => chalk.hex(SECTION_MUTED)(text)
  const width = options.width ?? 20
  const elapsed = elapsedMs >= 1000 ? ` · ${formatElapsed(elapsedMs)}` : ''
  const note = typeof state?.detail?.note === 'function' ? state.detail.note() : state?.detail?.note
  const body = state === null
    ? `${options.pending ?? 'preparing…'}${elapsed}`
    : `${renderBar(state.done, state.total, width)}  ${formatProgressCount(state.done, state.total, options.unit, state.detail?.count)}${note ? ` · ${note}` : ''}${elapsed}`
  return renderCommandNotice({ state: 'progress', message: `${options.label}  ${muted(body)}` })
}

export function createProgressBar(line: ProgressLine, options: ProgressBarOptions): ProgressBar {
  const now = options.now ?? Date.now
  const startedAt = now()
  let state: { done: number; total: number; detail?: ProgressDetail } | null = null
  let finished = false
  const paint = (): void => {
    if (finished) return
    line.update(renderProgressBar(options, state, now() - startedAt))
  }
  paint()
  const tickMs = options.tickMs ?? 1000
  const timer = tickMs > 0 ? setInterval(paint, tickMs) : null
  // A ticking row must not keep the process alive after the operation ends
  // some other way (an uncaught error path that never reached `finish`).
  timer?.unref?.()
  return {
    set: (done, total, detail) => {
      state = { done, total, detail }
      paint()
    },
    finish: text => {
      finished = true
      if (timer) clearInterval(timer)
      line.finish(text)
    },
  }
}
