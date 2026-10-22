/**
 * RenderDiagnostics — always-on, low-volume record of the renderer events that
 * can move a reader's viewport or leave stale rows in scrollback.
 *
 * Full renderer traces (EVOT_TUI_TRACE=1) are opt-in because they serialize
 * every frame. A user reporting "the screen jumped" has not enabled them, so
 * the evidence must already be in the session's screen.log: which branch
 * repainted, which frame, which region of the frame changed first, and the
 * frame geometry at that moment. `/log` prints the totals.
 */

import type { RendererDiagnostic } from './renderer.js'

export type FrameRegion = 'history' | 'partial' | 'live'

export interface RenderDiagnosticsDeps {
  /** Where records go. The session's screen.log in the REPL. */
  log: (lines: string[]) => void
  /** Frame row boundaries at the time of the event, for attribution. */
  regions: () => { historyRows: number; liveRegionStart: number }
  now?: () => number
}

/** Minimum spacing between stale-scrollback log lines; rows are accumulated. */
const STALE_LOG_INTERVAL_MS = 1000

export class RenderDiagnostics {
  private fullRedraws = 0
  private viewportRedraws = 0
  private shifts = 0
  private staleEvents = 0
  private staleRows = 0
  private pendingStaleRows = 0
  private pendingStaleEvents = 0
  private lastStaleLogAt = Number.NEGATIVE_INFINITY

  constructor(private readonly deps: RenderDiagnosticsDeps) {}

  record(diagnostic: RendererDiagnostic): void {
    if (diagnostic.kind === 'full_redraw' || diagnostic.kind === 'viewport_redraw') {
      const full = diagnostic.kind === 'full_redraw'
      if (full) this.fullRedraws++
      else this.viewportRedraws++
      const region = diagnostic.firstChanged === null ? 'n/a' : this.regionOf(diagnostic.firstChanged)
      this.deps.log([
        `[render] ${full ? 'full' : 'viewport'} redraw · ${diagnostic.branch} · frame ${diagnostic.frame}`
        + ` · rows ${diagnostic.previousLines}→${diagnostic.newLines}`
        + ` · viewportTop ${diagnostic.viewportTop}`
        + ` · firstChanged ${diagnostic.firstChanged ?? 'n/a'} (${region})`
        + ` · ${diagnostic.columns}x${diagnostic.rows}`,
      ])
      return
    }
    if (diagnostic.kind === 'scrollback_shift') {
      this.shifts++
      this.deps.log([
        `[render] scrollback shift · frame ${diagnostic.frame}`
        + ` · shiftedFrom ${diagnostic.shiftedFrom} (${this.regionOf(diagnostic.shiftedFrom)})`
        + ` · delta ${diagnostic.delta >= 0 ? '+' : ''}${diagnostic.delta}`
        + ` · viewportTop ${diagnostic.viewportTop}`
        + ` · rows ${diagnostic.previousLines}→${diagnostic.newLines}`,
      ])
      return
    }
    this.staleEvents++
    this.staleRows += diagnostic.staleRows
    this.pendingStaleEvents++
    this.pendingStaleRows += diagnostic.staleRows
    const now = this.deps.now?.() ?? Date.now()
    if (now - this.lastStaleLogAt < STALE_LOG_INTERVAL_MS) return
    this.lastStaleLogAt = now
    const region = this.regionOf(diagnostic.firstChanged)
    this.deps.log([
      `[render] stale scrollback · ${this.pendingStaleRows} row(s) over ${this.pendingStaleEvents} frame(s)`
      + ` · frame ${diagnostic.frame} · firstChanged ${diagnostic.firstChanged} (${region})`
      + ` · viewportTop ${diagnostic.viewportTop}`
      + ` · rows ${diagnostic.previousLines}→${diagnostic.newLines}`,
    ])
    this.pendingStaleEvents = 0
    this.pendingStaleRows = 0
  }

  /** One-line session summary for `/log`; null when nothing happened. */
  summary(): string | null {
    if (this.fullRedraws === 0 && this.viewportRedraws === 0 && this.staleEvents === 0 && this.shifts === 0) return null
    const parts = [
      `${this.fullRedraws} full redraw(s) with scrollback cleared`,
      `${this.staleRows} stale scrollback row(s) over ${this.staleEvents} frame(s)`,
    ]
    if (this.shifts > 0) parts.push(`${this.shifts} scrollback shift repaint(s)`)
    if (this.viewportRedraws > 0) parts.push(`${this.viewportRedraws} viewport redraw(s) with scrollback preserved`)
    return `  Render: ${parts.join(' · ')}`
  }

  private regionOf(row: number): FrameRegion {
    const { historyRows, liveRegionStart } = this.deps.regions()
    if (row < historyRows) return 'history'
    if (row < liveRegionStart) return 'partial'
    return 'live'
  }
}
