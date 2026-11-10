import type { LoopSession } from '../../features/loop/session.js'
import type { TaskSession } from '../../features/task/session.js'
import { isBackgroundPanelShortcut } from '../app/background/background-panel.js'
import type { BackgroundTerminals } from '../app/background/background-terminals.js'
import { type ReplControlAction, decideReplControl } from '../app/composer/repl-control.js'
import type { createQueueEdit } from '../app/queue/queue-edit.js'
import { isQueueManageShortcut } from '../app/queue/queue-manage.js'
import type { ManualCompaction } from '../app/run/manual-compaction.js'
import type { RunInteraction } from '../app/run/run-interaction.js'
import { isCommandWindowTypingEvent } from '../app/selector/command-window-trigger.js'
import { exitLineageHint } from '../app/session/fork-nav.js'
import type { PromptSuggestion } from '../app/suggestion/index.js'
import type { AskController } from './ask.js'
import type { CommandWindowController } from './command-window.js'
import type { ComposerController } from './composer.js'
import type { IdleController } from './idle.js'
import type { RunController } from './run.js'
import type { ScrollbackController } from './scrollback.js'
import type { SelectorKeysController } from './selector-keys.js'
import type { SessionController } from './session.js'
import type { SlashController } from './slash.js'
import type { ReplState } from './state.js'
import type { SubmitController } from './submit.js'
import { clearEditor, closeCompletion, insertText } from '../input/editor.js'
import type { TermRenderer } from '../screen/renderer.js'
import type { KeyEvent } from '../../ui/keys.js'
import { SELECTOR_OWNER, isBackgroundSelector, isCommandSelector } from '../../ui/selector-identity.js'
import { selectorClearQuery } from '../../ui/selector.js'

/** What this controller needs from the host. Looked up lazily on every use. */
export interface KeysDeps {
  readonly asks: AskController
  readonly backgroundTerminals: BackgroundTerminals
  readonly cleanup: () => void
  readonly commandWindow: CommandWindowController
  readonly composer: ComposerController
  readonly exitAfterCleanup: (code: number) => void
  readonly idle: IdleController
  readonly insertPaste: (raw: string) => void
  readonly loopSession: LoopSession
  readonly manualCompaction: ManualCompaction
  readonly queueEdit: ReturnType<typeof createQueueEdit>
  readonly renderer: TermRenderer
  readonly runCtl: RunController
  readonly runInteraction: RunInteraction
  readonly scrollback: ScrollbackController
  readonly selectorKeys: SelectorKeysController
  readonly sessionCtl: SessionController
  readonly slashCtl: SlashController
  readonly submit: SubmitController
  readonly suggestionInput: { handle(event: { type: string; }): boolean; }
  readonly suggestions: PromptSuggestion
  readonly taskSession: TaskSession
  readonly withDraftImages: (submit: () => void) => void
}

export interface KeysController {
  handleKey(event: KeyEvent): void
}

/** Top-level key routing: overlays first, then a running turn, then the composer. */
export function createKeysController(st: ReplState, deps: KeysDeps): KeysController {
  function handleKey(event: KeyEvent) {
    if (deps.suggestionInput.handle(event)) return
    if (event.type !== 'escape' || st.overlay.kind !== 'none' || st.editor.completion || deps.queueEdit.editingEntry()) {
      deps.runInteraction.clear()
    }
    // Typing keeps focus in the composer while refreshing the formal window
    // above it. Up/down is the explicit gesture that promotes that same state.
    if (deps.commandWindow.activateCommandWindow(event)) { deps.suggestions.reconcile(); return }
    handleKeyInner(event)
    deps.commandWindow.refreshCommandWindowPreview(isCommandWindowTypingEvent(event))
    deps.suggestions.reconcile()
  }

  function handleKeyInner(event: KeyEvent) {

    // Mouse dragging creates a native terminal selection outside our editor
    // state. Most keypresses repaint the whole live region to release it. A
    // selector navigation key is the latency-sensitive exception: repainting
    // every selector, preview-pane and composer row made ↑/↓ feel sticky even
    // though only two choice rows changed. Let the renderer diff those rows.
    const commandSelectorNavigation = st.overlay.kind === 'selector'
      && st.focusedCommandWindowGeneration !== null
      && isCommandSelector(st.overlay.state)
      && (event.type === 'up' || event.type === 'down' || event.type === 'tab' || event.type === 'shift-tab')
    // While the composer owns a mounted command window, ordinary text edits
    // should likewise remain differential. Invalidating from the live-region
    // start reaches above the viewport for a tall session pane, forcing a
    // clear-and-repaint even when `/re` merely becomes `/`.
    const commandWindowEditing = st.commandWindowPreview !== null
      && (event.type === 'char'
        || event.type === 'shift-char'
        || event.type === 'backspace'
        || event.type === 'delete')
    if (!commandSelectorNavigation && !commandWindowEditing) {
      deps.renderer.invalidateRowsFrom(st.liveRegionStartRow)
    }

    if (deps.queueEdit.editingEntry()) {
      if (event.type === 'escape' || (event.type === 'ctrl' && event.key === 'c')) {
        deps.queueEdit.cancelQueueEdit()
        return
      }
      if (isQueueManageShortcut(event)) {
        deps.scrollback.commitSystem('sys-queue-edit-lock', '  Finish or discard the queued prompt edit first.')
        return
      }
    }
    if (isQueueManageShortcut(event)) {
      if (st.overlay.kind === 'selector' && st.overlay.state.owner === SELECTOR_OWNER.queue) {
        st.overlay = { kind: 'none' }
        deps.renderer.requestRender()
      } else if (st.streamRef && st.queuedUserMessages.length > 0) {
        deps.queueEdit.openQueueSelector()
      }
      return
    }

    if (isBackgroundPanelShortcut(event)) {
      deps.backgroundTerminals.togglePanel()
      return
    }
    // The panel claims its own gestures (enter / x / X / esc) before the
    // generic selector handling, which would otherwise treat them as filter
    // input or a plain selection.
    if (st.overlay.kind === 'selector' && isBackgroundSelector(st.overlay.state)) {
      if (deps.backgroundTerminals.handlePanelKey(event)) return
    }

    const actions = decideReplControl({
      event,
      overlay: st.overlay,
      isLoading: st.isLoading,
      hasStream: st.streamRef !== null,
      editor: st.editor,
      exitHint: st.exitHint,
      logMode: st.logMode !== null,
      hasQueuedPrompt: st.queuedUserMessages.length > 0,
      isCompacting: deps.manualCompaction.active,
      interaction: deps.runInteraction.snapshot(deps.runCtl.runInteractionInput()),
    })

    for (const action of actions) {
      if (applyReplControlAction(action, event)) return
    }
  }

  function applyReplControlAction(action: ReplControlAction, event: KeyEvent): boolean {
    switch (action.kind) {
      case 'restore-queued':
        deps.queueEdit.restoreLastQueuedUserMessageToEditor()
        return true
      case 'reclaim-turn': {
        // Non-destructive by contract: ctrl+b never kills. If nothing was
        // actually released (it all finished in the same tick) say so rather
        // than falling through to an interrupt — this key must never be the one
        // that ends a run.
        const wasForeground = deps.backgroundTerminals.foregroundCount() > 0
        const freed = deps.backgroundTerminals.reclaimTurn()
        if (freed === 0) {
          deps.scrollback.commitSystem('sys-reclaim-turn', '  Nothing to move to the background.')
          deps.renderer.requestRender()
          return true
        }
        if (wasForeground) {
          deps.scrollback.commitSystem('sys-reclaim-turn', '  ● Shell moved to background; it keeps running.')
        }
        deps.renderer.requestRender()
        return true
      }
      case 'stop-background': {
        deps.backgroundTerminals.refresh(false)
        const input = deps.runCtl.runInteractionInput()
        if (deps.runInteraction.requestInterrupt(input) === 'interrupt') {
          deps.backgroundTerminals.stopAll(input.backgroundOwner ?? null)
        }
        deps.renderer.requestRender()
        return true
      }
      case 'stop-loop':
        // Parked between loop ticks: Esc stops the loop, behind the same
        // two-press window as a running turn. The wait row shows "esc again"
        // after the first press; the second one is `/loop stop` without typing.
        if (deps.runInteraction.requestInterrupt(deps.runCtl.runInteractionInput()) === 'interrupt') {
          deps.loopSession.cancelWait()
        }
        deps.renderer.requestRender()
        return true
      case 'interrupt':
        // Same gesture as opencode: the first Esc arms a short window and the
        // spinner switches to "esc again to interrupt"; only the second press
        // within that window stops the work.
        if (deps.runInteraction.requestInterrupt(deps.runCtl.runInteractionInput()) !== 'interrupt') {
          deps.renderer.requestRender()
          return true
        }
        if (deps.manualCompaction.active) {
          deps.manualCompaction.abort()
          return true
        }
        deps.runCtl.interruptStream('sys-int', '  Interrupted.')
        return true
      case 'exit':
        deps.cleanup()
        if (st.sessionId) {
          process.stdout.write(`\n\x1b[90m${'─'.repeat(80)}\x1b[0m\n`)
          process.stdout.write(`\x1b[90mResume: evot --resume ${st.sessionId}\x1b[0m\n`)
          for (const hint of exitLineageHint(st.lastLineage)) process.stdout.write(`\x1b[90m${hint}\x1b[0m\n`)
          process.stdout.write('\n')
        }
        deps.exitAfterCleanup(0)
        return true
      case 'show-exit-hint':
        st.exitHint = true
        deps.renderer.requestRender()
        if (st.exitHintTimer) clearTimeout(st.exitHintTimer)
        st.exitHintTimer = setTimeout(() => { st.exitHint = false; deps.renderer.requestRender() }, 2000)
        return true
      case 'clear-editor':
        st.editor = clearEditor(st.editor)
        deps.renderer.requestRender()
        return true
      case 'close-completion':
        st.editor = closeCompletion(st.editor)
        deps.renderer.requestRender()
        return true
      case 'clear-exit-hint':
        st.exitHint = false
        return false
      case 'cancel-ask':
        st.overlay = { kind: 'none' }
        deps.idle.unfreezeTerminalTitle()
        deps.runCtl.interruptStream('sys-ask-cancel', '  ⏺ Cancelled.')
        return true
      case 'clear-selector-query':
        if (st.overlay.kind === 'selector') st.overlay = { kind: 'selector', state: selectorClearQuery(st.overlay.state) }
        deps.renderer.requestRender()
        return true
      case 'close-overlay': {
        // Closing a promoted command window also consumes its slash command,
        // matching the previous one-Esc lifecycle. The hot focus/navigation
        // path remains stable; only this explicit close is allowed to shrink.
        const closesCommandWindow = st.focusedCommandWindowGeneration !== null
          && st.overlay.kind === 'selector'
          && isCommandSelector(st.overlay.state)
        // Ask and task-model overlays froze the tab title on a '?'. Every way
        // of leaving them must release it, or the glyph outlives the prompt and
        // no later overlay or run can repaint the title.
        if (st.overlay.kind === 'ask-user') {
          deps.asks.resolvePendingAsk()
          deps.idle.unfreezeTerminalTitle()
        }
        if (st.overlay.kind === 'selector' && st.overlay.state.owner === SELECTOR_OWNER.taskModel) {
          deps.asks.resolvePendingTaskModel()
        }
        if (st.overlay.kind === 'selector' && st.overlay.state.owner === SELECTOR_OWNER.task) {
          deps.taskSession.invalidate()
        }
        deps.sessionCtl.invalidateExplicitResumeSelector()
        st.overlay = { kind: 'none' }
        st.focusedCommandWindowGeneration = null
        deps.commandWindow.cancelResumeSearchEnrichment()
        deps.commandWindow.nextCommandWindowGeneration()
        if (closesCommandWindow) deps.composer.clearAll()
        deps.commandWindow.releaseCommandWindowLayout()
        deps.renderer.requestRender()
        return true
      }
      case 'exit-log-mode':
        deps.slashCtl.leaveLogMode()
        deps.renderer.requestRender()
        return true
      case 'selector-key':
        deps.selectorKeys.handleSelectorKey(event)
        return true
      case 'ask-key':
        deps.asks.handleAskKey(event)
        return true
      case 'toggle-expanded':
        deps.composer.toggleExpanded()
        return true
      case 'loading-enter':
        deps.withDraftImages(deps.submit.handleLoadingEnter)
        return true
      case 'loading-char':
        if (event.type === 'char' || event.type === 'shift-char') {
          st.editor = insertText(st.editor, event.char)
          deps.renderer.requestRender()
        }
        return true
      case 'loading-paste':
        if (event.type === 'paste') {
          deps.insertPaste(event.text)
          deps.renderer.requestRender()
        }
        return true
      case 'normal-key':
        deps.composer.handleNormalKey(event)
        return true
    }
  }

  return { handleKey }
}
