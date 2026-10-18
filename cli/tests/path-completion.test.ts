import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { complete, fileCompletionTarget } from '../src/commands/completion.js'
import { applyCompletion, createEditorState, getEditorText, insertText } from '../src/term/input/editor.js'

test('URLs, ratios and dates are not filesystem completion targets', () => {
  for (const text of ['open https://example.com', 'https://example.com/a?x=1', 'git+ssh://host/repo', 'compare A/B', 'ratio 1/2', 'date 2026/10/18']) {
    expect(fileCompletionTarget(text, text.length), text).toBeNull()
  }
  expect(fileCompletionTarget('read ../evot/xx', 15)?.word).toBe('../evot/xx')
})

test('quoted and escaped paths keep spaces, Unicode and trailing prose', () => {
  const root = mkdtempSync(join(tmpdir(), 'evot-path-'))
  try {
    mkdirSync(join(root, 'my folder'))
    writeFileSync(join(root, 'my folder', 'test.ts'), '')
    mkdirSync(join(root, '\u8d44\u6599'))
    writeFileSync(join(root, '\u8d44\u6599', 'test.ts'), '')
    for (const directory of ['my folder', '\u8d44\u6599']) {
      const partial = `${root}/${directory}/te`
      const input = `read "${partial}" then continue`
      const cursor = input.indexOf('" then') + 1
      const target = fileCompletionTarget(input, cursor)
      expect(target?.word).toBe(partial)
      const editor = { ...insertText(createEditorState(), input), cursorCol: cursor }
      const result = applyCompletion(editor)
      expect(result.applied).toBe(true)
      expect(getEditorText(result.state)).toBe(`read "${root}/${directory}/test.ts" then continue`)
    }
    const input = `read ${root}/my\\ folder/te`
    const result = applyCompletion(insertText(createEditorState(), input))
    expect(getEditorText(result.state)).toBe(`read ${root}/my\\ folder/test.ts`)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('completion at a middle cursor replaces the basename but keeps the path suffix', () => {
  const input = 'read ./tests/unused'
  const cursor = 'read ./te'.length
  const result = applyCompletion({ ...insertText(createEditorState(), input), cursorCol: cursor })
  expect(result.applied).toBe(true)
  expect(getEditorText(result.state)).toBe('read ./tests/unused')
  expect(complete(input, cursor)?.wordEnd).toBe('read ./tests'.length)
})
