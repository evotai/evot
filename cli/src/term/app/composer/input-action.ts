import { completeSlashCommand, fileCompletionTarget } from '../../../commands/completion.js'
import { extractAtPrefix } from '../../../commands/file-completion.js'
import { isSlashCommand, resolveCommand } from '../../../commands/index.js'
import type { SkillEntry } from '../../../commands/skill/scan.js'
import { editorCursorOffset, getEditorText, type EditorState } from '../../input/editor.js'
import { argumentCompletion, type CommandInventory } from './command-arguments.js'
import { suggestionCommand } from './command-usage.js'

export type TabAction =
  | { kind: 'local' }
  | { kind: 'arguments'; completion: NonNullable<ReturnType<typeof argumentCompletion>> }
  | { kind: 'queue' }
  | { kind: 'assist' }
  | { kind: 'none' }

/** Shared by dispatch and the footer. Local namespaces retain Tab even with
 * zero matches: editing a missing path must never submit the whole draft. */
export function tabAction(editor: EditorState, options: {
  busy: boolean; editing: boolean; skills?: readonly SkillEntry[]; inventory?: CommandInventory
}): TabAction {
  if (editor.completion) return { kind: 'local' }
  const line = editor.lines[editor.cursorLine] ?? ''
  const before = line.slice(0, editor.cursorCol)
  const text = getEditorText(editor)
  if (extractAtPrefix(before)) return { kind: 'local' }
  const cursor = editorCursorOffset(editor)
  const argumentsMenu = options.inventory && argumentCompletion(text, cursor, options.inventory)
  if (argumentsMenu) return { kind: 'arguments', completion: argumentsMenu }
  if (fileCompletionTarget(line, editor.cursorCol, options.skills)) return { kind: 'local' }
  if (!options.busy && !options.editing && suggestionCommand(text, cursor)) return { kind: 'assist' }
  if (completeSlashCommand(before.trimStart(), options.skills) && before.trimStart().startsWith('/')) return { kind: 'local' }
  if (options.editing) return { kind: 'none' }
  if (options.busy && text.trim()) {
    if (isSlashCommand(text) && resolveCommand(text, options.skills).kind !== 'skill') return { kind: 'none' }
    return { kind: 'queue' }
  }
  return { kind: 'assist' }
}

export function tabActionHint(action: TabAction): string | undefined {
  switch (action.kind) {
    case 'local': case 'arguments': return 'Tab complete · Enter accept'
    case 'queue': return 'Enter steer · Tab queue · Shift+↑ dequeue · Ctrl+N assist'
    case 'none': return 'Enter run command · commands do not queue'
    case 'assist': return undefined
  }
}
