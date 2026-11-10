import { expect, test } from 'bun:test'
import { FileCompletion } from '../../../src/term/app/composer/file-completion-controller.js'
import { createEditorState, insertText, getEditorText } from '../../../src/term/input/editor.js'
import type { FileCompletionResult } from '../../../src/commands/file-completion.js'

const result: FileCompletionResult = { prefix: '@f', prefixStart: 0, items: [{ label: 'file', value: '@file', isDirectory: false }] }

test('single file completion is projected into the current editor', async () => {
  let editor = insertText(createEditorState(), '@f')
  const owner = new FileCompletion(async () => result)
  await owner.refresh(editor, '/fixture', true, () => editor, next => { editor = next })
  expect(getEditorText(editor)).toBe('@file ')
  owner.dispose()
})

test('new requests cancel old searches even when a search ignores abort', async () => {
  const first = Promise.withResolvers<FileCompletionResult | null>()
  let signal: AbortSignal | undefined
  let requests = 0
  let editor = insertText(createEditorState(), '@f')
  const owner = new FileCompletion(async (_text, _cwd, abort) => {
    if (++requests === 1) { signal = abort; return first.promise }
    return result
  })
  let applied = 0
  const apply = (next: typeof editor) => { applied++; editor = next }
  const old = owner.refresh(editor, '/fixture', false, () => editor, apply)
  await owner.refresh(editor, '/fixture', false, () => editor, apply)
  first.resolve(null)
  await old
  expect(signal?.aborted).toBe(true)
  expect(applied).toBe(1)
  expect(editor.completion?.items).toHaveLength(1)
})

test('edited text and disposed owners reject late results', async () => {
  for (const disposed of [false, true]) {
    const pending = Promise.withResolvers<FileCompletionResult | null>()
    let editor = insertText(createEditorState(), '@f')
    let applied = false
    const owner = new FileCompletion(() => pending.promise)
    const work = owner.refresh(editor, '/fixture', true, () => editor, () => { applied = true })
    if (disposed) owner.dispose()
    else editor = insertText(editor, 'new')
    pending.resolve(result)
    await work
    expect(applied).toBe(false)
  }
})

test('failed optional search preserves the draft', async () => {
  const editor = insertText(createEditorState(), '@f')
  const owner = new FileCompletion(async () => { throw new Error('fd failed') })
  let applied = false
  await owner.refresh(editor, '/fixture', true, () => editor, () => { applied = true })
  expect(applied).toBe(false)
  expect(getEditorText(editor)).toBe('@f')
})
