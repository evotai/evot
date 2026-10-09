import { describe, expect, test } from 'bun:test'
import { handleSelectorControl, RESUME_UNSHARE_CONFIRM } from '../src/term/app/selector-control.js'
import { RESUME_SELECTOR_TITLE } from '../src/term/app/resume.js'
import { SKILL_SELECTOR_TITLE } from '../src/term/app/skill-window.js'
import { createAppSelectorState } from '../src/term/app/selector-identity.js'
import { createSelectorState, selectorExpandItems, selectorType, type SelectorItem } from '../src/term/selector.js'

const char = (value: string) => ({ type: 'char' as const, char: value })
const key = (type: 'up' | 'down' | 'tab' | 'shift-tab' | 'backspace' | 'enter' | 'escape' | 'delete') => ({ type })

describe('repl selector control', () => {
  const items: SelectorItem[] = [
    { label: 'one', id: 'session-one', detail: 'first' },
    { label: 'two', id: 'session-two', detail: 'second' },
  ]

  test('updates focus on down/up', () => {
    let state = createSelectorState('Select model', items)
    const down = handleSelectorControl(state, key('down'))
    expect(down.kind).toBe('update')
    if (down.kind === 'update') {
      expect(down.state.focusIndex).toBe(1)
      state = down.state
    }

    const up = handleSelectorControl(state, key('up'))
    expect(up.kind).toBe('update')
    if (up.kind === 'update') expect(up.state.focusIndex).toBe(0)
  })

  test('tab moves down and shift-tab moves up', () => {
    const state = createSelectorState('Select model', items)
    const next = handleSelectorControl(state, key('tab'))
    expect(next.kind).toBe('update')
    if (next.kind !== 'update') return
    expect(next.state.focusIndex).toBe(1)

    const previous = handleSelectorControl(next.state, key('shift-tab'))
    expect(previous.kind).toBe('update')
    if (previous.kind === 'update') expect(previous.state.focusIndex).toBe(0)
  })

  test('updates query on char and backspace', () => {
    let action = handleSelectorControl(createSelectorState('Select model', items), char('w'))
    expect(action.kind).toBe('update')
    if (action.kind !== 'update') return
    expect(action.state.query).toBe('w')
    expect(action.state.items.map(i => i.label)).toEqual(['two'])

    action = handleSelectorControl(action.state, key('backspace'))
    expect(action.kind).toBe('update')
    if (action.kind === 'update') {
      expect(action.state.query).toBe('')
      expect(action.state.items.length).toBe(2)
    }
  })

  test('escape closes selector', () => {
    expect(handleSelectorControl(createSelectorState('T', items), key('escape')).kind).toBe('close')
  })

  test('first navigation key focuses and moves in every command window', () => {
    for (const [owner, title] of [['model', 'Models'], ['skill', SKILL_SELECTOR_TITLE], ['resume', RESUME_SELECTOR_TITLE]] as const) {
      for (const direction of ['up', 'down', 'tab', 'shift-tab'] as const) {
        const backwards = direction === 'up' || direction === 'shift-tab'
        const state = {
          ...createAppSelectorState(owner, title, items),
          focusIndex: backwards ? 1 : 0,
          listFocused: false,
        }
        const action = handleSelectorControl(state, key(direction))
        expect(action.kind).toBe('update')
        if (action.kind !== 'update') continue
        expect(action.state.listFocused).toBe(true)
        expect(action.state.focusIndex).toBe(backwards ? 0 : 1)
        expect(state.listFocused).toBe(false)
      }
    }
  })

  test('first model arrow wraps and skips provider headers', () => {
    const state = {
      ...createSelectorState('Models', [
        { label: 'Provider A', header: true, focusable: false },
        { label: 'one', id: 'one' },
        { label: 'Provider B', header: true, focusable: false },
        { label: 'two', id: 'two' },
      ]),
      circularNavigation: true,
      listFocused: false,
    }
    for (const direction of ['up', 'down'] as const) {
      const action = handleSelectorControl(state, key(direction))
      expect(action.kind).toBe('update')
      if (action.kind !== 'update') continue
      expect(action.state.listFocused).toBe(true)
      expect(action.state.focusIndex).toBe(3)
      const next = handleSelectorControl(action.state, key(direction))
      expect(next.kind).toBe('update')
      if (next.kind === 'update') expect(next.state.focusIndex).toBe(1)
    }
  })

  test('first arrow at a non-circular boundary still focuses the list', () => {
    const state = { ...createAppSelectorState('resume', RESUME_SELECTOR_TITLE, items), listFocused: false }
    const action = handleSelectorControl(state, key('up'))
    expect(action.kind).toBe('update')
    if (action.kind !== 'update') return
    expect(action.state.listFocused).toBe(true)
    expect(action.state.focusIndex).toBe(0)
  })

  test('navigation after filtering moves immediately and preserves the query', () => {
    const state = selectorType(createSelectorState('Models', items), 'o')
    const action = handleSelectorControl(state, key('down'))
    expect(action.kind).toBe('update')
    if (action.kind !== 'update') return
    expect(action.state.listFocused).toBe(true)
    expect(action.state.focusIndex).toBe(1)
    expect(action.state.query).toBe('o')
  })

  test('first arrow handles an empty preview', () => {
    const state = { ...createSelectorState('Models', []), listFocused: false, circularNavigation: true }
    for (const direction of ['up', 'down'] as const) {
      const action = handleSelectorControl(state, key(direction))
      expect(action.kind).toBe('update')
      if (action.kind !== 'update') continue
      expect(action.state.listFocused).toBe(true)
      expect(action.state.focusIndex).toBe(0)
    }
  })

  test('typing returns resume focus to the filter', () => {
    const state = { ...createAppSelectorState('resume', RESUME_SELECTOR_TITLE, items), listFocused: true }
    const next = handleSelectorControl(state, char('o'))
    expect(next.kind).toBe('update')
    if (next.kind === 'update') {
      expect(next.state.listFocused).toBe(false)
      expect(next.state.query).toBe('o')
    }
  })

  test('resume enter returns selected session id', () => {
    const action = handleSelectorControl(createAppSelectorState('resume', RESUME_SELECTOR_TITLE, items), key('enter'))
    expect(action).toEqual({ kind: 'resume', sessionId: 'session-one' })
  })

  test('model enter returns provider-qualified select-model action', () => {
    const state = createAppSelectorState('model', 'Select model', [{ label: 'claude', id: 'anthropic:claude', detail: 'anthropic' }])
    expect(handleSelectorControl(state, key('enter'))).toEqual({ kind: 'select-model', spec: 'anthropic:claude' })
  })

  test('model space only pins the row as the account default, no switch', () => {
    const state = createAppSelectorState('model', 'Select model', [{ label: 'claude', id: 'anthropic:claude', detail: 'anthropic' }])
    expect(handleSelectorControl(state, { type: 'char', char: ' ' })).toEqual({ kind: 'pin-default-model', spec: 'anthropic:claude' })
    // Space never leaks into the filter: model ids carry no spaces.
    expect(handleSelectorControl(state, { type: 'char', char: ' ' }).kind).not.toBe('update')
  })

  test('space stays a filter character outside the live model picker', () => {
    const task = createAppSelectorState('taskModel', 'Task model', [{ label: 'claude', id: 'anthropic:claude' }])
    const action = handleSelectorControl(task, { type: 'char', char: ' ' })
    expect(action.kind).toBe('update')
    const resume = handleSelectorControl(createAppSelectorState('resume', RESUME_SELECTOR_TITLE, items), { type: 'char', char: ' ' })
    expect(resume.kind).toBe('update')
  })

  test('skill inventory enter is read-only', () => {
    const state = createAppSelectorState('skill', SKILL_SELECTOR_TITLE, [{ label: 'review', id: 'review' }])
    expect(handleSelectorControl(state, key('enter'))).toEqual({ kind: 'none' })
  })

  test('delete requires a second press before removing resume session', () => {
    const state = createAppSelectorState('resume', RESUME_SELECTOR_TITLE, items)
    const first = handleSelectorControl(state, key('delete'))
    expect(first.kind).toBe('update')
    if (first.kind !== 'update') return
    expect(first.state.pendingDeleteId).toBe('session-one')
    expect(first.state.subtitle).toBe('d confirm delete · esc cancel')
    expect(first.state.items.map(i => i.label)).toEqual(['one', 'two'])

    const second = handleSelectorControl(first.state, key('delete'))
    expect(second.kind).toBe('delete-session')
    if (second.kind === 'delete-session') {
      expect(second.sessionId).toBe('session-one')
      expect(second.label).toBe('one')
      expect(second.state.items.map(i => i.label)).toEqual(['two'])
      expect(second.state.pendingDeleteId).toBeUndefined()
      expect(second.state.subtitle).toBeUndefined()
    }
  })

  test('bare d requires a second press before removing resume session', () => {
    const state = { ...createAppSelectorState('resume', RESUME_SELECTOR_TITLE, items), listFocused: true, previewPane: { offset: 0, confirmDeleteKey: 'd' } }
    const first = handleSelectorControl(state, char('d'))
    expect(first.kind).toBe('update')
    if (first.kind !== 'update') return

    const second = handleSelectorControl(first.state, char('d'))
    expect(second.kind).toBe('delete-session')
  })

  test('navigation after arming resume delete cancels the confirmation', () => {
    const state = createAppSelectorState('resume', RESUME_SELECTOR_TITLE, items)
    const armed = handleSelectorControl(state, key('delete'))
    expect(armed.kind).toBe('update')
    if (armed.kind !== 'update') return

    const moved = handleSelectorControl(armed.state, key('down'))
    expect(moved.kind).toBe('update')
    if (moved.kind === 'update') {
      expect(moved.state.pendingDeleteId).toBeUndefined()
      expect(moved.state.subtitle).toBeUndefined()
      expect(moved.state.focusIndex).toBe(1)
    }
  })

  test('async list refresh between presses cannot delete a different session', () => {
    const armed = handleSelectorControl(createAppSelectorState('resume', RESUME_SELECTOR_TITLE, items), key('delete'))
    expect(armed.kind).toBe('update')
    if (armed.kind !== 'update') return
    expect(armed.state.pendingDeleteId).toBe('session-one')

    // listSessionsWithText resolving reorders the pool. Keep the focused
    // session, but drop the armed delete so a confirming keypress cannot fire.
    const reordered = selectorExpandItems(armed.state, [
      { label: 'two', id: 'session-two', detail: 'second' },
      { label: 'one', id: 'session-one', detail: 'first' },
    ])
    expect(reordered.pendingDeleteId).toBeUndefined()
    expect(reordered.items[reordered.focusIndex]?.id).toBe('session-one')

    const next = handleSelectorControl(reordered, key('delete'))
    expect(next.kind).toBe('update')
    if (next.kind === 'update') expect(next.state.pendingDeleteId).toBe('session-one')
  })

  test('u unshares a cloud row after a confirming press and keeps a local row inert', () => {
    const cloudItems: SelectorItem[] = [
      { label: 'one', id: 'session-one', detail: 'first', cloud: true },
      { label: 'two', id: 'session-two', detail: 'second' },
    ]
    const list = { ...createAppSelectorState('resume', RESUME_SELECTOR_TITLE, cloudItems), listFocused: true, sessionScope: 'cloud' as const }
    const armed = handleSelectorControl(list, char('u'))
    expect(armed.kind).toBe('update')
    if (armed.kind !== 'update') return
    expect(armed.state.pendingDeleteId).toBe('session-one')
    expect(armed.state.pendingDeleteKind).toBe('unshare')
    expect(armed.state.subtitle).toBe(RESUME_UNSHARE_CONFIRM)

    // `d` after `u` re-arms as a delete rather than confirming anything.
    const switched = handleSelectorControl(armed.state, char('d'))
    expect(switched.kind).toBe('update')
    if (switched.kind === 'update') expect(switched.state.pendingDeleteKind).toBe('delete')
    // And `u` after `d` likewise.
    if (switched.kind === 'update') expect(handleSelectorControl(switched.state, char('u')).kind).toBe('update')

    const confirmed = handleSelectorControl(armed.state, char('u'))
    expect(confirmed.kind).toBe('unshare-session')
    if (confirmed.kind !== 'unshare-session') return
    expect(confirmed.sessionId).toBe('session-one')
    // The /share list is cloud rows only, so the row leaves it.
    expect(confirmed.state.items.map(item => item.label)).toEqual(['two'])
    expect(confirmed.state.pendingDeleteId).toBeUndefined()
    expect(confirmed.state.subtitle).toBeUndefined()

    // In the sessions list the row stays: it is still a session here.
    const sessions = { ...list, sessionScope: 'all' as const }
    const armedAll = handleSelectorControl(sessions, char('u'))
    if (armedAll.kind !== 'update') throw new Error('expected arm')
    const kept = handleSelectorControl(armedAll.state, char('u'))
    expect(kept.kind).toBe('unshare-session')
    if (kept.kind === 'unshare-session') expect(kept.state.items.map(item => item.label)).toEqual(['one', 'two'])

    // Moving away drops the armed unshare and its subtitle.
    const moved = handleSelectorControl(armed.state, key('down'))
    if (moved.kind === 'update') {
      expect(moved.state.pendingDeleteId).toBeUndefined()
      expect(moved.state.subtitle).toBeUndefined()
    }
    // A local-only row has nothing to unshare.
    expect(handleSelectorControl({ ...list, focusIndex: 1 }, char('u'))).toEqual({ kind: 'none' })
  })

  test('non resume delete is ignored', () => {
    const state = createSelectorState('Select model', items)
    expect(handleSelectorControl(state, key('delete')).kind).toBe('none')
  })

  test('queue selector supports selection, edit, and remove only', () => {
    const state = createAppSelectorState('queue', 'Prompt queue', [{
      label: '1. later',
      id: 'follow_up|q1|3',
      searchText: 'later',
    }])
    expect(handleSelectorControl(state, key('enter'))).toEqual({
      kind: 'queue-edit',
      entry: { queue: 'follow_up', id: 'q1', version: 3, text: 'later' },
    })
    expect(handleSelectorControl(state, key('delete')).kind).toBe('queue-remove')
    expect(handleSelectorControl(state, { type: 'ctrl', key: 'd' }).kind).toBe('queue-remove')
    expect(handleSelectorControl(state, { type: 'shift-char', char: 'j' }).kind).toBe('none')
    expect(handleSelectorControl(state, { type: 'ctrl-enter' }).kind).toBe('none')
  })

  test('queue character keys do not define alternate edit or remove shortcuts', () => {
    const state = createAppSelectorState('queue', 'Prompt queue', [{
      label: '1. queued',
      id: 'steering|q2|0',
      searchText: 'queued',
    }])
    expect(handleSelectorControl(state, char('e')).kind).toBe('none')
    expect(handleSelectorControl(state, char('x')).kind).toBe('none')
  })

  test('other ctrl key is ignored', () => {
    const state = createSelectorState(RESUME_SELECTOR_TITLE, items)
    expect(handleSelectorControl(state, { type: 'ctrl', key: 'c' }).kind).toBe('none')
  })
})
