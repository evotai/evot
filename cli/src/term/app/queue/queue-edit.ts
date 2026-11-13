import { errorText } from '../../../ui/format.js'
import type { ComposerSnapshot } from '../composer/snapshot.js'
import { getEditorText, type EditorState } from '../../input/editor.js'
import type { OverlayState } from '../selector/overlay-state.js'
import { createQueueSelectorState, type ManagedQueuedPrompt } from './queue-manage.js'
import { pendingEntryLabel, type PendingQueue, type QueueTarget } from './pending-queue.js'
import type { QueueLifecycle } from './queue-lifecycle.js'

export interface QueueEditing {
  entry: ManagedQueuedPrompt
  stash: ComposerSnapshot
  consumed: boolean
}
export interface QueueEditDeps {
  queue: PendingQueue
  lifecycle: QueueLifecycle
  getTarget(): QueueTarget
  getEditor(): EditorState
  expand(text: string): string | null
  setOverlay(overlay: OverlayState): void
  getEditing(): QueueEditing | null
  setEditing(edit: QueueEditing | null): void
  snapshot(): ComposerSnapshot
  restore(snapshot: ComposerSnapshot, recovery?: boolean): void
  preparing(): boolean
  commitSystem(id: string, text: string, kind?: 'error'): void
  requestRender(): void
}

/** Queue editing and presentation only. Stream ownership and scheduling live
 * in QueueLifecycle, while PendingQueue is the single source of pending data. */
export function createQueueEdit(deps: QueueEditDeps) {
  const queue = deps.queue
  const notify = (message: string) => { deps.commitSystem('sys-queue', `  ${message}`); deps.requestRender() }
  const entries = () => queue.visible(deps.getTarget())
  const editingEntry = () => deps.getEditing()?.entry ?? null
  const managed = (entry: ReturnType<typeof entries>[number]): ManagedQueuedPrompt => ({
    id: entry.id, version: entry.version, queue: entry.queue, text: pendingEntryLabel(entry),
  })
  const find = (entry: ManagedQueuedPrompt) => entries().find(candidate => candidate.id === entry.id)

  function openQueueSelector() {
    if (deps.getEditing()) { notify('Finish or discard the queued prompt edit first.'); return }
    if (queue.state.blocked) deps.lifecycle.recoverOwnership()
    const visible = entries()
    if (!visible.length) { deps.setOverlay({ kind: 'none' }); notify('No queued prompts.'); return }
    deps.setOverlay({ kind: 'selector', state: createQueueSelectorState(visible.map(managed), visible.some(entry => entry.paused)) })
    deps.requestRender()
  }
  function finishQueueEdit() {
    const edit = deps.getEditing()
    if (!edit) return
    deps.setEditing(null)
    deps.restore(edit.stash)
  }
  function cancelQueueEdit() { finishQueueEdit(); notify('Queue edit discarded.') }
  function editQueuedPrompt(item: ManagedQueuedPrompt) {
    const entry = find(item)
    if (!entry) { notify('Queued prompt is no longer pending.'); return }
    if (deps.preparing() || deps.getEditing()) { notify('Finish or discard the pending input first.'); return }
    if (entry.contentJson) { notify('Structured prompts cannot be edited here. Use Shift+↑ to recover pending prompts newest first.'); return }
    deps.setEditing({ entry: item, stash: deps.snapshot(), consumed: false })
    deps.restore(entry.snapshot)
    deps.setOverlay({ kind: 'none' })
    notify('Editing queued prompt · Enter save · Esc discard')
  }
  function saveQueueEdit(text: string) {
    const edit = deps.getEditing()
    if (!edit || !text.trim()) return
    if (edit.consumed) { notify('Original prompt was sent; copy your changes or press Esc to discard this edit.'); return }
    const entry = find(edit.entry)
    if (!entry) { edit.consumed = true; notify('Original prompt was sent; edit retained. Esc discards.'); return }
    try {
      const expanded = deps.expand(text)
      if (expanded === null) { notify('Local commands cannot replace a queued prompt.'); return }
      queue.update(entry, edit.entry.version, text, expanded)
      finishQueueEdit()
      notify('Queued prompt updated.')
    } catch (err) {
      notify(`Queue edit failed: ${errorText(err)}`)
      deps.lifecycle.reconcile()
      if (find(edit.entry)) edit.entry = managed(entry)
    }
  }
  function removeQueuedPrompt(item: ManagedQueuedPrompt) {
    const entry = find(item)
    if (!entry) { notify('Queued prompt is no longer pending.'); return }
    try { queue.remove(entry, item.version); openQueueSelector() }
    catch (err) { deps.lifecycle.reconcile(); notify(`Queue remove failed: ${errorText(err)}`) }
    deps.requestRender()
  }
  function restoreLastQueuedUserMessageToEditor() {
    if (getEditorText(deps.getEditor()).length || deps.getEditing() || deps.preparing()) { notify('Finish or clear the draft before dequeueing.'); return }
    const entry = entries().at(-1)
    if (!entry) { notify('No queued prompts.'); return }
    try { queue.remove(entry, entry.version); deps.restore(entry.snapshot, true) }
    catch (err) { deps.lifecycle.reconcile(); notify(`Dequeue failed: ${errorText(err)}`) }
    deps.requestRender()
  }
  return { editingEntry, openQueueSelector, editQueuedPrompt, cancelQueueEdit, saveQueueEdit, removeQueuedPrompt,
    restoreLastQueuedUserMessageToEditor, entries }
}
