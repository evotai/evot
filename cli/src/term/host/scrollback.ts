import { type OutputLine, buildPrivacyHappeningCard, buildUserMessage } from '../../render/output.js'
import { buildRunFooterLine } from '../../render/run-footer.js'
import type { RunThinking } from '../../render/run-thinking.js'
import type { PrivacyFeed } from '../app/privacy-feed.js'
import type { SuggestionContext, WorkflowRuntime } from '../app/suggestion/context.js'
import { formatMemoryLine, memorySnapshot } from '../diagnostics/memory.js'
import type { ScreenLog } from '../diagnostics/screen-log.js'
import type { ReplState } from './state.js'
import type { Committer } from '../screen/committer.js'

/** What this controller needs from the host. Looked up lazily on every use. */
export interface ScrollbackDeps {
  readonly committer: Committer
  readonly compactLines: OutputLine[]
  readonly expandedLines: OutputLine[]
  readonly liveWorkflowRuntime: () => WorkflowRuntime
  readonly privacyFeed: PrivacyFeed
  readonly runThinking: RunThinking
  readonly screenLog: ScreenLog
  readonly suggestionContext: SuggestionContext
}

export interface ScrollbackController {
  commitBackgroundLine(slot: string, text: string): void
  commitFlushResult(flushed: { lines: OutputLine[]; expandedLines?: OutputLine[] | undefined; }): void
  commitLines(outputLines: OutputLine[]): void
  commitPrivacyHappenings(): void
  commitRevealed(id: string, text: string, erasedText: string, delayMs: number): void
  commitRunFooter(): void
  commitStatusLine(line: OutputLine): void
  commitSystem(id: string, text: string, kind?: "user" | "assistant" | "thinking" | "tool" | "tool_result" | "verbose" | "error" | "system" | "cancelled"): void
  commitSystemLines(outputLines: OutputLine[]): void
  commitUserMessage(text: string): void
  memoryLine(): string
  restoreLines(outputLines: OutputLine[], expandedOutputLines?: OutputLine[]): void
}

/** Commits finished lines to scrollback: user turns, system notices, run footers, status lines. */
export function createScrollbackController(st: ReplState, deps: ScrollbackDeps): ScrollbackController {
  function commitPrivacyHappenings(): void {
    for (const { notice, fresh } of deps.privacyFeed.poll(st.sessionId)) commitLines(buildPrivacyHappeningCard(notice, fresh))
  }

  function restoreLines(outputLines: OutputLine[], expandedOutputLines: OutputLine[] = outputLines) {
    deps.committer.restore(outputLines, expandedOutputLines)
  }

  function commitUserMessage(text: string): void {
    deps.suggestionContext.user(text, deps.liveWorkflowRuntime())
    commitLines(buildUserMessage(text))
  }

  function commitLines(outputLines: OutputLine[]) {
    deps.committer.commit(outputLines)
  }

  function commitSystem(id: string, text: string, kind: OutputLine['kind'] = 'system') {
    deps.committer.system(id, text, kind)
  }

  function commitRunFooter() {
    if (st.runStartedAt === null) return
    const line = buildRunFooterLine(st.runStartedAt, Date.now(), st.runTurnCount, deps.runThinking.finish())
    st.runStartedAt = null
    if (line) commitLines([line])
    // One memory line per run in the screen log: a report of a bloated
    // process then comes with the trend and what this client retained.
    deps.screenLog.logLines([memoryLine()])
  }

  function memoryLine(): string {
    return formatMemoryLine(memorySnapshot({
      compactRows: deps.compactLines.length,
      expandedRows: deps.expandedLines.length,
      messages: st.appState.messages.length,
    }))
  }

  /**
   * Show a secret on screen, then take it back.
   *
   * The mechanics live on the Committer, which owns the line arrays and the
   * timer, so the erase is reachable by tests. Here this is only the wiring the
   * command layer calls through.
   */
  function commitRevealed(id: string, text: string, erasedText: string, delayMs: number) {
    deps.committer.revealTemporarily(id, text, erasedText, delayMs)
  }

  /** Commit a transient status line (model / thinking level). Rapid re-toggles
   *  replace the previous status in place instead of stacking a new line each
   *  time. Model and thinking share one status slot so alternating switches
   *  stay single-line. Only the trailing line is eligible for replacement, so a
   *  later user message or other output freezes the prior status into history. */
  function commitStatusLine(line: OutputLine) {
    deps.committer.commitStatus(line)
  }

  /** Commit slash-command system lines, collapsing model/thinking status in place. */
  function commitSystemLines(outputLines: OutputLine[]) {
    for (const line of outputLines) {
      if (line.kind === 'system' && (line.id === 'sys-model' || line.id === 'sys-think')) {
        commitStatusLine(line)
      } else {
        deps.committer.commitNotice([line])
      }
    }
  }

  /** Commit flush result with optional dual-commit (compact summary vs expanded full). */
  function commitFlushResult(flushed: { lines: OutputLine[]; expandedLines?: OutputLine[] }) {
    if (flushed.lines.length === 0) return
    if (flushed.expandedLines) {
      deps.committer.commitDual(flushed.lines, flushed.expandedLines)
    } else {
      commitLines(flushed.lines)
    }
  }

  /** Unique id per emission: these lines are history, not collapsible status. */
  function commitBackgroundLine(slot: string, text: string): void {
    commitSystem(`sys-bg-${slot}-${st.nextBackgroundLineId++}`, text)
  }

  return { commitBackgroundLine, commitFlushResult, commitLines, commitPrivacyHappenings, commitRevealed, commitRunFooter, commitStatusLine, commitSystem, commitSystemLines, commitUserMessage, memoryLine, restoreLines }
}
