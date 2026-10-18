import { expect, test } from 'bun:test'
import { createEditorState, editorCursorOffset, getEditorText, insertText, replaceAfterCursor } from '../src/term/input/editor.js'

const editor = (text: string, cursorLine: number, cursorCol: number) => ({
  ...insertText(createEditorState(), text), cursorLine, cursorCol,
})

test('suffix replacement preserves all text before the cursor without mutating the saved draft', () => {
  const original = editor('Keep this\nRun the old suite\nOld ending', 1, 8)
  const result = replaceAfterCursor(original, 'new suite\nNew ending')
  expect(getEditorText(result)).toBe('Keep this\nRun the new suite\nNew ending')
  expect(getEditorText(original)).toBe('Keep this\nRun the old suite\nOld ending')
  expect(editorCursorOffset(original)).toBe('Keep this\nRun the '.length)
  expect(result.cursorLine).toBe(2)
  expect(result.cursorCol).toBe('New ending'.length)
})

test('the same operation handles the start, end, partial words and empty suffixes', () => {
  for (const [text, cursor, replacement, expected] of [
    ['old text', 0, 'new text', 'new text'],
    ['Run the', 7, ' tests', 'Run the tests'],
    ['Run the old', 5, 'ests', 'Run tests'],
    ['Run the old', 8, '', 'Run the '],
  ] as const) {
    expect(getEditorText(replaceAfterCursor(editor(text, 0, cursor), replacement))).toBe(expected)
  }
})

test('cursor offsets and suffix replacement snap to grapheme boundaries', () => {
  const state = editor('Cafe\u0301 old text', 0, 4)
  expect(editorCursorOffset(state)).toBe(5)
  expect(getEditorText(replaceAfterCursor(state, ' new text'))).toBe('Cafe\u0301 new text')
  const emoji = editor('Use \u{1f469}\u200d\u{1f4bb} old text', 0, 7)
  const offset = editorCursorOffset(emoji)
  const original = getEditorText(emoji)
  const result = getEditorText(replaceAfterCursor(emoji, ' new text'))
  expect(result).toBe(original.slice(0, offset) + ' new text')
})
