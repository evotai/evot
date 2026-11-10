import type { KeyEvent } from '../../ui/keys.js'
import { browseSearchKey } from '../../ui/browse-window.js'
import { handleSplitPaneKey, resetPaneForSelection } from '../../ui/split-pane.js'
import { selectorDown, selectorFocusList, selectorSelect, selectorUp, type SelectorState } from '../../ui/selector.js'

export type ComputeAction =
  | { kind: 'update'; state: SelectorState }
  | { kind: 'close' }
  | { kind: 'create' }
  | { kind: 'edit'; id: string }
  | { kind: 'toggle'; id: string }
  | { kind: 'check'; id: string }
  | { kind: 'delete'; id: string; state: SelectorState }
  | { kind: 'none' }

function id(state: SelectorState): string | undefined {
  return selectorSelect(state)?.id
}

/** Same gestures as the Task list; `r` checks the machine instead of running. */
export function handleComputeKey(state: SelectorState, event: KeyEvent, columns = 80, rows = 24): ComputeAction {
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
  if (event.type !== 'char') return { kind: 'none' }
  if (event.char === 'n') return { kind: 'create' }
  const machineId = id(state)
  if (!machineId) return { kind: 'none' }
  if (event.char === 'e') return { kind: 'edit', id: machineId }
  if (event.char === ' ') return { kind: 'toggle', id: machineId }
  if (event.char === 'r') return { kind: 'check', id: machineId }
  if (event.char !== 'd') return { kind: 'none' }
  if (state.pendingDeleteId === machineId) {
    return { kind: 'delete', id: machineId, state: { ...state, pendingDeleteId: undefined, subtitle: undefined } }
  }
  return {
    kind: 'update',
    state: { ...state, pendingDeleteId: machineId, subtitle: 'Press d again to delete' },
  }
}
