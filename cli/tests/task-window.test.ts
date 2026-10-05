import { beforeAll, describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import { handleTaskKey } from '../src/task/control.js'
import { createTaskWindow } from '../src/task/window.js'
import type { ScheduledTask, TaskListResponse, TaskRunSummary } from '../src/task/types.js'
import { buildSelectorRegionLines } from '../src/term/viewmodel/selector.js'
import { PANE_MAX_WIDTH } from '../src/term/preview-scroll.js'
import { getTheme } from '../src/render/theme/index.js'
import stripAnsi from 'strip-ansi'

const now = Date.now()
const recentRuns: TaskRunSummary[] = [
  {
    id: 'run-running', status: 'running', source: 'schedule', delivery_status: 'not_requested',
    scheduled_for: now - 30_000, updated_at: now - 5_000,
  },
  {
    id: 'run-sent', status: 'succeeded', source: 'schedule', delivery_status: 'sent',
    scheduled_for: now - 3_600_000, updated_at: now - 3_500_000,
  },
  {
    id: 'run-delivery-failed', status: 'succeeded', source: 'manual', delivery_status: 'failed',
    scheduled_for: now - 7_200_000, updated_at: now - 7_100_000, error: 'delivery failed',
  },
]

const task: ScheduledTask = {
  id: 'task1', revision: 1, name: 'Daily report', cron: '0 9 * * 1-5',
  timezone: 'Asia/Shanghai', instruction: 'Prepare report', executor_id: 'exec1',
  model_policy: 'fixed', model_spec: 'evot-pro:claude-opus', thinking_level: 'high',
  workspace_ref: '', delivery_channel: 'feishu', delivery_target: 'p2p:*',
  timeout_seconds: 900, max_lateness_seconds: 14_400,
  enabled: true, next_run_at: now + 3_600_000, last_run: recentRuns[0],
  recent_runs: recentRuns,
  stats: {
    window_days: 30,
    runs: 12,
    completed: 10,
    succeeded: 9,
    execution_success_rate: 0.9,
    delivery_attempted: 8,
    delivery_sent: 7,
    delivery_success_rate: 0.875,
  },
}

const response: TaskListResponse = {
  cache: { ready: true, synced_at: now, stale: false },
  tasks: [task],
}

describe('task window', () => {
  beforeAll(() => { chalk.level = 3 })
  const modelLabels = { 'evot-pro:claude-opus': 'Claude Opus' }

  test('list row leads with name, schedule and status; statistics stay in details', () => {
    const state = createTaskWindow(response, undefined, undefined, modelLabels)
    expect(state.title).toBe('Tasks')
    expect(state.subtitle).toBe('')
    expect(state.presentation).toBe('browser')
    expect(state.noFilter).toBeUndefined()
    expect(state.items[0]?.label).toBe('Daily report')
    expect(state.items[0]?.status).toEqual({ text: 'Running', tone: 'active' })
    expect(state.items[0]?.detail).toStartWith('Weekdays 09:00 · Asia/Shanghai · Next ')
    expect(state.items[0]?.detail).not.toContain('runs')
  })

  test('side pane includes instructions, configuration, counts and history', () => {
    const preview = createTaskWindow(response, undefined, undefined, modelLabels).items[0]?.preview ?? []
    expect(preview).toContain('Model  Claude Opus · high')
    expect(preview).toContain('# Instructions')
    expect(preview).toContain(task.instruction)
    expect(preview).toContain(`Schedule  ${task.cron} · ${task.timezone}`)
    expect(preview).toContain('# Activity')
    expect(preview).toContain('12 runs · 9 succeeded · last 30 days')
    expect(preview.join('\n')).not.toContain('%')
    expect(preview).toContain('# Recent runs')
    expect(preview.some(line => line.includes('Running'))).toBe(true)
    expect(preview.some(line => line.includes('Delivery failed'))).toBe(true)
  })

  test('recent runs lead the pane and failed runs carry the alert marker', () => {
    const preview = createTaskWindow(response, undefined, undefined, modelLabels).items[0]?.preview ?? []
    const section = (label: string) => preview.indexOf(`# ${label}`)
    expect(section('Recent runs')).toBeGreaterThan(-1)
    expect(section('Recent runs')).toBeLessThan(section('Activity'))
    expect(section('Activity')).toBeLessThan(section('Instructions'))

    const runs = preview.filter(line => /^(! )?[✓✗◷–] /.test(line))
    expect(runs).toEqual([
      expect.stringMatching(/^◷ just now {2}Running$/),
      expect.stringMatching(/^✓ .* {2}Succeeded · sent$/),
      expect.stringMatching(/^! ✗ .* {2}Delivery failed · manual$/),
    ])
  })

  test('long run errors are complete and reachable in the details pane', () => {
    const error = "conf error: fixed task model is unavailable: evot-pro:evot-fast (conf error: model 'evot-fast' is not served by any configured provider)"
    const failed: TaskRunSummary = {
      id: 'run-model-error', status: 'needs_attention', source: 'schedule', delivery_status: 'not_requested',
      scheduled_for: now - 60_000, updated_at: now - 60_000, error,
    }
    const state = createTaskWindow({ ...response, tasks: [{ ...task, recent_runs: [failed] }] })
    const preview = state.items[0]?.preview ?? []
    expect(preview.find(line => line.includes('Needs attention'))).not.toContain(error)
    expect(preview).toContain('# Latest issue')
    expect(preview).toContain(error.replace(/^conf error: /, ''))
    for (const columns of [90, 120]) {
      const rendered = Array.from({ length: 40 }, (_, page) => buildSelectorRegionLines(
        { ...state, previewPane: { ...state.previewPane!, offset: page * 2 } }, columns, 20,
      ).map(stripAnsi).join('\n')).join('\n')
      expect(rendered).toContain('provider)')
    }
  })

  test('the alert marker renders the run in red and is not shown as text', () => {
    const state = createTaskWindow(response, undefined, undefined, modelLabels)
    const lines = Array.from({ length: 3 }, (_, offset) => buildSelectorRegionLines(
      { ...state, previewPane: { ...state.previewPane!, offset: offset * 3 } }, 120, 24,
    )).flat()
    const failed = lines.find(line => stripAnsi(line).includes('Delivery failed · manual'))
    expect(failed).toBeDefined()
    expect(stripAnsi(failed!)).not.toContain('! ✗')
    // The themed error ink opens right before the glyph; never ANSI red.
    const errorOpen = chalk.hex(getTheme().errorHex)('x').split('x')[0]!
    expect(failed).toContain(`${errorOpen}✗ `)
    expect(failed).not.toMatch(/\x1b\[31m/)
    const running = lines.find(line => stripAnsi(line).includes('◷ just now'))
    expect(running).not.toContain(errorOpen)
  })

  test('rendered two-pane layout keeps model, metrics, and recent activity visible', () => {
    for (const [columns, rows] of [[120, 24], [90, 20]] as const) {
      const state = createTaskWindow(response, undefined, undefined, modelLabels)
      const rendered = Array.from({ length: 30 }, (_, page) => buildSelectorRegionLines(
        { ...state, previewPane: { ...state.previewPane!, offset: page * 2 } }, columns, rows,
      ).map(stripAnsi).join('\n')).join('\n')
      expect(rendered).toContain('Model  Claude Opus · high')
      expect(rendered).toContain('12 runs')
      expect(rendered).toContain('9 succeeded')
      expect(rendered).toContain('Prepare report')
      expect(rendered).toContain('Recent runs')
      expect(rendered).toContain('◷ just now  Running')
    }
  })

  test('detail data replaces the focused row history without duplicating sections', () => {
    const fullHistory = Array.from({ length: 8 }, (_, index): TaskRunSummary => ({
      id: `run-${index}`,
      status: 'succeeded',
      source: index % 2 ? 'manual' : 'schedule',
      delivery_status: index === 0 ? 'failed' : 'sent',
      scheduled_for: now - index * 60_000,
      updated_at: now - index * 60_000,
    }))
    const detail = { ...task, runs: fullHistory }
    const preview = createTaskWindow(response, task.id, detail).items[0]?.preview ?? []
    expect(preview.filter(line => line === '# Recent runs')).toHaveLength(1)
    expect(preview.filter(line => /^(! )?[✓✗◷–] /.test(line))).toHaveLength(3)
    expect(preview).toContain('Enter to view all runs')
    expect(preview.some(line => line.includes('Delivery failed'))).toBe(true)
  })

  test('delivery errors are separated from compact run rows and scoped to the executor', () => {
    const error = 'run error: Feishu channel is not configured'
    const failed = { ...recentRuns[2]!, error }
    const state = createTaskWindow({ ...response, tasks: [{ ...task, last_run: failed, recent_runs: [failed] }] })
    const preview = state.items[0]?.preview ?? []
    expect(preview).toContain('Delivery  Feishu · All bot direct conversations')
    const summary = preview.find(line => line.startsWith('! ✗')) ?? ''
    expect(summary.match(/delivery failed/gi)).toHaveLength(1)
    expect(summary).not.toContain('run error')
    expect(preview).toContain('# Latest issue')
    expect(preview).toContain('Feishu was not configured on the executor that ran this task')
    expect(preview).toContain('Executor  Not recorded')
  })

  test('the issue shows its actual host separately from the Feishu destination', () => {
    const failed = { ...recentRuns[2]!, error: 'run error: Feishu channel is not configured\nExecutor: build-server' }
    const preview = createTaskWindow({ ...response, tasks: [{
      ...task, last_run: failed, recent_runs: [failed],
    }] }).items[0]?.preview ?? []
    expect(preview).toContain('Executor  build-server')
    expect(preview).toContain('Delivery  Feishu · All bot direct conversations')
    expect(preview).toContain('Feishu was not configured on the executor that ran this task')
    expect(preview.join('\n')).not.toContain('Executor:')
  })

  test('a recovered task labels the older failure as a previous issue', () => {
    const state = createTaskWindow({ ...response, tasks: [{
      ...task, last_run: recentRuns[1], recent_runs: [recentRuns[1]!, recentRuns[2]!],
    }] })
    const preview = state.items[0]?.preview ?? []
    expect(state.items[0]?.status?.text).toBe('On')
    expect(preview).not.toContain('# Latest issue')
    expect(preview.some(line => line.startsWith('# Previous issue · '))).toBe(true)
  })

  test('a queued run shows its age, and an unclaimed one names the missing executor', () => {
    const stale: TaskRunSummary = {
      id: 'run-pending', status: 'pending', source: 'manual', delivery_status: 'not_requested',
      scheduled_for: now - 180_000, updated_at: now - 180_000,
    }
    const queued = { ...task, last_run: stale, recent_runs: [stale] }
    const state = createTaskWindow({ ...response, tasks: [queued] })
    expect(state.items[0]?.status?.text).toBe('Queued 3m')
    const preview = state.items[0]?.preview ?? []
    expect(preview.some(line => line.includes('Queued') && line.includes('awaiting an executor'))).toBe(true)
    const fresh: TaskRunSummary = { ...stale, scheduled_for: now - 10_000, updated_at: now - 10_000 }
    const freshState = createTaskWindow({ ...response, tasks: [{ ...task, last_run: fresh, recent_runs: [fresh] }] })
    expect(freshState.items[0]?.status?.text).toBe('Queued')
    expect((freshState.items[0]?.preview ?? []).some(line => line.includes('awaiting an executor'))).toBe(false)
  })

  test('cold tasks show zero total and successful runs', () => {
    const cold: ScheduledTask = {
      ...task,
      id: 'cold',
      name: 'Cold task',
      last_run: null,
      recent_runs: [],
      stats: {
        window_days: 30, runs: 0, completed: 0, succeeded: 0,
        execution_success_rate: null, delivery_attempted: 0, delivery_sent: 0,
        delivery_success_rate: null,
      },
    }
    const state = createTaskWindow({ ...response, tasks: [cold] })
    expect(state.items[0]?.preview?.join('\n')).toContain('0 runs · 0 succeeded')
    expect(state.items[0]?.preview).toContain('No runs yet')
  })

  test('full instructions remain reachable by paging on wide and narrow terminals', () => {
    const instruction = Array.from({ length: 40 }, (_, i) => `instruction-line-${i}`).join('\n')
    const state = createTaskWindow({ ...response, tasks: [{ ...task, instruction }] })
    for (const columns of [60, 100, 180]) {
      const pages = Array.from({ length: 30 }, (_, page) => buildSelectorRegionLines(
        { ...state, previewPane: { ...state.previewPane!, offset: page * 5 } }, columns, 28,
      ).map(stripAnsi).join('\n')).join('\n')
      for (let i = 0; i < 40; i++) expect(pages).toContain(`instruction-line-${i}`)
    }
    const next = handleTaskKey(state, { type: 'page-down' })
    expect(next.kind).toBe('update')
    if (next.kind !== 'update') throw new Error('expected detail page update')
    expect(next.state.previewPane?.offset).toBeGreaterThan(0)
    const navigate = handleTaskKey(next.state, { type: 'down' })
    if (navigate.kind !== 'update') throw new Error('expected navigation')
    // At the final task, navigation does not change selection or reset reading.
    expect(navigate.state.previewPane?.offset).toBe(next.state.previewPane?.offset)
  })

  test('wide terminals give the list the larger share and details a readable pane', () => {
    const state = createTaskWindow(response)
    const lines = buildSelectorRegionLines(state, 180, 32).map(stripAnsi)
    const divider = lines.find(row => row.includes('│'))?.indexOf('│') ?? -1
    // The shared split: details take about a third, capped at 72 columns.
    expect(divider).toBeGreaterThan(90)
    expect(180 - divider).toBeGreaterThan(52)
    expect(180 - divider).toBeLessThanOrEqual(PANE_MAX_WIDTH + 4)
  })

  test('details have fixed height regardless of instruction length or terminal height', () => {
    for (const columns of [60, 100, 180]) {
      const short = createTaskWindow({ ...response, tasks: [{ ...task, instruction: 'hi' }] })
      const long = createTaskWindow({ ...response, tasks: [{ ...task, instruction: 'long instruction\n'.repeat(200) }] })
      for (const rows of [20, 32, 60]) {
        const shortLines = buildSelectorRegionLines(short, columns, rows)
        const longLines = buildSelectorRegionLines(long, columns, rows)
        expect(longLines.length).toBe(shortLines.length)
        expect(longLines.length).toBeLessThan(30)
      }
      expect(buildSelectorRegionLines(long, columns, 60).length)
        .toBe(buildSelectorRegionLines(long, columns, 32).length)
    }
  })

  test('Tab focuses details, arrows scroll without selecting tasks, ends clamp, Esc returns to list', () => {
    let state = createTaskWindow({ ...response, tasks: [{ ...task, instruction: 'readable line\n'.repeat(30) }, { ...task, id: 'second' }] })
    const apply = (event: Parameters<typeof handleTaskKey>[1]) => {
      const action = handleTaskKey(state, event, 120, 32)
      if (action.kind === 'update') state = action.state
      return action
    }
    apply({ type: 'tab' })
    expect(state.previewPane?.focused).toBe(true)
    apply({ type: 'down' })
    expect(state.previewPane?.offset).toBe(1)
    expect(state.focusIndex).toBe(0)
    expect(apply({ type: 'char', char: 'd' }).kind).toBe('none')
    for (let i = 0; i < 100; i++) apply({ type: 'page-down' })
    const bottom = state.previewPane?.offset
    apply({ type: 'down' })
    expect(state.previewPane?.offset).toBe(bottom)
    apply({ type: 'up' })
    expect(state.previewPane?.offset).toBe(bottom! - 1)
    for (let i = 0; i < 100; i++) apply({ type: 'page-up' })
    expect(state.previewPane?.offset).toBe(0)
    apply({ type: 'escape' })
    expect(state.previewPane?.focused).toBe(false)
    apply({ type: 'down' })
    expect(state.focusIndex).toBe(1)
  })

  test('footer exposes edit/delete only when the task list owns focus', () => {
    const state = createTaskWindow(response)
    expect(state.hints).toEqual([
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
    ])
    expect(state.items[0]?.hints).toEqual(state.hints)
    for (const focused of [false, true]) {
      const text = buildSelectorRegionLines({
        ...state, previewPane: { ...state.previewPane!, focused },
      }, 120, 32).map(stripAnsi).join('\n')
      expect(text).toContain(focused ? 'scroll' : 'select')
      expect(text).not.toContain('page-up')
      if (focused) {
        expect(text).not.toContain('d delete')
        expect(text).not.toContain('pause/resume')
      } else {
        expect(text).toContain('e edit')
        expect(text).toContain('r run now')
        expect(text).toContain('space pause/resume')
        expect(text).toContain('d delete')
      }
      if (!focused) expect(text).toContain('enter runs')
      expect(text).not.toContain('Tab to focus')
      expect(text).not.toContain('Tab back')
    }
  })

  test('maps task shortcuts without filtering', () => {
    const state = createTaskWindow(response)
    expect(handleTaskKey(state, { type: 'char', char: 'r' })).toEqual({ kind: 'run', id: 'task1' })
    expect(handleTaskKey(state, { type: 'char', char: ' ' })).toEqual({ kind: 'toggle', id: 'task1' })
    const help = handleTaskKey(state, { type: 'char', char: '?' })
    expect(help.kind).toBe('none')
    const armed = handleTaskKey(state, { type: 'char', char: 'd' })
    expect(armed.kind).toBe('update')
    if (armed.kind === 'update') {
      expect(handleTaskKey(armed.state, { type: 'char', char: 'd' }).kind).toBe('delete')
    }
  })
})
