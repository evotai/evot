import { renderErrorNotice } from '../../render/command-notice.js'

import type { QueryStream } from '../../native/index.js'
import { buildUserMessage, type OutputLine } from '../../render/output.js'
import { clearEditor, getEditorText, insertText, type EditorState } from '../input/editor.js'
import type { OverlayState } from './overlay-state.js'
import { readPromptQueues, reconcilePromptQueue, visibleQueueEntries, type QueuedUserMessage } from './prompt-queue.js'
import { createQueueSelectorState, type ManagedQueuedPrompt } from './queue-manage.js'
import { mergeQueuedIntoEditorText } from './queue-restore.js'
import { SELECTOR_OWNER } from './selector-identity.js'
import { errorText } from '../../render/format.js'

export interface QueueEditDeps {
  getStream: () => QueryStream | null
  getQueued: () => QueuedUserMessage[]
  setQueued: (messages: QueuedUserMessage[]) => void
  getEditor: () => EditorState
  setEditor: (editor: EditorState) => void
  getOverlay: () => OverlayState
  setOverlay: (overlay: OverlayState) => void
  commitSystem: (id: string, text: string, kind?: OutputLine['kind']) => void
  commitLines: (lines: OutputLine[]) => void
  commitUser?: (text: string) => void
  clearAll: () => void
  requestRender: () => void
}

export function createQueueEdit(deps: QueueEditDeps) {
  let editing: ManagedQueuedPrompt | null = null
  let stash = ''

  function editingEntry(): ManagedQueuedPrompt | null {
    return editing
  }

  function managedQueueEntries(): ManagedQueuedPrompt[] {
    const stream = deps.getStream()
    if (!stream) return []
    return visibleQueueEntries(readPromptQueues(stream), deps.getQueued())
  }

  function openQueueSelector() {
    let entries: ManagedQueuedPrompt[]
    try {
      entries = managedQueueEntries()
    } catch (err) {
      deps.commitSystem('sys-queue-err', `  Queue read failed: ${errorText(err)}`, 'error')
      deps.requestRender()
      return
    }
    if (entries.length === 0) {
      deps.setOverlay({ kind: 'none' })
      deps.commitSystem('sys-queue-empty', '  No queued prompts.')
      return
    }
    deps.setOverlay({ kind: 'selector', state: createQueueSelectorState(entries) })
    deps.requestRender()
  }

  function editQueuedPrompt(entry: ManagedQueuedPrompt) {
    if (!deps.getStream()) return
    editing = entry
    stash = getEditorText(deps.getEditor())
    deps.clearAll()
    deps.setEditor(insertText(deps.getEditor(), entry.text))
    deps.setOverlay({ kind: 'none' })
    deps.commitSystem('sys-queue-edit', '  Editing queued prompt · Enter save · Esc discard')
    deps.requestRender()
  }

  function finishQueueEdit() {
    editing = null
    deps.clearAll()
    deps.setEditor(insertText(deps.getEditor(), stash))
    stash = ''
    deps.requestRender()
  }

  function cancelQueueEdit() {
    finishQueueEdit()
    deps.commitSystem('sys-queue-edit-cancel', '  Queue edit discarded.')
  }

  function saveQueueEdit(text: string) {
    const stream = deps.getStream()
    if (!stream || !editing || !text.trim()) return
    const entry = editing
    try {
      const updated = stream.updateQueuedPrompt(entry.queue, entry.id, entry.version, text)
      deps.setQueued(deps.getQueued().map(message => message.id === entry.id
        ? { ...message, version: updated.version, text }
        : message))
      finishQueueEdit()
      deps.commitSystem('sys-queue-edit-save', '  Queued prompt updated.')
    } catch (err) {
      try {
        const current = managedQueueEntries().find(candidate => candidate.id === entry.id)
        if (current) editing = { ...current, text }
        else finishQueueEdit()
      } catch {
        // Failed refresh is not proof the entry was consumed. Retain the edit
        // and its draft so the user can retry or explicitly discard it.
      }
      deps.commitSystem('sys-queue-err', renderErrorNotice(`Queue edit failed: ${errorText(err)}`))
      deps.requestRender()
    }
  }

  function removeQueuedPrompt(entry: ManagedQueuedPrompt) {
    const stream = deps.getStream()
    if (!stream) return
    try {
      stream.removeQueuedPrompt(entry.queue, entry.id, entry.version)
      deps.setQueued(deps.getQueued().filter(message => message.id !== entry.id))
      openQueueSelector()
    } catch (err) {
      reconcileQueuedUserMessages()
      deps.commitSystem('sys-queue-err', renderErrorNotice(`Queue remove failed: ${errorText(err)}`))
      openQueueSelector()
    }
  }

  /** Pull the newest queued prompt back into the editor without
   *  aborting the active run. Native optimistic version matching prevents an
   *  already-consumed prompt from being silently edited. */
  function restoreLastQueuedUserMessageToEditor() {
    const stream = deps.getStream()
    const queued = deps.getQueued()
    if (!stream || queued.length === 0) return
    const last = queued[queued.length - 1]!
    try {
      stream.removeQueuedPrompt(last.queue, last.id, last.version)
      deps.setQueued(queued.slice(0, -1))
      const next = mergeQueuedIntoEditorText([last.text], getEditorText(deps.getEditor()))
      deps.setEditor(insertText(clearEditor(deps.getEditor()), next))
      deps.requestRender()
    } catch {
      // The engine already consumed it at a turn boundary; normal event handling
      // will commit the visible copy to history.
    }
  }

  /** Move mid-stream queued messages into the input box after an interrupt. */
  function restoreQueuedUserMessagesToEditor() {
    const queued = deps.getQueued()
    if (queued.length === 0) return
    const messages = queued.map(message => message.text)
    deps.setQueued([])
    const next = mergeQueuedIntoEditorText(messages, getEditorText(deps.getEditor()))
    deps.setEditor(insertText(clearEditor(deps.getEditor()), next))
    deps.requestRender()
  }

  /** Commit queued prompts that are no longer present in either native queue. */
  function reconcileQueuedUserMessages() {
    const stream = deps.getStream()
    const queued = deps.getQueued()
    if (queued.length === 0 || !stream) return
    let reconciliation: ReturnType<typeof reconcilePromptQueue>
    try {
      reconciliation = reconcilePromptQueue(readPromptQueues(stream), queued)
    } catch {
      return
    }
    const { ids: remainingIds, remaining, consumed } = reconciliation
    for (const message of consumed) {
      if (deps.commitUser) deps.commitUser(message.text)
      else deps.commitLines(buildUserMessage(message.text))
    }
    deps.setQueued(remaining)
    const overlay = deps.getOverlay()
    if (remaining.length === 0 && overlay.kind === 'selector' && overlay.state.owner === SELECTOR_OWNER.queue) {
      deps.setOverlay({ kind: 'none' })
    }
    if (editing && !remainingIds.has(editing.id)) {
      finishQueueEdit()
      deps.commitSystem('sys-queue-edit-consumed', '  Queued prompt was already consumed; edit closed.')
    }
  }

  return {
    editingEntry,
    openQueueSelector,
    editQueuedPrompt,
    cancelQueueEdit,
    saveQueueEdit,
    removeQueuedPrompt,
    restoreLastQueuedUserMessageToEditor,
    restoreQueuedUserMessagesToEditor,
    reconcileQueuedUserMessages,
  }
}
