import { describe, test, expect } from 'bun:test'
import { buildOverlayBlocks } from '../src/term/viewmodel/overlays.js'
import { buildSelectorRegionLines } from '../src/term/viewmodel/selector.js'
import { blocksToLines } from '../src/term/viewmodel/types.js'
import {
  backgroundOutputRows,
  backgroundOutputViewport,
  createBackgroundOutputState,
  createBackgroundPanelState,
  formatOutputPosition,
  scrollBackgroundOutput,
} from '../src/term/app/background-panel.js'
import { selectorDown } from '../src/term/selector.js'
import type { BackgroundProcess } from '../src/native/index.js'

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

function proc(overrides: Partial<BackgroundProcess> = {}): BackgroundProcess {
  return {
    task_id: 'aaaaaaaa-1111',
    command: 'sleep 30',
    cwd: '/tmp',
    output_path: '/tmp/out.txt',
    status: 'running',
    exit_code: null,
    elapsed_ms: 1500,
    output_file_truncated: false,
    ...overrides,
  }
}

function render(processes: BackgroundProcess[], moves = 0): string[] {
  let state = createBackgroundPanelState(processes)
  for (let i = 0; i < moves; i++) state = selectorDown(state)
  return blocksToLines(buildOverlayBlocks({ kind: 'selector', state }, 100)).map(stripAnsi)
}

describe('background panel rendering', () => {
  test('leads with the title and only the active count', () => {
    const lines = render([
      proc({ task_id: 'a' }),
      proc({ task_id: 'b', status: 'completed', exit_code: 0 }),
    ])
    expect(lines[1]).toBe('Background  1')
    expect(lines[2]).toBe('1 active shell')
  })

  test('the shared title keeps the row tally independent of status', () => {
    const lines = render([proc(), proc({ task_id: 'b' })])
    expect(lines[1]).toBe('Background  2')
  })

  test('no filter line is offered, since bare letters are actions', () => {
    const text = render([proc()]).join('\n')
    expect(text).not.toContain('Filter')
    expect(text).not.toContain('type to search')
  })

  test('hints use compact key/action pairs joined by a middot', () => {
    const lines = render([proc()])
    expect(lines[lines.length - 1])
      .toBe('↑/↓ select · Enter view output · x stop · Esc close')
  })

  test('navigation cannot select a finished task', () => {
    const processes = [
      proc({ task_id: 'a' }),
      proc({ task_id: 'b', command: 'finished command', status: 'completed', exit_code: 0 }),
    ]
    for (const moves of [0, 1, 2]) {
      const lines = render(processes, moves)
      expect(lines[lines.length - 1]).toContain('x stop')
      expect(lines.join('\n')).not.toContain('finished command')
    }
  })

  test('stop all is only advertised with more than one live shell', () => {
    const one = render([proc()])
    const two = render([proc({ task_id: 'a' }), proc({ task_id: 'b' })])
    expect(one[one.length - 1]).not.toContain('X stop all')
    expect(two[two.length - 1]).toContain('X stop all')
  })

  test('a single group renders without a heading', () => {
    const text = render([proc(), proc({ task_id: 'b' })]).join('\n')
    expect(text).not.toContain('Shells')
    expect(text).not.toContain('Completed')
  })

  test('finished history does not add any rendered rows', () => {
    const active = proc({ task_id: 'a' })
    const processes = [
      active,
      proc({ task_id: 'b', status: 'completed', exit_code: 0 }),
      proc({ task_id: 'c', status: 'failed', exit_code: 1 }),
      proc({ task_id: 'd', status: 'killed' }),
    ]
    expect(render(processes)).toEqual(render([active]))
    expect(buildSelectorRegionLines(createBackgroundPanelState(processes), 100, 24))
      .toEqual(buildSelectorRegionLines(createBackgroundPanelState([active]), 100, 24))
  })

  test('finished-only history renders the same empty panel as no history', () => {
    const processes = [
      proc({ status: 'completed', exit_code: 0 }),
      proc({ task_id: 'failed', status: 'failed', exit_code: 1 }),
      proc({ task_id: 'killed', status: 'killed' }),
    ]
    expect(render(processes)).toEqual(render([]))
    expect(buildSelectorRegionLines(createBackgroundPanelState(processes), 100, 24))
      .toEqual(buildSelectorRegionLines(createBackgroundPanelState([]), 100, 24))
  })

  test('the focused row is marked and rows carry a parenthesised status', () => {
    const lines = render([proc({ command: 'bun run dev' })])
    expect(lines.some(l => l.startsWith('· bun run dev'))).toBe(true)
    expect(lines.find(l => l.includes('bun run dev'))).toContain('(running · 2s)')
  })

  test('an empty panel states it in the body and offers only close', () => {
    const lines = render([])
    expect(lines).toContain('  No tasks currently running')
    expect(lines[lines.length - 1]).toBe('Esc close')
    // No count line above an empty body: the body is the whole message.
    expect(lines.join('\n')).not.toContain('active shell')
  })

  test('live output uses a bounded full-width tail with a back hint', () => {
    const output = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n')
    const state = createBackgroundOutputState(proc(), output)
    const lines = buildSelectorRegionLines(state, 100, 24).map(stripAnsi)

    expect(lines).toContain('⌘ Background task · aaaaaaaa')
    expect(lines.some(line => line.trim() === 'line 30')).toBe(true)
    expect(lines.some(line => line.trim() === 'line 1')).toBe(false)
    expect(lines.join('\n')).toContain('Esc back')
    expect(lines.every(line => line.length <= 100)).toBe(true)

    const short = buildSelectorRegionLines(state, 100, 12).map(stripAnsi)
    expect(short.length).toBeLessThan(lines.length)
    expect(short.some(line => line.trim() === 'line 30')).toBe(true)
  })

  test('output footer only shows navigation and available stop action', () => {
    for (const status of ['running', 'completed'] as const) {
      const state = createBackgroundOutputState(proc({ status }), 'hello')
      const lines = buildSelectorRegionLines(state, 120, 30).map(stripAnsi)
      const footer = lines.find(line => line.includes('Esc back'))
      expect(footer).toBeDefined()
      expect(footer).toContain('scroll')
      expect(footer).not.toContain('follow')
      expect(footer).not.toContain('command')
      if (status === 'running') expect(footer).toContain('x stop')
      else expect(footer).not.toContain('stop')
    }
  })

  test('detail shows one complete command, not a second clipped summary', () => {
    const command = 'cd /repo && pytest -q tests/ > /tmp/test.log 2>&1; tail -3 /tmp/test.log; git diff --check'
    const state = createBackgroundOutputState(proc({ command, status: 'completed', exit_code: 0 }), '2619 passed\ndiff-ok')
    const lines = buildSelectorRegionLines(state, 120, 30).map(stripAnsi)
    const text = lines.join('\n')
    expect(text.split('cd /repo').length - 1).toBe(1)
    expect(text).toContain(command)
    expect(text).toContain('2619 passed')
    expect(text).toContain('diff-ok')
    expect(text).not.toContain('⌘ bash')
    expect(text).toContain('Background task · aaaaaaaa')
  })

  test('live output includes the complete script before output', () => {
    const process = proc({ command: 'printf hello\nprintf world' })
    const state = createBackgroundOutputState(process, 'hello\nworld')
    const rendered = buildSelectorRegionLines(state, 80, 30)
    const plain = rendered.map(stripAnsi)
    expect(plain.filter(text => text.includes('running ·'))).toHaveLength(1)
    expect(plain).toContain('  Command')
    expect(plain).toContain('  printf hello')
    expect(plain).toContain('  printf world')
    expect(plain).toContain('  Output')
    expect(plain).toContain('  hello')
    expect(plain).toContain('  world')
    expect(plain.join('\n')).not.toContain('Output:')
    expect(plain.join('\n')).not.toContain('ctrl+o')
  })

  test('huge command metadata never pushes activity or navigation off screen', () => {
    const command = 'echo ' + 'long-argument '.repeat(1200)
    for (const rows of [10, 12, 24, 40]) {
      const state = createBackgroundOutputState(proc({ command }), 'latest output')
      const lines = buildSelectorRegionLines(state, 60, rows).map(stripAnsi)
      expect(lines.length).toBeLessThanOrEqual(rows)
      expect(lines.every(text => text.length <= 60)).toBe(true)
      expect(lines).toContain('  latest output')
      expect(lines.join('\n')).toContain('Esc')
      const commandView = { ...state, outputView: { scrollOffset: 0 } }
      expect(buildSelectorRegionLines(commandView, 60, rows).length).toBeLessThanOrEqual(rows)
    }
  })

  test('scrolling reaches every wrapped command row including later commands', () => {
    const command = "python3 - <<'PY'\nprint('fixture')\n\nPY\nchrome --screenshot=" + 'x'.repeat(160)
    const state = createBackgroundOutputState(proc({ command }), 'fixture created')
    const rows = backgroundOutputRows(state, 40)
    expect(rows).toContain('chrome')
    expect(rows.join('\n')).toContain('--screenshot=')
    for (let offset = 0; offset < rows.length; offset++) {
      const view = { ...state, outputView: { scrollOffset: offset } }
      const lines = buildSelectorRegionLines(view, 40, 12).map(stripAnsi)
      expect(lines).toContain(`  ${rows[offset]}`)
      expect(lines.length).toBeLessThanOrEqual(12)
      expect(lines.join('\n')).toContain('Background task · aaaaaaaa')
      expect(lines.join('\n')).not.toContain('script (5 lines)')
    }
  })

  test('the overlay keeps one height at every scroll position', () => {
    // The composer sits directly under the overlay: a body window that grows or
    // shrinks with the scroll position would drag the prompt up and down.
    const output = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join('\n')
    const state = createBackgroundOutputState(proc(), output)
    const following = buildSelectorRegionLines(state, 100, 24).map(stripAnsi)
    const viewport = backgroundOutputViewport(state, 100, 24)
    expect(viewport.height).toBe(16)
    expect(following.some(line => line.trim() === 'line 60')).toBe(true)
    expect(following.join('\n')).toContain('earlier lines · ↑ to scroll back')

    for (const offset of [0, 1, 5, viewport.body.length - viewport.height - 1]) {
      const lines = buildSelectorRegionLines({ ...state, outputView: { scrollOffset: offset } }, 100, 24).map(stripAnsi)
      expect(lines).toHaveLength(following.length)
      expect(lines.join('\n')).toContain(`Paused · ${offset + 1}–${offset + viewport.height} of ${viewport.body.length}`)
    }
    // The top of the body is the command itself.
    const top = buildSelectorRegionLines({ ...state, outputView: { scrollOffset: 0 } }, 100, 24).map(stripAnsi)
    expect(top).toContain('  Command')
    expect(top).toContain('  sleep 30')
    // An offset at or past the last window is simply following.
    const bottom = buildSelectorRegionLines({ ...state, outputView: { scrollOffset: 10_000 } }, 100, 24).map(stripAnsi)
    expect(bottom).toEqual(following)
  })

  test('a short body has no scroll range and reports no position', () => {
    const state = createBackgroundOutputState(proc(), 'hello\nworld')
    const viewport = backgroundOutputViewport(state, 100, 24)
    expect(scrollBackgroundOutput(viewport, 'up')).toBeUndefined()
    expect(scrollBackgroundOutput(viewport, 'home')).toBeUndefined()
    expect(formatOutputPosition(viewport)).toBe('')
    const lines = buildSelectorRegionLines(state, 100, 24).map(stripAnsi)
    expect(lines.join('\n')).not.toContain('Paused')
  })

  test('scroll keys are clamped to the body and hand back to the tail at the bottom', () => {
    const output = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join('\n')
    const state = createBackgroundOutputState(proc(), output)
    const following = backgroundOutputViewport(state, 100, 24)
    const maxStart = following.body.length - following.height
    expect(following.start).toBe(maxStart)

    expect(scrollBackgroundOutput(following, 'up')).toBe(maxStart - 1)
    expect(scrollBackgroundOutput(following, 'page-up')).toBe(maxStart - (following.height - 1))
    expect(scrollBackgroundOutput(following, 'home')).toBe(0)
    expect(scrollBackgroundOutput(following, 'command')).toBe(0)
    expect(scrollBackgroundOutput(following, 'down')).toBeUndefined()

    const top = backgroundOutputViewport({ ...state, outputView: { scrollOffset: 0 } }, 100, 24)
    expect(scrollBackgroundOutput(top, 'up')).toBe(0)
    expect(scrollBackgroundOutput(top, 'page-up')).toBe(0)
    expect(scrollBackgroundOutput(top, 'down')).toBe(1)
    expect(scrollBackgroundOutput(top, 'end')).toBeUndefined()

    const nearBottom = backgroundOutputViewport({ ...state, outputView: { scrollOffset: maxStart - 1 } }, 100, 24)
    expect(scrollBackgroundOutput(nearBottom, 'down')).toBeUndefined()
    expect(scrollBackgroundOutput(nearBottom, 'page-down')).toBeUndefined()
  })

  test('capped-output warning stays pinned above a noisy tail', () => {
    const output = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n')
    const state = createBackgroundOutputState(proc({ output_file_truncated: true }), output)
    const lines = buildSelectorRegionLines(state, 100, 12).map(stripAnsi)

    expect(lines.some(line => line.includes('output file was capped'))).toBe(true)
    expect(lines.some(line => line.trim() === 'line 30')).toBe(true)
  })

  test('a multi-line command stays on one row', () => {
    const lines = render([proc({ command: 'tail -f log\n| grep err' })])
    const row = lines.find(l => l.includes('script (2 lines)'))
    expect(row).toBeDefined()
    expect(lines.join('\n')).not.toContain('tail -f log')
    expect(lines.some(l => l.includes('grep err'))).toBe(false)
  })
})
