import { isKnownRunEvent, type RunEvent } from '../native/contracts/query-event.js'
import { formatElapsed } from '../ui/format.js'

/** Local, monotonic timing of streamed reasoning; never a persisted contract. */
export class RunThinking {
  private startedAt: number | null = null
  private contentIndex: number | null = null
  private elapsed = 0
  private observed = false

  reset(): void {
    this.startedAt = null
    this.contentIndex = null
    this.elapsed = 0
    this.observed = false
  }

  observe(event: RunEvent, now = performance.now()): void {
    if (!isKnownRunEvent(event)) return
    if (event.kind === 'assistant_delta') {
      if (!event.payload.delta.trim()) return
      if (event.payload.content_type === 'thinking') {
        if (this.startedAt !== null && this.contentIndex !== event.payload.content_index) this.finish(now)
        if (this.startedAt === null) {
          this.startedAt = now
          this.contentIndex = event.payload.content_index
          this.observed = true
        }
      } else {
        this.finish(now)
      }
      return
    }
    switch (event.kind) {
      case 'assistant_tool_call':
      case 'assistant_completed':
      case 'llm_call_completed':
      case 'llm_call_retry':
      case 'turn_started':
      case 'tool_started':
      case 'run_finished':
      case 'error':
      case 'quota_waiting':
      case 'outage_waiting':
        this.finish(now)
    }
  }

  finish(now = performance.now()): number | null {
    if (this.startedAt !== null) {
      this.elapsed += Math.max(0, now - this.startedAt)
      this.startedAt = null
      this.contentIndex = null
    }
    return this.observed ? this.elapsed : null
  }
}

export function thinkingDuration(durationMs: number): string {
  return durationMs < 1000 ? '<1s' : formatElapsed(durationMs)
}
