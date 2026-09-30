import stripAnsi from 'strip-ansi'
import type { TranscriptItem } from '../native/index.js'
import { transcriptToMessages } from '../session/transcript.js'
import { createAppSelectorState } from '../term/app/selector-identity.js'
import { browseWindow } from '../term/app/browse-window.js'
import type { SelectorItem, SelectorState } from '../term/selector.js'
import type { ScheduledTask, TaskRunSummary } from './types.js'

const browseHints = [
  { keys: ['up', 'down'], action: 'select' },
  { keys: 'tab', action: 'details' },
  { keys: 'enter', action: 'view transcript' },
  { keys: 'escape', action: 'back to tasks' },
]
const transcriptHints = [
  { keys: ['up', 'down'], action: 'select' },
  { keys: 'tab', action: 'read / scroll' },
  { keys: 'escape', action: 'back to runs' },
]

function plain(text: string): string {
  return stripAnsi(text).replace(/[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '')
}

function date(value: number | undefined): string {
  return value ? new Date(value).toLocaleString() : 'Unknown time'
}

/** One row per *run*, not per session. Failed runs that never started an agent
 * still appear with their error; they do not have a transcript to open. */
export function createTaskRunsWindow(task: ScheduledTask, runs: TaskRunSummary[]): SelectorState {
  const sorted = [...runs].sort((a, b) => (b.scheduled_for || b.updated_at || 0) - (a.scheduled_for || a.updated_at || 0))
  const items: SelectorItem[] = sorted.map(run => ({
    id: run.id,
    label: date(run.scheduled_for || run.updated_at),
    detail: [run.status, run.delivery_status && run.delivery_status !== 'not_requested' ? `Delivery ${run.delivery_status}` : '',
      run.source === 'manual' ? 'Manual' : 'Scheduled'].filter(Boolean).join(' · '),
    preview: [
      `Run · ${date(run.scheduled_for || run.updated_at)}`,
      `Execution  ${run.status}`,
      `Delivery  ${run.delivery_status || 'Not requested'}`,
      `Source  ${run.source === 'manual' ? 'Manual' : 'Scheduled'}`,
      ...(run.error ? ['', '# Error', plain(run.error)] : []),
      ...(run.result_summary ? ['', '# Result', plain(run.result_summary)] : []),
      ...(run.session_id ? ['', 'Enter to view the execution transcript (read-only).'] : ['', 'No execution transcript for this run.']),
    ],
    hints: run.session_id ? browseHints : browseHints.filter(hint => hint.keys !== 'enter'),
  }))
  return {
    ...browseWindow(createAppSelectorState('task', `${task.name} · Runs`, items), true),
    noFilter: true,
    previewPane: { offset: 0 },
    hints: items.length ? browseHints : [{ keys: 'escape', action: 'back to tasks' }],
    subtitle: `${items.length === 20 ? 'Latest 20' : items.length} run${items.length === 1 ? '' : 's'}`,
    emptyMessage: 'No runs yet · Esc to tasks',
  }
}

/** Full local transcript, opened on demand. This is a *reader*, not resume:
 * inspecting an automation run cannot start a new turn or mutate its session.
 * The renderer wraps each entire entry and the details pane scrolls it. */
export function createTaskTranscriptWindow(
  task: ScheduledTask, run: TaskRunSummary, transcript: TranscriptItem[],
): SelectorState {
  const messages = transcriptToMessages(transcript)
  const items: SelectorItem[] = []
  for (const message of messages) {
    if (message.compaction) {
      items.push({
        id: `entry-${items.length}`, label: 'Compaction',
        detail: message.compaction.reason,
        preview: ['Compaction', '', plain(message.compaction.summary)], hints: transcriptHints,
      })
    }
    const blocks = message.content
    const visible = blocks?.length ? blocks : [{ type: 'text' as const, contentIndex: 0, text: message.text }]
    for (const block of visible) {
      if (block.type === 'text' && !block.text.trim()) continue
      const tool = block.type === 'tool_call' ? block.toolCall : null
      const label = tool ? `${tool.status === 'error' ? '✗' : '◫'} ${plain(tool.name)}`
        : block.type === 'thinking' ? 'Thinking' : message.role === 'user' ? 'User' : 'Assistant'
      const text = plain(tool
        ? [`Arguments  ${JSON.stringify(tool.args)}`, '', '# Result', tool.result ?? '(no result recorded)'].join('\n')
        : block.type === 'text' || block.type === 'thinking' ? block.text : '')
      if (!text.trim()) continue
      items.push({
        id: `entry-${items.length}`,
        label,
        detail: text.replace(/\s+/g, ' ').slice(0, 96),
        preview: [label, '', ...text.split('\n')],
        hints: transcriptHints,
      })
    }
  }
  return {
    ...browseWindow(createAppSelectorState('task', `${task.name} · Transcript`, items), true),
    noFilter: true,
    previewPane: { offset: 0 },
    hints: items.length ? transcriptHints : [{ keys: 'escape', action: 'back to runs' }],
    subtitle: `${date(run.scheduled_for || run.updated_at)} · read-only`,
    emptyMessage: 'No readable transcript in this run · Esc to runs',
  }
}
