import type { EditorState, HistoryState } from '../../input/editor.js'
import type { PastedImage } from './paste-input.js'

/** Recoverable prompt content is distinct from its compact display label. */
export interface ComposerSnapshot {
  text: string
  cursorLine: number
  cursorCol: number
  preferredVisualCol?: number
  chunks: [number, string][]
  images: [number, PastedImage][]
  undo: EditorState[]
  history: Pick<HistoryState, 'index' | 'savedInput'> & { length: number }
}
