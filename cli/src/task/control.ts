import type { KeyEvent } from '../term/input.js'
import { browseSearchKey } from '../term/app/browse-window.js'
import { handleSplitPaneKey, resetPaneForSelection } from '../term/split-pane.js'
import { selectorDown, selectorFocusList, selectorSelect, selectorUp, type SelectorState } from '../term/selector.js'

export type TaskAction =
  | { kind: 'update'; state: SelectorState }
  | { kind: 'close' }
  | { kind: 'detail'; id: string }
  | { kind: 'create' }
  | { kind: 'edit'; id: string }
  | { kind: 'toggle'; id: string }
  | { kind: 'run'; id: string }
  | { kind: 'history'; id: string }
  | { kind: 'share'; id: string }
  | { kind: 'delete'; id: string; state: SelectorState }
  | { kind: 'none' }

function id(state: SelectorState): string | undefined {
  return selectorSelect(state)?.id
}

export function handleTaskKey(state: SelectorState, event: KeyEvent, columns = 80, rows = 24): TaskAction {
  const paneAction = handleSplitPaneKey(state, event, columns, rows)
  if (paneAction) return paneAction
  const disarmed = { ...state, pendingDeleteId: undefined,
    subtitle: state.pendingDeleteId ? undefined : state.subtitle }
  const filtered = browseSearchKey(state, event)
  if (filtered) return { kind: 'update', state: resetPaneForSelection(state, filtered) }
  if (event.type === 'up' || (event.type === 'char' && event.char === 'k')) {
    return { kind: 'update', state: resetPaneForSelection(state, selectorUp(selectorFocusList(disarmed))) }
  }
  if (event.type === 'down' || (event.type === 'char' && event.char === 'j')) {
    return { kind: 'update', state: resetPaneForSelection(state, selectorDown(selectorFocusList(disarmed))) }
  }
  if (event.type === 'escape') return { kind: 'close' }
  if (event.type === 'enter') {
    const taskId = id(state)
    return taskId ? { kind: 'detail', id: taskId } : { kind: 'none' }
  }
  if (event.type !== 'char') return { kind: 'none' }
  if (event.char === 'n') return { kind: 'create' }
  const taskId = id(state)
  if (!taskId) return { kind: 'none' }
  if (event.char === 'e') return { kind: 'edit', id: taskId }
  if (event.char === ' ') return { kind: 'toggle', id: taskId }
  if (event.char === 'r') return { kind: 'run', id: taskId }
  if (event.char === 's') return { kind: 'share', id: taskId }
  if (event.char === 'h' || event.char === '\r') return { kind: 'history', id: taskId }
  if (event.char !== 'd') return { kind: 'none' }
  if (state.pendingDeleteId === taskId) {
    return { kind: 'delete', id: taskId, state: { ...state, pendingDeleteId: undefined, subtitle: undefined } }
  }
  return {
    kind: 'update',
    state: { ...state, pendingDeleteId: taskId, subtitle: 'Press d again to delete' },
  }
}
