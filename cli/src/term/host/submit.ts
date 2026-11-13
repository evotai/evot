import { isSlashCommand } from '../../commands/index.js'
import { promptInput } from '../../commands/skill/invocation.js'
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
import type { ComposerController } from './composer.js'
import { currentQueueTarget, type PendingQueue } from '../app/queue/pending-queue.js'
import { draftImageIds, type PendingImages } from '../app/composer/pending-images.js'
import { errorText } from '../../ui/format.js'
import type { ScrollbackController } from './scrollback.js'
import type { SlashController } from './slash.js'
import type { ReplState } from './state.js'
import { getEditorText } from '../input/editor.js'
import type { RenderDiagnostics } from '../screen/render-diagnostics.js'
import type { TermRenderer } from '../screen/renderer.js'

/** What this controller needs from the host. Looked up lazily on every use. */
export interface SubmitDeps {
  readonly composer: ComposerController
  readonly pendingQueue: PendingQueue
  readonly pendingImages: PendingImages
  readonly backgroundTerminals: BackgroundTerminals
  readonly buildImageContentBlocks: () => { blocks: ContentBlock[]; resolvedIds: Set<number>; } | null
  readonly clearAll: () => void
  readonly computeSession: ComputeSession
  readonly getDisplayText: () => string
  readonly getExpandedText: (resolvedImageIds?: Set<number> | undefined) => string
  readonly getHistoryText: () => string
  readonly manualCompaction: ManualCompaction
  readonly queueEdit: ReturnType<typeof createQueueEdit>
  readonly queueLifecycle: import('../app/queue/queue-lifecycle.js').QueueLifecycle
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
  enqueueDraft(): void
}

/** Enter on the composer: submits a draft when idle; steers, queues or blocks it while a turn runs. */
export function createSubmitController(st: ReplState, deps: SubmitDeps): SubmitController {
  function acceptDraft(queue: 'steering' | 'follow_up', sequence?: number): boolean {
    if (st.pendingQueue.blocked) {
      deps.scrollback.commitSystem('sys-queue-blocked', '  Queue ownership unresolved; Ctrl+G to reconcile before submitting.')
      deps.renderer.requestRender()
      return false
    }
    const imageResult = deps.buildImageContentBlocks()
    if (draftImageIds(getEditorText(st.editor)).some(id => !imageResult?.resolvedIds.has(id))) {
      deps.scrollback.commitSystem('sys-queue-image-error', '  Image content is unavailable; draft was not queued.')
      deps.renderer.requestRender()
      return false
    }
    const rawText = deps.getExpandedText(imageResult?.resolvedIds)
    const expandedText = promptInput(rawText, st.skillEntries)
    const displayText = deps.getDisplayText()
    if (expandedText === null) {
      deps.scrollback.commitSystem('sys-queue-command', "  Commands don't queue. Complete the command or press Enter.")
      deps.renderer.requestRender()
      return false
    }
    if (!expandedText && !imageResult) return false
    if (imageResult && expandedText !== rawText) {
      for (const block of imageResult.blocks) if (block.type === 'text') block.text = promptInput(block.text, st.skillEntries) ?? block.text
    }
    const history = deps.getHistoryText()
    const entry = deps.pendingQueue.accept({
      target: currentQueueTarget(st), queue, text: displayText || '(image prompt)', expandedText,
      contentJson: imageResult ? JSON.stringify(imageResult.blocks) : undefined,
      snapshot: deps.composer.snapshot(),
    }, sequence)
    try {
      if (st.streamRef) deps.pendingQueue.attach(st.streamRef)
    } catch (err) {
      // A local entry is safely removable only before native registration.
      if (!entry.native) deps.pendingQueue.remove(entry, entry.version)
      deps.scrollback.commitSystem('sys-queue-error', `  Queue failed: ${errorText(err)}`)
      deps.renderer.requestRender()
      return false
    }
    deps.suggestions.cancel()
    if (history) deps.saveInputHistory(history)
    deps.clearAll()
    deps.queueLifecycle.reconcile()
    deps.queueLifecycle.dispatchNext()
    deps.renderer.requestRender()
    return true
  }

  function enqueueDraft() {
    if ((!st.isLoading && !deps.manualCompaction.active) || st.pendingEnqueue || deps.queueEdit.editingEntry() || st.foregroundCommand) return
    const waits = deps.pendingImages.blocking(getEditorText(st.editor))
    if (!waits.length) { acceptDraft('follow_up'); return }
    const token = { epoch: st.draftEpoch, ...deps.pendingQueue.reserve(currentQueueTarget(st)) }
    st.pendingEnqueue = token
    deps.suggestions.cancel()
    deps.scrollback.commitSystem('sys-queue-image', '  Preparing queued images · editing or clearing cancels submission')
    deps.renderer.requestRender()
    void Promise.all(waits).then(() => {
      if (st.destroyed || st.pendingEnqueue !== token || token.epoch !== st.draftEpoch
        || token.chain !== st.pendingQueue.chain || currentQueueTarget(st) !== token.target) return
      st.pendingEnqueue = null
      deps.pendingQueue.release(token)
      if (!deps.buildImageContentBlocks()) {
        deps.scrollback.commitSystem('sys-queue-image-error', '  Image loading failed; draft was not queued.')
        deps.queueLifecycle.dispatchNext()
        deps.renderer.requestRender()
        return
      }
      if (!acceptDraft('follow_up', token.sequence)) deps.queueLifecycle.dispatchNext()
    }).catch(err => {
      if (st.pendingEnqueue !== token) return
      st.pendingEnqueue = null
      deps.pendingQueue.release(token)
      deps.scrollback.commitSystem('sys-queue-image-error', `  Image loading failed: ${errorText(err)}`)
      deps.queueLifecycle.dispatchNext()
      deps.renderer.requestRender()
    })
  }

  function handleLoadingEnter() {
    deps.suggestions.cancel()
    const displayText = deps.getDisplayText()
    const historyText = deps.getHistoryText()
    const imageResult = deps.buildImageContentBlocks()
    const imageBlocks = imageResult?.blocks ?? null
    const expandedText = imageResult
      ? deps.getExpandedText(imageResult.resolvedIds)
      : deps.getExpandedText()

    const modelText = promptInput(expandedText, st.skillEntries)
    const action = busySubmissionAction({
      displayText: modelText ?? displayText, expandedText: modelText ?? expandedText, hasImages: imageBlocks !== null,
      compacting: deps.manualCompaction.active, editingQueue: deps.queueEdit.editingEntry() !== null,
      hasRun: st.isLoading,
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
        acceptDraft('follow_up')
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

    if (action === 'steer') {
      const accepted = acceptDraft('steering')
      // Steering is only inspected between tool calls, so anything holding the
      // turn holds this message with it — a shell watched in the foreground or a
      // blocking task_output call alike. During that wait typing appears to do
      // nothing. Freeing both lets the message land now; the work keeps running.
      if (accepted && st.streamRef) deps.backgroundTerminals.reclaimTurnForMessage()
      deps.renderer.requestRender()
    }
  }

  function submitDraft() {
    if (st.pendingQueue.blocked) {
      deps.scrollback.commitSystem('sys-queue-blocked', '  Queue ownership unresolved; Ctrl+G to reconcile before submitting.')
      deps.renderer.requestRender()
      return
    }
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
    const modelText = promptInput(expandedText || submitRaw, st.skillEntries)
    if (imageBlocks && modelText !== null && modelText !== expandedText) {
      for (const block of imageBlocks) if (block.type === 'text') block.text = promptInput(block.text, st.skillEntries) ?? block.text
    }
    if (modelText === null && isSlashCommand(expandedText || submitRaw)) {
      deps.slashCtl.handleSlashInput(expandedText || submitRaw)
    } else if (st.logMode) {
      // Preserve structured content on the initial fork query as on follow-ups.
      deps.slashCtl.runLogQuery(st.logMode, imageBlocks ? '' : modelText ?? expandedText, imageBlocks ? JSON.stringify(imageBlocks) : undefined)
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
        deps.runCtl.runQuery(modelText ?? expandedText, undefined, undefined, taskExtension)
      }
    }
  }

  return { handleLoadingEnter, submitDraft, enqueueDraft }
}
