import { replaceOrPushStatusLine } from '../app/status-line.js'
import type { OutputLine } from '../../render/output.js'
import { buildOutputBlocks, blocksToLines } from '../viewmodel/index.js'

export interface CommitterDeps {
  compactLines: OutputLine[]
  expandedLines: OutputLine[]
  isExpanded: () => boolean
  columns: () => number
  logLines: (lines: string[]) => void
  notices?: (lines: OutputLine[]) => void
  requestRender: () => void
  /** Called after an in-place edit, so the append-only render cache rebuilds. */
  invalidateHistory: () => void
}

/**
 * Upper bound on the rows either view keeps for redraws.
 *
 * The renderer repaints only the viewport, but a resize or an invalidated
 * prefix replays these arrays into the terminal, and the render cache holds a
 * flattened copy of every row. Unbounded, a long tool-heavy session kept its
 * entire scrollback three times over (lines, expanded lines, caches), with the
 * expanded view carrying every tool result in full. The screen log and the
 * session transcript keep the complete history.
 */
export const MAX_HISTORY_LINES = 20_000
/** Rows dropped per trim beyond the bound, so the full rebuild it costs is rare. */
const TRIM_BATCH = 4_000

export class Committer {
  /** Reveals still waiting to be erased. Held so shutdown cannot leave one dangling. */
  private readonly pendingReveals = new Set<ReturnType<typeof setTimeout>>()

  constructor(private readonly deps: CommitterDeps) {}

  /** Drop the oldest rows of any view past the bound; the render cache rebuilds. */
  private trim(): void {
    let trimmed = false
    for (const list of [this.deps.compactLines, this.deps.expandedLines]) {
      if (list.length <= MAX_HISTORY_LINES) continue
      // An earlier notice sits at index 0 and goes with the dropped rows.
      const drop = list.length - MAX_HISTORY_LINES + TRIM_BATCH
      list.splice(0, drop, {
        id: 'history-trimmed',
        kind: 'system',
        text: `… earlier output no longer kept on screen; the session log has it (/log)`,
      })
      trimmed = true
    }
    if (trimmed) this.deps.invalidateHistory()
  }

  /** Block layout only needs the line it follows, so history is never copied. */
  private contextAfter(previous: OutputLine | undefined): { prevKind?: string; columns?: number } {
    return { prevKind: previous?.kind, columns: this.deps.columns() }
  }

  restore(lines: OutputLine[], expandedLines: OutputLine[] = lines): void {
    if (lines.length === 0 && expandedLines.length === 0) return
    appendAll(this.deps.compactLines, lines)
    appendAll(this.deps.expandedLines, expandedLines)
    this.trim()
    this.deps.requestRender()
  }

  commit(lines: OutputLine[]): void {
    this.commitDual(lines, lines)
  }

  /**
   * Append to scrollback. Nothing here is persisted: these lines render output
   * the agent already wrote to the transcript, so capturing them as notices
   * would store — and later share — a second copy of every tool error.
   */
  commitDual(compact: OutputLine[], expanded: OutputLine[]): void {
    if (!compact.length && !expanded.length) return
    const previous = this.deps.compactLines.at(-1)
    appendAll(this.deps.compactLines, compact)
    appendAll(this.deps.expandedLines, expanded)
    this.trim()
    this.paint(this.deps.isExpanded() ? expanded : compact, previous)
  }

  /**
   * Commit lines that exist only on this client — a cancellation, a slash
   * command reply, a connection failure the transcript never saw. These are
   * offered to `notices` so a shared session still shows them.
   */
  commitNotice(lines: OutputLine[]): void {
    if (lines.length === 0) return
    this.commitDual(lines, lines)
    this.deps.notices?.(lines)
  }

  commitStatus(line: OutputLine): void {
    const replaced = replaceOrPushStatusLine(this.deps.compactLines, line)
    replaceOrPushStatusLine(this.deps.expandedLines, line)
    if (replaced) this.deps.invalidateHistory()
    this.deps.notices?.([line])
    this.paint([line], this.deps.compactLines.at(-2))
  }

  system(id: string, text: string, kind: OutputLine['kind'] = 'system'): void {
    this.commitNotice([{ id, kind, text }])
  }

  /**
   * Commit a line the terminal shows but the screen log never receives.
   *
   * For a revealed secret. The log is a plain file that outlives the session and
   * feeds `/log`, so writing the value there would undo any on-screen erase.
   */
  commitUnlogged(lines: OutputLine[]): void {
    if (lines.length === 0) return
    appendAll(this.deps.compactLines, lines)
    appendAll(this.deps.expandedLines, lines)
    this.trim()
    this.deps.requestRender()
  }

  /**
   * Rewrite an already-committed line in place, found by id.
   *
   * Scrollback is otherwise append-only, and the terminal redraws each frame
   * from these arrays rather than from what was printed — so replacing the text
   * here does erase it from the screen. Returns false when the line is gone,
   * which is the normal outcome after `/clear`.
   */
  replaceById(id: string, text: string): boolean {
    let found = false
    for (const list of [this.deps.compactLines, this.deps.expandedLines]) {
      const index = list.findIndex((line) => line.id === id)
      if (index === -1) continue
      const existing = list[index]
      if (!existing) continue
      list[index] = { ...existing, text }
      found = true
    }
    if (!found) return false
    // In-place mutation invalidates the cache's append-only prefix.
    this.deps.invalidateHistory()
    this.deps.requestRender()
    return true
  }

  /**
   * Show a secret, then take it back.
   *
   * A revealed credential should not sit in the scrollback for the rest of the
   * session, where it survives every later screenshot, screen share and scroll
   * back up. It stays for `delayMs`, then the line is rewritten to its masked
   * form.
   *
   * The timer lives here rather than in the REPL so it is reachable by tests:
   * the erase is the whole point of the feature, and in the REPL closure it could
   * only be type-checked, never run. Returns the timer so callers can clear it.
   */
  revealTemporarily(id: string, text: string, erasedText: string, delayMs: number): ReturnType<typeof setTimeout> {
    this.commitUnlogged([{ id, kind: 'system', text }])
    this.deps.notices?.([{ id, kind: 'system', text: erasedText }])
    // Only the masked form is logged; see commitUnlogged.
    const context = this.contextAfter(this.deps.compactLines.at(-2))
    this.deps.logLines(blocksToLines(buildOutputBlocks([{ id, kind: 'system', text: erasedText }], context)))
    const timer = setTimeout(() => {
      this.pendingReveals.delete(timer)
      // A missing line is the normal outcome after /clear; nothing to erase.
      this.replaceById(id, erasedText)
    }, delayMs)
    this.pendingReveals.add(timer)
    return timer
  }

  /** Erase every pending reveal now, then drop its timer. For shutdown. */
  flushReveals(): void {
    for (const timer of this.pendingReveals) clearTimeout(timer)
    this.pendingReveals.clear()
  }

  paint(lines: OutputLine[], previous: OutputLine | undefined): void {
    const blocks = buildOutputBlocks(lines, this.contextAfter(previous))
    this.deps.logLines(blocksToLines(blocks))
    this.deps.requestRender()
  }
}

/** `push(...items)` without the spread: a restored transcript can exceed the
 *  engine's argument limit. */
function appendAll(target: OutputLine[], items: OutputLine[]): void {
  for (const item of items) target.push(item)
}
