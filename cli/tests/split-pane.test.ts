import { expect, test } from 'bun:test'
import { createResumeWindow } from '../src/term/app/selector-windows.js'
import { handleSelectorControl } from '../src/term/app/selector-control.js'
import { handleTaskKey } from '../src/task/control.js'
import { createAppSelectorState } from '../src/term/app/selector-identity.js'
import { splitPaneHints } from '../src/term/split-pane.js'
import type { SelectorState } from '../src/term/selector.js'

const items = ['first', 'second'].map(id => ({
  id, label: id, preview: ['Title', '', ...Array.from({ length: 60 }, (_, i) => `line ${i}`)],
  hints: [{ keys: 'enter', action: 'open' }, { keys: 'e', action: 'edit' }, { keys: 'd', action: 'delete' }],
}))

for (const feature of ['task', 'resume'] as const) {
  test(`${feature}: shared Tab/arrows/Esc, no destructive actions in detail focus`, () => {
    let state: SelectorState = feature === 'resume' ? createResumeWindow(items, undefined, true) : {
      ...createAppSelectorState('task', 'Tasks', items), noFilter: true,
      previewPane: { offset: 0, confirmDeleteKey: 'd' },
    }
    const handle = feature === 'resume' ? handleSelectorControl : handleTaskKey
    const apply = (event: Parameters<typeof handleTaskKey>[1]) => {
      const action = handle(state, event, 120, 32)
      if (action.kind === 'update') state = action.state
      return action
    }
    apply({ type: 'tab' })
    expect(state.previewPane?.focused).toBe(true)
    expect(state.focusIndex).toBe(0)
    apply({ type: 'down' })
    expect(state.previewPane?.offset).toBe(1)
    expect(state.focusIndex).toBe(0)
    expect(apply({ type: 'ctrl', key: 'd' }).kind).toBe('none')
    expect(apply({ type: 'char', char: 'd' }).kind).toBe('none')
    expect(splitPaneHints(state).map(hint => hint.action)).toEqual(['scroll', 'list', 'back'])
    apply({ type: 'escape' })
    expect(state.previewPane?.focused).toBe(false)
    apply({ type: 'down' })
    expect(state.focusIndex).toBe(1)
    expect(state.previewPane?.offset).toBe(0)
    apply({ type: 'char', char: 'd' })
    expect(splitPaneHints(state).map(hint => hint.action)).toEqual(['confirm delete', 'cancel'])
    apply({ type: 'escape' })
    expect(state.pendingDeleteId).toBeUndefined()
    expect(state.items).toHaveLength(2)
    apply({ type: 'char', char: 'd' })
    const confirmed = apply({ type: 'char', char: 'd' })
    expect(confirmed.kind).toBe(feature === 'task' ? 'delete' : 'delete-session')
    if (confirmed.kind !== 'delete' && confirmed.kind !== 'delete-session') throw new Error('expected delete command')
    expect(confirmed.state.pendingDeleteId).toBeUndefined()
    // Task rows are removed only after a successful HTTP deletion. Session
    // commands supply a local next-state; the harness has not applied it yet.
    expect(confirmed.state.items).toHaveLength(feature === 'task' ? 2 : 1)
    expect(state.items).toHaveLength(2)
  })
}

test('an armed unshare asks for u, not the delete key', () => {
  let state: SelectorState = createResumeWindow([{ ...items[0]!, cloud: true }], undefined, true)
  const action = handleSelectorControl(state, { type: 'char', char: 'u' }, 120, 32)
  if (action.kind !== 'update') throw new Error('expected arm')
  state = action.state
  expect(splitPaneHints(state)).toEqual([
    { keys: 'u', action: 'confirm unshare', confirmationPending: true },
    { keys: 'escape', action: 'cancel' },
  ])
})

test('busy rows suppress action hints without relying on status strings', () => {
  const state = createResumeWindow([{ ...items[0]!, pendingAction: true }], undefined, true)
  expect(splitPaneHints(state).map(hint => hint.action)).toEqual(['select', 'details', 'close'])
})

test('resume uses bare e for rename rather than ctrl-r', () => {
  const state = createResumeWindow(items, undefined, true)
  const renamed = handleSelectorControl(state, { type: 'char', char: 'e' })
  expect(renamed.kind).toBe('update')
  if (renamed.kind !== 'update') throw new Error('expected rename mode')
  expect(renamed.state.rename?.sessionId).toBe('first')
  expect(handleSelectorControl(state, { type: 'ctrl', key: 'r' }).kind).toBe('none')
})

test('search accepts e and d literally; only list focus permits rename and delete', () => {
  let state = createResumeWindow([{ ...items[0]!, label: 'edited' }, items[1]!], undefined, true)
  const apply = (event: Parameters<typeof handleTaskKey>[1]) => {
    const action = handleSelectorControl(state, event)
    if (action.kind === 'update') state = action.state
    return action
  }
  apply({ type: 'char', char: '/' })
  expect(state.listFocused).toBe(false)
  expect(splitPaneHints(state).map(hint => hint.action)).not.toContain('delete')
  for (const char of 'edited') {
    apply({ type: 'char', char })
    expect(state.rename).toBeUndefined()
    expect(state.pendingDeleteId).toBeUndefined()
  }
  expect(state.query).toBe('edited')
  apply({ type: 'down' })
  expect(state.listFocused).toBe(true)
  apply({ type: 'char', char: 'e' })
  expect(state.rename?.sessionId).toBe('first')
})

test('task deletion cannot confirm a different ID after a reorder', () => {
  const state = { ...createAppSelectorState('task', 'Tasks', items), pendingDeleteId: 'first', focusIndex: 1 }
  const result = handleTaskKey(state, { type: 'char', char: 'd' })
  expect(result.kind).toBe('update')
  if (result.kind !== 'update') throw new Error('must arm the new row rather than delete')
  expect(result.state.pendingDeleteId).toBe('second')
})

test('empty list cannot transfer focus into absent details', () => {
  const state = createResumeWindow([], undefined, true)
  expect(handleSelectorControl(state, { type: 'tab' }).kind).toBe('none')
  // No window-level hints: the header must keep its row tally, which window
  // hints would have suppressed.
  expect(state.hints).toBeUndefined()
  expect(state.listFocused).toBe(true)
})
