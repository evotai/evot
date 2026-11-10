import type { QueuedPrompt } from '../../../native/contracts/results.js'
import type { ManagedQueuedPrompt, PromptQueueKind } from './queue-manage.js'

/** Narrow port: queue presentation never owns the native run or its lifecycle. */
export interface PromptQueueReader {
  queuedPrompts(queue: PromptQueueKind): QueuedPrompt[]
}
export type QueuedUserMessage = QueuedPrompt & { text: string; queue: PromptQueueKind }

export function queueEntryText(entry: QueuedPrompt): string {
  const content = entry.message.content
  if (!Array.isArray(content)) return '(non-text prompt)'
  const text = content.flatMap((block: unknown) => {
    if (block === null || typeof block !== 'object' || !('type' in block) || !('text' in block)) return []
    return block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
  }).join('\n').trim()
  return text || '(non-text prompt)'
}

/** Both reads must succeed. A failed read must not look like an empty queue:
 * that would commit pending drafts as consumed or close an active edit. */
export function readPromptQueues(reader: PromptQueueReader): ManagedQueuedPrompt[] {
  const collect = (queue: PromptQueueKind) => reader.queuedPrompts(queue).map(entry => ({
    queue, id: entry.id, version: entry.version, text: queueEntryText(entry),
  }))
  return [...collect('steering'), ...collect('follow_up')]
}

export function visibleQueueEntries(entries: ManagedQueuedPrompt[], visible: QueuedUserMessage[]): ManagedQueuedPrompt[] {
  const text = new Map(visible.map(message => [message.id, message.text]))
  return entries.map(entry => ({ ...entry, text: text.get(entry.id) ?? entry.text }))
}

/** Stable partition: consumed copies are committed once, in submission order. */
export function reconcilePromptQueue(entries: ManagedQueuedPrompt[], visible: QueuedUserMessage[]) {
  const ids = new Set(entries.map(entry => entry.id))
  const remaining: QueuedUserMessage[] = []
  const consumed: QueuedUserMessage[] = []
  for (const message of visible) (ids.has(message.id) ? remaining : consumed).push(message)
  return { ids, remaining, consumed }
}
