/**
 * TermRenderer — differential rendering engine for terminal output.
 *
 * Renders a full frame each cycle, diffs against the previous frame, and only
 * redraws changed lines. Uses synchronized output (DEC mode 2026) to eliminate
 * flicker.
 *
 * The cursor/viewport state machine follows pi-tui's renderer
 * (~/github/pi/packages/tui/src/tui.ts) with one deliberate divergence:
 *
 * Scrollback is append-only for in-place edits. pi clears the screen and
 * replays the whole frame whenever a row above the viewport changes, which yanks
 * a reader who scrolled up back to the bottom and destroys native scrollback and
 * any selection. Here an edit that leaves every row at its own index is left
 * stale instead, reported through the trace and diagnostics hooks.
 *
 * Hidden live rows may stay stale while streaming; replaying the transcript
 * per delta is worse than provisional history. Repair them at the next durable
 * commit, or when the user explicitly invalidates history. Geometry is
 * separate: a shrink that moves the caret above the physical viewport redraws
 * only the visible tail instead of replaying history to recover the editor.
 *
 * Resizing can retain native scrollback only when the terminal's physical rows
 * stay aligned with the producer frame (for example, widening short plain-text
 * lines). Once wrapping, full-width backgrounds, or viewport height can change
 * that alignment, the renderer rebuilds it with a full repaint. Repainting a
 * new logical tail over terminal-reflowed history corrupts both coordinates and
 * backgrounds, and subsequent differential frames cannot repair the result.
 */

import { CURSOR_MARKER, type RenderFrame, type RenderOverlay } from './render-frame.js'
import { performance } from 'node:perf_hooks'
import stringWidth from 'string-width'
import stripAnsi from 'strip-ansi'
import { normalizeTerminalOutput, wrapTextWithAnsi, visibleWidth } from '../render/wrap.js'

// --- Constants ---

const MIN_RENDER_INTERVAL_MS = 16
const SYNC_START = '\x1b[?2026h'
const SYNC_END = '\x1b[?2026l'
const CLEAR_LINE = '\x1b[2K'
const CLEAR_VIEWPORT = '\x1b[2J\x1b[H'
const CLEAR_SCREEN_AND_SCROLLBACK = `${CLEAR_VIEWPORT}\x1b[3J`
const SEGMENT_RESET = '\x1b[0m\x1b]8;;\x07'
const OSC133_MARKER = /\x1b\]133;[ABC]\x07/g
const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'
const NOWRAP = '\x1b[?7l'   // Disable auto-wrap (DECAWM off)
const WRAP = '\x1b[?7h'     // Re-enable auto-wrap

// --- Types ---

export interface RendererTraceEntry {
  schemaVersion: 1
  ts: string
  kind: 'frame'
  frame: number
  branch: string
  terminal: {
    columns: number
    rows: number
    term?: string
    program?: string
    programVersion?: string
  }
  frameState: {
    previousLines: number
    newLines: number
    maxLinesRenderedBefore: number
    maxLinesRenderedAfter: number
    previousViewportTopBefore: number
    previousViewportTopAfter: number
    hardwareCursorRowBefore: number
    hardwareCursorRowAfter: number
    cursorRow: number | null
    cursorColumn: number | null
    firstChanged: number | null
    lastChanged: number | null
    targetViewportTop: number
    maxVisibleWidth: number
    osc133Markers: number
    overwideLines: Array<{ row: number; width: number }>
    /** Changed rows above the viewport left unpainted in scrollback this frame. */
    staleScrollbackRows?: number
  }
  viewportTail?: string[]
  viewportPatch?: { start: number; lines: string[] }
  ansiWrites: string[]
}

/**
 * Always-on, cheap render events for post-hoc debugging. Destructive history
 * replays and viewport-only resize repaints are reported separately so a jump
 * can be attributed without a full trace.
 */
export type RendererDiagnostic =
  | {
    /** The screen and scrollback were cleared and the whole frame replayed. */
    kind: 'full_redraw'
    frame: number
    branch: string
    previousLines: number
    newLines: number
    viewportTop: number
    firstChanged: number | null
    columns: number
    rows: number
  }
  | {
    /** Only the visible viewport was repainted; native scrollback is retained. */
    kind: 'viewport_redraw'
    frame: number
    branch: string
    previousLines: number
    newLines: number
    viewportTop: number
    firstChanged: null
    columns: number
    rows: number
  }
  | {
    kind: 'stale_scrollback'
    frame: number
    staleRows: number
    firstChanged: number
    viewportTop: number
    previousLines: number
    newLines: number
  }
  | {
    /** Rows above the viewport shifted index; repainted rather than corrupted. */
    kind: 'scrollback_shift'
    frame: number
    shiftedFrom: number
    delta: number
    viewportTop: number
    previousLines: number
    newLines: number
  }

export interface TermRendererOptions {
  stdout?: NodeJS.WriteStream
  trace?: (entry: RendererTraceEntry) => void
  onDiagnostic?: (diagnostic: RendererDiagnostic) => void
}

// --- Renderer ---

export class TermRenderer {
  private stdout: NodeJS.WriteStream
  private trace: ((entry: RendererTraceEntry) => void) | null
  private onDiagnostic: ((diagnostic: RendererDiagnostic) => void) | null
  private traceWrites: string[] | null = null
  private pendingTraceWrites: string[] = []
  private frameNumber = 0
  private previousLines: string[] = []
  /**
   * Producer lines of the painted frame, parallel to `previousLines`. A
   * committed row whose producer string is the very same object as last frame
   * reuses its finalized text: history is append-only by contract, so the
   * transcript prefix costs nothing per frame instead of a marker scan, a tab
   * normalization and a fresh string per row.
   */
  private previousSourceLines: string[] = []
  /** Producer lines of the frame being finalized, adopted with `previousLines`. */
  private pendingSourceLines: string[] = []
  private previousWidth = 0
  private previousHeight = 0
  private hardwareCursorRow = 0
  private maxLinesRendered = 0
  private previousViewportTop = 0
  /** Logical frame length retained after a bottom-anchored tail first reaches the viewport end. */
  private trailingEdgeAnchorLength = 0
  /** `committedRows` of the frame currently painted. */
  private previousCommittedRows = Number.POSITIVE_INFINITY
  private invalidatedRows = new Set<number>()
  private scrollbackInvalidated = false
  /** Lowest logical row this renderer left unpainted in scrollback, if any. */
  private scrollbackStaleFrom: number | null = null
  /** Hidden live rows are repaired once on the next durable commit. */
  private liveScrollbackStaleFrom: number | null = null
  private forcedRepaint = false

  // Render scheduling
  private renderCallback: (() => RenderFrame | string[]) | null = null
  private renderRequested = false
  private renderTimer: ReturnType<typeof setTimeout> | undefined
  private lastRenderAt = 0
  private destroyed = false

  // --- Constructor ---

  constructor(opts?: TermRendererOptions) {
    this.stdout = opts?.stdout ?? process.stdout
    this.trace = opts?.trace ?? null
    this.onDiagnostic = opts?.onDiagnostic ?? null
  }

  // --- Accessors ---

  get termRows(): number {
    return safeDimension(this.stdout.rows, 24)
  }

  get termCols(): number {
    return safeDimension(this.stdout.columns, 80)
  }

  // --- Lifecycle ---

  init(): void {
    this.destroyed = false
    this.write(NOWRAP + HIDE_CURSOR)
    this.stdout.on('resize', this.onResize)
  }

  destroy(): void {
    if (this.destroyed) return
    this.renderRequested = false
    this.renderCallback = null
    if (this.renderTimer) {
      clearTimeout(this.renderTimer)
      this.renderTimer = undefined
    }
    // Move cursor below rendered content so shell prompt appears cleanly
    if (this.previousLines.length > 0) {
      const targetRow = this.previousLines.length
      const diff = targetRow - this.hardwareCursorRow
      if (diff > 0) this.write(`\x1b[${diff}B`)
      this.write('\r\n')
    }
    this.write(WRAP + SHOW_CURSOR)
    this.destroyed = true
    this.stdout.off('resize', this.onResize)
  }

  // --- Public API ---

  setRenderCallback(cb: () => RenderFrame | string[]): void {
    this.renderCallback = cb
  }

  /**
   * Force a repaint of every row from `startRow` down on the next frame.
   *
   * A native terminal selection is owned by the terminal, not by us: there is
   * no escape sequence to read or clear it. Rewriting the cells under it is the
   * only way to make it go, and a drag covers a range of rows, so repainting
   * just the caret row would leave the rest of the highlight on screen.
   *
   * Callers pass the first row of the live region. Committed transcript above
   * it is left alone: repainting scrollback on every keystroke would cost more
   * than the stale highlight there is worth.
   */
  invalidateRowsFrom(startRow: number): void {
    if (this.destroyed || this.previousLines.length === 0) return
    const from = Math.max(0, Math.min(startRow, this.previousLines.length - 1))
    for (let row = from; row < this.previousLines.length; row++) {
      this.invalidatedRows.add(row)
    }
    this.requestRender()
  }

  /**
   * Declare that committed rows above the viewport changed on purpose, so the
   * next frame may clear and replay history to make scrollback match.
   *
   * This is the only way a differential frame ever repaints scrollback. It is
   * for explicit actions whose whole point is to alter committed content — a
   * Ctrl+O expand toggle, or erasing a revealed secret in place — where a
   * stale copy in scrollback would defeat the action. Streaming layout changes
   * never call this; they leave scrollback alone (see the header comment).
   */
  invalidateScrollback(): void {
    if (this.destroyed) return
    this.scrollbackInvalidated = true
    this.requestRender()
  }

  requestRender(force = false): void {
    if (this.destroyed) return
    if (force) {
      this.previousLines = []
      this.previousSourceLines = []
      this.previousWidth = -1
      this.previousHeight = -1
      this.hardwareCursorRow = 0
      this.maxLinesRendered = 0
      this.previousViewportTop = 0
      this.trailingEdgeAnchorLength = 0
      this.invalidatedRows.clear()
      this.scrollbackInvalidated = false
      this.scrollbackStaleFrom = null
      this.liveScrollbackStaleFrom = null
      this.previousCommittedRows = Number.POSITIVE_INFINITY
      // Reported as its own branch: a forced repaint reaches the same code path
      // as a resize, and a log that called it `width_change` would send the
      // next person debugging a jump after the wrong cause.
      this.forcedRepaint = true
      if (this.renderTimer) {
        clearTimeout(this.renderTimer)
        this.renderTimer = undefined
      }
      this.renderRequested = true
      process.nextTick(() => {
        if (this.destroyed || !this.renderRequested) return
        this.renderRequested = false
        this.lastRenderAt = performance.now()
        this.doRender()
      })
      return
    }
    if (this.renderRequested) return
    this.renderRequested = true
    process.nextTick(() => this.scheduleRender())
  }

  /**
   * Clear the viewport and scrollback. Used for /clear command.
   */
  clearScreen(): void {
    this.write(SYNC_START + CLEAR_SCREEN_AND_SCROLLBACK + SYNC_END)
    this.previousLines = []
    this.previousSourceLines = []
    this.hardwareCursorRow = 0
    this.maxLinesRendered = 0
    this.previousViewportTop = 0
    this.trailingEdgeAnchorLength = 0
    this.invalidatedRows.clear()
    this.scrollbackInvalidated = false
    this.scrollbackStaleFrom = null
    this.liveScrollbackStaleFrom = null
    this.previousCommittedRows = Number.POSITIVE_INFINITY
    this.previousWidth = this.termCols
    this.previousHeight = this.termRows
  }

  // --- Private: scheduling ---

  private scheduleRender(): void {
    if (this.destroyed || this.renderTimer || !this.renderRequested) return
    const elapsed = performance.now() - this.lastRenderAt
    const delay = Math.max(0, MIN_RENDER_INTERVAL_MS - elapsed)
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined
      if (this.destroyed || !this.renderRequested) return
      this.renderRequested = false
      this.lastRenderAt = performance.now()
      this.doRender()
      if (this.renderRequested) this.scheduleRender()
    }, delay)
  }

  private onResize = (): void => {
    // Compare actual dimensions in doRender. A drag can emit many events, and
    // terminals also emit redundant events on focus/layout changes.
    this.requestRender()
  }

  /**
   * A viewport-only resize is safe only while physical row i still represents
   * logical row i. Native reflow is not observable through stdout, so anything
   * that could change the row mapping must establish a fresh full-render base.
   */
  private canPreserveScrollbackOnResize(
    newLines: string[],
    width: number,
    height: number,
    widthChanged: boolean,
    heightChanged: boolean,
  ): boolean {
    // With a scrollback buffer, height changes alter the terminal's physical
    // viewport origin independently of our logical `lines.length - height`.
    // If both frames fit on screen there is no off-screen history to misalign.
    if (heightChanged && (this.previousLines.length > this.previousHeight || newLines.length > height)) {
      return false
    }
    if (!widthChanged) return true

    // Rewrapped text and resized background padding must replace the old
    // physical rows, not coexist with terminal-reflowed copies of them.
    if (newLines.length !== this.previousLines.length) return false
    for (let row = 0; row < newLines.length; row++) {
      if (newLines[row] !== this.previousLines[row]) return false
      // On shrink, xterm and compatible terminals reflow rows whose content
      // exceeds the new width. On grow, our full-render/differential invariant
      // guarantees there are no native wrapped rows to join.
      if (width < this.previousWidth && visibleWidth(this.previousLines[row]!) > width) return false
    }
    return true
  }

  // --- Private: core render ---

  private doRender(): void {
    if (this.destroyed || !this.renderCallback) return

    const width = this.termCols
    const height = this.termRows
    const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width
    const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height
    if (this.trace) {
      this.traceWrites = this.pendingTraceWrites
      this.pendingTraceWrites = []
    }
    const frame = ++this.frameNumber
    const forced = this.forcedRepaint
    this.forcedRepaint = false
    const previousLineCount = this.previousLines.length
    const maxLinesRenderedBefore = this.maxLinesRendered
    const previousViewportTopBefore = this.previousViewportTop
    const hardwareCursorRowBefore = this.hardwareCursorRow

    // Get new frame from callback
    const raw = this.renderCallback()
    const rendered = Array.isArray(raw) ? { lines: raw } : raw
    // Read after the callback: layout may only discover mid-build that its
    // committed prefix reshaped, and that must apply to this frame.
    const repaintHistory = this.scrollbackInvalidated
    this.scrollbackInvalidated = false
    let baseLines = rendered.lines
    // Absent means the producer only appends, so the whole frame qualifies.
    const committedRows = rendered.committedRows === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.trunc(rendered.committedRows))
    const previousCommittedRows = this.previousCommittedRows
    this.previousCommittedRows = committedRows
    const anchorStart = rendered.bottomAnchorStart
    const hasTailAnchor = rendered.bottomAnchor
      && anchorStart !== undefined
      && Number.isFinite(anchorStart)
    if (hasTailAnchor) {
      // A resize establishes a new natural layout. Do not carry an anchor from
      // a differently-sized viewport unless the rebuilt frame reaches bottom.
      if (widthChanged || heightChanged) this.trailingEdgeAnchorLength = 0
      // Only durable rows may reach the bottom. A command window that scrolls
      // the frame past the viewport end is not the composer earning its place
      // there; when the window closes the composer must return to the content.
      const transientRows = Math.max(0, Math.trunc(rendered.transientRows ?? 0))
      const durableLength = Math.max(0, baseLines.length - transientRows)
      if (durableLength >= height) {
        this.trailingEdgeAnchorLength = Math.max(this.trailingEdgeAnchorLength, durableLength)
      } else if (this.trailingEdgeAnchorLength > baseLines.length) {
        // Keep committed content in place and absorb transient live-region
        // shrinkage immediately before that region. Padding the frame's top
        // would move history; padding its end would leave the composer high.
        const insertion = Math.max(0, Math.min(Math.trunc(anchorStart), baseLines.length))
        const padding = Array.from(
          { length: this.trailingEdgeAnchorLength - baseLines.length },
          () => '',
        )
        baseLines = [
          ...baseLines.slice(0, insertion),
          ...padding,
          ...baseLines.slice(insertion),
        ]
      }
    }
    // Before the first natural bottom contact, short frames retain their normal
    // flow position. Screen overlays still do their own temporary composition.
    // Rows committed in both frames may reuse last frame's finalized text.
    // Nothing is reusable under an overlay: composition rewrites the viewport.
    const reusableRows = rendered.overlay
      ? 0
      : Math.min(committedRows, previousCommittedRows, baseLines.length, this.previousLines.length)
    const finalized = rendered.overlay
      ? this.finalizeLines(
          this.compositeOverlay(baseLines.map(line => line.replaceAll(CURSOR_MARKER, '')), rendered.overlay, width, height),
          0,
          height,
        )
      : this.finalizeLines(baseLines, reusableRows, height)
    const newLines = finalized.lines
    const cursorPos = finalized.cursor

    // Soft overwide-line guard: DECAWM is off, so overflows are silent. When
    // tracing or EVOT_DEBUG=1, surface them so layout bugs are not invisible.
    if (this.trace || process.env.EVOT_DEBUG === '1') {
      for (let row = 0; row < newLines.length; row++) {
        const lineWidth = visibleWidth(newLines[row]!)
        if (lineWidth > width && process.env.EVOT_DEBUG === '1') {
          process.stderr.write(
            `[evot] overwide render line row=${row} width=${lineWidth} > terminal=${width}\n`,
          )
        }
      }
    }

    let staleScrollbackRows = 0
    const traceFrame = (
      branch: string,
      firstChanged: number | null = null,
      lastChanged: number | null = null,
    ): void => {
      if (!this.trace) return
      const viewportTop = Math.max(0, newLines.length - height)
      const viewportTail = newLines.slice(viewportTop)
      const maxVisibleWidth = viewportTail.reduce(
        (max, line) => Math.max(max, stringWidth(stripAnsi(line))),
        0,
      )
      const osc133Markers = viewportTail.reduce(
        (count, line) => count + (line.match(OSC133_MARKER)?.length ?? 0),
        0,
      )
      const overwideLines: Array<{ row: number; width: number }> = []
      for (let row = 0; row < newLines.length; row++) {
        const lineWidth = visibleWidth(newLines[row]!)
        if (lineWidth > width) overwideLines.push({ row, width: lineWidth })
      }
      const differential = branch === 'differential_update'
        || branch === 'deleted_lines_diff'
        || branch === 'no_change'
      const patchStart = firstChanged ?? newLines.length
      const patchEnd = lastChanged === null
        ? patchStart
        : Math.min(lastChanged + 1, newLines.length)
      const entry: RendererTraceEntry = {
        schemaVersion: 1,
        ts: new Date().toISOString(),
        kind: 'frame',
        frame,
        branch,
        terminal: {
          columns: width,
          rows: height,
          term: process.env.TERM,
          program: process.env.TERM_PROGRAM,
          programVersion: process.env.TERM_PROGRAM_VERSION,
        },
        frameState: {
          previousLines: previousLineCount,
          newLines: newLines.length,
          maxLinesRenderedBefore,
          maxLinesRenderedAfter: this.maxLinesRendered,
          previousViewportTopBefore,
          previousViewportTopAfter: this.previousViewportTop,
          hardwareCursorRowBefore,
          hardwareCursorRowAfter: this.hardwareCursorRow,
          cursorRow: cursorPos?.row ?? null,
          cursorColumn: cursorPos?.col ?? null,
          firstChanged,
          lastChanged,
          targetViewportTop: viewportTop,
          maxVisibleWidth,
          osc133Markers,
          overwideLines,
          staleScrollbackRows,
        },
        ...(differential
          ? { viewportPatch: { start: patchStart, lines: newLines.slice(patchStart, patchEnd) } }
          : { viewportTail }),
        ansiWrites: this.traceWrites ?? [],
      }
      this.traceWrites = null
      try {
        this.trace(entry)
      } catch {
        // Diagnostics must never break rendering.
      }
    }

    // --- Full render helper (kept in lockstep with pi-tui) ---
    const fullRender = (clear: boolean, branch: string, firstChanged: number | null = null): void => {
      if (clear) this.diagnose({
        kind: 'full_redraw',
        frame,
        branch,
        previousLines: previousLineCount,
        newLines: newLines.length,
        viewportTop: previousViewportTopBefore,
        firstChanged,
        columns: width,
        rows: height,
      })
      let buffer = SYNC_START + HIDE_CURSOR
      if (clear) buffer += CLEAR_SCREEN_AND_SCROLLBACK
      for (let i = 0; i < newLines.length; i++) {
        if (i > 0) buffer += '\r\n'
        buffer += newLines[i]
      }
      this.hardwareCursorRow = Math.max(0, newLines.length - 1)
      this.maxLinesRendered = clear ? newLines.length : Math.max(this.maxLinesRendered, newLines.length)
      const bufferLength = Math.max(height, newLines.length)
      this.previousViewportTop = Math.max(0, bufferLength - height)
      this.adoptFrame(newLines)
      this.previousWidth = width
      this.previousHeight = height
      this.scrollbackStaleFrom = null
      this.liveScrollbackStaleFrom = null
      buffer += this.hardwareCursorSequence(cursorPos, newLines.length) + SYNC_END
      this.write(buffer)
      traceFrame(branch)
    }

    const viewportRender = (branch: string, firstChanged: number | null = null): void => {
      this.diagnose({
        kind: 'viewport_redraw', frame, branch, previousLines: previousLineCount,
        newLines: newLines.length, viewportTop: previousViewportTopBefore,
        firstChanged: null, columns: width, rows: height,
      })
      const viewportTop = Math.max(0, newLines.length - height)
      // ED 2 can promote the old visible screen into tmux history. Repaint
      // addressable rows in place instead: CSI B clamps rather than scrolling,
      // and EL removes old tails without touching native history.
      let buffer = SYNC_START + HIDE_CURSOR + '\x1b[H'
      for (let row = 0; row < height; row++) {
        if (row > 0) buffer += '\x1b[1B'
        buffer += `\r${CLEAR_LINE}${newLines[viewportTop + row] ?? ''}`
      }
      const trailingRows = height - Math.max(1, Math.min(newLines.length, height))
      if (trailingRows > 0) buffer += `\x1b[${trailingRows}A`
      this.hardwareCursorRow = Math.max(0, newLines.length - 1)
      this.maxLinesRendered = newLines.length
      this.previousViewportTop = viewportTop
      this.previousWidth = width
      this.previousHeight = height
      this.adoptFrame(newLines)
      this.invalidatedRows.clear()
      // Repainting the visible screen does not repair retained history.
      buffer += this.hardwareCursorSequence(cursorPos, newLines.length) + SYNC_END
      this.write(buffer)
      traceFrame(branch, firstChanged)
    }

    // First render
    if (this.previousLines.length === 0 && !widthChanged && !heightChanged) {
      fullRender(false, 'first_render')
      return
    }

    if (forced) {
      fullRender(true, 'forced_repaint')
      return
    }

    // Geometry changes may invalidate physical cursor coordinates as well as
    // the row mapping in native scrollback. Preserve the viewport-only path
    // only when that mapping is provably unchanged; otherwise rebuild a clean
    // physical base before resuming differential rendering.
    // Termux retains its differential height-only path for keyboard toggles.
    if (widthChanged || (heightChanged && !isTermuxSession())) {
      // An explicit history edit (for example erasing a revealed secret)
      // must still reach off-screen rows when it coincides with a resize.
      if (repaintHistory) {
        fullRender(true, 'history_invalidated')
        return
      }
      const branch = widthChanged ? 'width_change' : 'height_change'
      if (!this.canPreserveScrollbackOnResize(newLines, width, height, widthChanged, heightChanged)) {
        fullRender(true, branch)
        return
      }
      viewportRender(branch)
      return
    }

    // --- Differential render ---
    const previousBufferLength = this.previousHeight > 0
      ? this.previousViewportTop + this.previousHeight
      : height
    let prevViewportTop = heightChanged ? Math.max(0, previousBufferLength - height) : this.previousViewportTop
    let viewportTop = prevViewportTop
    let hardwareCursorRow = this.hardwareCursorRow

    // A visible shrink may lift the composer. Preserve physical scrollback
    // rather than clearing/replaying history just to put the footer at bottom.
    // The off-viewport/deletion guards below still handle unaddressable edits.

    const computeLineDiff = (targetRow: number): number => {
      const currentScreenRow = hardwareCursorRow - prevViewportTop
      const targetScreenRow = targetRow - viewportTop
      return targetScreenRow - currentScreenRow
    }

    // Consume explicit row invalidations with this frame. They force a repaint
    // even when the rendered bytes are unchanged (for example, to release a
    // native terminal selection covering the active input row).
    const invalidatedRows = this.invalidatedRows

    // Find first and last changed lines, tracking the addressable subrange in
    // the same pass. Rows above the viewport sit in terminal scrollback and
    // cannot be addressed, so their changes are counted but never painted.
    let firstChanged = -1
    let lastChanged = -1
    let firstVisibleChanged = -1
    let lastVisibleChanged = -1
    /** First unaddressable changed row in the live region, which may have shifted. */
    let firstShiftedChanged = -1
    // Safe only if the row was committed in both frames: history appending moves
    // the boundary down, and the new frame alone would call such a row safe.
    const committedBoundary = Math.min(committedRows, previousCommittedRows)
    const maxLines = Math.max(newLines.length, this.previousLines.length)
    for (let i = 0; i < maxLines; i++) {
      const oldLine = i < this.previousLines.length ? this.previousLines[i] : ''
      const newLine = i < newLines.length ? newLines[i] : ''
      const changed = oldLine !== newLine
      if (!changed && !invalidatedRows.has(i)) continue
      if (firstChanged === -1) firstChanged = i
      lastChanged = i
      if (i < prevViewportTop) {
        staleScrollbackRows++
        // An invalidation repaints identical bytes; only a real diff can shift.
        if (changed && i >= committedBoundary && firstShiftedChanged === -1) firstShiftedChanged = i
        continue
      }
      if (firstVisibleChanged === -1) firstVisibleChanged = i
      lastVisibleChanged = i
    }
    invalidatedRows.clear()

    // Treat scrollback as append-only: leave unaddressable rows with their last
    // painted content and patch only the addressable ones. A streaming table
    // widening a column, or a finished thinking header, must never scroll a
    // reader back to the bottom or clear the terminal's history.
    //
    // An explicit invalidation is the exception. It must also repair rows this
    // renderer knowingly left behind on earlier frames: those rows have already
    // been adopted into previousLines, so they no longer show up as a diff and
    // would otherwise stay wrong for the rest of the session.
    if (repaintHistory && (staleScrollbackRows > 0 || this.scrollbackStaleFrom !== null)) {
      fullRender(true, 'history_invalidated', Math.min(
        firstChanged === -1 ? maxLines : firstChanged,
        this.scrollbackStaleFrom ?? maxLines,
      ))
      return
    }
    // Streaming changes are provisional. Rebuild on the next durable commit,
    // including hidden changes adopted as stale earlier or removed by a shrink.
    // Otherwise one reflow/animation can replay the transcript at 10Hz.
    const newlyCommittedChange = firstShiftedChanged !== -1 && committedRows > previousCommittedRows
      && firstShiftedChanged < committedRows
    // A collapse can put the removed rows beyond the new committed boundary.
    // The next commit must repair those too, even if it never crosses their index.
    const committedStaleChange = this.liveScrollbackStaleFrom !== null && committedRows > previousCommittedRows
    if (newlyCommittedChange || committedStaleChange) {
      const shiftedFrom = Math.min(
        firstShiftedChanged === -1 ? maxLines : firstShiftedChanged,
        this.liveScrollbackStaleFrom ?? maxLines,
      )
      this.diagnose({
        kind: 'scrollback_shift',
        frame,
        shiftedFrom,
        delta: newLines.length - this.previousLines.length,
        viewportTop: prevViewportTop,
        previousLines: this.previousLines.length,
        newLines: newLines.length,
      })
      fullRender(true, 'scrollback_shift', shiftedFrom)
      return
    }
    if (firstShiftedChanged !== -1) {
      this.liveScrollbackStaleFrom = Math.min(this.liveScrollbackStaleFrom ?? firstShiftedChanged, firstShiftedChanged)
    }
    if (staleScrollbackRows > 0) {
      this.scrollbackStaleFrom = Math.min(this.scrollbackStaleFrom ?? firstChanged, firstChanged)
      this.diagnose({
        kind: 'stale_scrollback',
        frame,
        staleRows: staleScrollbackRows,
        firstChanged,
        viewportTop: prevViewportTop,
        previousLines: this.previousLines.length,
        newLines: newLines.length,
      })
      firstChanged = firstVisibleChanged
      lastChanged = lastVisibleChanged
    }

    // Relative cursor-up clamps at the terminal top if a transient window
    // collapses past the caret. Recover the visible tail before adopting such
    // coordinates, independently from repairing off-screen history.
    if (cursorPos && cursorPos.row < prevViewportTop) {
      viewportRender('cursor_recovery', firstChanged === -1 ? null : firstChanged)
      return
    }
    if (Math.max(0, newLines.length - 1) < prevViewportTop) {
      viewportRender('deleted_lines_above_viewport', firstChanged === -1 ? null : firstChanged)
      return
    }

    const appendedLines = newLines.length > this.previousLines.length
    if (appendedLines) {
      if (firstChanged === -1) firstChanged = this.previousLines.length
      lastChanged = newLines.length - 1
    }
    const appendStart = appendedLines && firstChanged === this.previousLines.length && firstChanged > 0

    // No addressable changes. Adopt the new logical frame even when only
    // scrollback rows differ, so later diffs compare against what layout
    // currently produces rather than re-reporting the same stale rows.
    if (firstChanged === -1) {
      this.positionHardwareCursor(cursorPos, newLines.length)
      this.adoptFrame(newLines)
      this.previousWidth = width
      this.previousViewportTop = prevViewportTop
      this.previousHeight = height
      traceFrame('no_change')
      return
    }

    // All changes are in deleted lines (content shrunk)
    if (firstChanged >= newLines.length) {
      if (this.previousLines.length > newLines.length) {
        let buffer = SYNC_START + HIDE_CURSOR
        // Move to end of new content (clamp to 0 for empty content)
        const targetRow = Math.max(0, newLines.length - 1)
        if (targetRow < prevViewportTop) {
          viewportRender('deleted_lines_above_viewport', firstChanged)
          return
        }
        const lineDiff = computeLineDiff(targetRow)
        if (lineDiff > 0) buffer += `\x1b[${lineDiff}B`
        else if (lineDiff < 0) buffer += `\x1b[${-lineDiff}A`
        buffer += '\r'
        // Clear extra lines without scrolling
        const extraLines = this.previousLines.length - newLines.length
        if (extraLines > height) {
          viewportRender('deleted_lines_exceed_height', firstChanged)
          return
        }
        const clearStartOffset = newLines.length === 0 ? 0 : 1
        if (extraLines > 0 && clearStartOffset > 0) buffer += `\x1b[${clearStartOffset}B`
        for (let i = 0; i < extraLines; i++) {
          buffer += `\r${CLEAR_LINE}`
          if (i < extraLines - 1) buffer += '\x1b[1B'
        }
        const moveBack = Math.max(0, extraLines - 1 + clearStartOffset)
        if (moveBack > 0) buffer += `\x1b[${moveBack}A`
        this.hardwareCursorRow = targetRow
        buffer += this.hardwareCursorSequence(cursorPos, newLines.length) + SYNC_END
        this.write(buffer)
      }
      this.adoptFrame(newLines)
      this.previousWidth = width
      this.previousHeight = height
      this.previousViewportTop = prevViewportTop
      traceFrame('deleted_lines_diff', firstChanged, lastChanged)
      return
    }

    // --- Build differential update buffer ---
    let buffer = SYNC_START + HIDE_CURSOR
    const prevViewportBottom = prevViewportTop + height - 1
    const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged

    // If target is below visible viewport, scroll down. Use a normal hardware
    // scroll (CRLF) so completed output settles into the terminal's real
    // scrollback — selection and scrollback stay consistent. This matches pi's
    // renderer; an in-place repaint here would desync the on-screen window from
    // the terminal's scrollback and make a selection jump on scroll.
    if (moveTargetRow > prevViewportBottom) {
      const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop))
      const moveToBottom = height - 1 - currentScreenRow
      if (moveToBottom > 0) buffer += `\x1b[${moveToBottom}B`
      const scroll = moveTargetRow - prevViewportBottom
      buffer += '\r\n'.repeat(scroll)
      prevViewportTop += scroll
      viewportTop += scroll
      hardwareCursorRow = moveTargetRow
    }

    // Move cursor to first changed line
    const lineDiff = computeLineDiff(moveTargetRow)
    if (lineDiff > 0) buffer += `\x1b[${lineDiff}B`
    else if (lineDiff < 0) buffer += `\x1b[${-lineDiff}A`

    buffer += appendStart ? '\r\n' : '\r'

    // Render changed lines
    const renderEnd = Math.min(lastChanged, newLines.length - 1)
    for (let i = firstChanged; i <= renderEnd; i++) {
      if (i > firstChanged) buffer += '\r\n'
      buffer += CLEAR_LINE
      buffer += newLines[i]
    }

    // Track where cursor ended up
    let finalCursorRow = renderEnd

    // If content shrunk, clear extra lines
    if (this.previousLines.length > newLines.length) {
      if (renderEnd < newLines.length - 1) {
        const moveDown = newLines.length - 1 - renderEnd
        buffer += `\x1b[${moveDown}B`
        finalCursorRow = newLines.length - 1
      }
      const extraLines = this.previousLines.length - newLines.length
      // These rows were already addressable in the previous frame. Moving
      // down clears them in place; CRLF at its last row would scroll history
      // unnecessarily and shift the reading position even without a full clear.
      const clearStartOffset = newLines.length === 0 ? 0 : 1
      if (clearStartOffset > 0) buffer += '\x1b[1B'
      for (let i = 0; i < extraLines; i++) {
        buffer += `\r${CLEAR_LINE}`
        if (i < extraLines - 1) buffer += '\x1b[1B'
      }
      const moveBack = extraLines - 1 + clearStartOffset
      if (moveBack > 0) buffer += `\x1b[${moveBack}A`
    }

    // Update state before encoding the final cursor move into the same frame.
    this.hardwareCursorRow = finalCursorRow
    this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length)
    this.previousViewportTop = Math.max(prevViewportTop, finalCursorRow - height + 1)
    this.adoptFrame(newLines)
    this.previousWidth = width
    this.previousHeight = height
    buffer += this.hardwareCursorSequence(cursorPos, newLines.length) + SYNC_END
    this.write(buffer)
    traceFrame('differential_update', firstChanged, lastChanged)
  }

  // --- Private: viewport overlays and cursor positioning ---

  /**
   * Composite modal content into the visible viewport without changing the
   * transcript's logical height. This follows pi's screen-relative overlay
   * model: long transcripts keep their length, while short frames are padded to
   * one terminal height only while the overlay is visible.
   */
  private compositeOverlay(
    baseLines: string[],
    overlay: RenderOverlay,
    width: number,
    height: number,
  ): string[] {
    const result = [...baseLines]
    const workingHeight = Math.max(result.length, height)
    while (result.length < workingHeight) result.push('')

    const overlayWidth = Math.max(1, width - Math.min(4, Math.max(0, width - 1)))
    const wrapped = overlay.lines.flatMap(line => wrapTextWithAnsi(line, overlayWidth))
    const maxHeight = Math.max(1, height - Math.min(2, Math.max(0, height - 1)))
    const visibleOverlay = wrapped.slice(0, maxHeight)
    const viewportStart = Math.max(0, workingHeight - height)
    const row = Math.max(0, Math.floor((height - visibleOverlay.length) / 2))

    // Centre the block, not each row. Per-line centring gives every row its own
    // left edge, which shifts rows against each other and destroys any column
    // alignment the overlay content built with padding.
    const blockWidth = visibleOverlay.reduce(
      (max, line) => Math.max(max, stringWidth(stripAnsi(line))),
      0,
    )
    const col = Math.max(0, Math.floor((width - Math.min(blockWidth, width)) / 2))
    for (let index = 0; index < visibleOverlay.length; index++) {
      result[viewportStart + row + index] = `${' '.repeat(col)}${visibleOverlay[index]!}`
    }
    return result
  }

  /** Record the painted frame together with the producer lines it came from. */
  private adoptFrame(newLines: string[]): void {
    this.previousLines = newLines
    this.previousSourceLines = this.pendingSourceLines
  }

  /**
   * Turn producer lines into terminal rows: take the cursor position from the
   * last visible marker, strip every marker, normalize tabs and close each row
   * with a reset. Rows below `reusableRows` whose producer string is the same
   * object as in the painted frame keep their finalized text.
   */
  private finalizeLines(
    source: string[],
    reusableRows: number,
    height: number,
  ): { lines: string[]; cursor: { row: number; col: number } | null } {
    const lines = new Array<string>(source.length)
    const viewportTop = Math.max(0, source.length - height)
    let cursor: { row: number; col: number } | null = null
    for (let row = source.length - 1; row >= 0; row--) {
      const line = source[row]!
      if (row < reusableRows && line === this.previousSourceLines[row]) {
        lines[row] = this.previousLines[row]!
        continue
      }
      let text = line
      const markerIndex = text.indexOf(CURSOR_MARKER)
      if (markerIndex !== -1) {
        if (!cursor && row >= viewportTop) {
          const col = stringWidth(stripAnsi(text.slice(0, markerIndex)))
          // Do not let CHA clamp an off-row marker onto unrelated text at the
          // terminal edge. Layout must provide an addressable cursor cell.
          if (col < this.termCols) cursor = { row, col }
        }
        // Internal hints must never escape, including hidden history markers
        // or multiple markers left by a composite frame. Last visible owner wins.
        text = text.replaceAll(CURSOR_MARKER, '')
      }
      lines[row] = normalizeTerminalOutput(text) + SEGMENT_RESET
    }
    // A copy: producers may edit their array in place between frames, and an
    // aliased reference would then agree with itself and hide the change.
    this.pendingSourceLines = source.slice()
    return { lines, cursor }
  }

  /** Position the terminal-owned cursor, also anchoring IME composition. */
  private positionHardwareCursor(cursorPos: { row: number; col: number } | null, totalLines: number): void {
    this.write(this.hardwareCursorSequence(cursorPos, totalLines))
  }

  /** Encode cursor placement inside the frame, before synchronized output ends. */
  private hardwareCursorSequence(cursorPos: { row: number; col: number } | null, totalLines: number): string {
    if (!cursorPos || totalLines <= 0) return HIDE_CURSOR
    const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1))
    const targetCol = Math.max(0, cursorPos.col)
    const rowDelta = targetRow - this.hardwareCursorRow
    let buffer = ''
    if (rowDelta > 0) buffer += `\x1b[${rowDelta}B`
    else if (rowDelta < 0) buffer += `\x1b[${-rowDelta}A`
    buffer += `\x1b[${targetCol + 1}G`
    buffer += SHOW_CURSOR
    this.hardwareCursorRow = targetRow
    return buffer
  }

  // --- Private: output ---

  private diagnose(diagnostic: RendererDiagnostic): void {
    if (!this.onDiagnostic) return
    try {
      this.onDiagnostic(diagnostic)
    } catch {
      // Diagnostics must never break rendering.
    }
  }

  private write(data: string): void {
    if (this.destroyed) return
    if (this.trace) {
      if (this.traceWrites) this.traceWrites.push(data)
      else this.pendingTraceWrites.push(data)
    }
    this.stdout.write(data)
  }
}

// --- Helpers ---

function isTermuxSession(): boolean {
  return Boolean(process.env.TERMUX_VERSION)
}

function safeDimension(n: number | undefined, fallback: number): number {
  return n != null && Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}
