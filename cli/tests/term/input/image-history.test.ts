import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { InputImageHistory, type InputImage } from '../../../src/term/input/image-history.js'
import { HistoryManager } from '../../../src/session/history.js'
import { createEditorState, insertText, clearEditor, getEditorText, createHistoryState, historyPrev, historyNext } from '../../../src/term/input/editor.js'
import { resolveHistoryText, resolveSubmitText } from '../../../src/term/input/paste_refs.js'

describe('input image history', () => {
  test('recalls image tags and attachments after submit clears the draft', () => {
    const images = new InputImageHistory()
    const draft = new Map<number, InputImage>([[1, { id: 1, base64: 'image-bytes', mediaType: 'image/png' }]])
    let editor = insertText(createEditorState(), 'Review this [Image #1]')
    const text = resolveHistoryText(getEditorText(editor), new Map())
    images.capture(text, draft)
    const history = createHistoryState([text])
    editor = clearEditor(editor)
    draft.clear()
    const recalled = historyPrev(history, editor)
    images.restore(getEditorText(recalled.editor), draft)
    expect(getEditorText(recalled.editor)).toBe('Review this [Image #1]')
    expect(draft.get(1)?.base64).toBe('image-bytes')
    expect(resolveSubmitText(text, new Map(), new Set(draft.keys()))).toBe('Review this')
  })

  test('down restores the current draft without binding it to the recalled image', () => {
    const images = new InputImageHistory()
    const draft = new Map<number, InputImage>([
      [1, { id: 1, base64: 'old', mediaType: 'image/png' }],
      [2, { id: 2, base64: 'draft', mediaType: 'image/png' }],
    ])
    images.capture('[Image #1] [Image #2]', draft)
    const editor = insertText(createEditorState(), 'Draft [Image #2]')
    const recalled = historyPrev(createHistoryState(['Old [Image #1]']), editor)
    images.restore(getEditorText(recalled.editor), draft)
    draft.delete(1)
    const restored = historyNext(recalled.history, recalled.editor)
    images.restore(getEditorText(restored.editor), draft)
    expect(getEditorText(restored.editor)).toBe('Draft [Image #2]')
    expect(draft.get(2)?.base64).toBe('draft')
    images.restore('Old [Image #1]', draft)
    expect(draft.get(1)?.base64).toBe('old')
  })

  test('round trips through plain-text history across restarts with fresh IDs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evot-image-history-'))
    try {
      const path = join(dir, 'sample image.png')
      writeFileSync(path, 'image')
      const historyPath = join(dir, 'evot_history')
      // Historical escaped-text fixture: no attachment metadata or version wrapper.
      writeFileSync(historyPath, 'old prompt\\nsecond line\n')
      const manager = new HistoryManager(historyPath, { explicitPath: true })
      expect(manager.load()).toEqual(['old prompt\nsecond line'])
      const images = new InputImageHistory()
      images.capture('Review [Image #1] and [Image #2]', new Map([
        [1, { id: 1, base64: 'bytes', mediaType: 'image/png', filePath: path }],
        [2, { id: 2, base64: 'bytes', mediaType: 'image/png', filePath: path }],
      ]))
      manager.append(images.serialize('Review [Image #1] and [Image #2]'))
      // The legacy reader still sees ordinary escaped text, never a JSON envelope.
      const legacyLines = readFileSync(historyPath, 'utf8').trimEnd().split('\n')
      expect(legacyLines[1]).toBe(`Review [Image #1 source: ${path}] and [Image #2 source: ${path}]`)
      expect(legacyLines[1]).not.toContain('bytes')
      const restored = new InputImageHistory()
      let nextId = 10
      const entries = manager.load().map(text => restored.deserialize(text, () => nextId++))
      expect(entries).toEqual(['old prompt\nsecond line', 'Review [Image #10] and [Image #11]'])
      const draft = new Map<number, InputImage>()
      restored.restore(entries[1] ?? '', draft)
      expect(draft.get(10)?.filePath).toBe(path)
      expect(draft.get(11)?.filePath).toBe(path)
      expect(nextId).toBe(12)
      rmSync(path)
      restored.restore(entries[1] ?? '', draft)
      expect(draft.size).toBe(0)
      expect(resolveSubmitText(entries[1] ?? '', new Map(), new Set())).toContain('[Image #10]')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('unresolved references reserve IDs and never attach a later paste', () => {
    const images = new InputImageHistory()
    let id = 1
    expect(images.deserialize('[Image #1] [Image #1]', () => id++)).toBe('[Image #1] [Image #1]')
    expect(images.deserialize('[Image #1]', () => id++)).toBe('[Image #2]')
    const draft = new Map<number, InputImage>([[id, { id, base64: 'new', mediaType: 'image/png' }]])
    images.restore('[Image #1]', draft)
    expect(draft.has(1)).toBe(false)
    expect(draft.get(3)?.base64).toBe('new')
  })
})
