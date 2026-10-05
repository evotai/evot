import { createAppSelectorState } from '../term/app/selector-identity.js'
import { browseWindow } from '../term/app/browse-window.js'
import { PREVIEW_ALERT_PREFIX, PREVIEW_SECTION_PREFIX, type SelectorItem, type SelectorState } from '../term/selector.js'
import type { ScheduledTask, TaskListResponse, TaskRunSummary, TaskStats } from './types.js'
import { taskRunError } from './run-error.js'

const hints = [
  { keys: ['up', 'down'], action: 'select' },
  { keys: 'tab', action: 'details' },
  { keys: 'enter', action: 'runs' },
  { keys: '/', action: 'search' },
  { keys: 'n', action: 'new' },
  { keys: 'e', action: 'edit' },
  { keys: 'r', action: 'run now' },
  { keys: 'space', action: 'pause/resume' },
  { keys: 's', action: 'share' },
  { keys: 'd', action: 'delete' },
  { keys: 'escape', action: 'close' },
]

const emptyStats: TaskStats = {
  window_days: 30,
  runs: 0,
  completed: 0,
  succeeded: 0,
  execution_success_rate: null,
  delivery_attempted: 0,
  delivery_sent: 0,
  delivery_success_rate: null,
}

function dateTime(value: number): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value))
}

function relativeTime(value: number): string {
  if (!value) return '—'
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function schedule(task: ScheduledTask): string {
  const [minute, hour, day, month, weekday] = task.cron.split(' ')
  const clock = minute !== undefined && hour !== undefined
    && /^\d+$/.test(minute) && /^\d+$/.test(hour)
    ? `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
    : ''
  if (day === '*' && month === '*' && weekday === '1-5' && clock) return `Weekdays ${clock}`
  if (day === '*' && month === '*' && weekday === '*' && clock) return `Daily ${clock}`
  if (minute === '0' && hour === '*' && day === '*' && month === '*' && weekday === '*') return 'Hourly'
  if (minute === '*' && hour === '*' && day === '*' && month === '*' && weekday === '*') return 'Every minute'
  const interval = minute?.match(/^\*\/(\d+)$/)?.[1]
  if (interval && hour === '*' && day === '*' && month === '*' && weekday === '*') return `Every ${interval}m`
  return task.cron
}

function status(run: TaskRunSummary | null | undefined): string {
  if (!run) return 'Never run'
  switch (run.status) {
    case 'succeeded': return run.delivery_status === 'failed' ? 'Delivery failed' : 'Succeeded'
    case 'failed': return 'Failed'
    case 'needs_attention': return 'Needs attention'
    case 'running':
    case 'claimed': return 'Running'
    case 'pending': return 'Queued'
    case 'unknown': return 'Unknown'
    case 'expired': return 'Expired'
    case 'cancelled': return 'Cancelled'
    default: return run.status
  }
}

function statusIcon(run: TaskRunSummary): string {
  if (run.status === 'succeeded' && run.delivery_status !== 'failed') return '✓'
  if (run.status === 'running' || run.status === 'claimed' || run.status === 'pending') return '◷'
  if (run.status === 'cancelled') return '–'
  return '✗'
}

/** A run whose outcome needs the user: failed, stuck, or undelivered. */
function runWentWrong(run: TaskRunSummary): boolean {
  return statusIcon(run) === '✗'
}

/** Minutes a run has occupied its current state, when that is worth saying. */
function stateAge(run: TaskRunSummary): string {
  const since = run.updated_at || run.scheduled_for
  if (!since) return ''
  const minutes = Math.floor((Date.now() - since) / 60_000)
  return minutes >= 1 ? ` ${minutes}m` : ''
}

function taskState(task: ScheduledTask): string {
  if (!task.enabled) return 'Paused'
  const latest = task.last_run
  if (!latest) return 'Ready'
  if (latest.status === 'running' || latest.status === 'claimed') return `Running${stateAge(latest)}`
  if (latest.status === 'pending') return `Queued${stateAge(latest)}`
  if (runWentWrong(latest)) return 'Attention'
  return 'On'
}

export type TaskModelLabels = Readonly<Record<string, string>>

function model(task: ScheduledTask, labels: TaskModelLabels = {}): string {
  if (task.model_policy === 'default') return 'Device default at run time'
  const fallback = task.model_spec.includes(':')
    ? task.model_spec.slice(task.model_spec.indexOf(':') + 1)
    : task.model_spec
  const name = labels[task.model_spec]?.trim() || fallback || 'Unavailable model'
  return `${name}${task.thinking_level ? ` · ${task.thinking_level}` : ''}`
}

function recentRun(run: TaskRunSummary): string {
  const at = run.updated_at || run.scheduled_for
  const details = [
    run.source === 'manual' ? 'manual' : '',
    // Dispatchers poll every few seconds, so a run still queued a minute later
    // has no live owner: name that instead of looking merely busy.
    run.status === 'pending' && run.scheduled_for && Date.now() - run.scheduled_for > 60_000
      ? 'awaiting an executor'
      : '',
    run.delivery_status === 'sent' ? 'sent' : '',
  ].filter(Boolean)
  const alert = runWentWrong(run) ? PREVIEW_ALERT_PREFIX : ''
  return `${alert}${statusIcon(run)} ${relativeTime(at)}  ${status(run)}${details.length ? ` · ${details.join(' · ')}` : ''}`
}

function preview(
  task: ScheduledTask,
  allRuns?: TaskRunSummary[],
  modelLabels: TaskModelLabels = {},
): string[] {
  const stats = task.stats ?? emptyStats
  const runs = allRuns ?? task.recent_runs ?? []
  const history = runs.length > 0 ? runs.slice(0, 3).map(recentRun) : ['No runs yet']
  const issue = runs.find(run => run.error?.trim())
  // This is historical executor state, not a diagnosis of the current CLI.
  const issueError = issue?.error ? taskRunError(issue.error) : undefined
  const issueText = issueError?.message.replace(/^(?:run error:|conf error:)\s*/i, '').replace(/\s+/g, ' ')
    .replace(/^Feishu channel is not configured$/, 'Feishu was not configured on the executor that ran this task')
  const errors = issue ? [
    `${PREVIEW_SECTION_PREFIX}${issue === runs[0] ? 'Latest issue' : `Previous issue · ${relativeTime(issue.updated_at || issue.scheduled_for)}`}`,
    `Executor  ${issueError?.executor ?? 'Not recorded'}`,
    issueText ?? '',
    '',
  ] : []
  const delivery = !task.delivery_channel ? 'Local result only'
    : `${task.delivery_channel === 'feishu' ? 'Feishu' : task.delivery_channel} · ${task.delivery_target === 'p2p:*' ? 'All bot direct conversations' : task.delivery_target}`
  // A compact overview first; full history belongs in the runs window.
  // Keep the latest issue separate so wrapped errors don't bury the overview.
  return [
    task.name,
    `Model  ${model(task, modelLabels)}`,
    `Delivery  ${delivery}`,
    '',
    `${PREVIEW_SECTION_PREFIX}Recent runs`,
    ...history,
    ...(runs.length > 3 ? ['Enter to view all runs'] : []),
    '',
    ...errors,
    `${PREVIEW_SECTION_PREFIX}Activity`,
    `${stats.runs} runs · ${stats.succeeded} succeeded · last ${stats.window_days || 30} days`,
    '',
    `${PREVIEW_SECTION_PREFIX}Configuration`,
    `Schedule  ${task.cron} · ${task.timezone}`,
    `Next  ${task.enabled ? dateTime(task.next_run_at) : 'Paused'}`,
    `Delivery  ${delivery}`,
    `Workspace  ${task.workspace_ref || 'Default workspace'}`,
    `Timeout  ${task.timeout_seconds}s · Max lateness ${task.max_lateness_seconds}s`,
    '',
    `${PREVIEW_SECTION_PREFIX}Instructions`,
    ...task.instruction.split('\n'),
  ]
}

function item(
  task: ScheduledTask,
  allRuns?: TaskRunSummary[],
  modelLabels: TaskModelLabels = {},
): SelectorItem {
  const taskModel = model(task, modelLabels)
  const state = taskState(task)
  return {
    id: task.id,
    label: task.name,
    status: { text: state, tone: state === 'Attention' ? 'attention'
      : state.startsWith('Running') || state.startsWith('Queued') ? 'active' : 'muted' },
    detail: [schedule(task), task.timezone, task.enabled ? `Next ${dateTime(task.next_run_at)}` : 'Schedule paused'].join(' · '),
    searchText: `${task.name} ${task.instruction} ${task.cron} ${task.timezone} ${taskModel}`,
    preview: preview(task, allRuns, modelLabels),
    hints,
  }
}

export function createTaskWindow(
  response: TaskListResponse,
  focusId?: string,
  detailTask?: ScheduledTask,
  modelLabels: TaskModelLabels = {},
): SelectorState {
  const items = response.tasks.map(task => {
    // List fields remain authoritative; only same-revision history is cached.
    const detailed = detailTask?.id === task.id && detailTask.revision === task.revision
      ? { ...task, runs: detailTask.runs } : task
    return item(detailed, detailed.runs, modelLabels)
  })
  const index = focusId ? items.findIndex(row => row.id === focusId) : 0
  return {
    ...browseWindow(createAppSelectorState('task', 'Tasks', items), true),
    focusIndex: index >= 0 ? index : 0,
    searchHint: 'names and instructions',
    hints: items.length ? hints : [{ keys: 'n', action: 'new' }, { keys: 'escape', action: 'close' }],
    subtitle: response.cache.stale
      ? 'Data may be stale'
      : '',
    emptyMessage: 'No scheduled tasks · n to create',
  }
}
