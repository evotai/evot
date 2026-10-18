import { extractAtPrefix } from '../../../commands/file-completion.js'
import { fileCompletionTarget } from '../../../commands/completion.js'
import { editorCursorOffset, getEditorText, type EditorState } from '../../input/editor.js'
import type { PromptSuggestion } from './controller.js'
import { suggestionCommand } from './command.js'
import { argumentCompletion, type CommandInventory } from './arguments.js'

/** Input routing only. Local menus, paths and @ references take precedence
 * over any cached model candidate, even when the path has no matches. */
export function createSuggestionInput(host: {
  controller: PromptSuggestion
  eligible(): boolean
  editor(): EditorState
  replace(text: string): void
  changed(): void
  dismissed?(): void
  inventory?(): CommandInventory
  showArguments?(completion: NonNullable<ReturnType<typeof argumentCompletion>>): void
}): { handle(event: { type: string }): boolean } {
  return { handle(event) {
    if (event.type === 'escape' && !host.editor().completion && host.eligible() && host.controller.dismiss()) {
      host.dismissed?.()
      host.changed()
      return true
    }
    if (event.type !== 'tab' && event.type !== 'right') return false
    const editor = host.editor()
    const currentLine = editor.lines[editor.cursorLine] ?? ''
    const before = currentLine.slice(0, editor.cursorCol)
    if (editor.completion || extractAtPrefix(before)) {
      host.controller.cancel()
      return false
    }
    // Finite command arguments (model/session IDs) own their namespace even
    // when an ID contains a slash and resembles a filesystem path.
    if (event.type === 'tab' && host.eligible() && host.inventory && host.showArguments && editor.cursorLine === 0) {
      const completion = argumentCompletion(getEditorText(editor), editorCursorOffset(editor), host.inventory())
      if (completion) {
        host.controller.cancel()
        host.showArguments(completion)
        host.changed()
        return true
      }
    }
    if (fileCompletionTarget(currentLine, editor.cursorCol)) {
      host.controller.cancel()
      return false
    }
    if (event.type === 'tab' && host.controller.next()) {
      host.changed()
      return true
    }
    if (event.type === 'right' && host.controller.text()) {
      host.replace(host.controller.take())
      host.changed()
      return true
    }
    if (event.type !== 'tab' || !host.eligible()) return false
    const text = getEditorText(editor)
    if (text.trimStart().startsWith('/') && !suggestionCommand(text, editorCursorOffset(editor))) return false
    host.controller.complete(text, editorCursorOffset(editor))
    host.changed()
    return true
  } }
}
