import { describe, expect, test } from 'bun:test'
import { TermRenderer, type RendererDiagnostic, type RendererTraceEntry } from '../src/term/renderer.js'
import { CURSOR_MARKER, type RenderFrame } from '../src/term/render-frame.js'
import { buildShellFrame, type ShellSnapshot } from '../src/term/viewmodel/shell.js'
import { buildRunStatusBlock } from '../src/term/viewmodel/run-status.js'
import { createSpinnerState, formatSpinnerLine, spinnerStatsFromLastUsage } from '../src/term/spinner.js'
import { createModelWindow, createResumeWindow } from '../src/term/app/selector-windows.js'
import { promptFromSnapshot } from '../src/term/viewmodel/prompt-snapshot.js'
import { createEditorState } from '../src/term/input/editor.js'
import { createInitialState } from '../src/term/app/state.js'
import { visibleWidth } from '../src/render/wrap.js'
import { ScreenHarness } from './helpers/screen.js'

async function paint(renderer: TermRenderer, screen: ScreenHarness): Promise<void> {
  renderer.requestRender()
  await Bun.sleep(25)
  await screen.settle()
}

function snapshot(columns: number, rows: number): ShellSnapshot {
  const contentLines = Array.from({ length: 40 }, (_, i) => `history ${i}`)
  return {
    contentLines, committedRows: contentLines.length, preEditorBlocks: [],
    overlay: { kind: 'none' }, preview: null, commandFocused: false,
    prompt: promptFromSnapshot({
      editor: createEditorState(), session: createInitialState('model', '/work'),
      active: true, logMode: false, dashboardUrl: null,
      exitHint: false, columns, rows, gitBranch: null, backgroundProcessCount: 0,
    }),
  }
}

function expectAtomicCursorFrames(traces: RendererTraceEntry[]): void {
  for (const trace of traces) {
    const frames = trace.ansiWrites.filter(write => write.includes('\x1b[?2026h'))
    expect(frames).toHaveLength(1)
    expect(frames[0]?.endsWith('\x1b[?2026l')).toBe(true)
    expect(frames[0]?.lastIndexOf('\x1b[?25h')).toBeGreaterThanOrEqual(0)
    expect(frames[0]?.lastIndexOf('\x1b[?25h')).toBeLessThan(frames[0]!.indexOf('\x1b[?2026l'))
    // The caret must not be restored by a second write outside the frame.
    expect(trace.ansiWrites.some(write => !write.includes('\x1b[?2026h') && write.includes('\x1b[?25h'))).toBe(false)
  }
}

describe('streaming viewport stability', () => {
  test('rate digit changes keep a one-row status, a complete action, and a stationary caret', async () => {
    const screen = new ScreenHarness(62, 24)
    const traces: RendererTraceEntry[] = []
    const diagnostics: RendererDiagnostic[] = []
    const renderer = new TermRenderer({ stdout: screen.stdout, trace: t => traces.push(t), onDiagnostic: d => diagnostics.push(d) })
    const input = snapshot(62, 24)
    input.prompt = { ...input.prompt, lines: ['draft-marker'], cursorCol: 12, busy: true }
    let frame = buildShellFrame(input)
    renderer.init()
    renderer.setRenderCallback(() => frame)
    const cursorRows: number[] = []
    try {
      for (const [elapsed, tokens] of [[9300, 90], [9500, 90], [9600, 92], [9800, 92]]) {
        const state = {
          ...createSpinnerState(), phase: 'responding' as const, phaseStartedAt: 1000,
          streamStartedAt: 1000, streaming: true, tokenCount: tokens!, lastTokenAt: 1000 + elapsed!,
        }
        const text = formatSpinnerLine(state, 1000 + elapsed!, spinnerStatsFromLastUsage(null, tokens!, true), { columns: 62 })
        expect(visibleWidth(text)).toBeLessThanOrEqual(62)
        expect(text).toContain('esc twice to interrupt')
        const status = buildRunStatusBlock(text, 62)
        expect(status.lines).toHaveLength(1)
        frame = buildShellFrame({ ...input, preEditorBlocks: [status] })
        await paint(renderer, screen)
        cursorRows.push(screen.terminal.buffer.active.cursorY)
        expect(screen.rowOf('draft-marker')).toBe(cursorRows.at(-1)!)
      }
      expect(new Set(cursorRows).size).toBe(1)
      expect(diagnostics.some(d => d.kind === 'full_redraw')).toBe(false)
      expectAtomicCursorFrames(traces)
    } finally {
      renderer.destroy()
      await screen.settle()
      screen.terminal.dispose()
    }
  })

  test.each([8, 12, 24, 28, 36])('a background spinner stays visible behind command windows in an %i-row pane', async rows => {
    for (const selector of [createModelWindow(undefined, 'model'), createResumeWindow([])]) {
      const screen = new ScreenHarness(80, rows)
      const diagnostics: RendererDiagnostic[] = []
      const renderer = new TermRenderer({ stdout: screen.stdout, onDiagnostic: d => diagnostics.push(d) })
      const input = snapshot(80, rows)
      input.prompt = { ...input.prompt, lines: ['/mo'], cursorCol: 3, backgroundProcessCount: 1 }
      let tick = 0
      const makeFrame = () => buildShellFrame({
        ...input, preview: { kind: 'selector', state: selector },
        preEditorBlocks: [buildRunStatusBlock(formatSpinnerLine({
          ...createSpinnerState(), phase: 'awaiting_background', phaseStartedAt: 1000, frame: tick,
        }, 2000, undefined, { columns: 80, hideInteractionHint: true }), 80)],
      })
      renderer.init()
      renderer.setRenderCallback(makeFrame)
      try {
        await paint(renderer, screen)
        const beforeCursor = screen.terminal.buffer.active.cursorY
        for (tick = 1; tick <= 3; tick++) {
          await paint(renderer, screen)
          const frame = makeFrame()
          expect(frame.lines.length - input.contentLines.length).toBeLessThan(rows)
          expect(screen.rowOf('Background task running')).toBeGreaterThanOrEqual(0)
          expect(screen.rowOf('/mo')).toBe(beforeCursor)
          expect(screen.terminal.buffer.active.cursorY).toBe(beforeCursor)
        }
        expect(diagnostics).toEqual([])
      } finally {
        renderer.destroy()
        await screen.settle()
        screen.terminal.dispose()
      }
    }
  })

  test('collapsing an oversized live window recovers only the viewport and subsequent typing remains visible', async () => {
    const screen = new ScreenHarness(80, 28)
    const traces: RendererTraceEntry[] = []
    const diagnostics: RendererDiagnostic[] = []
    const renderer = new TermRenderer({ stdout: screen.stdout, trace: t => traces.push(t), onDiagnostic: d => diagnostics.push(d) })
    const history = Array.from({ length: 40 }, (_, i) => `history ${i}`)
    let transient = Array.from({ length: 26 }, (_, i) => `transient ${i}`)
    let draft = 'draft-marker'
    renderer.init()
    renderer.setRenderCallback(() => ({
      lines: [...history, ...transient, 'rule', '', '', `${CURSOR_MARKER}${draft}`, '', 'rule', 'footer', ''],
      committedRows: history.length,
    }))
    try {
      await paint(renderer, screen)
      const scrollback = screen.terminal.buffer.active.baseY
      traces.length = 0
      transient = []
      await paint(renderer, screen)
      expect(diagnostics.some(d => d.kind === 'full_redraw')).toBe(false)
      expect(diagnostics.some(d => d.kind === 'viewport_redraw' && d.branch === 'cursor_recovery')).toBe(true)
      expect(screen.terminal.buffer.active.baseY).toBe(scrollback)
      expect(screen.rowOf(draft)).toBe(screen.terminal.buffer.active.cursorY)
      const recovery = traces[0]
      expect(recovery?.ansiWrites.join('')).not.toContain('\x1b[3J')
      // tmux may promote ED 2's cleared screen into history. Address rows with
      // CUU/CUD/EL instead of either clearing or emitting scrolling linefeeds.
      expect(recovery?.ansiWrites.join('')).not.toContain('\x1b[2J')
      expect(recovery?.ansiWrites.join('')).not.toContain('\n')
      expect(recovery?.ansiWrites.join('')).not.toContain('history 0')
      draft += '-typed'
      await paint(renderer, screen)
      expect(screen.rowOf(draft)).toBeGreaterThanOrEqual(0)
      expect(screen.rowOf(draft)).toBe(screen.terminal.buffer.active.cursorY)
      expectAtomicCursorFrames(traces)
    } finally {
      renderer.destroy()
      await screen.settle()
      screen.terminal.dispose()
    }
  })

  test('committing a collapsed preview repairs removed rows beyond the new boundary once', async () => {
    const screen = new ScreenHarness(80, 12)
    const diagnostics: RendererDiagnostic[] = []
    const renderer = new TermRenderer({ stdout: screen.stdout, onDiagnostic: d => diagnostics.push(d) })
    const history = Array.from({ length: 10 }, (_, i) => `history ${i}`)
    let partial = ['kept 0', 'kept 1', ...Array.from({ length: 40 }, (_, i) => `discarded ${i}`)]
    let committedRows = 10
    renderer.init()
    renderer.setRenderCallback(() => ({ lines: [...history, ...partial, `${CURSOR_MARKER}draft`, 'footer'], committedRows }))
    try {
      await paint(renderer, screen)
      partial = partial.slice(0, 2)
      await paint(renderer, screen)
      expect(diagnostics.some(d => d.kind === 'full_redraw')).toBe(false)
      diagnostics.length = 0
      committedRows = 12
      await paint(renderer, screen)
      expect(diagnostics.filter(d => d.kind === 'full_redraw')).toHaveLength(1)
      const buffer = screen.terminal.buffer.active
      const all = Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? '')
      expect(all.join('\n')).not.toContain('discarded')
      diagnostics.length = 0
      await paint(renderer, screen)
      expect(diagnostics).toEqual([])
    } finally {
      renderer.destroy()
      await screen.settle()
      screen.terminal.dispose()
    }
  })

  test('hidden live reflow and append stay differential, with one history repair on commit', async () => {
    const screen = new ScreenHarness(80, 12)
    const diagnostics: RendererDiagnostic[] = []
    const renderer = new TermRenderer({ stdout: screen.stdout, onDiagnostic: d => diagnostics.push(d) })
    const history = Array.from({ length: 10 }, (_, i) => `history ${i}`)
    let partial = Array.from({ length: 30 }, (_, i) => `partial ${i}`)
    let committedRows = history.length
    renderer.init()
    renderer.setRenderCallback((): RenderFrame => ({
      lines: [...history, ...partial, `${CURSOR_MARKER}draft`, 'footer'], committedRows,
    }))
    try {
      await paint(renderer, screen)
      for (let i = 0; i < 4; i++) {
        partial = [...partial]
        partial[0] = `reflow ${i}`
        if (i % 2) partial.push(`appended ${i}`)
        await paint(renderer, screen)
        expect(screen.rowOf('draft')).toBe(screen.terminal.buffer.active.cursorY)
      }
      expect(diagnostics.filter(d => d.kind === 'stale_scrollback')).toHaveLength(4)
      expect(diagnostics.some(d => d.kind === 'full_redraw')).toBe(false)
      diagnostics.length = 0
      committedRows = history.length + partial.length
      await paint(renderer, screen)
      expect(diagnostics.filter(d => d.kind === 'full_redraw')).toHaveLength(1)
      diagnostics.length = 0
      await paint(renderer, screen)
      expect(diagnostics).toEqual([])
    } finally {
      renderer.destroy()
      await screen.settle()
      screen.terminal.dispose()
    }
  })
})
