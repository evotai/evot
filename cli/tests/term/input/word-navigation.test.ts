import { describe, expect, test } from 'bun:test'
import {
  createEditorState,
  deleteWordForward,
  getEditorText,
  insertText,
  moveWordLeft,
  moveWordRight,
} from '../../../src/term/input/editor.js'
import { UndoStack } from '../../../src/term/input/undo-stack.js'
import { findWordBackward, findWordForward } from '../../../src/term/input/word-navigation.js'

describe('word navigation', () => {
  test('moves across ASCII words and punctuation', () => {
    const text = 'hello world.foo'
    // From end of "world.foo": stop after the embedded punctuation, then at word start.
    expect(findWordBackward(text, text.length)).toBe('hello world.'.length)
    expect(findWordBackward(text, 'hello world.'.length)).toBe('hello '.length)
    expect(findWordBackward(text, 'hello world'.length)).toBe('hello '.length)
    expect(findWordForward(text, 0)).toBe('hello'.length)
    expect(findWordForward(text, 'hello'.length)).toBe('hello world'.length)
    expect(findWordForward(text, 'hello world'.length)).toBe('hello world.'.length)
  })

  test('treats paste and image refs as atomic units', () => {
    const ref = '[Image #7]'
    const text = `prefix ${ref} tail`
    const endOfRef = `prefix ${ref}`.length
    expect(findWordBackward(text, endOfRef)).toBe('prefix '.length)
    expect(findWordForward(text, 'prefix '.length)).toBe(endOfRef)
  })

  test('editor word moves cross lines at boundaries', () => {
    let state = insertText(createEditorState(), 'one two\nthree')
    state = moveWordLeft(state)
    expect(state.cursorLine).toBe(1)
    expect(state.cursorCol).toBe(0)
    state = moveWordLeft(state)
    expect(state.cursorLine).toBe(0)
    expect(state.cursorCol).toBe('one two'.length)
    state = moveWordLeft(state)
    expect(getEditorText(state).slice(0, state.cursorCol)).toBe('one ')
    state = moveWordRight(state)
    expect(state.cursorCol).toBe('one two'.length)
  })

  test('deleteWordForward removes the next word run', () => {
    let state = insertText(createEditorState(), 'hello world')
    state = { ...state, cursorCol: 'hello'.length }
    state = deleteWordForward(state)
    expect(getEditorText(state)).toBe('hello')
  })
})

describe('UndoStack', () => {
  test('clones on push and restores on pop', () => {
    const stack = new UndoStack<{ value: string }>()
    const first = { value: 'a' }
    stack.push(first)
    first.value = 'mutated'
    expect(stack.pop()).toEqual({ value: 'a' })
    expect(stack.pop()).toBeUndefined()
  })
})
