import { expect, test } from 'bun:test'
import { createQueueLifecycle } from '../../../src/term/app/queue/queue-lifecycle.js'
import { createQueueEdit, type QueueEditing } from '../../../src/term/app/queue/queue-edit.js'
import { PendingQueue, createPendingQueueState } from '../../../src/term/app/queue/pending-queue.js'
import { createEditorState, getEditorText, insertText } from '../../../src/term/input/editor.js'
import type { OverlayState } from '../../../src/term/app/selector/overlay-state.js'
import { draft, queueFixture } from '../../helpers/prompt-queue.js'

function harness() {
  const queue = new PendingQueue(createPendingQueueState()), native = queueFixture()
  queue.begin('session-a')
  let editor = createEditorState(), editing: QueueEditing | null = null
  let overlay: OverlayState = { kind: 'none' }, dispatch: string | null = null
  let busy = true, preparing = false
  const messages: string[] = [], committed: string[] = [], dispatched: string[] = []
  const lifecycle = createQueueLifecycle({
    queue, getTarget: () => 'session-a', getStream: () => busy ? native.stream : null,
    preparing: () => preparing, editing: () => editing !== null, busy: () => busy,
    getDispatch: () => dispatch, setDispatch: id => { dispatch = id },
    runQueued: async entry => {
      dispatched.push(entry.expandedText)
      lifecycle.started(native.stream)
      lifecycle.settled(native.stream, queue.state.chain, true)
    },
    consumed: entries => {
      committed.push(...entries.map(entry => entry.text))
      if (editing && entries.some(entry => entry.id === editing?.entry.id)) editing.consumed = true
    },
    notify: text => { messages.push(text) }, requestRender: () => {},
  })
  const ctl = createQueueEdit({
    queue, lifecycle, getTarget: () => 'session-a', getEditor: () => editor, expand: text => text,
    setOverlay: next => { overlay = next },
    getEditing: () => editing, setEditing: next => { editing = next },
    snapshot: () => draft(getEditorText(editor)),
    restore: saved => { editor = insertText(createEditorState(), saved.text) },
    preparing: () => preparing,
    commitSystem: (_id, text) => { messages.push(text) }, requestRender: () => {},
  })
  const accept = (text: string) => queue.accept({ target: 'session-a', queue: 'follow_up', text, expandedText: text, snapshot: draft(text) })
  return { queue, native, ctl, lifecycle, messages, committed, dispatched, accept,
    text: () => getEditorText(editor), editing: () => editing, overlay: () => overlay,
    setDraft: (text: string) => { editor = insertText(createEditorState(), text) },
    idle: () => { busy = false }, prepare: () => { preparing = true },
  }
}

test('dequeue is newest-first, preserves the other native entry, and never aborts', () => {
  const h = harness(), b = h.accept('B'), c = h.accept('C')
  h.queue.attach(h.native.stream)
  h.ctl.restoreLastQueuedUserMessageToEditor()
  expect(h.text()).toBe('C')
  expect(h.queue.state.entries).toEqual([b])
  expect(h.native.calls).toEqual(['follow_up', 'follow_up'])
  expect(h.native.queues.follow_up.map(entry => entry.id)).toEqual([b.native?.id])
  expect(h.committed).toEqual([])
  expect(h.messages.at(-1)).toContain('Pulled back · not sent.')
  expect(c.native?.id).toBeDefined()
})

test.each(['existing draft', ' ', '\n'])('dequeue protects a nonempty composer: %j', text => {
  const h = harness(), b = h.accept('B')
  h.setDraft(text)
  h.ctl.restoreLastQueuedUserMessageToEditor()
  expect(h.text()).toBe(text)
  expect(h.queue.state.entries).toEqual([b])
  expect(h.messages.at(-1)).toContain('Ctrl+C clears it')
})

test('dequeue with empty queue or pending image action is harmless', () => {
  const h = harness()
  h.ctl.restoreLastQueuedUserMessageToEditor()
  expect(h.text()).toBe('')
  h.accept('B'); h.prepare()
  h.ctl.restoreLastQueuedUserMessageToEditor()
  expect(h.queue.state.entries).toHaveLength(1)
  expect(h.text()).toBe('')
})

test('dequeue failure preserves draft and reconciles a consumption winner without resurrecting it', () => {
  const h = harness()
  h.accept('B'); h.queue.attach(h.native.stream); h.native.consume()
  h.ctl.restoreLastQueuedUserMessageToEditor()
  expect(h.text()).toBe('')
  expect(h.committed).toEqual(['B'])
  expect(h.queue.state.entries).toEqual([])
  expect(h.messages.at(-1)).toContain('Already sent · cannot pull back.')
})

test('structured editing is blocked without taking over an unrelated draft', () => {
  const h = harness(), b = h.accept('[Image #1]')
  b.contentJson = '[{"type":"image"}]'
  h.setDraft('unrelated [Pasted text #2 +9 lines]')
  h.ctl.editQueuedPrompt(b)
  expect(h.editing()).toBeNull()
  expect(h.text()).toBe('unrelated [Pasted text #2 +9 lines]')
  expect(h.queue.state.entries).toEqual([b])
})

test('edit save changes existing entry and recovery content, then restores stashed draft', () => {
  const h = harness(), b = h.accept('B')
  h.setDraft('unrelated')
  h.ctl.editQueuedPrompt(b)
  expect(h.text()).toBe('B')
  h.ctl.saveQueueEdit('edited B')
  expect(h.editing()).toBeNull()
  expect(h.text()).toBe('unrelated')
  expect(b.snapshot.text).toBe('edited B')
  expect(h.queue.state.entries).toHaveLength(1)
})

test('consumption during edit retains unsaved text until explicit discard', () => {
  const h = harness(), b = h.accept('B')
  h.queue.attach(h.native.stream)
  h.setDraft('stashed')
  h.ctl.editQueuedPrompt(b)
  h.setDraft('unsaved change')
  h.native.consume()
  h.lifecycle.reconcile()
  expect(h.editing()?.consumed).toBe(true)
  expect(h.text()).toBe('unsaved change')
  h.ctl.saveQueueEdit('unsaved change')
  expect(h.queue.state.entries).toEqual([])
  expect(h.text()).toBe('unsaved change')
  h.ctl.cancelQueueEdit()
  expect(h.text()).toBe('stashed')
})

test('stale terminal cleanup cannot detach or pause a successor chain', () => {
  const h = harness(), oldChain = h.queue.state.chain
  h.lifecycle.pause(null)
  h.queue.begin('session-a')
  const c = h.accept('C')
  h.queue.attach(h.native.stream)
  h.lifecycle.settled(h.native.stream, oldChain, false)
  expect(h.queue.state.running).toBe(true)
  expect(h.queue.state.blocked).toBe(false)
  expect(h.native.queues.follow_up.map(entry => entry.id)).toEqual([c.native?.id])
})

test('paused queue management and explicit resume work idle and preserve composer draft', async () => {
  const h = harness()
  h.accept('B'); h.accept('C')
  h.lifecycle.pause(null); h.idle(); h.setDraft('unrelated draft')
  h.ctl.openQueueSelector()
  const overlay = h.overlay()
  expect(overlay.kind === 'selector' && overlay.state.items[0]?.label).toBe('Resume paused queue')
  h.lifecycle.resumePaused(); h.lifecycle.resumePaused()
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  expect(h.dispatched).toEqual(['B', 'C'])
  expect(h.text()).toBe('unrelated draft')
  expect(h.committed).toEqual(['B', 'C'])
})
