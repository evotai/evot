import type { KeyEvent } from './input.js'
import type { SelectorState } from './selector.js'
import type { Hint } from './design/key-hints.js'
import { selectorPreviewGeometry, previewScrollLimit } from './preview-scroll.js'
import { SELECTOR_OWNER } from './app/selector-identity.js'

export type PaneAction = { kind: 'update'; state: SelectorState } | { kind: 'none' }

/** Shared focus/scroll ownership. null delegates to the feature's list actions;
 * 'none' consumes a key in the detail pane so it cannot mutate the list. */
export function handleSplitPaneKey(state: SelectorState, event: KeyEvent, columns = 80, rows = 24): PaneAction | null {
  const pane = state.previewPane
  if (!pane) return null
  const selected = state.items[state.focusIndex]
  const disarm = (): SelectorState => state.pendingDeleteId
    ? { ...state, pendingDeleteId: undefined, subtitle: undefined } : state
  if (event.type === 'escape' && state.pendingDeleteId) return { kind: 'update', state: disarm() }
  if (event.type === 'tab' || event.type === 'shift-tab') {
    if (!selected?.preview?.length) return { kind: 'none' }
    return { kind: 'update', state: { ...disarm(), listFocused: true, previewPane: { ...pane, focused: !pane.focused } } }
  }
  if (pane.focused && event.type === 'escape') {
    return { kind: 'update', state: { ...state, listFocused: true, previewPane: { ...pane, focused: false } } }
  }
  const down = event.type === 'down' || (state.noFilter && event.type === 'char' && event.char === 'j')
  const up = event.type === 'up' || (state.noFilter && event.type === 'char' && event.char === 'k')
  if (event.type === 'page-up' || event.type === 'page-down' || (pane.focused && (up || down))) {
    if (!selected?.preview?.length) return { kind: 'none' }
    const geometry = selectorPreviewGeometry(state, columns, rows)
    const max = previewScrollLimit(selected.preview, geometry.width, geometry.height)
    const offset = Math.min(pane.offset, max)
    const delta = event.type === 'page-down' ? geometry.height - 1
      : event.type === 'page-up' ? 1 - geometry.height : down ? 1 : -1
    return { kind: 'update', state: { ...disarm(), previewPane: {
      ...pane, offset: Math.max(0, Math.min(max, offset + delta)),
    } } }
  }
  return pane.focused ? { kind: 'none' } : null
}

/** Reset detail scrolling only when selection/filter changes, not on repaint. */
export function resetPaneForSelection(previous: SelectorState, next: SelectorState): SelectorState {
  if (!next.previewPane || (previous.query === next.query
    && previous.items[previous.focusIndex]?.id === next.items[next.focusIndex]?.id)) return next
  return { ...next, previewPane: { ...next.previewPane, offset: 0, focused: false } }
}

/** Owners whose list can sit under the composer without the keyboard. */
const COMPOSER_PREVIEW_OWNERS = new Set<symbol>([SELECTOR_OWNER.resume, SELECTOR_OWNER.shares, SELECTOR_OWNER.task])

/** Contextual hints: the shell owns navigation, features supply domain actions. */
export function splitPaneHints(state: SelectorState): Hint[] {
  const selected = state.items[state.focusIndex]
  if (state.previewPane?.focused) return [
    { keys: ['up', 'down'], action: 'scroll' },
    { keys: 'tab', action: 'list' },
    { keys: 'escape', action: 'back' },
  ]
  if (selected?.id && state.pendingDeleteId === selected.id && state.previewPane?.confirmDeleteKey) return [
    state.pendingDeleteKind === 'unshare'
      ? { keys: 'u', action: 'confirm unshare', confirmationPending: true }
      : { keys: state.previewPane.confirmDeleteKey, action: 'confirm delete', confirmationPending: true },
    { keys: 'escape', action: 'cancel' },
  ]
  // A list that does not own the keyboard — a command preview under the
  // composer, or a resume/shares list after pressing `/` — offers only the
  // gestures that work there. Letters go to the filter when the list has
  // one, else to the composer. `↑/↓` selects; on a preview it also promotes
  // the window.
  if (state.owner !== undefined && COMPOSER_PREVIEW_OWNERS.has(state.owner) && state.listFocused !== true) return [
    ...(state.noFilter ? [] : [{ keys: 'type', action: 'search' }]),
    { keys: ['up', 'down'], action: 'select' },
    { keys: 'escape', action: state.query ? 'clear search' : 'close' },
  ]
  if (selected?.pendingAction) return [
    { keys: ['up', 'down'], action: 'select' },
    ...(selected.preview?.length ? [{ keys: 'tab', action: 'details' }] : []),
    { keys: 'escape', action: 'close' },
  ]
  return selected?.hints ?? state.hints ?? [{ keys: 'escape', action: 'close' }]
}
