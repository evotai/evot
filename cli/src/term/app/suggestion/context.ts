import type { TranscriptItem } from '../../../native/contracts/results.js'
import type { SuggestionExchange, SuggestionMessage, SuggestionTasks, SuggestionTurn, SuggestionWorkflow } from '../../../native/contracts/suggestion.js'
import { runContextEvent, transcriptContextEvents, type ContextEvent } from './events.js'
import { recentHistory } from './history.js'
import { SuggestionProgressLedger } from './progress.js'
import { checklistTasks } from './tasks.js'

export interface WorkflowRuntime {
  execution: SuggestionWorkflow['runtime']['execution']
  mode: 'normal' | 'log'
  queued: number
  background: number
  activities?: SuggestionWorkflow['runtime']['activities']
  /** Host-only: a live tool call holds the turn on a background task. Never
   * serialized; `waiting` alone also covers parked loops and idle tasks. */
  toolWait?: boolean
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
  /** Closed exchanges, oldest first. The open one lives in `current`. */
  private thread: SuggestionExchange[] = []
  private current: SuggestionExchange | undefined
  /** Stage at the instant the user acted, set by `user()` before apply.
   * Replayed transcripts have no live runtime, so they derive it from the
   * observed lifecycle alone. */
  private leaving: string | undefined
  /** Whether `current.assistant` came from a completed answer. */
  private labelAnswered = false

  clear(): void {
    this.messages = []
    this.session = 'new'
    this.turn = 'none'
    this.tasks = undefined
    this.progress.clear()
    this.replyAvailable = false
    this.thread = []
    this.current = undefined
    this.leaving = undefined
    this.labelAnswered = false
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

  user(text: string, runtime: WorkflowRuntime = IDLE_WORKFLOW): void {
    this.leaving = this.stageNow(runtime)
    this.apply({ kind: 'user', text })
    this.leaving = undefined
  }
  begin(): void { this.apply({ kind: 'begin' }) }
  interrupt(): void { this.apply({ kind: 'interrupt' }) }
  fail(): void { this.apply({ kind: 'error' }) }

  observe(event: { kind: string; payload: Record<string, unknown> }): void {
    const observation = runContextEvent(event)
    if (observation) this.apply(observation)
  }

  snapshot(runtime: WorkflowRuntime = IDLE_WORKFLOW): SuggestionSnapshot {
    const tasks = this.tasks
    const progress = this.progress.snapshot()
    // Only exchanges older than the verbatim window add information.
    const messages = recentHistory(this.messages)
    const verbatimUsers = messages.filter(message => message.role === 'user').length
    const thread = this.thread.slice(0, Math.max(0, this.thread.length - (verbatimUsers - (this.current ? 1 : 0))))
    const workflow: SuggestionWorkflow = {
      schema_version: 1, session: this.session, last_turn: this.turn,
      pending_tools: this.progress.pendingCount,
      ...(tasks ? { tasks: { ...tasks, next: tasks.next.map(item => ({ ...item })) } } : {}),
      ...(progress ? { progress } : {}),
      ...(thread.length ? { thread: thread.map(exchange => ({ ...exchange })) } : {}),
      runtime: { execution: runtime.execution, mode: runtime.mode, queued_inputs: runtime.queued, background_tasks: runtime.background,
        ...(runtime.activities?.length ? { activities: runtime.activities.map(activity => ({ ...activity })) } : {}),
      },
    }
    const recovering = runtime.execution === 'idle' && !runtime.queued && !runtime.background && !runtime.activities?.length
      && (workflow.pending_tools > 0 || ['unfinished', 'interrupted', 'failed'].includes(this.turn))
    // Stale pending calls from an interrupted turn must not qualify merely
    // because an idle background task or parked loop also reads as waiting.
    const waitingForTools = runtime.toolWait === true && workflow.pending_tools > 0
    return { messages, workflow, answered: this.hasAnswer,
      automatic: messages.some(message => message.role === 'user')
        && (recovering || waitingForTools || (this.replyAvailable && ['answered', 'unknown'].includes(this.turn) && messages.at(-1)?.role === 'assistant')),
    }
  }

  private apply(event: ContextEvent): void {
    switch (event.kind) {
      case 'clear': this.clear(); break
      case 'user':
        this.tasks = undefined
        this.progress.clear()
        this.push('user', event.text)
        this.open(event.text)
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
          // A completed answer names the exchange; a tool preamble (before or
          // after it, e.g. following an injected task notification) only
          // stands in until one exists.
          if (this.current && (event.turn === 'answered' || !this.labelAnswered)) {
            this.current.assistant = exchangeLabel(event.text, 100)
            this.labelAnswered = event.turn === 'answered'
          }
        }
        for (const tool of event.tools) this.progress.call(tool)
        if (this.current) this.current.tools += event.tools.length
        this.turn = event.turn
        this.replyAvailable = Boolean(event.text.trim())
        break
      case 'tool_started': this.progress.started(event.tool); break
      case 'tool_finished':
        this.progress.finished(event.id, event.name, event.failed)
        if (event.failed) { this.turn = 'failed'; this.replyAvailable = false }
        if (this.current && event.failed) this.current.failed++
        break
    }
    if (this.current) this.current.outcome = this.turn
  }

  /** Close the previous exchange with its final outcome and start a new one.
   * The opening exchange is pinned: it usually names the session's goal. */
  private open(text: string): void {
    // Capture the state being left before anything about the new ask is applied.
    const from = { ...(this.current?.assistant ? { reply: this.current.assistant } : {}), stage: this.leaving ?? this.stageNow(IDLE_WORKFLOW) }
    if (this.current) {
      this.thread.push(this.current)
      if (this.thread.length > 48) this.thread.splice(1, 1)
    }
    this.current = { user: exchangeLabel(text, 120), tools: 0, failed: 0, outcome: 'unfinished', from }
    this.labelAnswered = false
  }

  /** Same derivation as the Rust `stage()`, from the runtime at the moment a user acts. */
  private stageNow(runtime: WorkflowRuntime): string {
    const live = (kind: string) => runtime.activities?.some(a => a.kind === kind && (a.phase === 'running' || a.phase === 'waiting')) ?? false
    if (live('loop')) return 'loop'
    if (live('background') || runtime.background > 0) return 'background'
    if (runtime.execution === 'running' || runtime.execution === 'retrying') return 'foreground_running'
    if (runtime.queued > 0) return 'queued'
    if (this.progress.snapshot()?.awaiting_input) return 'awaiting_input'
    if (this.turn === 'unfinished' || this.turn === 'interrupted' || this.turn === 'failed') return 'recovering'
    if (this.turn === 'answered') return 'answered'
    return 'fresh'
  }

  private push(role: SuggestionMessage['role'], text: string): void {
    if (!text.trim()) return
    // Several assistant turns can follow one user message (a prose answer, then
    // tool preambles after an injected task notification). The user reacts to
    // all of that prose, so join it; replacing would drop the real answer and
    // leave only a preamble, which reads as "the question was ignored".
    const previous = this.messages.at(-1)
    if (role === 'assistant' && previous?.role === 'assistant') previous.text = bound(`${previous.text}\n\n${text}`)
    else this.messages.push({ role, text: bound(text) })
    let total = this.messages.reduce((sum, message) => sum + message.text.length, 0)
    while (this.messages.length > 64 || (total > 131_072 && this.messages.length > 2)) total -= this.messages.shift()?.text.length ?? 0
  }
}

function bound(text: string): string {
  if (text.length <= 20_000) return text
  const chars = Array.from(text)
  return `${chars.slice(0, 4_000).join('')}\n[... middle omitted ...]\n${chars.slice(-16_000).join('')}`
}

/** First line of prose, bounded. Enough to recall the ask, never a transcript. */
function exchangeLabel(text: string, length: number): string {
  const paragraph = text.trim().split(/\n\s*\n/)[0] ?? ''
  return Array.from(paragraph.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim()).slice(0, length).join('')
}
