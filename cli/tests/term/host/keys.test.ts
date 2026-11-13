import { expect, test } from 'bun:test'
import { createKeysController, type KeysDeps } from '../../../src/term/host/keys.js'
import type { ReplState } from '../../../src/term/host/state.js'
import { createEditorState, insertText } from '../../../src/term/input/editor.js'
import { resolveRunInteraction } from '../../../src/term/app/run/run-interaction.js'
import { createPendingQueueState } from '../../../src/term/app/queue/pending-queue.js'
import { parseInput } from '../../../src/ui/keys.js'

function harness(text = 'future task') {
  const st = { editor: insertText(createEditorState(), text), overlay: { kind: 'none' },
    commandWindowPreview: null, isLoading: true, pendingEnqueue: null, pendingQueue: createPendingQueueState(),
    streamRef: {}, queuedUserMessages: [], exitHint: false, logMode: null, foregroundCommand: null,
  } as unknown as ReplState
  let editing = false
  const calls: string[] = []
  const deps = {
    pendingImages: { awaiting: false },
    terminal: { suspend: () => { calls.push('suspend') } },
    queueEdit: { editingEntry: () => editing ? { id: 'edit' } : null,
      restoreLastQueuedUserMessageToEditor: () => { calls.push('dequeue') },
      saveQueueEdit: () => { calls.push('save') }, entries: () => [], cancelQueueEdit: () => { calls.push('cancel-edit') } },
    composer: { getExpandedText: () => text, handleNormalKey: (event: { type: string }) => { calls.push(`local:${event.type}`) } },
    submit: { enqueueDraft: () => { calls.push('enqueue') }, handleLoadingEnter: () => { calls.push('steer') } },
    suggestionInput: { handle: (event: { type: string }) => {
      if (st.overlay.kind !== 'none' || st.editor.completion || event.type !== 'tab') return false
      calls.push('suggest'); return true
    } },
    suggestions: { reconcile: () => {} },
    suggest: { suggestionInventory: () => ({ models: [], sessions: [] }) },
    manualCompaction: { active: false },
    commandWindow: { activateCommandWindow: () => false, refreshCommandWindowPreview: () => {} },
    renderer: { invalidateRowsFrom: () => {}, requestRender: () => {} },
    runInteraction: { clear: () => {}, snapshot: () => resolveRunInteraction({ active: st.isLoading, owner: st.streamRef }) },
    runCtl: { runInteractionInput: () => ({}) },
    selectorKeys: { handleSelectorKey: (event: { type: string }) => { calls.push(`selector:${event.type}`) } },
    asks: { handleAskKey: (event: { type: string }) => { calls.push(`ask:${event.type}`) } },
    withDraftImages: (submit: () => void) => submit(),
  } as unknown as KeysDeps
  return { st, calls, keys: createKeysController(st, deps), edit: () => { editing = true } }
}

test('Ctrl-Z belongs to terminal lifecycle even with an overlay open', () => {
  const h = harness('draft')
  h.st.overlay = { kind: 'ask-user', state: {} } as ReplState['overlay']
  h.keys.handleKey({ type: 'ctrl', key: 'z' })
  expect(h.calls).toEqual(['suspend'])
  expect(h.st.isLoading).toBe(true)
})

test('busy Tab queues before cached suggestion routing and Enter remains steering', () => {
  const h = harness()
  h.keys.handleKey({ type: 'tab' })
  expect(h.calls).toEqual(['enqueue'])
  h.keys.handleKey({ type: 'enter' })
  expect(h.calls).toEqual(['enqueue', 'steer'])
})

test.each(['Review ./definitely-missing-file', 'Review @src', '/he'])('local completion owns busy Tab: %s', text => {
  const h = harness(text)
  h.keys.handleKey({ type: 'tab' })
  expect(h.calls).toEqual(['local:tab'])
})

test('trailing path whitespace returns busy Tab to enqueue', () => {
  const h = harness('Review ./definitely-missing-file ')
  h.keys.handleKey({ type: 'tab' })
  expect(h.calls).toEqual(['enqueue'])
})

test('idle/empty Tab stays assistance and Ctrl+N explicitly assists a busy draft', () => {
  const idle = harness(); idle.st.isLoading = false
  idle.keys.handleKey({ type: 'tab' })
  expect(idle.calls).toEqual(['suggest'])
  const empty = harness(''); empty.keys.handleKey({ type: 'tab' })
  expect(empty.calls).toEqual(['suggest'])
  const busy = harness(); busy.keys.handleKey({ type: 'ctrl', key: 'n' })
  expect(busy.calls).toEqual(['suggest'])
})

test('queue edit owns Enter/Tab and cannot duplicate the pending prompt', () => {
  const h = harness(); h.edit()
  h.keys.handleKey({ type: 'tab' }); h.keys.handleKey({ type: 'enter' })
  expect(h.calls).toEqual(['save'])
})

test('pending image action suppresses repeated submission intent', () => {
  const h = harness()
  h.st.pendingEnqueue = { epoch: 1, chain: 1, target: null, sequence: 1 }
  h.keys.handleKey({ type: 'tab' }); h.keys.handleKey({ type: 'enter' })
  expect(h.calls).toEqual([])
})

test('Shift+Up is an ordinary Up: only Esc pulls a pending prompt back', () => {
  const ordinary = harness('')
  for (const event of parseInput(Buffer.from('\x1b[1;2A'))) ordinary.keys.handleKey(event)
  expect(ordinary.calls).not.toContain('dequeue')
})
