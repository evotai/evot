import { expect, test } from 'bun:test'
import { PromptSuggestion, createSuggestionInput, type SuggestionHints } from '../src/term/app/suggestion.js'
import { createEditorState, editorCursorOffset, getEditorText, insertText, replaceAfterCursor } from '../src/term/input/editor.js'
import type { SuggestionOutcome } from '../src/native/contracts/ports.js'
import type { UIMessage } from '../src/term/app/types.js'
import { context } from './helpers/suggestion-context.js'
import { parsePasteRefs } from '../src/term/input/paste_refs.js'
import { PendingImages } from '../src/term/app/pending-images.js'

const tick = () => new Promise<void>(resolve => queueMicrotask(resolve))

function harness(text: string, history: UIMessage[] = []) {
  let editor = insertText(createEditorState(), text)
  let eligible = true
  let dismissed = 0
  const requests: { hints?: SuggestionHints; resolve(outcome: SuggestionOutcome): void; aborted: boolean }[] = []
  const controller = new PromptSuggestion({
    key: () => 'session', eligible: () => eligible, context: () => context(history), draft: () => getEditorText(editor), cursor: () => editorCursorOffset(editor), changed: () => {},
    start: (_messages, hints) => {
      let resolve!: (outcome: SuggestionOutcome) => void
      const promise = new Promise<SuggestionOutcome>(yes => { resolve = yes })
      const request = { hints, resolve, aborted: false }
      requests.push(request)
      return { outcome: () => promise, result: async () => null, abort: () => { request.aborted = true } }
    },
  })
  const input = createSuggestionInput({
    controller, eligible: () => eligible, editor: () => editor,
    replace: text => { editor = replaceAfterCursor(editor, text) }, changed: () => {}, dismissed: () => { dismissed++ },
  })
  return { input, controller, requests, text: () => getEditorText(editor), dismissed: () => dismissed,
    setEligible: (value: boolean) => { eligible = value }, setEditor: (value: typeof editor) => { editor = value } }
}

test('interrupted turn ending in a user message still accepts Tab and cycles three cached completions', async () => {
  const h = harness('Commit', [{ id: 'u', role: 'user', text: 'Commit', timestamp: 0 }])
  expect(h.input.handle({ type: 'tab' })).toBe(true)
  expect(h.controller.pending()).toBe(true)
  expect(h.requests[0]!.hints).toMatchObject({ explicit: true, draft: 'Commit', suffix: '' })
  h.requests[0]!.resolve({ candidates: [' current changes', ' after reviewing the diff', ' and push the branch'], status: 'ready' })
  await tick()
  for (let i = 0; i < 13; i++) {
    expect(h.input.handle({ type: 'tab' })).toBe(true)
    expect(h.controller.pending()).toBe(false)
  }
  expect(h.requests).toHaveLength(1)
  expect(h.controller.position()).toEqual({ current: 2, total: 3 })
  expect(h.input.handle({ type: 'right' })).toBe(true)
  expect(h.text()).toBe('Commit after reviewing the diff')
  expect(h.requests).toHaveLength(1)
  expect(h.input.handle({ type: 'right' })).toBe(false)
})

test('empty composer and draft-only new sessions start explicit requests and never silently ignore Tab', async () => {
  for (const draft of ['', 'who']) {
    const h = harness(draft)
    expect(h.input.handle({ type: 'tab' })).toBe(true)
    expect(h.controller.pending()).toBe(true)
    for (let i = 0; i < 5; i++) expect(h.input.handle({ type: 'tab' })).toBe(true)
    expect(h.requests).toHaveLength(1)
    h.requests[0]!.resolve({ candidates: [], status: 'empty' })
    await tick()
    expect(h.controller.feedback()).toBe('none')
    expect(h.input.handle({ type: 'tab' })).toBe(true)
    expect(h.requests).toHaveLength(2)
    expect(h.controller.pending()).toBe(true)
    h.controller.cancel()
  }
})

test('slash and @ completion, unavailable input and ordinary cursor keys retain their routing', () => {
  for (const draft of ['/lo', '/new', '@src', 'read @src']) {
    const h = harness(draft)
    expect(h.input.handle({ type: 'tab' })).toBe(false)
    expect(h.requests).toHaveLength(0)
  }
  const h = harness('draft')
  h.setEligible(false)
  expect(h.input.handle({ type: 'tab' })).toBe(false)
  h.setEligible(true)
  expect(h.input.handle({ type: 'left' })).toBe(false)
  h.setEditor({ ...insertText(createEditorState(), 'draft'), cursorCol: 2 })
  expect(h.input.handle({ type: 'tab' })).toBe(true)
  expect(h.requests).toHaveLength(1)
  expect(h.requests[0]!.hints).toMatchObject({ explicit: true, draft: 'dr', suffix: 'aft' })
})

test('Esc dismisses a preview or explicit wait without modifying the draft or falling through', async () => {
  for (const resolved of [false, true]) {
    const h = harness('Run the old suite')
    h.setEditor({ ...insertText(createEditorState(), h.text()), cursorCol: 8 })
    h.input.handle({ type: 'tab' })
    if (resolved) {
      h.requests[0]!.resolve({ candidates: ['new suite'], status: 'ready' })
      await tick()
    }
    expect(h.input.handle({ type: 'escape' })).toBe(true)
    expect(h.text()).toBe('Run the old suite')
    expect(h.controller.text()).toBe('')
    expect(h.controller.pending()).toBe(false)
    expect(h.dismissed()).toBe(1)
    expect(h.input.handle({ type: 'escape' })).toBe(false)
  }
})

test('Esc does not steal local completion menus or invisible automatic work', () => {
  const h = harness('')
  const history: UIMessage[] = [
    { id: 'u', role: 'user', text: 'Fix the test', timestamp: 0 },
    { id: 'a', role: 'assistant', text: 'Done', timestamp: 0 },
  ]
  h.controller.start()
  expect(h.input.handle({ type: 'escape' })).toBe(false)
  expect(h.dismissed()).toBe(0)
  h.controller.cancel()
})

test('paths keep local Tab priority even when there are no filesystem matches', () => {
  for (const text of ['../evot/xx', './missing-path/file', '~/projects/missing', '/tmp/missing/file', 'read ../evot/xx', '/loop inspect ../evot/xx']) {
    const h = harness(text)
    for (let i = 0; i < 3; i++) expect(h.input.handle({ type: 'tab' })).toBe(false)
    expect(h.requests).toHaveLength(0)
    expect(h.text()).toBe(text)
  }
  const h = harness('read ../evot/xx then explain')
  h.setEditor({ ...insertText(createEditorState(), h.text()), cursorCol: 'read ../evot/xx'.length })
  expect(h.input.handle({ type: 'tab' })).toBe(false)
  expect(h.requests).toHaveLength(0)
})

test('local path completion preempts cached and in-flight model suggestions', async () => {
  for (const resolved of [false, true]) {
    const h = harness('read ../evot/xx')
    // Simulate a request started before the input router handed ownership over.
    h.controller.complete(h.text())
    if (resolved) {
      h.requests[0]!.resolve({ candidates: [' and explain it'], status: 'ready' })
      await tick()
      expect(h.controller.text()).toBe(' and explain it')
    }
    expect(h.input.handle({ type: 'tab' })).toBe(false)
    expect(h.controller.pending()).toBe(false)
    expect(h.controller.text()).toBe('')
    if (!resolved) expect(h.requests[0]!.aborted).toBe(true)
    expect(h.requests).toHaveLength(1)
  }
})

test('finishing a path with whitespace returns Tab to intent assistance', () => {
  const h = harness('read ../evot/xx ')
  expect(h.input.handle({ type: 'tab' })).toBe(true)
  expect(h.requests).toHaveLength(1)
})

test('middle-caret suggestions replace the saved suffix, cycle locally, and leave the prefix untouched', async () => {
  const h = harness('Run the old suite')
  h.setEditor({ ...insertText(createEditorState(), 'Run the old suite'), cursorCol: 'Run the '.length })
  expect(h.input.handle({ type: 'tab' })).toBe(true)
  expect(h.requests[0]!.hints).toMatchObject({ explicit: true, draft: 'Run the ', suffix: 'old suite' })
  h.requests[0]!.resolve({ candidates: ['unit tests', 'integration tests', 'smoke tests'], status: 'ready' })
  await tick()
  expect(h.controller.replacing()).toBe(true)
  expect(h.text()).toBe('Run the old suite')
  for (let i = 0; i < 4; i++) expect(h.input.handle({ type: 'tab' })).toBe(true)
  expect(h.requests).toHaveLength(1)
  h.input.handle({ type: 'right' })
  expect(h.text()).toBe('Run the integration tests')
})

test('cursor changes discard stale replacements even when the draft text is unchanged', async () => {
  const h = harness('Run the old suite')
  h.setEditor({ ...insertText(createEditorState(), 'Run the old suite'), cursorCol: 8 })
  h.input.handle({ type: 'tab' })
  h.setEditor({ ...insertText(createEditorState(), 'Run the old suite'), cursorCol: 4 })
  h.requests[0]!.resolve({ candidates: ['unit tests'], status: 'ready' })
  await tick()
  expect(h.controller.text()).toBe('')
  h.input.handle({ type: 'tab' })
  expect(h.requests[1]!.hints).toMatchObject({ explicit: true, draft: 'Run ', suffix: 'the old suite' })
})

test('rewrites at the start or on a previous line replace all text through the end', async () => {
  for (const [draft, row, col, prefix, suffix] of [
    ['Old text', 0, 0, '', 'Old text'],
    ['Keep this\nRun old tests\nRemove this too', 1, 4, 'Keep this\nRun ', 'old tests\nRemove this too'],
  ] as const) {
    const h = harness(draft)
    h.setEditor({ ...insertText(createEditorState(), draft), cursorLine: row, cursorCol: col })
    h.input.handle({ type: 'tab' })
    expect(h.requests[0]!.hints).toMatchObject({ explicit: true, ...(prefix ? { draft: prefix } : {}), suffix })
    h.requests[0]!.resolve({ candidates: ['new tests\nThen review'], status: 'ready' })
    await tick()
    h.input.handle({ type: 'right' })
    expect(h.text()).toBe(prefix + 'new tests\nThen review')
  }
})

test('known slash commands use registered usage and cycle argument suggestions without executing', async () => {
  for (const command of ['/loop', '/resume', '/sessions', '/task']) {
    const h = harness(command)
    expect(h.input.handle({ type: 'tab' })).toBe(true)
    expect(h.requests[0]!.hints?.command?.name).toBe(command)
    expect(h.requests[0]!.hints?.command?.usage).toBeTruthy()
    expect(h.requests[0]!.hints?.draft).toBe(command)
    expect(h.requests[0]!.hints?.suffix).toBe('')
    h.requests[0]!.resolve({ candidates: [' first argument', ' second argument', ' third argument'], status: 'ready' })
    await tick()
    for (let i = 0; i < 4; i++) h.input.handle({ type: 'tab' })
    h.input.handle({ type: 'right' })
    expect(h.text()).toBe(command + ' second argument')
    expect(h.requests).toHaveLength(1)
  }
})

test('command names and fixed subcommands keep their local completion path', () => {
  for (const draft of ['/', '/lo', '/unknown', '/new', '/harden ch', '/share pub']) {
    const h = harness(draft)
    expect(h.input.handle({ type: 'tab' })).toBe(false)
    expect(h.requests).toHaveLength(0)
  }
  const h = harness('/loop 5m old task')
  h.setEditor({ ...insertText(createEditorState(), '/loop 5m old task'), cursorCol: 9 })
  expect(h.input.handle({ type: 'tab' })).toBe(true)
  expect(h.requests[0]!.hints?.draft).toBe('/loop 5m ')
  expect(h.requests[0]!.hints?.suffix).toBe('old task')
  expect(h.requests[0]!.hints?.command?.name).toBe('/loop')
})

test('image references survive Tab cycling and acceptance while attachment data stays untouched', async () => {
  const images = new Map([[7, { base64: 'private-image-data' }]])
  const pending = new PendingImages()
  let finish!: () => void
  pending.track(7, new Promise<void>(resolve => { finish = resolve }))
  for (const [draft, col, prefix, suffix, candidates, expected] of [
    ['[Image #7]', 10, '[Image #7]', '', [' explain the problem', ' compare it with the expected result'], '[Image #7] compare it with the expected result'],
    ['Review the old issue [Image #7]', 11, 'Review the ', 'old issue [Image #7]', ['layout [Image #7]', 'contrast [Image #7]'], 'Review the contrast [Image #7]'],
    ['[Image #7]', 0, '', '[Image #7]', ['Explain [Image #7]', 'Review [Image #7]'], 'Review [Image #7]'],
  ] as const) {
    const h = harness(draft)
    h.setEditor({ ...insertText(createEditorState(), draft), cursorCol: col })
    expect(h.input.handle({ type: 'tab' })).toBe(true)
    expect(h.requests[0]?.hints).toMatchObject({ suffix, ...(prefix ? { draft: prefix } : {}) })
    expect(JSON.stringify(h.requests[0]?.hints)).not.toContain('private-image-data')
    h.requests[0]!.resolve({ candidates: [...candidates], status: 'ready' })
    await tick()
    expect(h.input.handle({ type: 'tab' })).toBe(true)
    expect(h.requests).toHaveLength(1)
    expect(h.input.handle({ type: 'right' })).toBe(true)
    expect(h.text()).toBe(expected)
    expect(parsePasteRefs(h.text()).map(ref => ref.id)).toEqual([7])
    expect(images.get(7)?.base64).toBe('private-image-data')
    expect(pending.has(7)).toBe(true)
  }
  finish()
  await tick()
})

test('candidates cannot remove, duplicate, reorder or invent attachment references', async () => {
  const h = harness('Old [Image #7] [Image #8] [Pasted text #2 +3 lines]')
  h.setEditor({ ...insertText(createEditorState(), h.text()), cursorCol: 0 })
  h.input.handle({ type: 'tab' })
  h.requests[0]!.resolve({ candidates: [
    'No attachments', 'Duplicate [Image #7] [Image #7] [Image #8] [Pasted text #2 +3 lines]',
    'Reorder [Image #8] [Image #7] [Pasted text #2 +3 lines]', 'Invent [Image #9]',
    'Review [Image #7] [Image #8] [Pasted text #2 +3 lines]',
  ], status: 'ready' })
  await tick()
  expect(h.controller.position().total).toBe(1)
  h.input.handle({ type: 'right' })
  expect(h.text()).toBe('Review [Image #7] [Image #8] [Pasted text #2 +3 lines]')
})

test('explicit context reads past interrupted tool calls without sending tool arguments or reasoning', () => {
  const user: UIMessage = { id: 'u', role: 'user', text: 'Commit', timestamp: 0 }
  const tool: UIMessage = { id: 'a', role: 'assistant', text: '', timestamp: 0, content: [
    { type: 'thinking', text: 'private thought', contentIndex: 0 },
    { type: 'tool_call', contentIndex: 1, toolCall: { id: 't', name: 'bash', args: { command: 'private command' }, status: 'done' } },
  ] }
  expect(context([user, tool]).messages).toEqual([{ role: 'user', text: 'Commit' }])
})
