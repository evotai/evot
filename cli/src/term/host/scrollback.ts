import { type OutputLine, buildPrivacyNoticeCard, buildUserMessage } from '../../render/output.js'
import { stripVTControlCharacters } from 'node:util'
import { buildRunFooterLine } from '../../render/run-footer.js'
import type { RunThinking } from '../../render/run-thinking.js'
import type { settledNoticeCard } from '../app/background/background-processes.js'
import type { PrivacyFeed } from '../app/privacy-feed.js'
import type { SuggestionContext, WorkflowRuntime } from '../app/suggestion/context.js'
import { formatMemoryLine, memorySnapshot } from '../diagnostics/memory.js'
import type { ScreenLog } from '../diagnostics/screen-log.js'
import type { ReplState } from './state.js'
import type { Committer } from '../screen/committer.js'
import { commandOutputLine, type CommandOutputPort } from '../widgets/command-output.js'

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
  commitBackgroundLine(slot: string, text: string, card?: ReturnType<typeof settledNoticeCard>): void
  commitFlushResult(flushed: { lines: OutputLine[]; expandedLines?: OutputLine[] | undefined; }): void
  commitLines(outputLines: OutputLine[]): void
  commitPrivacyHappenings(): void
  commitRevealed(id: string, text: string, erasedText: string, delayMs: number): void
  commitRunFooter(): void
  commitStatusLine(line: OutputLine): void
  /** Opt in to publishing the command's display output to this paired conversation. */
  commandOutput(requestRender: () => void, isActive?: () => boolean): CommandOutputPort
  commitSystem(id: string, text: string, kind?: "user" | "assistant" | "thinking" | "tool" | "tool_result" | "verbose" | "error" | "system" | "cancelled"): void
  commitLocalNotice(id: string, text: string): void
  commitSystemLines(outputLines: OutputLine[]): void
  commitUserMessage(text: string, photoId?: string): void
  memoryLine(): string
  restoreLines(outputLines: OutputLine[], expandedOutputLines?: OutputLine[]): void
}

/** Commits finished lines to scrollback: user turns, system notices, run footers, status lines. */
export function createScrollbackController(st: ReplState, deps: ScrollbackDeps): ScrollbackController {
  function commitPrivacyHappenings(): void {
    const cards = deps.privacyFeed.poll(st.sessionId).flatMap(({ notice, fresh }) => buildPrivacyNoticeCard(notice, fresh, st.appState.cwd))
    if (cards.length) commitLines(cards)
  }

  function restoreLines(outputLines: OutputLine[], expandedOutputLines: OutputLine[] = outputLines) {
    deps.committer.restore(outputLines, expandedOutputLines)
  }

  function commitUserMessage(text: string, photoId?: string): void {
    if (!st.logMode) st.conversationTail.append('user', text, photoId)
    deps.suggestionContext.user(text, deps.liveWorkflowRuntime())
    commitLines(buildUserMessage(text))
  }

  function commitLines(outputLines: OutputLine[]) {
    deps.committer.commit(outputLines)
  }

  function commitSystem(id: string, text: string, kind: OutputLine['kind'] = 'system') {
    deps.committer.system(id, text, kind)
  }

  // Device IDs, QR links and approval codes belong on the local terminal,
  // never in a shared conversation or screen.log.
  function commitLocalNotice(id: string, text: string) {
    deps.committer.commitUnlogged([{ id, kind: 'system', text }])
  }

  function commitRunFooter() {
    if (st.runStartedAt === null) return
    const line = buildRunFooterLine(st.runStartedAt, Date.now(), st.runTurnCount, deps.runThinking.finish())
    st.runStartedAt = null
    if (line) {
      commitLines([line])
      if (!st.logMode) st.conversationTail.append('footer', stripVTControlCharacters(line.text).trim())
    }
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
    const safe = line.remoteStatusText
    if (safe === undefined) { deps.committer.commitStatus(line); return }
    const display = (text: string) => ({ ...line, ...commandOutputLine(line.id, [{ text, tone: 'muted' }]) })
    const local = display(line.text)
    const replaced = deps.committer.commitStatus(local)
    if (!st.logMode) st.conversationTail.commitCommand([safe === line.text ? local : display(safe)], replaced)
  }

  function commandOutput(requestRender: () => void, isActive = () => true): CommandOutputPort {
    const session = st.sessionId, epoch = st.remoteEpoch, shared = !st.logMode
    const current = () => !st.destroyed && isActive()
    const mirror = () => shared && !st.logMode && st.sessionId === session && st.remoteEpoch === epoch
    return {
      commitLines(lines, remoteLines = lines) {
        if (!current()) return
        if (remoteLines !== lines) deps.committer.commitUnlogged(lines)
        else deps.committer.commit(lines)
        if (mirror()) st.conversationTail.commitCommand(remoteLines)
      },
      replaceLine(id, text, spans) {
        if (!current() || !deps.committer.replaceById(id, text, spans)) return false
        if (mirror()) st.conversationTail.replaceCommand(id, text, spans)
        return true
      },
      requestRender,
    }
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
  function commitBackgroundLine(slot: string, text: string, card?: ReturnType<typeof settledNoticeCard>): void {
    if (!st.logMode) {
      if (card) st.conversationTail.appendNoticeCard(text, card)
      else st.conversationTail.append('notice', stripVTControlCharacters(text))
    }
    commitSystem(`sys-bg-${slot}-${st.nextBackgroundLineId++}`, text)
  }

  return { commandOutput, commitBackgroundLine, commitFlushResult, commitLines, commitPrivacyHappenings, commitRevealed, commitRunFooter, commitStatusLine, commitSystem, commitLocalNotice, commitSystemLines, commitUserMessage, memoryLine, restoreLines }
}
