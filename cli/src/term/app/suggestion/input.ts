import type { SkillEntry } from '../../../commands/skill/scan.js'
import { editorCursorOffset, getEditorText, type EditorState } from '../../input/editor.js'
import { tabAction } from '../composer/input-action.js'
import type { PromptSuggestion } from './controller.js'
import { suggestionCommand } from '../composer/command-usage.js'
import type { argumentCompletion, CommandInventory } from '../composer/command-arguments.js'

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
  skills?(): readonly SkillEntry[]
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
    const action = tabAction(editor, { busy: false, editing: false, skills: host.skills?.(), inventory: host.inventory?.() })
    if (action.kind === 'local' || action.kind === 'arguments') {
      host.controller.yieldToLocalInput()
      if (action.kind === 'arguments' && event.type === 'tab' && host.eligible() && host.showArguments) {
        host.showArguments(action.completion)
        host.changed()
        return true
      }
      return false
    }
    if (event.type === 'tab' && host.controller.next()) {
      host.changed()
      return true
    }
    if (event.type === 'right' && host.controller.text()) {
      // Right edits the composer; it does not submit. Keep an empty-input
      // batch underneath the inserted draft, just as for hand-typed text.
      host.replace(host.controller.completing() ? host.controller.take() : host.controller.text())
      host.controller.reconcile()
      host.changed()
      return true
    }
    if (event.type !== 'tab' || !host.eligible()) return false
    const text = getEditorText(editor)
    if (text.trimStart().startsWith('/') && !suggestionCommand(text, editorCursorOffset(editor), host.skills?.())) return false
    host.controller.complete(text, editorCursorOffset(editor))
    host.changed()
    return true
  } }
}
