import { describe, expect, test } from 'bun:test'
import {
  acceptCompletion,
  applyCompletion,
  backspace,
  clearEditor,
  closeCompletion,
  createEditorState,
  createHistoryState,
  getEditorText,
  historyNext,
  historyPrev,
  insertContinuationNewline,
  insertText,
  isEditorEmpty,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  moveCompletion,
  pushHistory,
  refreshGhostHint,
  showCompletions,
  editorNeedsContinuation,
} from '../../../src/term/input/editor.js'

describe('term input editor', () => {
  test('insertText inserts chars and newlines', () => {
    let state = createEditorState()
    state = insertText(state, 'hello')
    expect(getEditorText(state)).toBe('hello')
    state = insertText(state, '\nworld')
    expect(state.lines).toEqual(['hello', 'world'])
    expect(state.cursorLine).toBe(1)
    expect(state.cursorCol).toBe(5)
  })

  test('backslash before the cursor requests continuation', () => {
    const state = insertText(createEditorState(), 'before\\after')
    const atBackslash = { ...state, cursorCol: 7 }
    expect(editorNeedsContinuation(atBackslash)).toBe(true)
  })

  test('continuation newline consumes the backslash gesture', () => {
    const state = insertText(createEditorState(), 'before\\after')
    const continued = insertContinuationNewline({ ...state, cursorCol: 7 })
    expect(continued.lines).toEqual(['before', 'after'])
    expect(continued.cursorLine).toBe(1)
    expect(continued.cursorCol).toBe(0)
  })

  test('continuation newline acts as a plain newline without a backslash', () => {
    const state = insertText(createEditorState(), 'beforeafter')
    const continued = insertContinuationNewline({ ...state, cursorCol: 6 })
    expect(continued.lines).toEqual(['before', 'after'])
  })

  test('backspace joins lines', () => {
    let state = createEditorState()
    state = insertText(state, 'a\nb')
    state = moveHome(state)
    state = backspace(state)
    expect(state.lines).toEqual(['ab'])
    expect(state.cursorLine).toBe(0)
    expect(state.cursorCol).toBe(1)
  })

  test('move left/right across lines', () => {
    let state = createEditorState()
    state = insertText(state, 'a\nb')
    state = moveLeft(state)
    expect(state.cursorLine).toBe(1)
    expect(state.cursorCol).toBe(0)
    state = moveLeft(state)
    expect(state.cursorLine).toBe(0)
    expect(state.cursorCol).toBe(1)
    state = moveRight(state)
    expect(state.cursorLine).toBe(1)
    expect(state.cursorCol).toBe(0)
  })

  test('clearEditor resets to empty', () => {
    let state = createEditorState()
    state = insertText(state, 'abc')
    state = clearEditor(state)
    expect(isEditorEmpty(state)).toBe(true)
  })

  test('completes a unique command immediately', () => {
    const result = applyCompletion(insertText(createEditorState(), '/he'))
    expect(result.applied).toBe(true)
    expect(getEditorText(result.state)).toBe('/help ')
    expect(result.state.completion).toBeNull()
  })

  test('opens, navigates, accepts and closes a completion menu', () => {
    const items = [
      { label: '/help', value: '/help ', description: 'Show help' },
      { label: '/harden', value: '/harden ', description: 'Harden changes' },
    ]
    let state = insertText(createEditorState(), '/h')
    state = showCompletions(state, items, 0, 2)
    expect(state.completion?.selectedIndex).toBe(0)

    state = moveCompletion(state, 1)
    expect(state.completion?.selectedIndex).toBe(1)
    state = acceptCompletion(state)
    expect(getEditorText(state)).toBe('/harden ')
    expect(state.completion).toBeNull()

    state = showCompletions(state, items, 0, state.cursorCol)
    expect(closeCompletion(state).completion).toBeNull()
  })

  test('stores an advisory note with the completion menu', () => {
    const note = 'files up to 6 levels deep — install fd to search deeper'
    const state = showCompletions(
      insertText(createEditorState(), '@src'),
      [{ label: 'src/', value: '@src/' }],
      0,
      4,
      note,
    )
    expect(state.completion?.note).toBe(note)
  })

  test('keeps a note-only completion open for an empty result', () => {
    const note = 'no matches · files up to 6 levels deep'
    const state = showCompletions(
      insertText(createEditorState(), '@deep'),
      [],
      0,
      5,
      note,
    )
    expect(state.completion?.items).toEqual([])
    expect(state.completion?.note).toBe(note)
    // Empty menus are safe for the same navigation functions as normal menus.
    expect(moveCompletion(state, 1)).toBe(state)
    expect(acceptCompletion(state)).toBe(state)
  })

  test('closes an empty completion when there is no advisory note', () => {
    const state = showCompletions(
      insertText(createEditorState(), '@deep'),
      [],
      0,
      5,
    )
    expect(state.completion).toBeNull()
  })

  test('omits an empty advisory note', () => {
    const state = showCompletions(
      insertText(createEditorState(), '/h'),
      [{ label: '/help', value: '/help ' }],
      0,
      2,
    )
    expect(state.completion).not.toHaveProperty('note')
  })

  test('editing clears an open completion menu', () => {
    const state = showCompletions(
      insertText(createEditorState(), '/h'),
      [{ label: '/help', value: '/help ' }],
      0,
      2,
    )
    expect(insertText(state, 'e').completion).toBeNull()
  })

  test('refreshGhostHint does not crash', () => {
    let state = createEditorState()
    state = insertText(state, '/he')
    state = refreshGhostHint(state)
    expect(typeof state.ghostHint).toBe('string')
  })

  test('history submission deduplicates consecutive entries and resets navigation', () => {
    const history = createHistoryState(['one', 'two'])
    const recalled = historyPrev(history, createEditorState())
    const submitted = pushHistory(recalled.history, '  two  ')
    expect(submitted.entries).toEqual(['one', 'two'])
    expect(submitted.index).toBe(2)
    expect(submitted.savedInput).toBe('')
    expect(pushHistory(submitted, ' ').entries).toEqual(['one', 'two'])
    expect(pushHistory(submitted, 'one').entries).toEqual(['one', 'two', 'one'])
    const latest = historyPrev(submitted, createEditorState())
    expect(getEditorText(latest.editor)).toBe('two')
    expect(getEditorText(historyPrev(latest.history, latest.editor).editor)).toBe('one')
  })

  test('history prev/next restore input', () => {
    let editor = createEditorState()
    let history = createHistoryState([])
    history = pushHistory(history, 'one')
    history = pushHistory(history, 'two')
    editor = insertText(editor, 'draft')

    let prev = historyPrev(history, editor)
    expect(prev.changed).toBe(true)
    expect(getEditorText(prev.editor)).toBe('two')

    prev = historyPrev(prev.history, prev.editor)
    expect(getEditorText(prev.editor)).toBe('one')

    let next = historyNext(prev.history, prev.editor)
    expect(getEditorText(next.editor)).toBe('two')

    next = historyNext(next.history, next.editor)
    expect(getEditorText(next.editor)).toBe('draft')
  })

  test('history prev/next handles multi-line entries', () => {
    let editor = createEditorState()
    let history = createHistoryState([])
    history = pushHistory(history, 'single line')
    history = pushHistory(history, 'line one\nline two\nline three')
    editor = insertText(editor, 'current')

    // Navigate to multi-line entry
    let prev = historyPrev(history, editor)
    expect(prev.changed).toBe(true)
    expect(prev.editor.lines).toEqual(['line one', 'line two', 'line three'])
    expect(prev.editor.cursorLine).toBe(2)
    expect(prev.editor.cursorCol).toBe(10)

    // Navigate further to single-line entry
    prev = historyPrev(prev.history, prev.editor)
    expect(prev.editor.lines).toEqual(['single line'])
    expect(prev.editor.cursorLine).toBe(0)

    // Navigate forward back to multi-line
    let next = historyNext(prev.history, prev.editor)
    expect(next.editor.lines).toEqual(['line one', 'line two', 'line three'])

    // Navigate forward to saved input
    next = historyNext(next.history, next.editor)
    expect(getEditorText(next.editor)).toBe('current')
  })

  test('move home/end update cursor', () => {
    let state = createEditorState()
    state = insertText(state, 'hello')
    state = moveHome(state)
    expect(state.cursorCol).toBe(0)
    state = moveEnd(state)
    expect(state.cursorCol).toBe(5)
  })
})
