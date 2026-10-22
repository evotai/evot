import { expect, test } from 'bun:test'
import { RenderDiagnostics } from '../src/term/render-diagnostics.js'
import { formatLogPaths } from '../src/term/repl-commands.js'

function harness(now: { value: number }) {
  const logged: string[] = []
  const diagnostics = new RenderDiagnostics({
    log: lines => logged.push(...lines),
    regions: () => ({ historyRows: 100, liveRegionStart: 150 }),
    now: () => now.value,
  })
  return { diagnostics, logged }
}

test('full redraws are logged with cause, geometry and the region that changed first', () => {
  const now = { value: 0 }
  const { diagnostics, logged } = harness(now)
  diagnostics.record({
    kind: 'full_redraw', frame: 42, branch: 'deleted_lines_above_viewport',
    previousLines: 300, newLines: 120, viewportTop: 276, firstChanged: 120, columns: 120, rows: 40,
  })
  expect(logged).toEqual([
    '[render] full redraw · deleted_lines_above_viewport · frame 42 · rows 300→120 · viewportTop 276 · firstChanged 120 (partial) · 120x40',
  ])
  diagnostics.record({
    kind: 'full_redraw', frame: 43, branch: 'width_change',
    previousLines: 120, newLines: 130, viewportTop: 80, firstChanged: null, columns: 90, rows: 40,
  })
  expect(logged[1]).toContain('firstChanged n/a (n/a)')
  expect(diagnostics.summary()).toBe('  Render: 2 full redraw(s) with scrollback cleared · 0 stale scrollback row(s) over 0 frame(s)')
})

test('viewport resize repaints are logged separately from destructive history replays', () => {
  const { diagnostics, logged } = harness({ value: 0 })
  diagnostics.record({
    kind: 'viewport_redraw', frame: 5, branch: 'width_change',
    previousLines: 2000, newLines: 1900, viewportTop: 1976,
    firstChanged: null, columns: 81, rows: 24,
  })
  expect(logged).toEqual([
    '[render] viewport redraw · width_change · frame 5 · rows 2000→1900 · viewportTop 1976 · firstChanged n/a (n/a) · 81x24',
  ])
  expect(diagnostics.summary()).toBe('  Render: 0 full redraw(s) with scrollback cleared · 0 stale scrollback row(s) over 0 frame(s) · 1 viewport redraw(s) with scrollback preserved')
})

test('stale scrollback events are throttled and accumulated', () => {
  const now = { value: 1_000 }
  const { diagnostics, logged } = harness(now)
  const stale = (frame: number, staleRows: number, firstChanged: number) => diagnostics.record({
    kind: 'stale_scrollback', frame, staleRows, firstChanged, viewportTop: 200, previousLines: 220, newLines: 221,
  })
  stale(1, 2, 50)
  now.value += 100
  stale(2, 3, 120)
  now.value += 100
  stale(3, 1, 180)
  // Only the first of a burst is logged; the rest accumulate into the next line.
  expect(logged).toEqual([
    '[render] stale scrollback · 2 row(s) over 1 frame(s) · frame 1 · firstChanged 50 (history) · viewportTop 200 · rows 220→221',
  ])
  now.value += 1_000
  stale(9, 4, 160)
  expect(logged[1]).toBe(
    '[render] stale scrollback · 8 row(s) over 3 frame(s) · frame 9 · firstChanged 160 (live) · viewportTop 200 · rows 220→221',
  )
  expect(diagnostics.summary()).toBe('  Render: 0 full redraw(s) with scrollback cleared · 10 stale scrollback row(s) over 4 frame(s)')
})

test('an uneventful session has no render summary and /log output is unchanged', () => {
  const { diagnostics } = harness({ value: 0 })
  expect(diagnostics.summary()).toBeNull()
  expect(formatLogPaths('/tmp/s.screen.log', null, diagnostics.summary())).toBe('  Log: /tmp/s.screen.log')
  expect(formatLogPaths('/tmp/s.screen.log', '/tmp/run', '  Render: x')).toBe('  Log: /tmp/s.screen.log\n  Renderer run: /tmp/run\n  Render: x')
})
