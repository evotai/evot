import { homedir } from 'os'
import { join } from 'path'
import type { RendererTraceEntry } from '../screen/renderer.js'
import { RollingLogWriter } from './rolling-log.js'

const MAX_BUFFERED_ENTRIES = 256
const DEFAULT_SEGMENT_MB = 4
const DEFAULT_RETAIN_SEGMENTS = 4
const DEFAULT_RETAIN_RUNS = 10
const CLEAR_VIEWPORT = '\x1b[2J\x1b[H'
const NOWRAP = '\x1b[?7l'
const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'

function positiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : fallback
}

/** EVOT_TUI_TRACE=1 opts in, =0 force-disables; an explicit rootDirectory
 *  (tests, tooling) also opts in unless force-disabled. */
function rendererTraceEnabled(options: RendererTraceOptions): boolean {
  const env = process.env.EVOT_TUI_TRACE
  if (env === '0') return false
  if (env === '1') return true
  return options.rootDirectory !== undefined
}

function segmentMaxBytes(): number {
  return positiveEnv('EVOT_TUI_TRACE_SEGMENT_MB', DEFAULT_SEGMENT_MB) * 1024 * 1024
}

interface TraceSnapshot {
  entry: RendererTraceEntry
  viewportTail: string[]
}

export interface RendererTraceOptions {
  rootDirectory?: string
  segmentMaxBytes?: number
  retainSegments?: number
  retainRuns?: number
}

/**
 * Opt-in renderer diagnostics backed by modular rolling storage.
 *
 * Disabled by default: every traced frame serializes and appends JSON on the
 * TUI thread, which is measurable overhead during streaming. Enable with
 * EVOT_TUI_TRACE=1 (or by passing an explicit rootDirectory, as tests and
 * tooling do); EVOT_TUI_TRACE=0 force-disables either way.
 *
 * Each process creates an isolated managed run under ~/.evotai/logs/renderer.
 * Segments roll independently of screen/markdown logs and begin with a replay
 * checkpoint, so retained segments stay analyzable after older ones are removed.
 */
export class RendererTrace {
  private readonly enabled: boolean
  private writer: RollingLogWriter | null = null
  private boundSessionId: string | null = null
  private buffer: RendererTraceEntry[] = []
  private droppedBeforeBind = 0
  private logicalLines = new Map<number, string>()
  private snapshot: TraceSnapshot | null = null

  constructor(private readonly options: RendererTraceOptions = {}) {
    this.enabled = rendererTraceEnabled(options)
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  /** Managed renderer run directory containing manifest + JSONL segments. */
  get filePath(): string | null {
    return this.writer?.runDirectory ?? null
  }

  bind(sessionId: string): void {
    if (!this.enabled || this.boundSessionId === sessionId) return
    try {
      const previousWriter = this.writer
      const nextWriter = new RollingLogWriter({
        rootDirectory: this.options.rootDirectory
          ?? join(homedir(), '.evotai', 'logs', 'renderer'),
        namespace: 'renderer-trace',
        segmentMaxBytes: this.options.segmentMaxBytes ?? segmentMaxBytes(),
        retainSegments: this.options.retainSegments
          ?? positiveEnv('EVOT_TUI_TRACE_SEGMENTS', DEFAULT_RETAIN_SEGMENTS),
        retainRuns: this.options.retainRuns
          ?? positiveEnv('EVOT_TUI_TRACE_RUNS', DEFAULT_RETAIN_RUNS),
        metadata: { sessionId },
      })
      previousWriter?.close()
      this.writer = nextWriter
      this.boundSessionId = sessionId

      if (previousWriter || this.droppedBeforeBind > 0) {
        const checkpoint = this.segmentCheckpoint()
        if (checkpoint) nextWriter.append(checkpoint)
        if (this.droppedBeforeBind > 0) {
          this.appendRecord({
            schemaVersion: 1,
            ts: new Date().toISOString(),
            kind: 'buffer_overflow',
            droppedEntries: this.droppedBeforeBind,
          })
        }
      } else {
        // A complete pre-bind buffer retains its original frame sequence.
        this.logicalLines.clear()
        this.snapshot = null
        for (const entry of this.buffer) this.appendEntry(entry)
      }
      this.buffer = []
      this.droppedBeforeBind = 0
    } catch {
      // Renderer diagnostics must never break the TUI.
    }
  }

  log(entry: RendererTraceEntry): void {
    if (!this.enabled) return
    // Empty spinner/scheduler frames contain no fence, reflow, cursor, or ANSI
    // evidence and would only consume rolling retention capacity.
    if (entry.branch === 'no_change' && entry.ansiWrites.length === 0) return
    if (this.writer) {
      this.appendEntry(entry)
      return
    }

    this.updateSnapshot(entry)
    if (this.buffer.length >= MAX_BUFFERED_ENTRIES) {
      this.buffer.shift()
      this.droppedBeforeBind++
    }
    this.buffer.push(entry)
  }

  close(): void {
    this.writer?.close()
  }

  private appendEntry(entry: RendererTraceEntry): void {
    const writer = this.writer
    if (!writer) return
    try {
      writer.append(JSON.stringify(entry), {
        // Called only when this append opens a segment. The checkpoint represents
        // the state immediately before `entry`, making the segment self-contained.
        segmentPrelude: () => this.segmentCheckpoint(),
      })
      this.updateSnapshot(entry)
    } catch {
      // Best-effort diagnostics only.
    }
  }

  private appendRecord(record: Record<string, unknown>): void {
    try {
      this.writer?.append(JSON.stringify(record), {
        segmentPrelude: () => this.segmentCheckpoint(),
      })
    } catch {
      // Best-effort diagnostics only.
    }
  }

  private updateSnapshot(entry: RendererTraceEntry): void {
    if (entry.viewportTail) {
      this.logicalLines.clear()
      // A checkpoint paints the physical viewport, whose origin can remain one
      // row below the bottom-aligned logical target after content shrinks.
      const start = entry.frameState.previousViewportTopAfter
      entry.viewportTail.forEach((line, index) => this.logicalLines.set(start + index, line))
    }
    if (entry.viewportPatch) {
      entry.viewportPatch.lines.forEach((line, index) => {
        this.logicalLines.set(entry.viewportPatch!.start + index, line)
      })
    }
    for (const index of this.logicalLines.keys()) {
      if (index >= entry.frameState.newLines) this.logicalLines.delete(index)
    }

    const tail: string[] = []
    for (let row = 0; row < entry.terminal.rows; row++) {
      const index = entry.frameState.previousViewportTopAfter + row
      tail.push(this.logicalLines.get(index) ?? '')
    }
    this.snapshot = { entry, viewportTail: tail }
  }

  private segmentCheckpoint(): string | null {
    const snapshot = this.snapshot
    if (!snapshot) return null

    const source = snapshot.entry
    const cursorScreenRow = Math.max(
      0,
      Math.min(
        source.terminal.rows - 1,
        source.frameState.hardwareCursorRowAfter - source.frameState.previousViewportTopAfter,
      ),
    )
    const cursorColumn = Math.max(
      0,
      Math.min(
        source.frameState.cursorColumn ?? 0,
        source.terminal.columns - 1,
      ),
    )
    const paint = snapshot.viewportTail.join('\r\n')
    const cursor = `\x1b[${cursorScreenRow + 1};${cursorColumn + 1}H`
      + (source.frameState.cursorRow === null ? HIDE_CURSOR : SHOW_CURSOR)

    const checkpoint: RendererTraceEntry = {
      ...source,
      ts: new Date().toISOString(),
      branch: 'segment_checkpoint',
      frameState: {
        ...source.frameState,
        previousLines: source.frameState.newLines,
        maxLinesRenderedBefore: source.frameState.maxLinesRenderedAfter,
        previousViewportTopBefore: source.frameState.previousViewportTopAfter,
        hardwareCursorRowBefore: source.frameState.hardwareCursorRowAfter,
        firstChanged: null,
        lastChanged: null,
      },
      viewportTail: snapshot.viewportTail,
      viewportPatch: undefined,
      ansiWrites: [NOWRAP + CLEAR_VIEWPORT + paint + cursor],
    }
    return JSON.stringify(checkpoint)
  }
}
