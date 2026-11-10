import { extractAtPrefix } from '../../commands/file-completion.js'
import type { Agent } from '../../native/index.js'
import type { HistoryManager } from '../../session/history.js'
import type { BackgroundTerminals } from '../app/background/background-terminals.js'
import type { FileCompletion } from '../app/composer/file-completion-controller.js'
import type { PastedImage } from '../app/composer/paste-input.js'
import { type ReplCommandContext, handleCopyCommand } from '../command-handlers.js'
import type { CommandWindowController } from './command-window.js'
import type { ScrollbackController } from './scrollback.js'
import type { ReplState } from './state.js'
import type { SubmitController } from './submit.js'
import { type EditorState, acceptCompletion, applyCompletion, backspace, clearEditor, clearLineAfter, clearLineBefore, deleteForward, deleteWordBefore, deleteWordForward, editorNeedsContinuation, getEditorText, historyNext, historyPrev, insertContinuationNewline, insertNewline, insertText, isEditorEmpty, moveCompletion, moveDown, moveEnd, moveHome, moveLeft, moveRight, moveUp, moveWordLeft, moveWordRight, pushHistory, refreshGhostHint } from '../input/editor.js'
import type { InputImageHistory } from '../input/image-history.js'
import { deleteRefBackspace, parsePasteRefs, resolveHistoryText, resolveSubmitText } from '../input/paste_refs.js'
import type { UndoStack } from '../input/undo-stack.js'
import type { TermRenderer } from '../screen/renderer.js'
import type { KeyEvent } from '../../ui/keys.js'

/** What this controller needs from the host. Looked up lazily on every use. */
export interface ComposerDeps {
  readonly agent: Agent
  readonly backgroundTerminals: BackgroundTerminals
  readonly commandWindow: CommandWindowController
  readonly editorUndo: UndoStack<EditorState>
  readonly exitAfterCleanup: (code: number) => void
  readonly fileCompletion: FileCompletion
  readonly historyMgr: HistoryManager
  readonly inputImageHistory: InputImageHistory
  readonly insertPaste: (raw: string) => void
  readonly pastedChunks: Map<number, string>
  readonly pastedImages: Map<number, PastedImage>
  readonly refreshConfigInfo: () => void
  readonly renderer: TermRenderer
  readonly replCommands: ReplCommandContext
  readonly scrollback: ScrollbackController
  readonly submit: SubmitController
  readonly tryPasteClipboard: () => Promise<void>
  readonly tryPasteImage: () => Promise<void>
  readonly withDraftImages: (submit: () => void) => void
}

export interface ComposerController {
  clearAll(): void
  getDisplayText(): string
  readonly getExpandedText: (resolvedImageIds?: Set<number> | undefined) => string
  getHistoryText(): string
  handleNormalKey(event: KeyEvent): void
  readonly mutateEditor: (mutator: (state: EditorState) => EditorState) => void
  saveInputHistory(text: string): void
  toggleExpanded(): void
}

/** The composer: editing keys, buffer mutation with undo, word deletion, history, file completion. */
export function createComposerController(st: ReplState, deps: ComposerDeps): ComposerController {
  function mutateEditor(mutator: (state: EditorState) => EditorState): void {
    const previous = st.editor
    const next = mutator(previous)
    if (next === previous) return
    // Only snapshot content-changing mutations for undo; pure cursor moves skip.
    if (getEditorText(next) !== getEditorText(previous)) {
      deps.editorUndo.push(previous)
    }
    st.editor = next
  }

  function undoEditor(): boolean {
    const previous = deps.editorUndo.pop()
    if (!previous) return false
    st.editor = previous
    return true
  }

  /** Toggle expanded view and redraw. */
  function toggleExpanded(): void {
    st.expanded = !st.expanded
    // An explicit Ctrl+O layout change should take effect immediately rather
    // than being mistaken for parser-induced shrink by the live-height guard.
    st.liveContentMaxHeight = 0
    // Differential render, not a forced clear. When the content being toggled
    // (e.g. the tool output you just ran) sits in the viewport, the renderer
    // repaints in place from the first changed line down, so the view stays
    // put instead of clearing and re-anchoring to the bottom (which is what
    // made the screen jump). The toggle applies to the whole transcript, so a
    // swap that also changes history above the viewport is allowed to replay
    // it: the user asked for a different view of that history.
    deps.renderer.invalidateScrollback()
  }

  /** Cycle the model's reasoning effort (Shift+Tab) and reflect it in the footer. */
  function cycleThinkingLevel(): void {
    let level: string | null
    try {
      level = deps.agent.cycleThinkingLevel()
    } catch {
      return
    }
    if (level === null) {
      deps.scrollback.commitStatusLine({ id: 'sys-think', kind: 'system', text: '  This model has no selectable thinking level' })
      return
    }
    deps.refreshConfigInfo()
    const label = level === 'off' ? 'off' : level
    deps.scrollback.commitStatusLine({ id: 'sys-think', kind: 'system', text: `  Thinking level → ${label}`,
      shareEvents: [{ kind: 'thinking_level_change', data: { thinking_level: level } }],
    })
    deps.renderer.requestRender()
  }

  /** Get expanded text — resolves paste refs, strips only resolved image refs. */
  function getExpandedText(resolvedImageIds?: Set<number>): string {
    return resolveSubmitText(getEditorText(st.editor), deps.pastedChunks, resolvedImageIds ?? null)
  }

  /** Get display text (raw with refs intact). */
  function getDisplayText(): string {
    return getEditorText(st.editor).trim()
  }

  /** Get history text: expand text pastes before their in-memory store is cleared. */
  function getHistoryText(): string {
    const text = resolveHistoryText(getEditorText(st.editor), deps.pastedChunks)
    deps.inputImageHistory.capture(text, deps.pastedImages)
    return text
  }

  function saveInputHistory(text: string): void {
    deps.historyMgr.append(deps.inputImageHistory.serialize(text))
    st.historyState = pushHistory(st.historyState, text)
  }

  /** Clear editor and paste state. */
  function clearAll() {
    deps.commandWindow.cancelCommandWindowLoads()
    deps.commandWindow.cancelResumeSearchEnrichment()
    st.editor = clearEditor(st.editor)
    deps.editorUndo.clear()
    deps.pastedChunks.clear()
    deps.pastedImages.clear()
  }

  /** Commit queued prompts that are no longer present in either native queue. */
  function refreshFileCompletions(acceptSingle: boolean): void {
    const beforeCursor = st.editor.lines[st.editor.cursorLine]?.slice(0, st.editor.cursorCol) ?? ''
    if (!extractAtPrefix(beforeCursor)) return
    void deps.fileCompletion.refresh(st.editor, st.appState.cwd, acceptSingle, () => st.editor, next => {
      st.editor = next
      deps.renderer.requestRender()
    })
  }

  function deleteAtCursor() {
    const line = st.editor.lines[st.editor.cursorLine]!
    const deletedRef = parsePasteRefs(line).find(ref => ref.start === st.editor.cursorCol)
    if (deletedRef) {
      deps.pastedChunks.delete(deletedRef.id)
      deps.pastedImages.delete(deletedRef.id)
    }
    mutateEditor(state => deleteForward(state))
    deps.renderer.requestRender()
  }

  function deleteWordAtCursor() {
    const lineIndex = st.editor.cursorLine
    const cursorCol = st.editor.cursorCol
    const refs = parsePasteRefs(st.editor.lines[lineIndex]!)
    mutateEditor(state => deleteWordBefore(state))
    if (st.editor.cursorLine === lineIndex) {
      for (const ref of refs) {
        if (ref.start < cursorCol && ref.end > st.editor.cursorCol) {
          deps.pastedChunks.delete(ref.id)
          deps.pastedImages.delete(ref.id)
        }
      }
    }
    deps.renderer.requestRender()
  }

  function deleteWordForwardAtCursor() {
    const lineIndex = st.editor.cursorLine
    const before = st.editor.lines[lineIndex]!
    const refs = parsePasteRefs(before)
    mutateEditor(state => deleteWordForward(state))
    const after = st.editor.lines[st.editor.cursorLine] ?? ''
    for (const ref of refs) {
      if (!after.includes(ref.match)) {
        deps.pastedChunks.delete(ref.id)
        deps.pastedImages.delete(ref.id)
      }
    }
    deps.renderer.requestRender()
  }

  function handleNormalKey(event: KeyEvent) {
    if (st.editor.completion && st.editor.completion.items.length > 0) {
      if (event.type === 'up' || event.type === 'down') {
        st.editor = moveCompletion(st.editor, event.type === 'up' ? -1 : 1)
        deps.renderer.requestRender()
        return
      }
      if (event.type === 'enter' || event.type === 'tab') {
        st.editor = acceptCompletion(st.editor)
        deps.renderer.requestRender()
        return
      }
    }

    if (event.type === 'ctrl') {
      switch (event.key) {
        case 'u':
          mutateEditor(state => clearLineBefore(state))
          deps.renderer.requestRender()
          return
        case 'k':
          mutateEditor(state => clearLineAfter(state))
          deps.renderer.requestRender()
          return
        case 'd':
          if (isEditorEmpty(st.editor)) {
            deps.exitAfterCleanup(0)
            return
          }
          deleteAtCursor()
          return
        case 'w':
          deleteWordAtCursor()
          return
        case 'a':
          st.editor = moveHome(st.editor)
          deps.renderer.requestRender()
          return
        case 'e':
          st.editor = moveEnd(st.editor)
          deps.renderer.requestRender()
          return
        case 'l':
          clearAll()
          deps.renderer.requestRender()
          return
        case 'v':
          deps.tryPasteImage()
          return
        case 'o':
          toggleExpanded()
          return
        case 'y':
          // Keyboard twin of `/clip copy`: last reply's Markdown source to the
          // clipboard. Ctrl+Y is the one free Ctrl letter with a clipboard
          // connotation (readline yank).
          void handleCopyCommand(deps.replCommands)
          return
        case '-':
          if (undoEditor()) deps.renderer.requestRender()
          return
        default:
          return
      }
    }

    switch (event.type) {
      case 'enter': {
        const rawText = getEditorText(st.editor).trim()
        if (!rawText) return
        // Check for continuation (unclosed fences, trailing backslash)
        if (editorNeedsContinuation(st.editor)) {
          mutateEditor(state => insertContinuationNewline(state))
          deps.renderer.requestRender()
          return
        }
        deps.withDraftImages(deps.submit.submitDraft)
        break
      }
      case 'shift-enter':
      case 'ctrl-enter':
      case 'alt-enter': {
        mutateEditor(state => insertNewline(state))
        deps.renderer.requestRender()
        break
      }
      case 'shift-tab': {
        cycleThinkingLevel()
        break
      }
      case 'tab': {
        const beforeCursor = st.editor.lines[st.editor.cursorLine]!.slice(0, st.editor.cursorCol)
        if (extractAtPrefix(beforeCursor)) {
          refreshFileCompletions(true)
          break
        }
        const previous = st.editor
        const result = applyCompletion(st.editor)
        if (result.applied) {
          if (getEditorText(result.state) !== getEditorText(previous)) {
            deps.editorUndo.push(previous)
          }
          st.editor = result.state
          deps.renderer.requestRender()
        }
        break
      }
      case 'char':
      case 'shift-char':
        mutateEditor(state => refreshGhostHint(insertText(state, event.char)))
        deps.renderer.requestRender()
        if (extractAtPrefix(st.editor.lines[st.editor.cursorLine]!.slice(0, st.editor.cursorCol))) {
          refreshFileCompletions(false)
        }
        break
      case 'paste':
        deps.insertPaste(event.text)
        deps.renderer.requestRender()
        break
      case 'paste-clipboard':
        void deps.tryPasteClipboard()
        break
      case 'delete':
        deleteAtCursor()
        break
      case 'backspace': {
        const currentLine = st.editor.lines[st.editor.cursorLine]!
        const refs = parsePasteRefs(currentLine)
        const refDel = deleteRefBackspace(currentLine, st.editor.cursorCol, refs)
        if (refDel) {
          const deletedRef = refs.find(ref => ref.end === st.editor.cursorCol)
          if (deletedRef) {
            deps.pastedChunks.delete(deletedRef.id)
            deps.pastedImages.delete(deletedRef.id)
          }
          mutateEditor(state => ({
            ...state,
            lines: state.lines.map((line, index) =>
              index === state.cursorLine ? refDel.newLine : line),
            cursorCol: refDel.newCursorCol,
            preferredVisualCol: undefined,
            ghostHint: '',
            completion: null,
          }))
        } else {
          mutateEditor(state => backspace(state))
        }
        st.editor = refreshGhostHint(st.editor)
        deps.renderer.requestRender()
        if (extractAtPrefix(st.editor.lines[st.editor.cursorLine]!.slice(0, st.editor.cursorCol))) {
          refreshFileCompletions(false)
        }
        break
      }
      case 'word-left':
        st.editor = moveWordLeft(st.editor)
        deps.renderer.requestRender()
        break
      case 'word-right':
        st.editor = moveWordRight(st.editor)
        deps.renderer.requestRender()
        break
      case 'alt-backspace':
        deleteWordAtCursor()
        break
      case 'alt-d':
        deleteWordForwardAtCursor()
        break
      case 'undo':
        if (undoEditor()) deps.renderer.requestRender()
        break
      case 'left':
        st.editor = moveLeft(st.editor)
        deps.renderer.requestRender()
        break
      case 'right':
        st.editor = moveRight(st.editor)
        deps.renderer.requestRender()
        break
      case 'home':
        st.editor = moveHome(st.editor)
        deps.renderer.requestRender()
        break
      case 'end':
        st.editor = moveEnd(st.editor)
        deps.renderer.requestRender()
        break
      case 'up': {
        const moved = moveUp(st.editor, Math.max(1, deps.renderer.termCols - 2))
        if (moved !== st.editor) {
          st.editor = moved
          deps.renderer.requestRender()
          break
        }
        // At the top visual row: navigate history.
        const result = historyPrev(st.historyState, st.editor)
        if (result.changed) {
          st.historyState = result.history
          deps.inputImageHistory.capture(getEditorText(st.editor), deps.pastedImages)
          st.editor = result.editor
          deps.inputImageHistory.restore(getEditorText(st.editor), deps.pastedImages)
          deps.renderer.requestRender()
        }
        break
      }
      case 'down': {
        const moved = moveDown(st.editor, Math.max(1, deps.renderer.termCols - 2))
        if (moved !== st.editor) {
          st.editor = moved
          deps.renderer.requestRender()
          break
        }
        // At the bottom visual row: navigate history.
        const result = historyNext(st.historyState, st.editor)
        if (result.changed) {
          st.historyState = result.history
          deps.inputImageHistory.capture(getEditorText(st.editor), deps.pastedImages)
          st.editor = result.editor
          deps.inputImageHistory.restore(getEditorText(st.editor), deps.pastedImages)
          deps.renderer.requestRender()
          break
        }
        // Nothing left for ↓ to do here, so it opens the background panel the
        // prompt hint is advertising. Cursor movement and history both had
        // their chance first, so no existing gesture is taken away.
        deps.backgroundTerminals.handlePromptDown(isEditorEmpty(st.editor))
        break
      }
      case 'page-up':
      case 'page-down':
        break
      default:
        break
    }
  }

  return { clearAll, getDisplayText, getExpandedText, getHistoryText, handleNormalKey, mutateEditor, saveInputHistory, toggleExpanded }
}
