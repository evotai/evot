import { wrapTextWithAnsi } from '../../ui/wrap.js'
import { getTheme } from '../../ui/theme/index.js'
import { clipDisplayText } from '../../ui/format.js'
import { CURSOR_MARKER } from '../screen/render-frame.js'
import type { SessionRenameState } from '../app/session/session-rename-editor.js'
import stringWidth from 'string-width'

export function buildSessionRenameLines(state: SessionRenameState, width: number): string[] {
  const theme = getTheme()
  const room = Math.max(1, width - 9)
  const chars = [...state.text]
  let before = chars.slice(0, state.cursor).join('')
  while (stringWidth(before) > room - 1 && before) before = [...before].slice(1).join('')
  const after = clipDisplayText(chars.slice(state.cursor).join(''), Math.max(0, room - stringWidth(before) - 1))
  return [
    theme.accentBold.paint('Rename session'),
    '',
    `  Name  ${theme.text.paint(before)}${state.saving ? '' : CURSOR_MARKER}${theme.text.paint(after)}`,
    '',
    theme.thinkText.paint(state.saving ? 'Saving…' : state.error ?? 'enter save · esc cancel · ctrl+u clear'),
  ].map(text => wrapTextWithAnsi(text, Math.max(1, width))[0] ?? '')
}
