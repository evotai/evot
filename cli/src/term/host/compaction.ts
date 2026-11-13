import type { Agent, ManualCompactionOutcome } from '../../native/index.js'
import { type OutputLine, messagesToOutputLines } from '../../render/output.js'
import { resumeElidedLine, selectResumeMessages } from '../../session/session-view.js'
import { transcriptToMessages } from '../../session/transcript.js'
import { isLegacyContextSummary } from '../../session/user-input.js'
import type { QueueLifecycle } from '../app/queue/queue-lifecycle.js'
import type { ManualCompaction } from '../app/run/manual-compaction.js'
import type { SuggestionContext } from '../app/suggestion/context.js'
import type { FrameController } from './frame.js'
import type { RunController } from './run.js'
import type { ScrollbackController } from './scrollback.js'
import { currentQueueTarget } from '../app/queue/pending-queue.js'
import type { ReplState } from './state.js'
import type { Committer } from '../screen/committer.js'
import type { TermRenderer } from '../screen/renderer.js'
import { manualCompactionLines } from '../viewmodel/manual-compaction.js'
import { createSpinnerState, setSpinnerPhase } from '../widgets/spinner.js'
import { errorText } from '../../ui/format.js'

/** What this controller needs from the host. Looked up lazily on every use. */
export interface CompactionDeps {
  readonly agent: Agent
  readonly committer: Committer
  readonly compactLines: OutputLine[]
  readonly expandedLines: OutputLine[]
  readonly frames: FrameController
  readonly manualCompaction: ManualCompaction
  readonly queueLifecycle: QueueLifecycle
  readonly renderer: TermRenderer
  readonly runCtl: RunController
  readonly scrollback: ScrollbackController
  readonly suggestionContext: SuggestionContext
}

export interface CompactionController {
  readonly runManualCompaction: (customInstructions: string) => Promise<void>
}

/** Manual /compact: runs it, rebuilds the screen from the compacted transcript, then submits what was queued meanwhile. */
export function createCompactionController(st: ReplState, deps: CompactionDeps): CompactionController {
  async function rebuildAfterManualCompaction(outcome: Extract<ManualCompactionOutcome, { status: 'compacted' }>, current: () => boolean) {
    if (!st.sessionId) return
    const sessionId = st.sessionId
    const transcript = await deps.agent.loadContextTranscript(sessionId)
    if (!current()) return
    const messages = transcriptToMessages(transcript.filter(item => !isLegacyContextSummary(item)))
    const { shown, hidden } = selectResumeMessages(messages)
    deps.suggestionContext.replaceHistory(transcript)

    st.appState = {
      ...st.appState,
      messages,
      sessionTokens: {
        ...st.appState.sessionTokens,
        contextTokens: outcome.tokens_after,
        contextWindow: outcome.context_window || st.appState.sessionTokens.contextWindow,
      },
    }
    deps.renderer.clearScreen()
    deps.compactLines.length = 0
    deps.expandedLines.length = 0
    deps.frames.resetHistoryCache()
    if (hidden > 0) deps.scrollback.restoreLines([resumeElidedLine(hidden)])
    // Both views, as on resume: otherwise ctrl+o could no longer open the
    // tool cards or lift the reasoning folds of the messages kept on screen.
    deps.scrollback.restoreLines(messagesToOutputLines(shown), messagesToOutputLines(shown, true))

    const lines = manualCompactionLines(outcome)
    deps.committer.commitDual(lines.compact, lines.expanded)
  }

  async function runManualCompaction(customInstructions: string) {
    if (!st.sessionId) {
      deps.scrollback.commitSystem('sys-compact', '  Nothing to compact: no active session.')
      return
    }

    if (st.pendingQueue.blocked) {
      deps.scrollback.commitSystem('sys-queue-blocked', '  Queue ownership unresolved; Ctrl+G to reconcile before compacting.')
      return
    }
    const generation = deps.runCtl.beginRun()
    const chain = deps.queueLifecycle.begin(currentQueueTarget(st))
    let successful = false
    st.isLoading = true
    st.spinnerState = setSpinnerPhase(createSpinnerState(), 'executing', 'compact')
    deps.runCtl.startSpinner()
    const targetSession = st.sessionId
    const ownsCompaction = () => !st.destroyed && deps.runCtl.ownsRun(generation) && st.sessionId === targetSession
    try {
      await deps.manualCompaction.run(
        () => deps.agent.compact(targetSession, customInstructions || undefined),
        () => {
          if (!ownsCompaction()) return
          st.manualCompactionPhase = deps.manualCompaction.phase
          st.manualCompactionActivity = deps.manualCompaction.activity
          deps.renderer.requestRender()
        },
        async outcome => {
          if (!ownsCompaction()) return
          successful = outcome.status !== 'cancelled'
          if (outcome.status === 'compacted') {
            await rebuildAfterManualCompaction(outcome, ownsCompaction)
          } else if (outcome.status === 'cancelled') {
            deps.scrollback.commitSystem('sys-compact-cancelled', '  Compaction cancelled.')
          } else {
            deps.scrollback.commitSystem('sys-compact-empty', '  Nothing to compact.')
          }
        },
      )
    } catch (err) {
      successful = false
      if (ownsCompaction()) deps.scrollback.commitSystem('sys-compact-err', `Compact failed: ${errorText(err)}`, 'error')
    } finally {
      if (ownsCompaction()) {
        st.manualCompactionPhase = null
        st.manualCompactionActivity = null
        st.isLoading = false
        deps.runCtl.stopSpinner()
        deps.queueLifecycle.settled(null, chain, successful)
        deps.renderer.requestRender()
        deps.queueLifecycle.dispatchNext()
      }
    }
  }

  return { runManualCompaction }
}
