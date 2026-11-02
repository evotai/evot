import { describe, test, expect } from 'bun:test'
import {
  BACKGROUND_PANEL_TITLE,
  PANEL_EMPTY_MESSAGE,
  backgroundPanelHints,
  createBackgroundOutputState,
  createBackgroundPanelState,
  decideBackgroundPanelAction,
  focusedPanelTarget,
  formatCommandLabel,
  formatElapsed,
  sanitizeTerminalOutput,
  formatPanelItems,
  formatPanelSubtitle,
  formatStatusDetail,
  isBackgroundPanelShortcut,
  refreshBackgroundPanelState,
  shouldDownOpenPanel,
  awaitedTaskIds,
  formatPanelActivity,
  WAITING_MARK,
} from '../src/term/app/background-panel.js'
import type { UIToolCall } from '../src/term/app/types.js'
import { selectorDown } from '../src/term/selector.js'
import type { BackgroundProcess } from '../src/native/index.js'

function proc(overrides: Partial<BackgroundProcess> = {}): BackgroundProcess {
  return {
    task_id: '028deb34-db80-401f-8c65-7b13f92efb36',
    command: 'sleep 30',
    cwd: '/tmp',
    output_path: '/tmp/out.txt',
    status: 'running',
    exit_code: null,
    elapsed_ms: 1500,
    output_file_truncated: false,
    stopped_by_user: false,
    ...overrides,
  }
}

describe('formatElapsed', () => {
  test('stays in seconds below a minute', () => {
    expect(formatElapsed(1500)).toBe('2s')
    expect(formatElapsed(59_000)).toBe('59s')
  })

  test('switches to minutes so a long run stays readable', () => {
    expect(formatElapsed(94_000)).toBe('1m 34s')
    expect(formatElapsed(120_000)).toBe('2m')
  })

  test('switches to hours for very long runs', () => {
    expect(formatElapsed(3_600_000)).toBe('1h')
    expect(formatElapsed(5_400_000)).toBe('1h 30m')
  })

  test('a negative clock reads as zero rather than a minus sign', () => {
    expect(formatElapsed(-500)).toBe('0s')
  })
})

describe('formatCommandLabel', () => {
  test('keeps a single-line command verbatim', () => {
    expect(formatCommandLabel('bun run dev')).toBe('bun run dev')
  })

  test('reports extra lines as a count so rows stay one line', () => {
    expect(formatCommandLabel('bun run dev\n--watch')).toBe('script (2 lines)')
    expect(formatCommandLabel('a\nb\nc')).toBe('script (3 lines)')
  })

  test('truncates long commands while keeping the line count visible', () => {
    const label = formatCommandLabel(`${'x'.repeat(200)}\nsecond`, 40)
    expect(label).toBe('script (2 lines)')
    expect(label.length).toBeLessThanOrEqual(40)
  })

  test('an empty command still yields a readable label', () => {
    expect(formatCommandLabel('')).toBe('(empty)')
  })
})

describe('formatStatusDetail', () => {
  test('a running task shows only its clock', () => {
    expect(formatStatusDetail(proc())).toBe('running · 2s')
  })

  test('a clean exit reports the code and elapsed time', () => {
    expect(formatStatusDetail(proc({ status: 'completed', exit_code: 0 })))
      .toBe('exit 0 · 2s')
  })

  test('a failure is named, not just numbered', () => {
    expect(formatStatusDetail(proc({ status: 'failed', exit_code: 7 })))
      .toBe('failed · exit 7 · 2s')
  })

  test('a model-initiated stop reads as stopped rather than killed', () => {
    expect(formatStatusDetail(proc({ status: 'killed' }))).toBe('stopped · 2s')
  })

  test('a user cancellation is named as such, matching the task cards', () => {
    // The panel and the tool cards must not spell the same outcome two ways.
    expect(formatStatusDetail(proc({ status: 'killed', stopped_by_user: true })))
      .toBe('cancelled by user · 2s')
  })
})

describe('formatPanelSubtitle', () => {
  test('an empty list has no subtitle, since the body states the empty case', () => {
    // Saying it twice, two rows apart, reads as two separate statements.
    expect(formatPanelSubtitle([])).toBeUndefined()
  })

  test('live tasks are counted as active shells', () => {
    expect(formatPanelSubtitle([proc(), proc({ task_id: 'b' })])).toBe('2 active shells')
    expect(formatPanelSubtitle([proc()])).toBe('1 active shell')
  })

  test('finished tasks are excluded from the count', () => {
    const subtitle = formatPanelSubtitle([
      proc(),
      proc({ task_id: 'b', status: 'completed', exit_code: 0 }),
      proc({ task_id: 'c', status: 'failed', exit_code: 1 }),
    ])
    expect(subtitle).toBe('1 active shell')
  })

  test('a list with no live work omits the active clause', () => {
    expect(formatPanelSubtitle([proc({ status: 'completed', exit_code: 0 })]))
      .toBeUndefined()
  })
})

describe('formatPanelItems', () => {
  test('rows carry the command, a status column and the task id', () => {
    const items = formatPanelItems([proc({ command: 'bun run dev' })])
    expect(items).toHaveLength(1)
    expect(items[0]!.label).toBe('bun run dev')
    // A command title already is the command: no second column repeats it.
    expect(items[0]!.detail).toBeUndefined()
    expect(items[0]!.status).toEqual({ text: 'running · 2s', tone: 'muted' })
    expect(items[0]!.id).toBe('028deb34-db80-401f-8c65-7b13f92efb36')
  })

  test('the full command stays searchable even when the row is truncated', () => {
    const items = formatPanelItems([proc({ command: 'bun run dev\n--watch --hot' })])
    expect(items[0]!.label).not.toContain('--hot')
    expect(items[0]!.searchText).toContain('--hot')
  })

  test('foreground tasks are listed too, since the panel is the whole picture', () => {
    // The footer count excludes them to avoid double-reporting a visible tool
    // card, but hiding them from the panel would make the list look wrong.
    const items = formatPanelItems([proc({ status: 'running_foreground' })])
    expect(items).toHaveLength(1)
  })

  test('a single group carries no heading', () => {
    // With only running shells on screen, a "Shells" label restates the title.
    const items = formatPanelItems([proc(), proc({ task_id: 'b' })])
    expect(items.some(item => item.header)).toBe(false)
  })

  test('a mixed list contains only live tasks without headings', () => {
    const items = formatPanelItems([
      proc({ task_id: 'a' }),
      proc({ task_id: 'b', status: 'completed', exit_code: 0 }),
      proc({ task_id: 'c', status: 'failed', exit_code: 1 }),
      proc({ task_id: 'd', status: 'killed' }),
      proc({ task_id: 'e', status: 'running_foreground' }),
    ])
    expect(items.map(item => item.id)).toEqual(['a', 'e'])
    expect(items.some(item => item.header)).toBe(false)
  })

  test('terminal statuses alone leave no rows', () => {
    const items = formatPanelItems([
      proc({ task_id: 'a', status: 'completed', exit_code: 0 }),
      proc({ task_id: 'b', status: 'failed', exit_code: 1 }),
      proc({ task_id: 'c', status: 'killed' }),
    ])
    expect(items).toEqual([])
  })

  test('finished work is hidden regardless of input order', () => {
    const items = formatPanelItems([
      proc({ task_id: 'done', status: 'completed', exit_code: 0 }),
      proc({ task_id: 'live' }),
    ])
    const ids = items.filter(item => !item.header).map(item => item.id)
    expect(ids).toEqual(['live'])
  })

  test('a running row advertises stop, a finished row does not', () => {
    const items = formatPanelItems([
      proc({ task_id: 'a' }),
      proc({ task_id: 'b', status: 'completed', exit_code: 0 }),
    ])
    const hintFor = (id: string) =>
      (items.find(item => item.id === id)?.hints ?? []).map(hint => hint.action)
    expect(hintFor('a')).toContain('stop')
    expect(hintFor('b')).not.toContain('stop')
  })
})

describe('backgroundPanelHints', () => {
  test('an empty panel offers only close', () => {
    // Nothing to select, view or stop, so every other key would be a dead end.
    expect(backgroundPanelHints(null, 0).map(hint => hint.action)).toEqual(['close'])
  })

  test('a focused running task offers select, view and stop', () => {
    expect(backgroundPanelHints({ id: 'a', live: true }, 1).map(hint => hint.action))
      .toEqual(['select', 'view output', 'stop', 'close'])
  })

  test('a finished task keeps view but drops stop', () => {
    expect(backgroundPanelHints({ id: 'a', live: false }, 0).map(hint => hint.action))
      .toEqual(['select', 'view output', 'close'])
  })

  test('stop all appears only once it differs from stop', () => {
    const one = backgroundPanelHints({ id: 'a', live: true }, 1).map(hint => hint.action)
    const two = backgroundPanelHints({ id: 'a', live: true }, 2).map(hint => hint.action)
    expect(one).not.toContain('stop all')
    expect(two).toContain('stop all')
  })
})

describe('shouldDownOpenPanel', () => {
  test('↓ opens the panel on an empty composer with live work', () => {
    expect(shouldDownOpenPanel({ editorEmpty: true, running: 1 })).toBe(true)
  })

  test('↓ is left alone while there is text, so it still moves the caret', () => {
    expect(shouldDownOpenPanel({ editorEmpty: false, running: 1 })).toBe(false)
  })

  test('↓ does nothing when no background work is running', () => {
    // The prompt is not advertising the gesture, so it must not fire.
    expect(shouldDownOpenPanel({ editorEmpty: true, running: 0 })).toBe(false)
  })
})

describe('createBackgroundPanelState', () => {
  test('opens on the panel title with a count subtitle', () => {
    const state = createBackgroundPanelState([proc()])
    expect(state.title).toBe(BACKGROUND_PANEL_TITLE)
    expect(state.subtitle).toBe('1 active shell')
    expect(state.focusIndex).toBe(0)
  })

  test('an empty list still opens, so the panel can report having nothing', () => {
    const state = createBackgroundPanelState([])
    expect(state.items).toHaveLength(0)
    expect(state.emptyMessage).toBe(PANEL_EMPTY_MESSAGE)
    expect(state.subtitle).toBeUndefined()
  })

  test('the panel opts out of filtering, keeping bare letters for actions', () => {
    expect(createBackgroundPanelState([proc()]).noFilter).toBe(true)
  })
})

describe('refreshBackgroundPanelState', () => {
  test('focus follows the task id rather than the row index', () => {
    const first = proc({ task_id: 'a', command: 'first' })
    const second = proc({ task_id: 'b', command: 'second' })
    const opened = selectorDown(createBackgroundPanelState([first, second]))
    expect(opened.focusIndex).toBe(1)

    // The first task disappears: focus must stay on 'b', now at index 0.
    const refreshed = refreshBackgroundPanelState(opened, [second])
    expect(refreshed.focusIndex).toBe(0)
    expect(refreshed.items[refreshed.focusIndex]!.id).toBe('b')
  })

  test('the last live task finishing leaves an empty panel', () => {
    const opened = createBackgroundPanelState([proc({ task_id: 'a' })])
    const refreshed = refreshBackgroundPanelState(
      opened,
      [proc({ task_id: 'a', status: 'completed', exit_code: 0 })],
    )
    expect(refreshed.items).toEqual([])
    expect(refreshed.allItems).toEqual([])
    expect(refreshed.subtitle).toBeUndefined()
    expect(refreshed.emptyMessage).toBe(PANEL_EMPTY_MESSAGE)
    expect(refreshed.focusIndex).toBe(0)
  })

  test('losing the focused task clamps onto a surviving row', () => {
    const opened = selectorDown(createBackgroundPanelState([
      proc({ task_id: 'a' }),
      proc({ task_id: 'b' }),
    ]))
    const refreshed = refreshBackgroundPanelState(opened, [proc({ task_id: 'a' })])
    expect(refreshed.focusIndex).toBe(0)
  })

  test('a finishing task before focus disappears without changing the selected id', () => {
    const a = proc({ task_id: 'a' })
    const b = proc({ task_id: 'b' })
    const opened = selectorDown(createBackgroundPanelState([a, b]))
    const refreshed = refreshBackgroundPanelState(opened, [{ ...a, status: 'completed' }, b])
    expect(refreshed.items.map(item => item.id)).toEqual(['b'])
    expect(refreshed.items[refreshed.focusIndex]?.id).toBe('b')
    expect(refreshed.subtitle).toBe('1 active shell')
  })

  test('a focused task finishing selects the surviving live task', () => {
    const a = proc({ task_id: 'a' })
    const b = proc({ task_id: 'b' })
    const opened = selectorDown(createBackgroundPanelState([a, b]))
    const refreshed = refreshBackgroundPanelState(opened, [a, { ...b, status: 'failed' }])
    expect(refreshed.items.map(item => item.id)).toEqual(['a'])
    expect(refreshed.items[refreshed.focusIndex]?.id).toBe('a')
  })

  test('an emptied list leaves focus in range', () => {
    const opened = createBackgroundPanelState([proc({ task_id: 'a' })])
    const refreshed = refreshBackgroundPanelState(opened, [])
    expect(refreshed.items).toHaveLength(0)
    expect(refreshed.focusIndex).toBe(0)
  })
})

describe('isBackgroundPanelShortcut', () => {
  test('ctrl+t opens the panel', () => {
    expect(isBackgroundPanelShortcut({ type: 'ctrl', key: 't' })).toBe(true)
  })

  test('other control keys are left alone', () => {
    expect(isBackgroundPanelShortcut({ type: 'ctrl', key: 'b' })).toBe(false)
    expect(isBackgroundPanelShortcut({ type: 'char', char: 't' })).toBe(false)
  })
})

describe('focusedPanelTarget', () => {
  test('reports whether the focused task is still live', () => {
    const state = createBackgroundPanelState([proc({ task_id: 'a' })])
    expect(focusedPanelTarget(state, [proc({ task_id: 'a' })]))
      .toEqual({ id: 'a', live: true })
  })

  test('a finished task is not a stop target', () => {
    const done = proc({ task_id: 'a', status: 'completed', exit_code: 0 })
    const state = createBackgroundPanelState([done])
    expect(focusedPanelTarget(state, [done])).toBeNull()
  })

  test('an empty list has no target', () => {
    expect(focusedPanelTarget(createBackgroundPanelState([]), [])).toBeNull()
  })
})

describe('decideBackgroundPanelAction', () => {
  const live = { id: 'a', live: true }
  const done = { id: 'a', live: false }

  test('esc closes the panel', () => {
    expect(decideBackgroundPanelAction({ type: 'escape' }, live)).toEqual({ kind: 'close' })
  })

  test('enter views the focused task output', () => {
    expect(decideBackgroundPanelAction({ type: 'enter' }, done))
      .toEqual({ kind: 'view', taskId: 'a' })
  })

  test('x stops a live task', () => {
    expect(decideBackgroundPanelAction({ type: 'char', char: 'x' }, live))
      .toEqual({ kind: 'stop', taskId: 'a' })
  })

  test('x on a finished task does nothing rather than erroring', () => {
    // Its process is already gone, so there is nothing to signal.
    expect(decideBackgroundPanelAction({ type: 'char', char: 'x' }, done))
      .toEqual({ kind: 'none' })
  })

  test('shift+X stops everything in both terminal encodings', () => {
    // Kitty reports a lowercased shift-char; legacy terminals send bare 'X'.
    expect(decideBackgroundPanelAction({ type: 'shift-char', char: 'x' }, live))
      .toEqual({ kind: 'stop-all' })
    expect(decideBackgroundPanelAction({ type: 'char', char: 'X' }, live))
      .toEqual({ kind: 'stop-all' })
  })

  test('stop-all works with nothing focused, so an empty panel is harmless', () => {
    expect(decideBackgroundPanelAction({ type: 'char', char: 'X' }, null))
      .toEqual({ kind: 'stop-all' })
  })

  test('enter with nothing focused is inert', () => {
    expect(decideBackgroundPanelAction({ type: 'enter' }, null)).toEqual({ kind: 'none' })
  })

  test('navigation keys are left to the shared selector logic', () => {
    expect(decideBackgroundPanelAction({ type: 'up' }, live)).toEqual({ kind: 'none' })
    expect(decideBackgroundPanelAction({ type: 'down' }, live)).toEqual({ kind: 'none' })
  })

  test('other letters do not trigger destructive actions', () => {
    expect(decideBackgroundPanelAction({ type: 'char', char: 'k' }, live))
      .toEqual({ kind: 'none' })
  })
})

describe('sanitizeTerminalOutput', () => {
  test('removes ANSI, OSC and unsafe controls from shell output', () => {
    const raw = '\x1b[31mred\x1b[0m\x1b]0;owned\x07\rprogress\u0000done'
    const safe = sanitizeTerminalOutput(raw)
    expect(safe).toBe('red\nprogressdone')
    expect(safe).not.toContain('\x1b')
    expect(safe).not.toContain('\u0000')
  })
})


describe('task names and the waiting marker', () => {
  test('a described task is titled by its description, the command follows dimmed', () => {
    const [item] = formatPanelItems([proc({
      command: 'cd /tmp && cargo fmt --all && cargo clippy -p databend-storages-common-cache',
      description: 'clippy storages-common-cache',
    })])
    expect(item!.label).toBe('clippy storages-common-cache')
    expect(item!.detail).toBe('cargo fmt --all && cargo clippy -p databend-storages-common-cache')
  })

  test('an undescribed task skips its setup to the command that runs', () => {
    const [cd, assigned] = formatPanelItems([
      proc({ task_id: 'a', command: 'cd /tmp && cargo clippy -p cache' }),
      proc({ task_id: 'b', command: `S="-o BatchMode=yes -i $HOME/.ssh/id"; ssh $S db0 './run.sh'` }),
    ])
    expect(cd!.label).toBe('cargo clippy -p cache')
    // A cd into the task's own cwd adds nothing.
    expect(cd!.detail).toBeUndefined()
    expect(assigned!.label).toBe(`ssh $S db0 './run.sh'`)
  })

  test('a cd into another directory is shown beside the title', () => {
    const [item] = formatPanelItems([proc({ cwd: '/work/repo', command: 'cd /srv/bench && ./run.sh' })])
    expect(item!.label).toBe('./run.sh')
    expect(item!.detail).toBe('in /srv/bench')
  })

  test('the awaited task carries the waiting marker in its status', () => {
    const items = formatPanelItems([proc({ task_id: 'a' }), proc({ task_id: 'b' })], ['b'])
    expect(items[0]!.status).toEqual({ text: 'running · 2s', tone: 'muted' })
    expect(items[1]!.status).toEqual({ text: `running · 2s  ${WAITING_MARK}`, tone: 'active' })
  })

  test('the marker follows a refresh', () => {
    const state = createBackgroundPanelState([proc({ task_id: 'a' })])
    expect(state.items[0]!.status?.text).not.toContain(WAITING_MARK)
    const next = refreshBackgroundPanelState(state, [proc({ task_id: 'a' })], ['a'])
    expect(next.items[0]!.status?.text).toContain(WAITING_MARK)
  })
})

describe('awaitedTaskIds', () => {
  const call = (overrides: Partial<UIToolCall>): UIToolCall => ({
    id: 'c', name: 'task_output', args: { task_id: 't1' }, status: 'running', ...overrides,
  })

  test('running blocking task_output calls name their task', () => {
    expect(awaitedTaskIds([call({}), call({ args: { task_id: 't2', block: true } })])).toEqual(['t1', 't2'])
  })

  test('a non-blocking poll, a finished call or another tool waits on nothing', () => {
    expect(awaitedTaskIds([
      call({ args: { task_id: 't1', block: false } }),
      call({ status: 'done' }),
      call({ name: 'task_stop' }),
      call({ args: {} }),
    ])).toEqual([])
  })
})

describe('formatPanelActivity', () => {
  test('a recently active task shows only its last line', () => {
    expect(formatPanelActivity('  Compiling cache v0.1.0 ', proc({ quiet_for_ms: 2_000 }))).toBe('Compiling cache v0.1.0')
  })

  test('silence of a minute or more is reported', () => {
    expect(formatPanelActivity('q72 finished in 41.2s', proc({ quiet_for_ms: 185_000 }))).toBe('q72 finished in 41.2s · quiet 3m 5s')
    expect(formatPanelActivity(undefined, proc({ quiet_for_ms: 60_000 }))).toBe('quiet 1m')
  })

  test('no output and no silence leaves no activity row', () => {
    expect(formatPanelActivity(undefined, proc({}))).toBeUndefined()
  })
})
