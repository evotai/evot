export interface SuggestionMessage { role: 'user' | 'assistant'; text: string }
export interface SuggestionCommand { name: string; description: string; usage: string }
export interface SuggestionImage { id: number; media_type: string; data: string }

/** Evidence about an exchange, not a claim that the whole user goal is done. */
export type SuggestionTurn = 'none' | 'unfinished' | 'interrupted' | 'failed' | 'answered' | 'unknown'
export interface SuggestionTasks {
  /** `plan` is retained for legacy payloads; current writers use checklists only. */
  source: 'checklist' | 'plan'
  pending: number
  in_progress: number
  completed: number
  /** Bounded labels for unfinished work only. Completed labels are omitted. */
  next: { text: string; status: 'pending' | 'in_progress' }[]
}
export interface SuggestionProgress {
  calls: number
  executed: number
  completed: number
  failed: number
  /** Executed calls requested after the latest authored assistant prose. */
  since_last_reply: number
  awaiting_input: boolean
  recent: { name: string; status: 'pending' | 'completed' | 'failed'; description?: string }[]
}
export interface SuggestionActivity {
  kind: 'background' | 'loop'
  id: string
  goal?: string
  phase: 'running' | 'waiting'
  elapsed_minutes?: number
  quiet_minutes?: number
  iteration?: number
  cadence?: 'fixed' | 'dynamic'
  interval_ms?: number
  next_check_at?: string
  wait_reason?: string
  unchanged_iterations?: number
}
/** One earlier user→assistant exchange, condensed. Carries the long-horizon
 * goal and this user's habits beyond the verbatim recent-message window. */
export interface SuggestionExchange {
  user: string
  assistant?: string
  tools: number
  failed: number
  outcome: SuggestionTurn
  /** The state the user moved from: what the previous reply left (its first
   * paragraph) and the stage at that moment. Together with `user` this makes
   * each exchange a trajectory step. Additive; absent in older writers. */
  from?: { reply?: string; stage: string }
}
export interface SuggestionWorkflow {
  schema_version: 1
  session: 'new' | 'resumed' | 'active'
  last_turn: SuggestionTurn
  pending_tools: number
  tasks?: SuggestionTasks
  /** Bounded tool metadata, never arguments, results or internal reasoning. */
  progress?: SuggestionProgress
  /** Earlier exchanges oldest first, excluding the current one. Additive. */
  thread?: SuggestionExchange[]
  runtime: {
    execution: 'idle' | 'running' | 'waiting' | 'retrying'
    /** `plan` is retained for legacy payloads; the CLI no longer enters it. */
    mode: 'normal' | 'plan' | 'log'
    queued_inputs: number
    background_tasks: number
    /** Current-process observations only; historical tools cannot populate this. */
    activities?: SuggestionActivity[]
  }
}
export interface SuggestionHints {
  explicit?: boolean
  activity?: 'idle' | 'running' | 'waiting'
  /** Optional additive contract; old addons can ignore it. */
  workflow?: SuggestionWorkflow
  draft?: string
  suffix?: string
  command?: SuggestionCommand
  /** Only images referenced by this draft; bytes are not part of the local cache key. */
  images?: SuggestionImage[]
  /** Deprecated wire field; never used to cycle. */
  rejected?: string[]
}
