import { describe, test, expect, beforeEach } from 'bun:test'
import { Writable } from 'node:stream'
import stripAnsi from 'strip-ansi'
import { TermRenderer, type RendererDiagnostic, type RendererTraceEntry } from '../src/term/renderer.js'
import { ScreenHarness } from './helpers/screen.js'
import { CURSOR_MARKER } from '../src/term/render-frame.js'
import { renderMarkdown } from '../src/render/markdown.js'
import { withColumns } from './helpers/stdout-columns.js'

// Mock stdout that captures writes
class MockStdout extends Writable {
  chunks: string[] = []
  rows = 24
  columns = 80

  _write(chunk: Buffer | string, _encoding: string, callback: () => void) {
    this.chunks.push(chunk.toString())
    callback()
  }

  get output(): string {
    return this.chunks.join('')
  }

  clear() {
    this.chunks = []
  }

  // Simulate event emitter for resize
  private listeners: Map<string, Function[]> = new Map()
  on(event: string, fn: Function): this {
    const list = this.listeners.get(event) ?? []
    list.push(fn)
    this.listeners.set(event, list)
    return this
  }
  off(event: string, fn: Function): this {
    const list = this.listeners.get(event) ?? []
    this.listeners.set(event, list.filter(f => f !== fn))
    return this
  }
  emit(event: string, ...args: any[]): boolean {
    const list = this.listeners.get(event) ?? []
    for (const fn of list) fn(...args)
    return list.length > 0
  }
}

function createRenderer(): { renderer: TermRenderer; stdout: MockStdout } {
  const stdout = new MockStdout() as any
  const renderer = new TermRenderer({ stdout })
  return { renderer, stdout }
}

// Helper: trigger a synchronous render by calling requestRender + flushing nextTick
async function renderFrame(renderer: TermRenderer): Promise<void> {
  renderer.requestRender()
  await new Promise(resolve => process.nextTick(resolve))
  // Wait for the scheduled render (MIN_RENDER_INTERVAL_MS = 16ms)
  await Bun.sleep(20)
}

describe('TermRenderer', () => {
  describe('init / destroy', () => {
    test('init hides cursor', () => {
      const { renderer, stdout } = createRenderer()
      renderer.init()
      expect(stdout.output).toContain('\x1b[?25l')
      renderer.destroy()
    })

    test('destroy shows cursor', () => {
      const { renderer, stdout } = createRenderer()
      renderer.init()
      stdout.clear()
      renderer.destroy()
      expect(stdout.output).toContain('\x1b[?25h')
    })

    test('double destroy does not move the cursor or write again', () => {
      const { renderer, stdout } = createRenderer()
      renderer.init()
      renderer.destroy()
      stdout.clear()
      renderer.destroy()
      expect(stdout.output).toBe('')
    })

    test('destroy prevents a pending frame from accessing disposed application state', async () => {
      const { renderer, stdout } = createRenderer()
      renderer.init()
      let frames = 0
      renderer.setRenderCallback(() => { frames++; return ['late'] })
      renderer.requestRender(true)
      renderer.destroy()
      stdout.clear()
      await Bun.sleep(25)
      expect(frames).toBe(0)
      expect(stdout.output).toBe('')
    })
  })

  describe('differential rendering', () => {
    test('first render outputs all lines', async () => {
      const { renderer, stdout } = createRenderer()
      renderer.init()
      renderer.setRenderCallback(() => ['line1', 'line2', 'line3'])
      stdout.clear()
      await renderFrame(renderer)
      expect(stdout.output).toContain('line1')
      expect(stdout.output).toContain('line2')
      expect(stdout.output).toContain('line3')
      renderer.destroy()
    })

    test('identical frames only refresh hardware cursor visibility', async () => {
      const { renderer, stdout } = createRenderer()
      renderer.init()
      renderer.setRenderCallback(() => ['line1', 'line2'])
      await renderFrame(renderer)
      stdout.clear()
      await renderFrame(renderer)
      expect(stdout.output).toBe('\x1b[?25l')
      renderer.destroy()
    })

    test('invalidated rows repaint without clearing viewport or scrollback', async () => {
      const { renderer, stdout } = createRenderer()
      renderer.init()
      renderer.setRenderCallback(() => ['history', `❯ hello${CURSOR_MARKER}`])
      await renderFrame(renderer)

      stdout.clear()
      renderer.invalidateRowsFrom(1)
      await renderFrame(renderer)

      const out = stdout.output
      expect(out).toContain('❯ hello')
      expect(out).toContain('\x1b[2K')
      expect(out).not.toContain('\x1b[2J')
      expect(out).not.toContain('\x1b[3J')
      expect(out).not.toContain('history')

      stdout.clear()
      await renderFrame(renderer)
      expect(stdout.output).not.toContain('❯ hello')
      renderer.destroy()
    })

    test('invalidating repaints every row of the live region, not just the caret row', async () => {
      // A mouse drag highlights a range of rows. Rewriting the cells is the only
      // way to release it, so one row is not enough.
      const { renderer, stdout } = createRenderer()
      renderer.init()
      renderer.setRenderCallback(() => [
        'committed transcript',
        '╭─────────╮',
        `│ draft${CURSOR_MARKER} │`,
        '╰─────────╯',
        'footer',
      ])
      await renderFrame(renderer)

      stdout.clear()
      renderer.invalidateRowsFrom(1)
      await renderFrame(renderer)

      const out = stdout.output
      for (const row of ['╭─────────╮', '│ draft', '╰─────────╯', 'footer']) {
        expect(out).toContain(row)
      }
      // Committed transcript above the live region is left alone: repainting
      // scrollback on every keystroke costs more than a stale highlight there.
      expect(out).not.toContain('committed transcript')
      renderer.destroy()
    })

    test('invalidating clamps a start row past the end of the frame', async () => {
      const { renderer, stdout } = createRenderer()
      renderer.init()
      renderer.setRenderCallback(() => ['only line'])
      await renderFrame(renderer)

      stdout.clear()
      renderer.invalidateRowsFrom(99)
      await renderFrame(renderer)
      expect(stdout.output).toContain('only line')
      renderer.destroy()
    })

    test('bottom anchor leaves a short frame at its natural position', async () => {
      const { renderer } = createRenderer()
      ;(renderer as any).stdout.rows = 8
      renderer.init()
      renderer.setRenderCallback(() => ({
        lines: ['history 1', 'Interrupted.', 'ad', `❯ draft${CURSOR_MARKER}`, 'footer'],
        bottomAnchor: true,
      }))

      await renderFrame(renderer)

      const reset = '\x1b[0m\x1b]8;;\x07'
      // Content decides placement. Padding a short frame to the viewport would
      // pin the composer to the bottom of an almost-empty session.
      expect((renderer as any).previousLines).toEqual([
        `history 1${reset}`,
        `Interrupted.${reset}`,
        `ad${reset}`,
        `❯ draft${reset}`,
        `footer${reset}`,
      ])
      expect((renderer as any).hardwareCursorRow).toBe(3)
      renderer.destroy()
    })

    test('bottom anchor lets a short frame shrink in place without a full clear', async () => {
      const { renderer, stdout } = createRenderer()
      stdout.rows = 8
      renderer.init()
      let thinking = ['thinking 0', 'thinking 1']
      renderer.setRenderCallback(() => ({
        lines: ['Interrupted.', ...thinking, `❯ ${CURSOR_MARKER}`, 'footer'],
        bottomAnchor: true,
      }))
      await renderFrame(renderer)

      stdout.clear()
      thinking = []
      await renderFrame(renderer)

      const lines = (renderer as any).previousLines as string[]
      // The frame follows its content up; no viewport re-anchor is involved
      // because the trailing edge was never on the bottom row.
      expect(lines).toHaveLength(3)
      expect(stripAnsi(lines.at(-2) ?? '')).toBe('❯ ')
      expect(stripAnsi(lines.at(-1) ?? '')).toBe('footer')
      expect(stdout.output).not.toContain('\x1b[2J')
      renderer.destroy()
    })

    test('appended lines use append fast path', async () => {
      const { renderer, stdout } = createRenderer()
      renderer.init()
      let lines = ['line1', 'line2']
      renderer.setRenderCallback(() => lines)
      await renderFrame(renderer)
      stdout.clear()
      lines = ['line1', 'line2', 'line3']
      await renderFrame(renderer)
      const out = stdout.output
      expect(out).toContain('line3')
      // Should not redraw line1 or line2
      expect(out).not.toContain('line1')
      expect(out).not.toContain('line2')
      renderer.destroy()
    })

    test('streaming table reflows visible rows through differential updates', async () => {
      const restore = withColumns(80)
      const { renderer, stdout } = createRenderer()
      stdout.rows = 16
      stdout.columns = 80
      renderer.init()
      let markdown = [
        '| Name | Value |',
        '| --- | --- |',
        '| first | short |',
      ].join('\n')
      renderer.setRenderCallback(() => [
        ...stripAnsi(renderMarkdown(markdown, { streaming: true })).split('\n'),
        'prompt',
      ])

      try {
        await renderFrame(renderer)
        stdout.clear()
        markdown += '\n| second | a much wider value that changes the live column geometry |'
        await renderFrame(renderer)

        const out = stdout.output
        expect(out).not.toContain('\x1b[2J\x1b[H')
        // The wider cell changes existing column geometry, so the header and
        // prior rows are repainted together with the newly arrived row.
        expect(out).toContain('Name')
        expect(out).toContain('second')
        expect(out).toContain('prompt')
      } finally {
        renderer.destroy()
        restore()
      }
    })

    test('changed middle line only redraws that line', async () => {
      const { renderer, stdout } = createRenderer()
      renderer.init()
      let lines = ['line1', 'line2', 'line3']
      renderer.setRenderCallback(() => lines)
      await renderFrame(renderer)
      stdout.clear()
      lines = ['line1', 'CHANGED', 'line3']
      await renderFrame(renderer)
      const out = stdout.output
      expect(out).toContain('CHANGED')
      expect(out).not.toContain('line1')
      expect(out).not.toContain('line3')
      renderer.destroy()
    })

    test('shrinking content clears extra lines', async () => {
      const { renderer, stdout } = createRenderer()
      renderer.init()
      let lines = ['line1', 'line2', 'line3']
      renderer.setRenderCallback(() => lines)
      await renderFrame(renderer)
      stdout.clear()
      lines = ['line1']
      await renderFrame(renderer)
      const out = stdout.output
      // Should contain clear line sequences for removed lines
      expect(out).toContain('\x1b[2K')
      renderer.destroy()
    })

    test('shrinking a visible frame clears removed rows without repainting the viewport', async () => {
      const { renderer, stdout } = createRenderer()
      stdout.rows = 8
      renderer.init()

      let lines = Array.from({ length: 8 }, (_, i) => `old ${i}`)
      renderer.setRenderCallback(() => lines)
      await renderFrame(renderer)

      stdout.clear()
      lines = ['history', 'Thinking...', '────────', '❯ ', '────────', 'footer']
      await renderFrame(renderer)

      const out = stdout.output
      expect(out).not.toContain('\x1b[2J\x1b[H')
      expect(out).toContain('\x1b[2K')
      expect(out).toContain('history')
      expect(out).toContain('footer')
      renderer.destroy()
    })

    test('shrinking a scrolled frame preserves physical scrollback', async () => {
      const { renderer, stdout } = createRenderer()
      stdout.rows = 8
      renderer.init()

      const history = Array.from({ length: 14 }, (_, i) => `history ${i}`)
      let lines = [
        ...history,
        'Thinking...',
        '────────',
        '❯ ',
        '────────',
        'footer',
        '',
      ]
      renderer.setRenderCallback(() => lines)
      await renderFrame(renderer)

      stdout.clear()
      // Mirrors run completion: the stable history prefix is unchanged, the
      // spinner disappears, and prompt + footer shift upward by one row.
      // Clearing and re-homing here copies the old prompt into Warp scrollback.
      lines = [
        ...history,
        '────────',
        '❯ ',
        '────────',
        'footer',
        '',
      ]
      await renderFrame(renderer)

      const out = stdout.output
      expect(out).not.toContain('\x1b[2J')
      expect(out).not.toContain('\x1b[H')
      expect(out).not.toContain('\x1b[3J')
      expect(out).toContain('footer')
      renderer.destroy()
    })

    test('uses synchronized output wrapping', async () => {
      const { renderer, stdout } = createRenderer()
      renderer.init()
      renderer.setRenderCallback(() => ['hello'])
      stdout.clear()
      await renderFrame(renderer)
      const out = stdout.output
      expect(out).toContain('\x1b[?2026h') // sync start
      expect(out).toContain('\x1b[?2026l') // sync end
      renderer.destroy()
    })
  })

  describe('off-viewport change (streaming markdown reflow)', () => {
    // When streaming, markdown re-renders the whole accumulated text each frame
    // and can reflow earlier lines (table realign, list renumber). A reflowed
    // line that has scrolled above the viewport cannot be addressed. pi clears
    // the screen and replays the frame, which drags a reader who scrolled up
    // back to the bottom and wipes native scrollback. We instead treat
    // scrollback as append-only: only addressable rows are patched and the
    // stale rows above are reported, never repainted.
    const CLEAR_SCREEN = '\x1b[2J\x1b[H\x1b[3J'

    async function paint(renderer: TermRenderer, screen: ScreenHarness): Promise<void> {
      renderer.requestRender()
      await Bun.sleep(25)
      await screen.settle()
    }

    test('changing a line above the viewport patches the viewport and keeps scrollback', async () => {
      const screen = new ScreenHarness(80, 10)
      const traces: RendererTraceEntry[] = []
      const diagnostics: RendererDiagnostic[] = []
      const renderer = new TermRenderer({
        stdout: screen.stdout,
        trace: entry => traces.push(entry),
        onDiagnostic: diagnostic => diagnostics.push(diagnostic),
      })
      renderer.init()
      const history = Array.from({ length: 30 }, (_, i) => `hist ${i}`)
      let lines = [...history, 's0', 's1', 's2', 's3', 's4', 's5']
      renderer.setRenderCallback(() => lines)
      await paint(renderer, screen)
      const baseBefore = screen.terminal.buffer.active.baseY
      traces.length = 0

      // Reflow an early line that is above the viewport while appending one.
      const reflowed = [...history]
      reflowed[5] = 'hist 5 REFLOWED'
      lines = [...reflowed, 's0', 's1', 's2', 's3', 's4', 's5', 's6']
      await paint(renderer, screen)

      expect(traces.map(t => t.branch)).toEqual(['differential_update'])
      expect(traces[0]?.frameState.staleScrollbackRows).toBe(1)
      const ansi = traces.flatMap(t => t.ansiWrites).join('')
      expect(ansi).not.toContain(CLEAR_SCREEN)
      expect(ansi).not.toContain('hist 5 REFLOWED')
      // The frame grew by one row through a normal hardware scroll.
      expect(screen.terminal.buffer.active.baseY).toBe(baseBefore + 1)
      expect(screen.viewport().at(-1)).toBe('s6')
      // Scrollback keeps the last painted content for the unaddressable row.
      const buffer = screen.terminal.buffer.active
      expect(buffer.getLine(5)?.translateToString(true)).toBe('hist 5')
      expect(diagnostics).toEqual([{
        kind: 'stale_scrollback',
        frame: 2,
        staleRows: 1,
        firstChanged: 5,
        viewportTop: 26,
        previousLines: 36,
        newLines: 37,
      }])
      renderer.destroy()
    })

    test('a reader scrolled up keeps their position when an off-screen row reflows', async () => {
      const screen = new ScreenHarness(80, 10)
      const renderer = new TermRenderer({ stdout: screen.stdout })
      renderer.init()
      const history = Array.from({ length: 30 }, (_, i) => `hist ${i}`)
      let lines = [...history, 's0', 's1', 's2']
      renderer.setRenderCallback(() => lines)
      await paint(renderer, screen)

      screen.terminal.scrollLines(-12)
      const readingTop = screen.terminal.buffer.active.viewportY
      const reading = screen.viewport()

      const reflowed = [...history]
      reflowed[2] = 'hist 2 REFLOWED'
      lines = [...reflowed, 's0', 's1', 's2', 's3']
      await paint(renderer, screen)

      expect(screen.terminal.buffer.active.viewportY).toBe(readingTop)
      expect(screen.viewport()).toEqual(reading)
      screen.terminal.scrollToBottom()
      expect(screen.viewport().at(-1)).toBe('s3')
      renderer.destroy()
    })

    test('off-viewport change with unchanged line count only adopts the new frame', async () => {
      const screen = new ScreenHarness(80, 10)
      const traces: RendererTraceEntry[] = []
      const renderer = new TermRenderer({ stdout: screen.stdout, trace: entry => traces.push(entry) })
      renderer.init()
      let banner = 'banner: main'
      const history = Array.from({ length: 200 }, (_, i) => `hist ${i}`)
      renderer.setRenderCallback(() => [banner, ...history])
      await paint(renderer, screen)
      const before = screen.viewport()
      traces.length = 0

      // The banner sits at row 0, far above the viewport. Changing it (e.g. a
      // git branch switch or update notice) must not clear the screen.
      banner = 'banner: feature-branch'
      await paint(renderer, screen)
      expect(traces.map(t => t.branch)).toEqual(['no_change'])
      expect(traces[0]?.frameState.staleScrollbackRows).toBe(1)
      expect(screen.viewport()).toEqual(before)

      // The stale row is reported once, not on every later frame.
      traces.length = 0
      await paint(renderer, screen)
      expect(traces.map(t => t.frameState.staleScrollbackRows)).toEqual([0])
      renderer.destroy()
    })

    test('off-viewport line-count growth scrolls the viewport without clearing', async () => {
      const screen = new ScreenHarness(80, 10)
      const traces: RendererTraceEntry[] = []
      const renderer = new TermRenderer({ stdout: screen.stdout, trace: entry => traces.push(entry) })
      renderer.init()
      let banner = ['banner']
      const history = Array.from({ length: 200 }, (_, i) => `hist ${i}`)
      renderer.setRenderCallback(() => [...banner, ...history])
      await paint(renderer, screen)
      const baseBefore = screen.terminal.buffer.active.baseY
      traces.length = 0

      // Banner grows from 1 line to 2 (async update notice). Visible rows are
      // the tail of history; they shift down by one row.
      banner = ['banner', 'New version available']
      await paint(renderer, screen)
      expect(traces.map(t => t.branch)).toEqual(['differential_update'])
      expect(traces.flatMap(t => t.ansiWrites).join('')).not.toContain(CLEAR_SCREEN)
      expect(screen.terminal.buffer.active.baseY).toBe(baseBefore + 1)
      expect(screen.viewport().at(-1)).toBe('hist 199')
      expect(screen.viewport()[0]).toBe('hist 190')
      renderer.destroy()
    })

    test('off-viewport line-count shrink clears the vacated row in place', async () => {
      const screen = new ScreenHarness(80, 10)
      const traces: RendererTraceEntry[] = []
      const renderer = new TermRenderer({ stdout: screen.stdout, trace: entry => traces.push(entry) })
      renderer.init()
      let banner = ['banner', 'transient notice']
      const history = Array.from({ length: 200 }, (_, i) => `hist ${i}`)
      renderer.setRenderCallback(() => [...banner, ...history])
      await paint(renderer, screen)
      const baseBefore = screen.terminal.buffer.active.baseY
      traces.length = 0

      banner = ['banner']
      await paint(renderer, screen)
      expect(traces.map(t => t.branch)).toEqual(['differential_update'])
      expect(traces.flatMap(t => t.ansiWrites).join('')).not.toContain(CLEAR_SCREEN)
      expect(screen.terminal.buffer.active.baseY).toBe(baseBefore)
      // Content ends one row higher; the vacated bottom row is blank.
      expect(screen.viewport()[8]).toBe('hist 199')
      expect(screen.viewport()[9]).toBe('')
      renderer.destroy()
    })

    test('a change spanning the viewport edge patches only the visible part', async () => {
      const screen = new ScreenHarness(80, 10)
      const traces: RendererTraceEntry[] = []
      const renderer = new TermRenderer({ stdout: screen.stdout, trace: entry => traces.push(entry) })
      renderer.init()
      const history = Array.from({ length: 8 }, (_, i) => `H${i}`)
      // 12 pending: with rows=10 and 20 total lines, viewportTop = 10.
      let pending = Array.from({ length: 12 }, (_, i) => `P${i}`)
      renderer.setRenderCallback(() => [...history, ...pending])
      await paint(renderer, screen)
      traces.length = 0

      pending = [...pending]
      pending[1] = 'P1-off'   // buffer index 9 — above viewport
      pending[3] = 'P3-vis'   // buffer index 11 — inside viewport
      await paint(renderer, screen)

      expect(traces.map(t => t.branch)).toEqual(['differential_update'])
      expect(traces[0]?.frameState.firstChanged).toBe(11)
      expect(traces[0]?.frameState.staleScrollbackRows).toBe(1)
      const ansi = traces.flatMap(t => t.ansiWrites).join('')
      expect(ansi).not.toContain(CLEAR_SCREEN)
      expect(ansi).not.toContain('P1-off')
      expect(screen.viewport()[1]).toBe('P3-vis')
      renderer.destroy()
    })

    test('a shrink that ends above the viewport still needs a full redraw and reports it', async () => {
      const screen = new ScreenHarness(80, 10)
      const diagnostics: RendererDiagnostic[] = []
      const renderer = new TermRenderer({ stdout: screen.stdout, onDiagnostic: d => diagnostics.push(d) })
      renderer.init()
      let lines = Array.from({ length: 40 }, (_, i) => `row ${i}`)
      renderer.setRenderCallback(() => lines)
      await paint(renderer, screen)

      lines = lines.slice(0, 5)
      await paint(renderer, screen)
      expect(screen.viewport().slice(0, 5)).toEqual(['row 0', 'row 1', 'row 2', 'row 3', 'row 4'])
      expect(diagnostics.map(d => d.kind)).toEqual(['stale_scrollback', 'full_redraw'])
      const redraw = diagnostics[1]
      if (redraw?.kind !== 'full_redraw') throw new Error('expected a full_redraw diagnostic')
      expect(redraw.branch).toBe('deleted_lines_above_viewport')
      expect(redraw.previousLines).toBe(40)
      expect(redraw.newLines).toBe(5)
      renderer.destroy()
    })

    test('invalidateScrollback replays history only when a flagged change is above the viewport', async () => {
      const screen = new ScreenHarness(80, 10)
      const diagnostics: RendererDiagnostic[] = []
      const renderer = new TermRenderer({ stdout: screen.stdout, onDiagnostic: d => diagnostics.push(d) })
      renderer.init()
      const history = Array.from({ length: 30 }, (_, i) => `hist ${i}`)
      let lines = [...history, 'tail']
      renderer.setRenderCallback(() => lines)
      await paint(renderer, screen)

      // Flagged, but only the visible tail changed: no clear.
      lines = [...history, 'tail edited']
      renderer.invalidateScrollback()
      await Bun.sleep(25)
      await screen.settle()
      expect(diagnostics).toEqual([])
      expect(screen.viewport().at(-1)).toBe('tail edited')

      // Flagged and a scrollback row changed (Ctrl+O, erased secret): replay.
      const edited = [...history]
      edited[3] = 'hist 3 erased'
      lines = [...edited, 'tail edited']
      renderer.invalidateScrollback()
      await Bun.sleep(25)
      await screen.settle()
      expect(diagnostics.map(d => d.kind === 'full_redraw' && d.branch)).toEqual(['history_invalidated'])
      const buffer = screen.terminal.buffer.active
      const all = Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? '')
      expect(all).toContain('hist 3 erased')
      expect(all).not.toContain('hist 3 ')

      // The flag is consumed: a later streaming reflow above the viewport is stale again.
      diagnostics.length = 0
      const reflowed = [...edited]
      reflowed[4] = 'hist 4 reflowed'
      lines = [...reflowed, 'tail edited']
      await paint(renderer, screen)
      expect(diagnostics.map(d => d.kind)).toEqual(['stale_scrollback'])

      // That row is now part of the adopted logical frame, so it no longer
      // appears as a diff. A later invalidation must still repair it, otherwise
      // an erased secret or a Ctrl+O toggle leaves it wrong for the session.
      diagnostics.length = 0
      lines = [...reflowed, 'tail again']
      renderer.invalidateScrollback()
      await Bun.sleep(25)
      await screen.settle()
      expect(diagnostics.map(d => d.kind === 'full_redraw' && d.branch)).toEqual(['history_invalidated'])
      const repaired = screen.terminal.buffer.active
      const rows = Array.from({ length: repaired.length }, (_, i) => repaired.getLine(i)?.translateToString(true) ?? '')
      expect(rows).toContain('hist 4 reflowed')
      expect(rows).not.toContain('hist 4')

      // Nothing is stale now, so a flag with no scrollback damage stays cheap.
      diagnostics.length = 0
      lines = [...reflowed, 'tail once more']
      renderer.invalidateScrollback()
      await Bun.sleep(25)
      await screen.settle()
      expect(diagnostics).toEqual([])
      renderer.destroy()
    })

    test('a live-region row shifting above the viewport is repainted, not left stale', async () => {
      const screen = new ScreenHarness(80, 10)
      const diagnostics: RendererDiagnostic[] = []
      const renderer = new TermRenderer({
        stdout: screen.stdout,
        onDiagnostic: d => diagnostics.push(d),
      })
      renderer.init()
      // 4 committed rows; everything after is live region.
      let lines = Array.from({ length: 30 }, (_, i) => `row ${i}`)
      renderer.setRenderCallback(() => ({ lines, committedRows: 4 }))
      await paint(renderer, screen)

      // A row is inserted inside the live region, above the viewport. Leaving
      // scrollback alone would duplicate row 19 and lose INSERTED entirely.
      lines = [...lines.slice(0, 4), 'INSERTED', ...lines.slice(4)]
      await paint(renderer, screen)

      expect(diagnostics.map(d => d.kind)).toEqual(['scrollback_shift', 'full_redraw'])
      expect(diagnostics.map(d => d.kind === 'full_redraw' && d.branch)).toEqual([false, 'scrollback_shift'])
      const buffer = screen.terminal.buffer.active
      const rows: string[] = []
      for (let i = 0; i < buffer.length; i++) {
        rows.push((buffer.getLine(i)?.translateToString(true) ?? '').trimEnd())
      }
      // Every logical row exists exactly once, in order.
      for (const line of lines) expect(rows).toContain(line)
      expect(rows.filter(r => r === 'row 19')).toHaveLength(1)
      renderer.destroy()
    })

    test('an in-place edit inside the committed prefix stays stale and cheap', async () => {
      const screen = new ScreenHarness(80, 10)
      const diagnostics: RendererDiagnostic[] = []
      const renderer = new TermRenderer({
        stdout: screen.stdout,
        onDiagnostic: d => diagnostics.push(d),
      })
      renderer.init()
      const lines = Array.from({ length: 30 }, (_, i) => `row ${i}`)
      renderer.setRenderCallback(() => ({ lines, committedRows: 30 }))
      await paint(renderer, screen)
      screen.terminal.scrollLines(-8)
      const readingTop = screen.terminal.buffer.active.viewportY

      // Same row count, so no index shifts: outdated text costs the reader
      // nothing and their scroll position is worth more than freshness.
      lines[3] = 'row 3 edited'
      await paint(renderer, screen)

      expect(diagnostics.map(d => d.kind)).toEqual(['stale_scrollback'])
      expect(screen.terminal.buffer.active.viewportY).toBe(readingTop)
      renderer.destroy()
    })

    test('rows committed by this frame are judged against the old boundary', async () => {
      const screen = new ScreenHarness(80, 10)
      const diagnostics: RendererDiagnostic[] = []
      const renderer = new TermRenderer({
        stdout: screen.stdout,
        onDiagnostic: d => diagnostics.push(d),
      })
      renderer.init()
      // 4 history rows + a 13-row partial: the partial overhangs the viewport by 3.
      const history = Array.from({ length: 4 }, (_, i) => `hist ${i}`)
      const partial = Array.from({ length: 13 }, (_, i) => `partial ${i}`)
      let lines = [...history, ...partial]
      let committedRows = 4
      renderer.setRenderCallback(() => ({ lines, committedRows }))
      await paint(renderer, screen)

      // A 5-row tool result commits into history, taller than the overhang, so
      // every shifted partial row lands inside the viewport and the only rows
      // changed above it are the new tool rows. Those are committed in the new
      // frame; judged by the new boundary alone they would be left stale.
      const tool = Array.from({ length: 5 }, (_, i) => `tool ${i}`)
      lines = [...history, ...tool, ...partial]
      committedRows = 9
      await paint(renderer, screen)

      expect(diagnostics.map(d => d.kind)).toEqual(['scrollback_shift', 'full_redraw'])
      const buffer = screen.terminal.buffer.active
      const rows: string[] = []
      for (let i = 0; i < buffer.length; i++) {
        rows.push((buffer.getLine(i)?.translateToString(true) ?? '').trimEnd())
      }
      for (const line of tool) expect(rows).toContain(line)
      expect(rows.filter(r => r === 'partial 0')).toHaveLength(1)
      renderer.destroy()
    })

    test('invalidating unchanged live-region rows above the viewport is not a shift', async () => {
      const screen = new ScreenHarness(80, 10)
      const diagnostics: RendererDiagnostic[] = []
      const renderer = new TermRenderer({
        stdout: screen.stdout,
        onDiagnostic: d => diagnostics.push(d),
      })
      renderer.init()
      // Live region starts at 4 and runs above the viewport, as a tall command
      // window does. A keypress invalidates it to release a mouse selection.
      const lines = Array.from({ length: 30 }, (_, i) => `row ${i}`)
      renderer.setRenderCallback(() => ({ lines, committedRows: 4 }))
      await paint(renderer, screen)

      renderer.invalidateRowsFrom(4)
      await Bun.sleep(25)
      await screen.settle()

      expect(diagnostics.map(d => d.kind)).toEqual(['stale_scrollback'])
      renderer.destroy()
    })

    test('a forced repaint reports its own cause, not a resize', async () => {
      const screen = new ScreenHarness(80, 10)
      const diagnostics: RendererDiagnostic[] = []
      const renderer = new TermRenderer({ stdout: screen.stdout, onDiagnostic: d => diagnostics.push(d) })
      renderer.init()
      renderer.setRenderCallback(() => Array.from({ length: 30 }, (_, i) => `row ${i}`))
      await paint(renderer, screen)

      // Theme detection repaints pre-painted ANSI history through requestRender(true).
      renderer.requestRender(true)
      await Bun.sleep(25)
      await screen.settle()
      expect(diagnostics.map(d => d.kind === 'full_redraw' && d.branch)).toEqual(['forced_repaint'])
      renderer.destroy()
    })

    test('a resize repaints only the viewport and reports a non-destructive redraw', async () => {
      const screen = new ScreenHarness(80, 10)
      const diagnostics: RendererDiagnostic[] = []
      const renderer = new TermRenderer({ stdout: screen.stdout, onDiagnostic: d => diagnostics.push(d) })
      renderer.init()
      renderer.setRenderCallback(() => Array.from({ length: 30 }, (_, i) => `row ${i}`))
      await paint(renderer, screen)

      screen.stdout.columns = 60
      screen.terminal.resize(60, 10)
      screen.stdout.emit('resize')
      await paint(renderer, screen)
      expect(diagnostics.map(d => d.kind)).toEqual(['viewport_redraw'])
      expect(diagnostics[0]?.kind === 'viewport_redraw' && diagnostics[0].branch).toBe('width_change')
      renderer.destroy()
    })

    // Ctrl+O expand: a tool block in the viewport grows from compact to
    // expanded with the prompt below it. The change starts inside the viewport,
    // so the renderer repaints in place from the first changed row down and
    // scrolls the prompt naturally — no viewport clear, no jump to the top.
    test('expanding in-viewport content grows in place without clearing', async () => {
      const { renderer, stdout } = createRenderer()
      stdout.rows = 12
      renderer.init()
      // Small transcript that fits entirely on screen: a couple of history
      // lines, a compact tool card, then the prompt.
      let lines = ['h0', 'h1', 'tool ✓ 2 lines', 'prompt']
      renderer.setRenderCallback(() => lines)
      await renderFrame(renderer)

      // Ctrl+O expands the tool card into its full output. The card and prompt
      // are all visible, so this must NOT clear the screen.
      stdout.clear()
      lines = ['h0', 'h1', 'tool ✓ 2 lines', '  out line 1', '  out line 2', '  out line 3', 'prompt']
      await renderFrame(renderer)

      const out = stdout.output
      expect(out).not.toContain(CLEAR_SCREEN)
      expect(out).toContain('out line 3')
      expect(out).toContain('prompt')
      renderer.destroy()
    })
  })

  describe('screen overlays', () => {
    test('screen overlay does not inflate a long transcript frame', async () => {
      const { renderer, stdout } = createRenderer()
      stdout.rows = 8
      stdout.columns = 40
      renderer.init()
      const history = Array.from({ length: 20 }, (_, index) => `history ${index}`)
      let showOverlay = false
      renderer.setRenderCallback(() => ({
        lines: history,
        ...(showOverlay ? { overlay: { lines: ['Pick model', '❯ model-a', '  model-b'] } } : {}),
      }))
      await renderFrame(renderer)

      stdout.clear()
      showOverlay = true
      await renderFrame(renderer)

      expect(stdout.output).toContain('Pick model')
      expect((renderer as any).previousLines).toHaveLength(history.length)
      renderer.destroy()
    })

    test('screen overlay pads only short frames to one viewport', async () => {
      const { renderer, stdout } = createRenderer()
      stdout.rows = 8
      stdout.columns = 40
      renderer.init()
      renderer.setRenderCallback(() => ({
        lines: ['history', 'prompt'],
        overlay: { lines: ['Help', 'close'] },
      }))
      await renderFrame(renderer)

      expect((renderer as any).previousLines).toHaveLength(stdout.rows)
      renderer.destroy()
    })

    test('centres the overlay as a block so its columns stay aligned', async () => {
      const { renderer, stdout } = createRenderer()
      stdout.rows = 12
      stdout.columns = 40
      renderer.init()
      // Rows of differing width that share a left edge: per-line centring would
      // give each row its own indent and shear the column apart.
      const overlayLines = [
        'title',
        'a    short',
        'bb   a much longer description',
        'ccc  mid',
      ]
      renderer.setRenderCallback(() => ({
        lines: ['history', 'prompt'],
        overlay: { lines: overlayLines },
      }))
      await renderFrame(renderer)

      const rendered: string[] = (renderer as any).previousLines
      const indentOf = (needle: string): number => {
        const row = rendered.find(line => stripAnsi(line).includes(needle))
        expect(row).toBeDefined()
        const bare = stripAnsi(row!)
        return bare.length - bare.trimStart().length
      }

      const indents = overlayLines.map(line => indentOf(line.split(/\s\s+/)[0]!))
      expect(new Set(indents).size).toBe(1)
      // The block is still centred: widest row is 30 of 40 columns → indent 5.
      expect(indents[0]).toBe(5)
      renderer.destroy()
    })
  })

  describe('clearScreen', () => {
    test('clears screen and resets state', async () => {
      const { renderer, stdout } = createRenderer()
      renderer.init()
      renderer.setRenderCallback(() => ['line1', 'line2'])
      await renderFrame(renderer)
      stdout.clear()
      renderer.clearScreen()
      const out = stdout.output
      expect(out).toContain('\x1b[2J') // clear screen
      expect(out).toContain('\x1b[H')  // cursor home
      expect(out).toContain('\x1b[3J') // pi-style full terminal clear
      renderer.destroy()
    })
  })

  describe('resize handling', () => {
    test('updates dimensions on resize', () => {
      const { renderer, stdout } = createRenderer()
      renderer.init()
      stdout.rows = 40
      stdout.columns = 120
      stdout.emit('resize')
      expect(renderer.termRows).toBe(40)
      expect(renderer.termCols).toBe(120)
      renderer.destroy()
    })

    test('redundant resize event does not force a redraw', async () => {
      const { renderer, stdout } = createRenderer()
      renderer.init()
      renderer.setRenderCallback(() => ['line1', 'line2'])
      await renderFrame(renderer)

      stdout.clear()
      stdout.emit('resize')
      await Bun.sleep(20)

      expect(stdout.output).not.toContain('\x1b[2J')
      expect(stdout.output).not.toContain('\x1b[3J')
      renderer.destroy()
    })

    test('actual resize repaints the viewport without clearing scrollback', async () => {
      const { renderer, stdout } = createRenderer()
      renderer.init()
      renderer.setRenderCallback(() => ['line1', 'line2'])
      await renderFrame(renderer)

      stdout.clear()
      stdout.columns = 120
      stdout.emit('resize')
      await Bun.sleep(20)

      expect(stdout.output).toContain('\x1b[2J\x1b[H')
      expect(stdout.output).not.toContain('\x1b[3J')
      expect(stdout.output).toContain('line1')
      renderer.destroy()
    })

    test('falls back when resize dimensions are non-finite', () => {
      const { renderer, stdout } = createRenderer()
      renderer.init()
      stdout.rows = Infinity
      stdout.columns = NaN
      stdout.emit('resize')
      expect(renderer.termRows).toBe(24)
      expect(renderer.termCols).toBe(80)
      renderer.destroy()
    })
  })

  describe('render throttling', () => {
    test('multiple requestRender calls coalesce into one render', async () => {
      const { renderer, stdout } = createRenderer()
      renderer.init()
      let callCount = 0
      renderer.setRenderCallback(() => {
        callCount++
        return ['frame ' + callCount]
      })
      stdout.clear()
      renderer.requestRender()
      renderer.requestRender()
      renderer.requestRender()
      await new Promise(resolve => process.nextTick(resolve))
      await Bun.sleep(20)
      // Should only have rendered once
      expect(callCount).toBe(1)
      renderer.destroy()
    })
  })

  describe('terminal line safety', () => {
    test('normalizes visible tabs and appends a segment reset to every line', async () => {
      const { renderer, stdout } = createRenderer()
      renderer.init()
      renderer.setRenderCallback(() => ['left\tright'])
      stdout.clear()
      await renderFrame(renderer)

      expect(stdout.output).not.toContain('\t')
      expect(stdout.output).toContain('left   right\x1b[0m\x1b]8;;\x07')
      renderer.destroy()
    })

    test('committed rows reuse their finalized text when the producer string is unchanged', async () => {
      const { renderer, stdout } = createRenderer()
      renderer.init()
      const history = ['a\tb', 'plain', 'c\td']
      let live = `edit${CURSOR_MARKER}`
      renderer.setRenderCallback(() => ({ lines: history.concat([live]), committedRows: history.length }))
      await renderFrame(renderer)
      stdout.clear()

      // Only the live row changes; history keeps the same string objects.
      live = `edited${CURSOR_MARKER}`
      await renderFrame(renderer)
      expect(stripAnsi(stdout.output)).toContain('edited')
      expect(stdout.output).not.toContain('a   b')
      expect(stdout.output).not.toContain(CURSOR_MARKER)

      // A changed committed row is finalized again (tabs normalized, reset
      // appended) and repainted.
      stdout.clear()
      history[1] = 'x\ty'
      await renderFrame(renderer)
      expect(stdout.output).not.toContain('\t')
      expect(stdout.output).toContain('x   y\x1b[0m\x1b]8;;\x07')
      renderer.destroy()
    })

    test('pi APC cursor marker is zero-width and removed before paint', async () => {
      const { renderer, stdout } = createRenderer()
      renderer.init()
      renderer.setRenderCallback(() => [`ab${CURSOR_MARKER}cd`])
      stdout.clear()
      await renderFrame(renderer)

      expect(stdout.output).not.toContain(CURSOR_MARKER)
      expect(stripAnsi(stdout.output)).toContain('abcd')
      expect(stdout.output).toContain('\x1b[3G')
      renderer.destroy()
    })

    test('a modal hides the underlying editor cursor but can provide its own', async () => {
      const { renderer, stdout } = createRenderer()
      let modal = ['modal']
      renderer.init()
      renderer.setRenderCallback(() => ({ lines: [`ab${CURSOR_MARKER}cd`], overlay: { lines: modal } }))
      try {
        await renderFrame(renderer)
        expect(stdout.output).not.toContain('\x1b[?25h')
        expect(stdout.output).not.toContain(CURSOR_MARKER)
        stdout.clear()
        modal = [`name ${CURSOR_MARKER}text`]
        await renderFrame(renderer)
        expect(stdout.output).toContain('\x1b[?25h')
        expect(stdout.output).not.toContain(CURSOR_MARKER)
      } finally {
        renderer.destroy()
      }
    })

    test('all internal markers are stripped and only an addressable visible cursor is shown', async () => {
      const { renderer, stdout } = createRenderer()
      stdout.rows = 4
      stdout.columns = 20
      let lines = [`old${CURSOR_MARKER}`, 'history', 'history', 'history', `中文${CURSOR_MARKER}`, `last${CURSOR_MARKER}`]
      renderer.init()
      renderer.setRenderCallback(() => lines)
      try {
        await renderFrame(renderer)
        expect(stdout.output).not.toContain(CURSOR_MARKER)
        expect(stdout.output).toContain('\x1b[5G')
        expect(stdout.output).toContain('\x1b[?25h')
        stdout.clear()
        lines = ['x'.repeat(20) + CURSOR_MARKER]
        await renderFrame(renderer)
        expect(stdout.output).not.toContain(CURSOR_MARKER)
        expect(stdout.output).not.toContain('\x1b[?25h')
        expect(stdout.output).toContain('\x1b[?25l')
      } finally {
        renderer.destroy()
      }
    })

    test('cursor marker positions and shows the terminal-owned cursor', async () => {
      const { renderer, stdout } = createRenderer()
      renderer.init()
      renderer.setRenderCallback(() => [`ab${CURSOR_MARKER}cd`])
      stdout.clear()
      await renderFrame(renderer)

      expect(stdout.output).toContain('\x1b[3G')
      expect(stdout.output).toContain('\x1b[?25h')
      // Never override user-selected cursor shape or color.
      expect(stdout.output).not.toMatch(/\x1b\[\d* q/)
      expect(stdout.output).not.toContain('\x1b]12;')
      stdout.clear()
      renderer.setRenderCallback(() => ['unfocused'])
      await renderFrame(renderer)
      expect(stdout.output).toContain('\x1b[?25l')
      expect(stdout.output).not.toContain('\x1b[?25h')
      renderer.destroy()
    })

    test('lines wider than terminal are clipped by DECAWM off', async () => {
      const { renderer, stdout } = createRenderer()
      stdout.columns = 20
      renderer.init()
      // Verify DECAWM off (no-wrap) is sent on init
      expect(stdout.output).toContain('\x1b[?7l')
      const longLine = 'A'.repeat(50)
      renderer.setRenderCallback(() => [longLine])
      stdout.clear()
      await renderFrame(renderer)
      // The renderer outputs the full line — the terminal clips it
      expect(stdout.output).toContain(longLine)
      renderer.destroy()
    })

    test('destroy re-enables auto-wrap', () => {
      const { renderer, stdout } = createRenderer()
      renderer.init()
      stdout.clear()
      renderer.destroy()
      expect(stdout.output).toContain('\x1b[?7h')
    })

    test('lines within terminal width render normally', async () => {
      const { renderer, stdout } = createRenderer()
      stdout.columns = 80
      renderer.init()
      const shortLine = 'Hello world'
      renderer.setRenderCallback(() => [shortLine])
      stdout.clear()
      await renderFrame(renderer)
      expect(stdout.output).toContain(shortLine)
      renderer.destroy()
    })
  })
})
