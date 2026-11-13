import type { ForkedAgent, QueryStream } from '../../../native/index.js'
import type { QueuedPrompt } from '../../../native/contracts/results.js'
import type { ComposerSnapshot } from '../composer/snapshot.js'
import type { PromptQueueKind } from './queue-manage.js'

export interface StartupQueueTarget { startup: number }
export type QueueTarget = string | ForkedAgent | StartupQueueTarget | null
export interface PendingEntry {
  id: string
  version: number
  sequence: number
  target: QueueTarget
  chain: number
  queue: PromptQueueKind
  text: string
  expandedText: string
  contentJson?: string
  snapshot: ComposerSnapshot
  paused: boolean
  native?: { stream: QueryStream; id: string; version: number }
}
export interface QueueReservation { sequence: number; chain: number; target: QueueTarget }
export interface PendingQueueState {
  entries: PendingEntry[]
  reservation: QueueReservation | null
  sequence: number
  chain: number
  target: QueueTarget
  running: boolean
  blocked: boolean
  continuable: boolean
}
export function createPendingQueueState(): PendingQueueState {
  return { entries: [], reservation: null, sequence: 0, chain: 0, target: null, running: false, blocked: false, continuable: false }
}

/** Where input typed right now belongs: the log fork, else the session, else
 * the not-yet-persisted startup session. */
export function currentQueueTarget(host: { logMode: ForkedAgent | null; sessionId: string | null; queueStartupTarget: StartupQueueTarget }): QueueTarget {
  return host.logMode ?? host.sessionId ?? host.queueStartupTarget
}

/** Read-only projection: rendering never synchronizes or mutates queue state. */
export function visiblePendingEntries(state: PendingQueueState, target: QueueTarget): PendingEntry[] {
  return state.entries.filter(entry => entry.target === target)
}
export function pendingEntryLabel(entry: PendingEntry): string {
  return `${entry.paused ? '[paused] ' : entry.queue === 'follow_up' ? '[next] ' : '[steer] '}${entry.text}`
}

/** Logical ownership survives stream cleanup. Only acknowledged native removals
 * can transfer a native-pending entry back to local ownership. */
export class PendingQueue {
  constructor(readonly state: PendingQueueState) {}

  begin(target: QueueTarget): number {
    if (this.state.blocked) throw new Error('Queue ownership is unresolved; retry queue reconciliation first.')
    this.state.reservation = null
    this.state.target = target
    this.state.running = true
    this.state.continuable = false
    return ++this.state.chain
  }

  bindSession(sessionId: string): void {
    const target = this.state.target
    if (typeof target === 'string' || (target !== null && !('startup' in target))) return
    for (const entry of this.state.entries) if (entry.target === target && entry.chain === this.state.chain) entry.target = sessionId
    this.state.target = sessionId
    if (this.state.reservation?.target === target && this.state.reservation.chain === this.state.chain) this.state.reservation.target = sessionId
  }

  visible(target: QueueTarget): PendingEntry[] {
    return visiblePendingEntries(this.state, target)
  }

  reserve(target: QueueTarget): QueueReservation {
    const reservation = { sequence: ++this.state.sequence, chain: this.state.chain, target }
    this.state.reservation = reservation
    return reservation
  }

  release(reservation: QueueReservation): void {
    if (this.state.reservation?.sequence === reservation.sequence) this.state.reservation = null
  }

  /** The draft being prepared was edited, cleared or abandoned. */
  cancelReservation(): void {
    this.state.reservation = null
  }

  /** A deferred entry is starting inside the current chain, not a new one. */
  continueChain(): number {
    this.state.running = true
    return this.state.chain
  }

  accept(input: Omit<PendingEntry, 'id' | 'version' | 'sequence' | 'chain' | 'paused'>, sequence = ++this.state.sequence): PendingEntry {
    const entry: PendingEntry = {
      ...input, id: `pending-${sequence}`, sequence, version: 1,
      chain: this.state.chain, paused: !this.state.running && !this.state.continuable,
    }
    this.state.entries.push(entry)
    this.state.entries.sort((a, b) => a.sequence - b.sequence)
    return entry
  }

  register(entry: PendingEntry, stream: QueryStream, queued: QueuedPrompt): void {
    entry.native = { stream, id: queued.id, version: queued.version }
  }

  attach(stream: QueryStream): void {
    for (const entry of this.state.entries) {
      if (entry.native || entry.paused || entry.chain !== this.state.chain || entry.target !== this.state.target || this.reservedBefore(entry)) continue
      const queued = entry.queue === 'steering'
        ? stream.steer(entry.expandedText, entry.contentJson)
        : stream.followUp(entry.expandedText, entry.contentJson)
      this.register(entry, stream, queued)
    }
  }

  /** A failed read is never evidence of consumption. Read both queues before
   * mutating anything, even if only one currently has visible entries. */
  reconcile(stream: QueryStream): PendingEntry[] {
    const native = new Map([...stream.queuedPrompts('steering'), ...stream.queuedPrompts('follow_up')].map(entry => [entry.id, entry]))
    for (const entry of this.state.entries) {
      if (entry.native?.stream !== stream) continue
      const current = native.get(entry.native.id)
      if (current && current.version !== entry.native.version) {
        entry.native.version = current.version
        entry.version++
      }
    }
    const consumed = this.state.entries.filter(entry => entry.native?.stream === stream && !native.has(entry.native.id))
    const removed = new Set(consumed.map(entry => entry.id))
    this.state.entries = this.state.entries.filter(entry => !removed.has(entry.id))
    return consumed
  }

  remove(entry: PendingEntry, version: number): void {
    if (!this.state.entries.includes(entry) || entry.version !== version) throw new Error('Queued prompt changed or was already consumed.')
    if (entry.native) entry.native.stream.removeQueuedPrompt(entry.queue, entry.native.id, entry.native.version)
    this.state.entries = this.state.entries.filter(candidate => candidate !== entry)
    if (this.state.blocked) this.state.blocked = this.state.entries.some(candidate => candidate.native !== undefined)
  }

  update(entry: PendingEntry, version: number, text: string, expandedText = text): void {
    if (!this.state.entries.includes(entry) || entry.version !== version) throw new Error('Queued prompt changed or was already consumed.')
    if (entry.contentJson) throw new Error('Dequeue this structured prompt to edit its attachments.')
    if (entry.native) {
      const result = entry.native.stream.updateQueuedPrompt(entry.queue, entry.native.id, entry.native.version, expandedText)
      entry.native.version = result.version
    }
    entry.version++
    entry.text = text
    entry.expandedText = expandedText
    entry.snapshot = { ...entry.snapshot, text, chunks: [], images: [], cursorLine: text.split('\n').length - 1, cursorCol: text.split('\n').at(-1)?.length ?? 0 }
  }

  /** Called after the run has settled (or abort has been requested). Retain
   * handles on ambiguous failures so reconciliation/removal can be retried. */
  detach(stream: QueryStream, consumed: (entries: PendingEntry[]) => void): void {
    if (!this.state.entries.some(entry => entry.native?.stream === stream)) {
      this.state.blocked = this.state.entries.some(entry => entry.native !== undefined)
      return
    }
    this.state.blocked = true
    consumed(this.reconcile(stream))
    for (const entry of this.state.entries) {
      if (entry.native?.stream !== stream) continue
      stream.removeQueuedPrompt(entry.queue, entry.native.id, entry.native.version)
      entry.native = undefined
    }
    this.state.blocked = this.state.entries.some(entry => entry.native !== undefined)
  }

  settle(chain: number, success: boolean): void {
    if (chain !== this.state.chain) return
    this.state.running = false
    this.state.continuable = success
    if (!success) for (const entry of this.state.entries) if (entry.chain === chain) entry.paused = true
  }

  private reservedBefore(entry: PendingEntry): boolean {
    const reservation = this.state.reservation
    return entry.queue === 'follow_up' && reservation !== null && reservation.chain === entry.chain && reservation.target === entry.target && reservation.sequence < entry.sequence
  }

  next(chain: number): PendingEntry | undefined {
    if (this.state.blocked || chain !== this.state.chain) return undefined
    return this.state.entries.find(entry => entry.chain === chain && !entry.paused && !entry.native && entry.target === this.state.target && !this.reservedBefore(entry))
  }

  resume(target: QueueTarget): void {
    this.begin(target)
    for (const entry of this.visible(target)) {
      entry.chain = this.state.chain
      entry.paused = false
    }
    this.state.running = false
  }
}
