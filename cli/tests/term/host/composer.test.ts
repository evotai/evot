import { expect, test } from 'bun:test'
import { createComposerController, type ComposerDeps } from '../../../src/term/host/composer.js'
import type { ReplState } from '../../../src/term/host/state.js'
import { createEditorState, createHistoryState, getEditorText, insertText } from '../../../src/term/input/editor.js'
import { PendingQueue, createPendingQueueState } from '../../../src/term/app/queue/pending-queue.js'
import { UndoStack } from '../../../src/term/input/undo-stack.js'
import type { PastedImage } from '../../../src/term/app/composer/paste-input.js'

function harness(text: string) {
  const st = { editor: insertText(createEditorState(), text), historyState: createHistoryState(['old']),
    draftEpoch: 0, draftImageEpoch: 0, pendingEnqueue: null, pendingQueue: createPendingQueueState() } as ReplState
  const chunks = new Map([[2, 'expanded\npaste']])
  const images = new Map<number, PastedImage>([[1, { id: 1, base64: 'fixture', mediaType: 'image/png' }]])
  const undo = new UndoStack<typeof st.editor>()
  undo.push(insertText(createEditorState(), 'prior draft'))
  const deps = { pastedChunks: chunks, pastedImages: images, editorUndo: undo,
    commandWindow: { cancelCommandWindowLoads: () => {}, cancelResumeSearchEnrichment: () => {} },
    pendingQueue: new PendingQueue(st.pendingQueue), queueLifecycle: { dispatchNext: () => {} }, suggestions: { cancel: () => {} }, renderer: { requestRender: () => {} },
  } as unknown as ComposerDeps
  return { st, chunks, images, undo, composer: createComposerController(st, deps) }
}

test('snapshot survives clearAll with exact text, images, paste chunks, cursor, undo and history bookmark', () => {
  const h = harness('look [Image #1] [Pasted text #2 +1 lines]')
  h.st.editor.cursorCol = 3
  h.st.historyState.savedInput = 'saved navigation draft'
  const saved = h.composer.snapshot()
  h.composer.clearAll()
  expect(h.images.size).toBe(0)
  expect(h.chunks.size).toBe(0)
  expect(h.undo.length).toBe(0)
  h.composer.restore(saved)
  expect(getEditorText(h.st.editor)).toBe(saved.text)
  expect(h.st.editor.cursorCol).toBe(3)
  expect(h.images.get(1)?.base64).toBe('fixture')
  expect(h.chunks.get(2)).toBe('expanded\npaste')
  expect(h.undo.pop()?.lines).toEqual(['prior draft'])
  expect(h.st.historyState.savedInput).toBe('saved navigation draft')
})

test('dequeue restoration starts fresh undo/history navigation and preserves later history entries', () => {
  const h = harness('queued text'), saved = h.composer.snapshot()
  h.st.historyState.entries.push('later accepted prompt')
  h.composer.restore(saved, true)
  expect(h.undo.length).toBe(0)
  expect(h.st.historyState.index).toBe(2)
  expect(h.st.historyState.entries).toEqual(['old', 'later accepted prompt'])
  expect(h.st.editor.completion).toBeNull()
  expect(h.st.editor.ghostHint).toBe('')
})

test('restoring an ordinary live draft does not accidentally enter history appended while it was stashed', () => {
  const h = harness('ordinary draft'), saved = h.composer.snapshot()
  h.st.historyState.entries.push('later entry')
  h.composer.restore(saved)
  expect(h.st.historyState.index).toBe(2)
  expect(getEditorText(h.st.editor)).toBe('ordinary draft')
})

test('editing invalidates prepared submission without invalidating unrelated image extraction ownership', () => {
  const h = harness('[Image #1]')
  h.st.pendingEnqueue = { epoch: 0, chain: 1, target: 'session', sequence: 1 }
  h.composer.mutateEditor(state => insertText(state, ' more text'))
  expect(h.st.pendingEnqueue).toBeNull()
  expect(h.st.draftEpoch).toBe(1)
  expect(h.st.draftImageEpoch).toBe(0)
  h.composer.clearAll()
  expect(h.st.draftImageEpoch).toBe(1)
})
