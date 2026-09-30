import type { KeyEvent } from '../input.js'
import { selectorBackspace, selectorClearQuery, selectorFocusList, selectorType, type SelectorState } from '../selector.js'

/** Shared shell for task/session browsing, including composer previews. */
export function browseWindow(state: SelectorState, listFocused = false): SelectorState {
  return {
    ...state,
    presentation: 'browser',
    previewPane: { offset: 0, confirmDeleteKey: 'd' },
    listFocused,
    lowercaseHints: true,
  }
}

/** Search has one ownership contract: `/` enters, Esc clears and returns to
 * the list; action letters remain literal while the input owns the keyboard. */
export function browseSearchKey(state: SelectorState, event: KeyEvent): SelectorState | undefined {
  if (state.presentation !== 'browser' || state.noFilter) return undefined
  const disarmed = { ...state, pendingDeleteId: undefined, subtitle: state.pendingDeleteId ? undefined : state.subtitle }
  if (state.listFocused === true && event.type === 'char' && event.char === '/') return { ...disarmed, listFocused: false }
  if (state.listFocused !== false) return undefined
  if (event.type === 'char') return selectorType(disarmed, event.char)
  if (event.type === 'paste') return selectorType(disarmed, event.text.replace(/[\r\n]+/g, ' '))
  if (event.type === 'backspace') return selectorBackspace(disarmed)
  if (event.type === 'escape') return selectorFocusList(selectorClearQuery(disarmed))
  return undefined
}
