export interface TaskRunSummary {
  id: string
  status: string
  source?: string
  delivery_status: string
  scheduled_for: number
  updated_at?: number
  session_id?: string
  error?: string
  result_summary?: string
}

export interface TaskStats {
  window_days: number
  runs: number
  completed: number
  succeeded: number
  execution_success_rate: number | null
  delivery_attempted: number
  delivery_sent: number
  delivery_success_rate: number | null
}

export interface ScheduledTask {
  id: string
  revision: number
  name: string
  cron: string
  timezone: string
  instruction: string
  executor_id: string
  model_policy: 'fixed' | 'default'
  model_spec: string
  thinking_level: string
  workspace_ref: string
  delivery_channel: string
  delivery_target: string
  timeout_seconds: number
  max_lateness_seconds: number
  enabled: boolean
  next_run_at: number
  last_run?: TaskRunSummary | null
  recent_runs?: TaskRunSummary[]
  stats?: TaskStats
  runs?: TaskRunSummary[]
}

export interface TaskListResponse {
  tasks: ScheduledTask[]
  cache: { ready: boolean; synced_at: number; stale: boolean }
}

export interface CreatedTaskResponse {
  task: ScheduledTask
  next_runs: number[]
}

/** `POST /v1/tasks/{id}/share` response: the public link for a task snapshot. */
export interface TaskShareCreated {
  id: string
  url: string
}

/** A shared task as `/share/t/{id}/task.json` serves it. The recipe only:
 *  no delivery target (masked, display-only), owner, executor or workspace. */
export interface TaskShareSnapshot {
  schema_version: number
  kind: string
  evot_version: string
  title?: string | null
  created_at: number
  data: {
    name: string
    cron: string
    timezone: string
    instruction: string
    model_policy: 'fixed' | 'default'
    model_spec: string
    thinking_level: string
    timeout_seconds: number
    max_lateness_seconds: number
    delivery_channel: string
    delivery_target_masked: string
  }
}

export interface TaskDeliveryDefaults {
  /** The Feishu channel is linked. Delivery can still be unavailable when no
   *  default notification chat is configured, so these are distinct problems
   *  with distinct fixes. */
  feishu_ready: boolean
  /** Chat this device delivers to when a task names no explicit target.
   *  Empty means Feishu delivery is unavailable. */
  feishu_target: string
}

export const TASK_RUNTIME_DEFAULT_MODEL = '__task_runtime_default__'

/** Opt-in Feishu fan-out to every direct conversation the bot has observed.
 *  Mirrors `gateway::channels::feishu::target::BROADCAST_TARGET`. Never a
 *  default: the user has to ask for it. */
export const BROADCAST_TARGET = 'p2p:*'
