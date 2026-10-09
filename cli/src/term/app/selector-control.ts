import { editSessionName } from './session-rename-editor.js'
import type { KeyEvent } from '../input.js'
import { browseSearchKey } from './browse-window.js'
import { handleSplitPaneKey, resetPaneForSelection } from '../split-pane.js'
import {
  selectorAdjustEffort,
  selectorBackspace,
  selectorDown,
  selectorEffortLevel,
  selectorFocusList,
  selectorRemoveItem,
  selectorSelect,
  selectorType,
  selectorUp,
  type SelectorState,
} from '../selector.js'
import { decideQueueSelectorAction, type ManagedQueuedPrompt } from './queue-manage.js'
import { toggleSkillGroup } from './skill-window.js'
import { SELECTOR_OWNER } from './selector-identity.js'

export type SelectorControlAction =
  | { kind: 'update'; state: SelectorState }
  | { kind: 'close' }
  | { kind: 'resume'; sessionId: string }
  | { kind: 'open-share'; shareId: string }
  | { kind: 'delete-share'; shareId: string; state: SelectorState }
  /** `thinkingLevel` is present only when the row carried an effort ladder, so
   *  a model with no selectable reasoning never names a tier. */
  | { kind: 'select-model'; spec: string; thinkingLevel?: string }
  /** Space on the live model picker: save the highlighted row as the account
   *  default for future sessions. The live model and the open picker stay. */
  | { kind: 'pin-default-model'; spec: string }
  | { kind: 'select-task-model'; spec: string; thinkingLevel?: string }
  | { kind: 'delete-session'; sessionId: string; label: string; state: SelectorState }
  /** `u u` on a cloud row: the server copy goes, the local transcript stays. */
  | { kind: 'unshare-session'; sessionId: string; label: string; state: SelectorState }
  | { kind: 'queue-edit'; entry: ManagedQueuedPrompt }
  | { kind: 'queue-remove'; entry: ManagedQueuedPrompt; state: SelectorState }
  | { kind: 'rename-session'; sessionId: string; title: string; state: SelectorState }
  | { kind: 'none' }

const RESUME_DELETE_CONFIRM = 'd confirm delete · esc cancel'
/** A cloud session is one logical thing: deleting it here removes both copies. */
const RESUME_DELETE_CLOUD_CONFIRM = 'd confirm delete here and from cloud · esc cancel'
/** Unsharing is the lighter action: the page and the cloud copy go, this machine keeps the session. */
export const RESUME_UNSHARE_CONFIRM = 'u confirm remove from cloud · local copy kept · esc cancel'
const CONFIRM_SUBTITLES = new Set([RESUME_DELETE_CONFIRM, RESUME_DELETE_CLOUD_CONFIRM, RESUME_UNSHARE_CONFIRM])

/** Drop an armed delete so a stray confirming keypress cannot delete a session. */
function disarmDelete(state: SelectorState): SelectorState {
  if (state.pendingDeleteId === undefined) return state
  const subtitle = state.subtitle !== undefined && CONFIRM_SUBTITLES.has(state.subtitle) ? undefined : state.subtitle
  return { ...state, pendingDeleteId: undefined, pendingDeleteKind: undefined, subtitle }
}

export function handleSelectorControl(state: SelectorState, event: KeyEvent, columns = 80, rows = 24): SelectorControlAction {
  const action = handleControl(state, event, columns, rows)
  return action.kind === 'update' ? { ...action, state: resetPaneForSelection(state, action.state) } : action
}

function handleControl(state: SelectorState, event: KeyEvent, columns: number, rows: number): SelectorControlAction {
  if (state.owner === SELECTOR_OWNER.resume && state.rename) {
    const edit = editSessionName(state.rename, event)
    if (edit.kind === 'cancel') return { kind: 'update', state: { ...state, rename: undefined } }
    const next = { ...state, rename: edit.value }
    return edit.kind === 'save'
      ? { kind: 'rename-session', sessionId: edit.value.sessionId, title: edit.title, state: next }
      : { kind: 'update', state: next }
  }
  const paneAction = handleSplitPaneKey(state, event, columns, rows)
  if (paneAction) return paneAction
  const filtered = browseSearchKey(state, event)
  if (filtered) return { kind: 'update', state: filtered }
  // Sessions and shared links are the same kind of list: letters are actions
  // while the list owns the input (`d d` deletes, `/` opens the filter), and
  // typing filters once the filter owns it. Only sessions can be renamed.
  const letterList = (state.owner === SELECTOR_OWNER.resume || state.owner === SELECTOR_OWNER.shares)
    && state.listFocused === true
  const resumeListFocused = letterList && state.owner === SELECTOR_OWNER.resume
  if (letterList && event.type === 'char' && event.char === '/') {
    return { kind: 'update', state: { ...disarmDelete(state), listFocused: false } }
  }
  if (resumeListFocused && event.type === 'char' && event.char === 'u') return unshareAction(state)
  if (resumeListFocused && event.type === 'char' && event.char === 'e') {
    const item = selectorSelect(state)
    if (!item?.id || item.header || item.focusable === false) return { kind: 'none' }
    const text = item.renameTitle ?? ''
    return { kind: 'update', state: { ...disarmDelete(state), rename: { sessionId: item.id, text, cursor: [...text].length } } }
  }
  switch (event.type) {
    case 'up':
    case 'shift-tab': {
      // Focus transfer and movement are one gesture: never consume the first
      // navigation key just to blur the composer/filter.
      return { kind: 'update', state: selectorUp(selectorFocusList(disarmDelete(state))) }
    }
    case 'down':
    case 'tab': {
      return { kind: 'update', state: selectorDown(selectorFocusList(disarmDelete(state))) }
    }
    case 'left':
    case 'right': {
      // Only a row carrying a ladder claims ←/→. Checked before anything else
      // mutates, so on every other selector these keys stay exactly as
      // unhandled as they were before the effort column existed.
      if (selectorEffortLevel(state.items[state.focusIndex]) === undefined) return { kind: 'none' }
      const next = selectorAdjustEffort(disarmDelete(state), event.type === 'left' ? -1 : 1)
      return next === state ? { kind: 'none' } : { kind: 'update', state: next }
    }
    case 'char':
      if (letterList && event.char === 'd') return deleteAction(state)
      // Model ids never contain a space, so the filter loses nothing by giving
      // the key to "set default". Task pickers keep their own default notion.
      if (state.owner === SELECTOR_OWNER.model && event.char === ' ') {
        const action = selectAction(disarmDelete(state))
        return action.kind === 'select-model' ? { kind: 'pin-default-model', spec: action.spec } : action
      }
      // Lists that reserve bare letters for their own gestures never build a
      // filter query: doing so would silently drop rows with no filter line on
      // screen to explain why.
      if (state.noFilter || state.owner === SELECTOR_OWNER.queue) return { kind: 'none' }
      return { kind: 'update', state: selectorType(disarmDelete(state), event.char) }
    case 'paste':
      if ((state.owner !== SELECTOR_OWNER.resume && state.owner !== SELECTOR_OWNER.shares) || state.noFilter) return { kind: 'none' }
      return { kind: 'update', state: selectorType(disarmDelete(state), event.text.replace(/[\r\n]+/g, ' ')) }
    case 'backspace':
      if (state.noFilter) return { kind: 'none' }
      return { kind: 'update', state: selectorBackspace(disarmDelete(state)) }
    case 'enter':
      return selectAction(disarmDelete(state))
    case 'escape':
      return { kind: 'close' }
    case 'delete':
      return deleteAction(state)
    case 'ctrl':
      return event.key === 'd' ? deleteAction(state) : { kind: 'none' }
    default:
      return { kind: 'none' }
  }
}

function selectAction(state: SelectorState): SelectorControlAction {
  if (state.owner === SELECTOR_OWNER.skill) {
    const next = toggleSkillGroup(state)
    return next ? { kind: 'update', state: next } : { kind: 'none' }
  }
  // Only explicitly owned actionable lists can dispatch business operations.
  // Skill/background/unknown lists must never fall through to model selection.
  if (state.owner !== SELECTOR_OWNER.model
    && state.owner !== SELECTOR_OWNER.taskModel
    && state.owner !== SELECTOR_OWNER.resume
    && state.owner !== SELECTOR_OWNER.shares
    && state.owner !== SELECTOR_OWNER.queue) return { kind: 'none' }

  const selected = selectorSelect(state)
  if (!selected) return { kind: 'close' }

  if (state.owner === SELECTOR_OWNER.resume) return { kind: 'resume', sessionId: selected.id ?? selected.label }
  if (state.owner === SELECTOR_OWNER.shares) return { kind: 'open-share', shareId: selected.id ?? '' }

  if (state.owner === SELECTOR_OWNER.queue) {
    const action = decideQueueSelectorAction(selected, 'enter')
    if (action.kind === 'edit') return { kind: 'queue-edit', entry: action.entry }
    return { kind: 'none' }
  }

  const level = selectorEffortLevel(selected)
  return {
    kind: state.owner === SELECTOR_OWNER.taskModel ? 'select-task-model' : 'select-model',
    spec: selected.id ?? selected.label,
    ...(level !== undefined ? { thinkingLevel: level } : {}),
  }
}

function deleteAction(state: SelectorState): SelectorControlAction {
  const target = selectorSelect(state)
  if (!target?.id) return { kind: 'none' }

  if (state.owner === SELECTOR_OWNER.queue) {
    const action = decideQueueSelectorAction(target, 'delete')
    if (action.kind !== 'remove') return { kind: 'none' }
    return {
      kind: 'queue-remove',
      entry: action.entry,
      state: selectorRemoveItem(state, state.focusIndex),
    }
  }

  if (state.owner !== SELECTOR_OWNER.resume && state.owner !== SELECTOR_OWNER.shares) return { kind: 'none' }

  // Deleting a session is irreversible, so the first press only arms it and a
  // second press confirms. The armed id must still be the focused row: an async
  // list refresh (listSessionsWithText) can reorder rows between the two
  // presses, and matching on index alone would delete the wrong session.
  if (state.pendingDeleteId === target.id && (state.pendingDeleteKind ?? 'delete') === 'delete') {
    if (state.owner === SELECTOR_OWNER.shares) {
      return { kind: 'delete-share', shareId: target.id, state: { ...state, pendingDeleteId: undefined, subtitle: undefined } }
    }
    return {
      kind: 'delete-session',
      sessionId: target.id,
      label: target.label,
      state: selectorRemoveItem({ ...state, subtitle: undefined }, state.focusIndex),
    }
  }

  return {
    kind: 'update',
    state: {
      ...state,
      listFocused: true,
      pendingDeleteId: target.id,
      pendingDeleteKind: 'delete',
      subtitle: target.cloud ? RESUME_DELETE_CLOUD_CONFIRM : RESUME_DELETE_CONFIRM,
    },
  }
}

/**
 * `u` on a cloud session row. Armed and confirmed like delete: a public or
 * team page stops working the moment the copy is gone. Only rows the list
 * marked as cloud respond, so the key is inert on a local-only session.
 */
function unshareAction(state: SelectorState): SelectorControlAction {
  const target = selectorSelect(state)
  if (!target?.id || !target.cloud) return { kind: 'none' }

  if (state.pendingDeleteId === target.id && state.pendingDeleteKind === 'unshare') {
    const cleared: SelectorState = { ...state, pendingDeleteId: undefined, pendingDeleteKind: undefined, subtitle: undefined }
    return {
      kind: 'unshare-session',
      sessionId: target.id,
      label: target.label,
      // The /share list holds cloud rows only, so the row leaves it; the
      // sessions list keeps it, now as a local row.
      state: state.sessionScope === 'cloud' ? selectorRemoveItem(cleared, state.focusIndex) : cleared,
    }
  }

  return {
    kind: 'update',
    state: { ...state, listFocused: true, pendingDeleteId: target.id, pendingDeleteKind: 'unshare', subtitle: RESUME_UNSHARE_CONFIRM },
  }
}
