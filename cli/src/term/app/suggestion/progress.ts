import type { SuggestionProgress } from '../../../native/contracts/suggestion.js'
import type { ToolEvidence } from './events.js'

interface Call {
  name: string
  description?: string
  executed: boolean
  status: 'pending' | 'completed' | 'failed'
  epoch: number
  requestedEpoch: number
  requiresInput: boolean
}

function label(text: string, length: number): string {
  return Array.from(text.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim()).slice(0, length).join('')
}

/** Only declared operation metadata crosses into the suggestion request.
 * No shell code, tool output or model reasoning enters the ledger. */
export class SuggestionProgressLedger {
  private pending = new Map<string, Call>()
  private settled = new Set<string>()
  private recent: Call[] = []
  private epoch = 0
  private counts = { calls: 0, executed: 0, completed: 0, failed: 0, since_last_reply: 0 }

  clear(): void {
    this.pending.clear()
    this.settled.clear()
    this.recent = []
    this.epoch = 0
    this.counts = { calls: 0, executed: 0, completed: 0, failed: 0, since_last_reply: 0 }
  }

  reply(): void { this.epoch++; this.counts.since_last_reply = 0 }

  get pendingCount(): number { return this.pending.size }

  call({ id, name, description, requiresInput }: ToolEvidence): void {
    if (this.pending.has(id) || this.settled.has(id)) return
    const call: Call = {
      name: label(name, 80), ...(description ? { description: label(description, 160) } : {}), requiresInput,
      executed: false, status: 'pending', epoch: -1, requestedEpoch: this.epoch,
    }
    this.counts.calls++
    this.pending.set(id, call)
    this.touch(call)
  }

  started(tool: ToolEvidence): void {
    this.call(tool)
    const call = this.pending.get(tool.id)
    if (call) this.executed(call)
  }

  finished(id: string, name: string, failed: boolean): void {
    this.call({ id, name, requiresInput: false })
    const call = this.pending.get(id)
    if (!call) return
    this.executed(call)
    call.status = failed ? 'failed' : 'completed'
    this.counts[failed ? 'failed' : 'completed']++
    this.pending.delete(id)
    this.settled.add(id)
    if (this.settled.size > 256) {
      const oldest = this.settled.values().next().value
      if (oldest !== undefined) this.settled.delete(oldest)
    }
  }

  snapshot(): SuggestionProgress | undefined {
    if (!this.counts.calls) return undefined
    return {
      ...this.counts,
      awaiting_input: [...this.pending.values()].some(call => call.requiresInput),
      recent: this.recent.map(call => ({
        name: call.name, status: call.status, ...(call.description ? { description: call.description } : {}),
      })),
    }
  }

  private executed(call: Call): void {
    if (!call.executed) { call.executed = true; this.counts.executed++ }
    // A background result arriving after a newer question does not supersede
    // that question. Only work requested since the prose can overtake it.
    if (call.requestedEpoch === this.epoch && call.epoch !== this.epoch) {
      call.epoch = this.epoch
      this.counts.since_last_reply++
    }
    this.touch(call)
  }

  private touch(call: Call): void {
    this.recent = this.recent.filter(item => item !== call)
    this.recent.push(call)
    if (this.recent.length > 6) this.recent.shift()
  }
}
