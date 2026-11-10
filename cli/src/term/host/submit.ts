import { isSlashCommand } from '../../commands/index.js'
import type { ComputeSession } from '../../features/compute/session.js'
import type { TaskSession } from '../../features/task/session.js'
import type { ContentBlock } from '../../native/index.js'
import type { BackgroundTerminals } from '../app/background/background-terminals.js'
import { busySubmissionAction } from '../app/queue/busy-submission.js'
import type { createQueueEdit } from '../app/queue/queue-edit.js'
import type { ManualCompaction } from '../app/run/manual-compaction.js'
import type { PromptSuggestion } from '../app/suggestion/index.js'
import { formatLogPaths } from '../command-handlers.js'
import type { RendererTrace } from '../diagnostics/renderer-trace.js'
import type { ScreenLog } from '../diagnostics/screen-log.js'
import type { RunController } from './run.js'
import type { ScrollbackController } from './scrollback.js'
import type { SlashController } from './slash.js'
import type { ReplState } from './state.js'
import { getEditorText } from '../input/editor.js'
import type { RenderDiagnostics } from '../screen/render-diagnostics.js'
import type { TermRenderer } from '../screen/renderer.js'

/** What this controller needs from the host. Looked up lazily on every use. */
export interface SubmitDeps {
  readonly backgroundTerminals: BackgroundTerminals
  readonly buildImageContentBlocks: () => { blocks: ContentBlock[]; resolvedIds: Set<number>; } | null
  readonly clearAll: () => void
  readonly computeSession: ComputeSession
  readonly getDisplayText: () => string
  readonly getExpandedText: (resolvedImageIds?: Set<number> | undefined) => string
  readonly getHistoryText: () => string
  readonly manualCompaction: ManualCompaction
  readonly queueEdit: ReturnType<typeof createQueueEdit>
  readonly renderDiagnostics: RenderDiagnostics
  readonly renderer: TermRenderer
  readonly rendererTrace: RendererTrace
  readonly runCtl: RunController
  readonly saveInputHistory: (text: string) => void
  readonly screenLog: ScreenLog
  readonly scrollback: ScrollbackController
  readonly slashCtl: SlashController
  readonly suggestions: PromptSuggestion
  readonly taskSession: TaskSession
}

export interface SubmitController {
  handleLoadingEnter(): void
  submitDraft(): void
}

/** Enter on the composer: submits a draft when idle; steers, queues or blocks it while a turn runs. */
export function createSubmitController(st: ReplState, deps: SubmitDeps): SubmitController {
  function handleLoadingEnter() {
    deps.suggestions.cancel()
    const displayText = deps.getDisplayText()
    const historyText = deps.getHistoryText()
    const imageResult = deps.buildImageContentBlocks()
    const imageBlocks = imageResult?.blocks ?? null
    const expandedText = imageResult
      ? deps.getExpandedText(imageResult.resolvedIds)
      : deps.getExpandedText()

    const action = busySubmissionAction({
      displayText, expandedText, hasImages: imageBlocks !== null,
      compacting: deps.manualCompaction.active, editingQueue: deps.queueEdit.editingEntry() !== null,
      hasRun: st.streamRef !== null,
    })
    if (deps.manualCompaction.active) {
      if (action === 'blocked_compaction_command') {
        // Not silently swallowed: commands cannot run mid-compaction and are
        // not queueable prompts. Keep the draft in the editor for later.
        deps.scrollback.commitSystem('sys-compact-cmd', "  Commands don't run during compaction. Press Esc to cancel it, or wait for it to finish.")
        deps.renderer.requestRender()
        return
      }
      if (action === 'queue_compaction') {
        const queuedDisplay = displayText || '(image prompt)'
        st.queuedCompactionSubmissions.push({
          displayText: queuedDisplay,
          expandedText,
          ...(imageBlocks ? { contentJson: JSON.stringify(imageBlocks) } : {}),
        })
        if (historyText) {
          deps.saveInputHistory(historyText)
        }
        deps.clearAll()
        deps.renderer.requestRender()
      }
      return
    }
    if (action === 'edit_queue') {
      deps.queueEdit.saveQueueEdit(expandedText)
      return
    }
    if (action === 'show_log') {
      deps.clearAll()
      const logPath = deps.screenLog.filePath
      if (logPath) {
        const text = formatLogPaths(logPath, deps.rendererTrace.filePath, deps.renderDiagnostics.summary())
        deps.scrollback.commitSystem('sys-log', text ?? `  Log: ${logPath}`)
      }
      else deps.scrollback.commitSystem('sys-log', '  No active screen log.')
      deps.renderer.requestRender()
      return
    }

    if (action === 'run_readonly_command') {
      if (historyText) deps.saveInputHistory(historyText)
      deps.clearAll()
      void deps.slashCtl.handleSlashInput(expandedText)
      return
    }

    // Slash commands are not model input: queueing one as follow-up text
    // would send "/compact" to the LLM as conversation. Keep the draft in the
    // editor and tell the user instead.
    if (action === 'blocked_run_command') {
      deps.scrollback.commitSystem('sys-cmd-busy', "  Commands don't queue while a response is running. Press Esc to interrupt, or wait for the turn to finish.")
      deps.renderer.requestRender()
      return
    }

    if (action === 'steer' && st.streamRef) {
      if (imageBlocks) {
        const contentJson = JSON.stringify(imageBlocks)
        const queued = st.streamRef.steer('', contentJson)
        st.queuedUserMessages.push({ ...queued, text: displayText || '(image prompt)', queue: 'steering' })
      } else {
        const queued = st.streamRef.steer(expandedText)
        if (displayText) st.queuedUserMessages.push({ ...queued, text: displayText, queue: 'steering' })
      }
      // Steering is only inspected between tool calls, so anything holding the
      // turn holds this message with it — a shell watched in the foreground or a
      // blocking task_output call alike. During that wait typing appears to do
      // nothing. Freeing both lets the message land now; the work keeps running.
      deps.backgroundTerminals.reclaimTurnForMessage()
      // Save expanded text to input history before clearAll() drops the
      // in-memory paste registry. Keep displayText only for compact rendering.
      if (historyText) {
        deps.saveInputHistory(historyText)
      }
      // Queue instead of committing now: history renders above the streaming
      // block, so an immediate commit lands above the incoming reply.
      // Plain and structured prompts are steering messages: consume them FIFO
      // at the next safe turn/tool boundary instead of waiting for the current
      // agent task to finish naturally.
      deps.clearAll()
      deps.renderer.requestRender()
    }
  }

  function submitDraft() {
    // Re-read: keys keep dispatching while a pending image load parks the
    // submit, so text captured before the wait can already be stale.
    const submitRaw = getEditorText(st.editor).trim()
    const displayText = deps.getDisplayText()
    const historyText = deps.getHistoryText()
    const imageResult = deps.buildImageContentBlocks()
    const imageBlocks = imageResult?.blocks ?? null
    // expandedText: only strip image refs that have resolved data.
    // Unresolved ones (e.g. from history) stay as [Image #N] text markers.
    const expandedText = imageResult
      ? deps.getExpandedText(imageResult.resolvedIds)
      : deps.getExpandedText()
    // Allow image-only or text-only submissions
    if (!expandedText && !imageBlocks) return
    deps.suggestions.cancel()
    if (historyText) deps.saveInputHistory(historyText)
    deps.clearAll()
    deps.renderer.requestRender()
    if (isSlashCommand(expandedText || submitRaw)) {
      deps.slashCtl.handleSlashInput(expandedText || submitRaw)
    } else if (st.logMode) {
      // In log mode, send to forked agent
      deps.slashCtl.runLogQuery(st.logMode, expandedText)
    } else {
      deps.scrollback.commitUserMessage(displayText)
      // If the model stopped the task edit with a plain-text question,
      // the next reply is still in that edit flow, not a normal coding
      // turn. Keep its task tool available until confirmation/cancel.
      const taskExtension = deps.taskSession.followUpExtension(st.sessionId)
        ?? deps.computeSession.followUpExtension(st.sessionId)
      if (imageBlocks) {
        const contentJson = JSON.stringify(imageBlocks)
        deps.runCtl.runQuery('', contentJson, undefined, taskExtension)
      } else {
        deps.runCtl.runQuery(expandedText, undefined, undefined, taskExtension)
      }
    }
  }

  return { handleLoadingEnter, submitDraft }
}
