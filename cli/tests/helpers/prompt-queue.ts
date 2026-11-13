import { QueryStream, type NativeRun, type PromptQueueKind } from '../../src/native/query-stream.js'
import type { QueryEvent } from '../../src/native/contracts/query-event.js'
import type { QueuedPrompt } from '../../src/native/contracts/results.js'
import type { ComposerSnapshot } from '../../src/term/app/composer/snapshot.js'

export function draft(text: string): ComposerSnapshot {
  return { text, cursorLine: 0, cursorCol: text.length, chunks: [], images: [], undo: [], history: { index: 0, savedInput: '', length: 0 } }
}

/** Production stream adapter with an atomic/versioned in-memory native port. */
export function queueFixture(events: QueryEvent[] = []) {
  const queues: Record<PromptQueueKind, QueuedPrompt[]> = { steering: [], follow_up: [] }
  const calls: string[] = []
  let sequence = 0
  let failRead = false
  let failRemove = false
  let failEnqueue = false
  const enqueue = (queue: PromptQueueKind, text: string, json: string | null): string => {
    calls.push(queue)
    if (failEnqueue) throw new Error('enqueue unavailable')
    const entry = { id: `native-${++sequence}`, version: 0, message: { content: json ? JSON.parse(json) : [{ type: 'text', text }] } }
    queues[queue].push(entry)
    return JSON.stringify(entry)
  }
  const remove = (queue: PromptQueueKind, id: string, version: number | null) => {
    if (failRemove) throw new Error('remove unavailable')
    const entry = queues[queue].find(item => item.id === id)
    if (!entry || (version !== null && version !== entry.version)) throw new Error('version conflict or consumed')
    queues[queue] = queues[queue].filter(item => item !== entry)
    return JSON.stringify(entry)
  }
  const raw: NativeRun = {
    sessionId: 'session-a', next: async () => events.length ? JSON.stringify(events.shift()) : null, abort: () => { calls.push('abort') },
    steer: (text, json) => enqueue('steering', text, json),
    followUp: (text, json) => enqueue('follow_up', text, json),
    queuedPrompts: queue => { if (failRead) throw new Error('read unavailable'); return JSON.stringify(queues[queue]) },
    removeQueuedPrompt: remove,
    updateQueuedPrompt: (queue, id, version, text) => {
      const entry = queues[queue].find(item => item.id === id)
      if (!entry || entry.version !== version) throw new Error('version conflict or consumed')
      entry.version++
      entry.message = { content: [{ type: 'text', text }] }
      return JSON.stringify(entry)
    },
    clearQueuedPrompts: queue => { queues[queue] = [] },
    sendQueuedPromptNow: () => { throw new Error('unexpected promotion') },
    moveQueuedPrompt: () => { throw new Error('unexpected reorder') },
    respondHostTool: async () => {},
  }
  return { stream: new QueryStream(raw), queues, calls,
    consume: (queue: PromptQueueKind = 'follow_up') => queues[queue].shift(),
    failEnqueue: (value = true) => { failEnqueue = value },
    failRead: (value = true) => { failRead = value },
    failRemove: (value = true) => { failRemove = value },
  }
}
