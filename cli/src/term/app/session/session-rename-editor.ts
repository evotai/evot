import type { KeyEvent } from '../../../ui/keys.js'

export type { SelectorRenameState as SessionRenameState } from '../../../ui/selector.js'
import type { SelectorRenameState as SessionRenameState } from '../../../ui/selector.js'
export type RenameEdit =
  | { kind: 'edit'; value: SessionRenameState }
  | { kind: 'cancel' }
  | { kind: 'save'; value: SessionRenameState; title: string }

export function sessionNameError(text: string): string | undefined {
  if (/[\p{Cc}\u2028\u2029]/u.test(text)) return 'Use a single line without control characters'
  const length = [...text.trim()].length
  if (length === 0 || length > 120) return 'Use 1–120 characters'
  return undefined
}

/** Pure Unicode-aware editing; no selector, terminal, persistence, or effects. */
export function editSessionName(value: SessionRenameState, event: KeyEvent): RenameEdit {
  if (value.saving) return { kind: 'edit', value }
  if (event.type === 'escape') return { kind: 'cancel' }
  if (event.type === 'enter') {
    const error = sessionNameError(value.text)
    if (error) return { kind: 'edit', value: { ...value, error } }
    return { kind: 'save', title: value.text.trim(), value: { ...value, saving: true, error: undefined } }
  }
  const chars = [...value.text]
  let cursor = value.cursor
  let inserted: string | undefined
  switch (event.type) {
    case 'char': inserted = event.char; break
    case 'paste': inserted = event.text; break
    case 'left': cursor = Math.max(0, cursor - 1); break
    case 'right': cursor = Math.min(chars.length, cursor + 1); break
    case 'home': cursor = 0; break
    case 'end': cursor = chars.length; break
    case 'backspace': if (cursor > 0) chars.splice(--cursor, 1); break
    case 'delete': chars.splice(cursor, 1); break
    case 'ctrl':
      if (event.key === 'a') cursor = 0
      else if (event.key === 'e') cursor = chars.length
      else if (event.key === 'u') { chars.splice(0, cursor); cursor = 0 }
      else if (event.key === 'k') chars.splice(cursor)
      break
    default: return { kind: 'edit', value }
  }
  if (inserted !== undefined) {
    if (/[\p{Cc}\u2028\u2029]/u.test(inserted) || chars.length + [...inserted].length > 120) {
      return { kind: 'edit', value: { ...value, error: 'Use a single line of at most 120 characters' } }
    }
    chars.splice(cursor, 0, ...inserted)
    cursor += [...inserted].length
  }
  return { kind: 'edit', value: { ...value, text: chars.join(''), cursor, error: undefined } }
}
