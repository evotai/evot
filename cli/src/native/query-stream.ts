import { decodeQueryEvent, type QueryEvent } from './contracts/query-event.js'

import { decodeResult, queuedPrompt, queuedPrompts, type QueuedPrompt } from './contracts/results.js'
export type { QueuedPrompt } from './contracts/results.js'

export type PromptQueueKind = 'steering' | 'follow_up'

/** Native run port. Importing the stream adapter never loads the NAPI binary. */
export interface NativeRun {
  readonly sessionId: string
  next(): Promise<string | null>
  abort(): void
  requestModelHandoff?(spec: string, effort: string | null): string
  steer(text: string, contentJson: string | null): string
  followUp(text: string, contentJson: string | null): string
  queuedPrompts(queue: PromptQueueKind): string
  updateQueuedPrompt(queue: PromptQueueKind, id: string, version: number, text: string): string
  removeQueuedPrompt(queue: PromptQueueKind, id: string, version: number | null): string
  sendQueuedPromptNow(id: string, version: number | null): string
  moveQueuedPrompt(queue: PromptQueueKind, id: string, version: number, direction: 'up' | 'down'): string
  clearQueuedPrompts(queue: PromptQueueKind): void
  respondHostTool(responseJson: string): Promise<void>
}

export class QueryStream {
  private ended = false
  private aborted = false

  constructor(private readonly raw: NativeRun) {}

  get sessionId(): string { return this.raw.sessionId }

  async next(): Promise<QueryEvent | null> {
    if (this.ended || this.aborted) return null
    try {
      const json = await this.raw.next()
      if (this.aborted) return null
      if (json === null) {
        this.ended = true
        return null
      }
      return decodeQueryEvent(json)
    } catch (error) {
      this.abort()
      throw error
    }
  }

  abort(): void {
    if (this.ended || this.aborted) return
    this.aborted = true
    this.raw.abort()
  }

  requestModelHandoff(spec: string, effort?: string): string {
    if (!this.raw.requestModelHandoff) throw new Error('This native addon does not support live model switching')
    return this.raw.requestModelHandoff(spec, effort ?? null)
  }

  steer(text: string, contentJson?: string): QueuedPrompt {
    return decodeResult(this.raw.steer(text, contentJson ?? null), queuedPrompt)
  }

  followUp(text: string, contentJson?: string): QueuedPrompt {
    return decodeResult(this.raw.followUp(text, contentJson ?? null), queuedPrompt)
  }

  queuedPrompts(queue: PromptQueueKind): QueuedPrompt[] {
    return decodeResult(this.raw.queuedPrompts(queue), queuedPrompts)
  }

  updateQueuedPrompt(queue: PromptQueueKind, id: string, version: number, text: string): QueuedPrompt {
    return decodeResult(this.raw.updateQueuedPrompt(queue, id, version, text), queuedPrompt)
  }

  removeQueuedPrompt(queue: PromptQueueKind, id: string, version?: number): QueuedPrompt {
    return decodeResult(this.raw.removeQueuedPrompt(queue, id, version ?? null), queuedPrompt)
  }

  sendQueuedPromptNow(id: string, version?: number): QueuedPrompt {
    return decodeResult(this.raw.sendQueuedPromptNow(id, version ?? null), queuedPrompt)
  }

  moveQueuedPrompt(queue: PromptQueueKind, id: string, version: number, direction: 'up' | 'down'): QueuedPrompt {
    return decodeResult(this.raw.moveQueuedPrompt(queue, id, version, direction), queuedPrompt)
  }

  clearQueuedPrompts(queue: PromptQueueKind): void { this.raw.clearQueuedPrompts(queue) }

  async respondHostTool(responseJson: string): Promise<void> { await this.raw.respondHostTool(responseJson) }

  /** Early return, consumer failure and decode failure all release the run.
   * Natural exhaustion does not issue a spurious cancellation. */
  async *[Symbol.asyncIterator](): AsyncIterableIterator<QueryEvent> {
    try {
      let event: QueryEvent | null
      while ((event = await this.next()) !== null) yield event
    } finally {
      this.abort()
    }
  }
}
