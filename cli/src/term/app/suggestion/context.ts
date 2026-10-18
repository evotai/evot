import type { TranscriptItem } from '../../../native/contracts/results.js'
import type { SuggestionMessage, SuggestionTasks, SuggestionTurn, SuggestionWorkflow } from '../../../native/contracts/suggestion.js'
import { runContextEvent, transcriptContextEvents, type ContextEvent } from './events.js'
import { recentHistory } from './history.js'
import { SuggestionProgressLedger } from './progress.js'
import { checklistTasks, taskLabel } from './tasks.js'

export interface WorkflowRuntime {
  execution: SuggestionWorkflow['runtime']['execution']
  mode: SuggestionWorkflow['runtime']['mode']
  queued: number
  background: number
  activities?: SuggestionWorkflow['runtime']['activities']
  plan?: readonly { text: string }[]
}
export const IDLE_WORKFLOW: WorkflowRuntime = { execution: 'idle', mode: 'normal', queued: 0, background: 0 }
export interface SuggestionSnapshot {
  messages: SuggestionMessage[]
  workflow: SuggestionWorkflow
  automatic: boolean
  answered: boolean
}

/** One read model for authored intent and execution evidence. Replay and live
 * events share a reducer; nothing here depends on rendered rows or UI state. */
export class SuggestionContext {
  private messages: SuggestionMessage[] = []
  private session: SuggestionWorkflow['session'] = 'new'
  private turn: SuggestionTurn = 'none'
  private tasks: SuggestionTasks | undefined
  private progress = new SuggestionProgressLedger()
  private replyAvailable = false

  clear(): void {
    this.messages = []
    this.session = 'new'
    this.turn = 'none'
    this.tasks = undefined
    this.progress.clear()
    this.replyAvailable = false
  }

  restore(items: readonly TranscriptItem[], session: SuggestionWorkflow['session'] = 'resumed'): void {
    this.clear()
    for (const event of transcriptContextEvents(items)) this.apply(event)
    this.session = session
  }

  /** Compaction changes prose, not the observed lifecycle or tool progress. */
  replaceHistory(items: readonly TranscriptItem[]): void {
    this.messages = []
    for (const event of transcriptContextEvents(items)) {
      if (event.kind === 'clear') this.messages = []
      else if (event.kind === 'user' || event.kind === 'assistant') this.push(event.kind, event.text)
    }
  }

  get hasAnswer(): boolean { return this.replyAvailable && this.turn === 'answered' }

  user(text: string): void { this.apply({ kind: 'user', text }) }
  begin(): void { this.apply({ kind: 'begin' }) }
  interrupt(): void { this.apply({ kind: 'interrupt' }) }
  fail(): void { this.apply({ kind: 'error' }) }

  observe(event: { kind: string; payload: Record<string, unknown> }): void {
    const observation = runContextEvent(event)
    if (observation) this.apply(observation)
  }

  snapshot(runtime: WorkflowRuntime = IDLE_WORKFLOW): SuggestionSnapshot {
    const plan = runtime.mode === 'plan' ? runtime.plan : undefined
    const tasks = this.tasks ?? (plan?.length ? {
      source: 'plan' as const, pending: plan.length, in_progress: 0, completed: 0,
      next: plan.slice(0, 6).map(item => ({ text: taskLabel(item.text), status: 'pending' as const })),
    } : undefined)
    const progress = this.progress.snapshot()
    const workflow: SuggestionWorkflow = {
      schema_version: 1, session: this.session, last_turn: this.turn,
      pending_tools: this.progress.pendingCount,
      ...(tasks ? { tasks: { ...tasks, next: tasks.next.map(item => ({ ...item })) } } : {}),
      ...(progress ? { progress } : {}),
      runtime: { execution: runtime.execution, mode: runtime.mode, queued_inputs: runtime.queued, background_tasks: runtime.background,
        ...(runtime.activities?.length ? { activities: runtime.activities.map(activity => ({ ...activity })) } : {}),
      },
    }
    const recovering = runtime.execution === 'idle' && !runtime.queued && !runtime.background && !runtime.activities?.length
      && (workflow.pending_tools > 0 || ['unfinished', 'interrupted', 'failed'].includes(this.turn))
    const messages = recentHistory(this.messages)
    return { messages, workflow, answered: this.hasAnswer,
      automatic: messages.some(message => message.role === 'user')
        && (recovering || (this.replyAvailable && ['answered', 'unknown'].includes(this.turn) && messages.at(-1)?.role === 'assistant')),
    }
  }

  private apply(event: ContextEvent): void {
    switch (event.kind) {
      case 'clear': this.clear(); break
      case 'user':
        this.tasks = undefined
        this.progress.clear()
        this.push('user', event.text)
        // A new goal and a new run both begin an unfinished exchange.
      case 'begin':
        this.session = 'active'; this.turn = 'unfinished'; this.replyAvailable = false
        break
      case 'interrupt': case 'error':
        this.turn = event.kind === 'interrupt' ? 'interrupted' : 'failed'
        this.replyAvailable = false
        break
      case 'assistant':
        if (event.text.trim()) {
          this.progress.reply()
          this.push('assistant', event.text)
          this.tasks = checklistTasks(event.text) ?? this.tasks
        }
        for (const tool of event.tools) this.progress.call(tool)
        this.turn = event.turn
        this.replyAvailable = Boolean(event.text.trim())
        break
      case 'tool_started': this.progress.started(event.tool); break
      case 'tool_finished':
        this.progress.finished(event.id, event.name, event.failed)
        if (event.failed) { this.turn = 'failed'; this.replyAvailable = false }
        break
    }
  }

  private push(role: SuggestionMessage['role'], text: string): void {
    if (!text.trim()) return
    if (text.length > 20_000) {
      const chars = Array.from(text)
      text = `${chars.slice(0, 4_000).join('')}\n[... middle omitted ...]\n${chars.slice(-16_000).join('')}`
    }
    const entry = { role, text }
    if (role === 'assistant' && this.messages.at(-1)?.role === 'assistant') this.messages[this.messages.length - 1] = entry
    else this.messages.push(entry)
    let total = this.messages.reduce((sum, message) => sum + message.text.length, 0)
    while (this.messages.length > 64 || (total > 131_072 && this.messages.length > 2)) total -= this.messages.shift()?.text.length ?? 0
  }
}
