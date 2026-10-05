import { expect, test } from 'bun:test'
import { createTaskRunsWindow, createTaskTranscriptWindow } from '../src/task/history.js'
import type { ScheduledTask, TaskRunSummary } from '../src/task/types.js'

const task: ScheduledTask = {
  id: 'task', name: 'Daily report', revision: 1, cron: '0 9 * * *', timezone: 'UTC',
  instruction: 'hi', executor_id: 'device', model_policy: 'default', model_spec: '',
  thinking_level: '', workspace_ref: '', delivery_channel: '', delivery_target: '',
  timeout_seconds: 60, max_lateness_seconds: 60, enabled: true, next_run_at: 0,
}
const failed: TaskRunSummary = {
  id: 'failed', status: 'failed', source: 'scheduled', delivery_status: 'not_requested',
  scheduled_for: 2000, error: 'Agent never started: model unavailable',
}
const success: TaskRunSummary = {
  id: 'ok', status: 'succeeded', source: 'manual', delivery_status: 'sent',
  scheduled_for: 1000, session_id: 'run-session', result_summary: 'Report delivered',
}

test('task history sorts runs, includes pre-agent failures and never offers them a transcript', () => {
  const state = createTaskRunsWindow(task, [success, failed])
  expect(state.items.map(row => row.id)).toEqual(['failed', 'ok'])
  expect(state.items[0]?.preview?.join(' ')).toContain('model unavailable')
  expect(state.items[0]?.preview?.join(' ')).toContain('No execution transcript')
  expect(state.items[0]?.hints?.some(hint => hint.keys === 'enter')).toBe(false)
  expect(state.items[1]?.hints?.some(hint => hint.keys === 'enter')).toBe(true)
  expect(state.items[1]?.preview?.join(' ')).toContain('Report delivered')
  expect(state.title).toContain('Daily report · Runs')
})

test('run errors show the reporting host without mistaking the shared executor id for a machine', () => {
  const hosted = { ...failed, error: 'run error: Feishu is not configured\nExecutor: remote-linux' }
  const state = createTaskRunsWindow(task, [hosted])
  expect(state.items[0]?.preview).toContain('Executor  remote-linux')
  expect(state.items[0]?.preview).toContain('run error: Feishu is not configured')
  expect(state.items[0]?.preview?.join('\n')).not.toContain('Executor:')
  const legacy = createTaskRunsWindow(task, [failed])
  expect(legacy.items[0]?.preview).toContain('Executor  Not recorded')
})

test('transcript is read-only and keeps entire user, answer and tool result', () => {
  const state = createTaskTranscriptWindow(task, success, [
    { type: 'user', text: 'What happened?' },
    { type: 'assistant', content: [
      { type: 'text', text: 'Checking.' },
      { type: 'tool_call', id: 'tool-1', name: 'bash', input: { command: 'echo ok' } },
      { type: 'text', text: 'Report complete.' },
    ] },
    { type: 'tool_result', tool_call_id: 'tool-1', tool_name: 'bash', content: 'everything passed' },
  ])
  expect(state.items.map(row => row.label)).toEqual(['User', 'Assistant', '◫ bash', 'Assistant'])
  expect(state.items[2]?.preview?.join(' ')).toContain('everything passed')
  expect(state.items.some(row => row.hints?.some(hint => hint.keys === 'enter'))).toBe(false)
  expect(state.subtitle).toContain('read-only')
})
