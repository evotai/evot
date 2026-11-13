import { resolveRunInteraction, type RunInteractionState } from '../run/run-interaction.js'
import type { KeyEvent } from '../../../ui/keys.js'
import type { OverlayState } from '../selector/overlay-state.js'
import type { EditorState } from '../../input/editor.js'
import { isEditorEmpty } from '../../input/editor.js'

export type ReplControlInput = {
  event: KeyEvent
  overlay: OverlayState
  isLoading: boolean
  hasStream: boolean
  editor: EditorState
  exitHint: boolean
  logMode: boolean
  hasQueuedPrompt: boolean
  isCompacting?: boolean
  /**
   * Something is waiting on a background task that ctrl+b can release without
   * killing it: a shell watched in the foreground, or a blocking `task_output`
   * call holding the turn.
   */
  interaction?: RunInteractionState
  canReclaimTurn?: boolean
}

export type ReplControlAction =
  | { kind: 'restore-queued' }
  | { kind: 'reclaim-turn' }
  | { kind: 'interrupt' }
  | { kind: 'stop-background' }
  | { kind: 'stop-loop' }
  | { kind: 'exit' }
  | { kind: 'show-exit-hint' }
  | { kind: 'clear-editor' }
  | { kind: 'close-completion' }
  | { kind: 'clear-exit-hint' }
  | { kind: 'cancel-ask' }
  | { kind: 'clear-selector-query' }
  | { kind: 'close-overlay' }
  | { kind: 'exit-log-mode' }
  | { kind: 'selector-key' }
  | { kind: 'ask-key' }
  | { kind: 'toggle-expanded' }
  | { kind: 'loading-enter' }
  | { kind: 'loading-char' }
  | { kind: 'loading-paste' }
  | { kind: 'normal-key' }

export function decideReplControl(input: ReplControlInput): ReplControlAction[] {
  const { event, overlay, isLoading, hasStream, editor, exitHint, logMode, hasQueuedPrompt, isCompacting, canReclaimTurn } = input
  const actions: ReplControlAction[] = []
  const interaction = input.interaction ?? resolveRunInteraction({
    active: isLoading || Boolean(isCompacting), owner: hasStream || isCompacting ? input : null,
    compacting: isCompacting, foregroundTasks: canReclaimTurn ? 1 : 0,
  })

  // Esc owns interrupt (confirmed by a second press in the REPL, opencode
  // style). Ctrl+C never interrupts: it clears the editor or exits the app.
  if (event.type === 'ctrl' && event.key === 'c') {
    if (overlay.kind === 'ask-user' && hasStream) return [{ kind: 'cancel-ask' }]
    if (isEditorEmpty(editor)) return [{ kind: exitHint ? 'exit' : 'show-exit-hint' }]
    return [{ kind: 'clear-editor' }]
  }

  if (event.type === 'ctrl' && event.key === 'b') {
    if (interaction.backgroundAction) return [{ kind: 'reclaim-turn' }]
    return [{ kind: 'normal-key' }]
  }

  if (exitHint) actions.push({ kind: 'clear-exit-hint' })

  if (event.type === 'escape') {
    if (overlay.kind !== 'none') {
      if (overlay.kind === 'ask-user' && hasStream) return actions.concat({ kind: 'cancel-ask' })
      if (overlay.kind === 'selector' && !overlay.state.rename && overlay.state.previewPane
        && (overlay.state.previewPane.focused || overlay.state.pendingDeleteId)) return actions.concat({ kind: 'selector-key' })
      if (overlay.kind === 'selector' && overlay.state.query) return actions.concat({ kind: 'clear-selector-query' })
      return actions.concat({ kind: 'close-overlay' })
    }
    if (editor.completion) return actions.concat({ kind: 'close-completion' })
    // A sent-but-pending prompt is cancelled before the run is: Esc pulls the
    // newest one back into the empty composer, running or idle, and reaches
    // interrupt only once nothing is pending. With a draft in a running turn
    // the same action explains itself instead of interrupting; an idle draft
    // falls through to the ordinary clear, and the next Esc pulls back.
    if (hasQueuedPrompt && (isLoading || isEditorEmpty(editor))) return actions.concat({ kind: 'restore-queued' })
    // Esc is the interrupt key; the REPL asks for a second press within a
    // short window. Backgrounding lives on ctrl+b, so neither key's meaning
    // depends on state the user cannot see.
    if (interaction.interruptTarget === 'background') return actions.concat({ kind: 'stop-background' })
    // A parked loop is interruptible like a run: two presses, same window, so
    // one stray Esc (a vim reflex, an escape sequence) cannot end it.
    if (interaction.interruptTarget === 'loop') return actions.concat({ kind: 'stop-loop' })
    if (interaction.interruptTarget) return actions.concat({ kind: 'interrupt' })
    if (interaction.backgroundStopping) return actions
    if (!isEditorEmpty(editor)) return actions.concat({ kind: 'clear-editor' })
    if (logMode) return actions.concat({ kind: 'exit-log-mode' })
    return actions
  }

  if (overlay.kind === 'help') return actions.concat({ kind: 'close-overlay' })
  if (overlay.kind === 'selector') return actions.concat({ kind: 'selector-key' })
  if (overlay.kind === 'ask-user') return actions.concat({ kind: 'ask-key' })

  // ctrl+o toggles expanded view in both loading and idle states
  if (event.type === 'ctrl' && event.key === 'o') return actions.concat({ kind: 'toggle-expanded' })

  // A visible completion owns confirmation/navigation even during a run.
  // Otherwise loading-enter submits the draft before the editor can accept
  // the selected path or command.
  if (editor.completion && editor.completion.items.length > 0
    && (event.type === 'enter' || event.type === 'tab' || event.type === 'up' || event.type === 'down')) {
    return actions.concat({ kind: 'normal-key' })
  }

  if (isLoading) {
    if (event.type === 'enter') return actions.concat({ kind: 'loading-enter' })
    if (event.type === 'char' || event.type === 'shift-char') return actions.concat({ kind: 'loading-char' })
    if (event.type === 'paste') return actions.concat({ kind: 'loading-paste' })
  }

  return actions.concat({ kind: 'normal-key' })
}
