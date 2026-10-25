import { describe, expect, test } from 'bun:test'
import { TermRenderer } from '../src/term/renderer.js'
import { CURSOR_MARKER } from '../src/term/render-frame.js'
import { ScreenHarness } from './helpers/screen.js'
import stripAnsi from 'strip-ansi'

async function renderFrame(renderer: TermRenderer): Promise<void> {
  renderer.requestRender()
  await new Promise(resolve => process.nextTick(resolve))
  await Bun.sleep(20)
}

/**
 * These assertions read the physical viewport of a real terminal emulator,
 * which is the only way to tell "row 11 of the screen" from "row 11 of the
 * logical frame".
 *
 * The rule under test: the content above the composer decides where it sits.
 * A short session keeps it high; after a visible shrink it follows content up
 * without clearing native scrollback merely to keep the footer at bottom.
 */
describe('composer placement on a real screen', () => {
  test('a wrapped interrupt hint remains visible when its prefix is not rewritten', async () => {
    const screen = new ScreenHarness(80, 24)
    const writes: string[] = []
    const renderer = new TermRenderer({ stdout: screen.stdout, trace: entry => writes.push(...entry.ansiWrites) })
    let armed = false
    renderer.init()
    renderer.setRenderCallback(() => ({
      lines: ['Connection interrupted · retrying · esc', armed ? 'again to interrupt' : 'twice to interrupt', `> ${CURSOR_MARKER}`],
    }))
    try {
      await renderFrame(renderer)
      await screen.settle()
      writes.length = 0
      armed = true
      await renderFrame(renderer)
      await screen.settle()
      const hint = /esc\s+again\s+to\s+interrupt/
      expect(stripAnsi(writes.join(''))).not.toMatch(hint)
      expect(screen.viewport().join('\n')).toMatch(hint)
    } finally {
      renderer.destroy()
      screen.terminal.dispose()
    }
  })

  test('a fresh short session keeps the composer just below its content', async () => {
    const screen = new ScreenHarness(80, 24)
    const renderer = new TermRenderer({ stdout: screen.stdout })
    renderer.init()
    renderer.setRenderCallback(() => ({
      lines: ['evot v1', '', '\u276f hi', 'hello there', `\u276f ${CURSOR_MARKER}`, 'footer row'],
      bottomAnchor: true,
    }))

    await renderFrame(renderer)
    await screen.settle()

    // Natural position, not the bottom row: padding a short frame down to the
    // viewport would pin the composer to the bottom of an almost-empty session.
    expect(screen.rowOf('evot v1')).toBe(0)
    expect(screen.rowOf('footer row')).toBe(5)
    expect(screen.viewport()[4]).toBe('\u276f')
    renderer.destroy()
  })

  test('a short session that shrinks follows its content up', async () => {
    const screen = new ScreenHarness(80, 24)
    const renderer = new TermRenderer({ stdout: screen.stdout })
    renderer.init()
    let thinking = ['thinking 0', 'thinking 1', 'thinking 2']
    renderer.setRenderCallback(() => ({
      lines: ['evot v1', '\u276f hi', ...thinking, `\u276f ${CURSOR_MARKER}`, 'footer row'],
      bottomAnchor: true,
    }))
    await renderFrame(renderer)
    await screen.settle()
    expect(screen.rowOf('footer row')).toBe(6)

    thinking = []
    await renderFrame(renderer)
    await screen.settle()

    // The composer was never at the bottom, so there is nothing to hold it
    // down: it rises with the content and leaves no stale rows behind.
    expect(screen.rowOf('footer row')).toBe(3)
    expect(screen.lastNonBlankRow()).toBe(3)
    expect(screen.viewport().some(line => line.startsWith('thinking '))).toBe(false)
    renderer.destroy()
  })

  test('a command window that reaches bottom closes without leaving a hole above the composer', async () => {
    const screen = new ScreenHarness(80, 12)
    const renderer = new TermRenderer({ stdout: screen.stdout })
    renderer.init()
    const content = ['evot v1', 'Server https://api.evot.ai']
    let commandWindow = Array.from({ length: 8 }, (_, i) => `selector ${i}`)
    renderer.setRenderCallback(() => ({
      lines: [...content, ...commandWindow, `\u276f /resume${CURSOR_MARKER}`, 'footer row'],
      bottomAnchor: true,
      bottomAnchorStart: content.length,
      transientRows: commandWindow.length,
    }))

    await renderFrame(renderer)
    await screen.settle()
    const serverRow = screen.rowOf('Server https://api.evot.ai')
    expect(screen.rowOf('footer row')).toBe(screen.rows - 1)

    commandWindow = []
    await renderFrame(renderer)
    await screen.settle()

    // The window only borrowed the bottom row; it did not earn the composer a
    // place there. History stays put and the composer follows it back up, with
    // the spare rows at the bottom of the screen rather than in the middle.
    expect(screen.rowOf('Server https://api.evot.ai')).toBe(serverRow)
    expect(screen.rowOf('\u276f /resume')).toBe(serverRow + 1)
    expect(screen.rowOf('footer row')).toBe(serverRow + 2)
    expect(screen.lastNonBlankRow()).toBe(serverRow + 2)
    expect(screen.viewport().some(line => line.startsWith('selector '))).toBe(false)
    renderer.destroy()
  })

  test('a command window that scrolls a short session closes without a hole', async () => {
    const screen = new ScreenHarness(80, 12)
    const renderer = new TermRenderer({ stdout: screen.stdout })
    renderer.init()
    const content = ['evot v1', '\u276f hi', 'Hi! What can I help you with?']
    let commandWindow = Array.from({ length: 14 }, (_, i) => `selector ${i}`)
    renderer.setRenderCallback(() => ({
      lines: [...content, ...commandWindow, `\u276f /mo${CURSOR_MARKER}`, 'footer row'],
      bottomAnchor: true,
      bottomAnchorStart: content.length,
      transientRows: commandWindow.length,
    }))

    await renderFrame(renderer)
    await screen.settle()
    expect(screen.rowOf('footer row')).toBe(screen.rows - 1)

    commandWindow = []
    await renderFrame(renderer)
    await screen.settle()

    // Whatever the terminal scrolled away stays in scrollback; on screen the
    // composer sits directly under the last transcript row, never below a
    // block of blank rows the closed window left behind.
    const viewport = screen.viewport()
    const composerRow = screen.rowOf('\u276f /mo')
    expect(composerRow).toBeGreaterThanOrEqual(0)
    expect(screen.rowOf('footer row')).toBe(composerRow + 1)
    expect(screen.lastNonBlankRow()).toBe(composerRow + 1)
    expect(viewport.slice(0, composerRow).every(line => line !== '')).toBe(true)
    expect(viewport.some(line => line.startsWith('selector '))).toBe(false)
    renderer.destroy()
  })

  test('a command window over a full transcript closes in place without reanchoring', async () => {
    const screen = new ScreenHarness(80, 12)
    const renderer = new TermRenderer({ stdout: screen.stdout })
    renderer.init()
    const transcript = Array.from({ length: 20 }, (_, i) => `history ${i}`)
    let commandWindow: string[] = []
    renderer.setRenderCallback(() => ({
      lines: [...transcript, ...commandWindow, `\u276f /mo${CURSOR_MARKER}`, 'footer row'],
      bottomAnchor: true,
      bottomAnchorStart: transcript.length,
      transientRows: commandWindow.length,
    }))

    await renderFrame(renderer)
    await screen.settle()
    expect(screen.rowOf('footer row')).toBe(screen.rows - 1)

    commandWindow = Array.from({ length: 6 }, (_, i) => `selector ${i}`)
    await renderFrame(renderer)
    await screen.settle()
    expect(screen.rowOf('footer row')).toBe(screen.rows - 1)

    commandWindow = []
    await renderFrame(renderer)
    await screen.settle()

    // Clear the six selector rows in place. No clear/replay just to force the
    // footer back down: it follows history with vacant rows below, not above.
    const viewport = screen.viewport()
    const footerRow = screen.rows - 1 - 6
    expect(screen.rowOf('footer row')).toBe(footerRow)
    expect(viewport[footerRow - 1]).toBe('\u276f /mo')
    expect(viewport[footerRow - 2]).toBe('history 19')
    expect(viewport.slice(footerRow + 1).every(line => line === '')).toBe(true)
    expect(viewport.some(line => line.startsWith('selector '))).toBe(false)
    renderer.destroy()
  })

  test('a frame taller than the viewport ends on the bottom row', async () => {
    const screen = new ScreenHarness(80, 24)
    const renderer = new TermRenderer({ stdout: screen.stdout })
    renderer.init()
    const history = Array.from({ length: 60 }, (_, i) => `history ${i}`)
    renderer.setRenderCallback(() => ({
      lines: [...history, `\u276f ${CURSOR_MARKER}`, 'footer row'],
      bottomAnchor: true,
    }))

    await renderFrame(renderer)
    await screen.settle()

    expect(screen.rowOf('footer row')).toBe(screen.rows - 1)
    expect(screen.lastNonBlankRow()).toBe(screen.rows - 1)
    renderer.destroy()
  })

  // Addressable shrink preserves history. If the caret leaves the physical
  // viewport, repaint only that viewport instead of replaying native history.
  test.each([1, 3, 8, 12, 30, 80])(
    'discarding %i thinking rows recovers off-screen geometry without replaying history',
    async thinkingRows => {
      const screen = new ScreenHarness(80, 24)
      const branches: string[] = []
      const renderer = new TermRenderer({ stdout: screen.stdout, trace: entry => branches.push(entry.branch) })
      renderer.init()
      const transcript = Array.from({ length: 40 }, (_, i) => `history ${i}`)
      let thinking = Array.from({ length: thinkingRows }, (_, i) => `thinking ${i}`)
      renderer.setRenderCallback(() => ({
        lines: [...transcript, ...thinking, `\u276f ${CURSOR_MARKER}`, 'footer row'],
        bottomAnchor: true,
      }))
      await renderFrame(renderer)
      await screen.settle()
      expect(screen.rowOf('footer row')).toBe(screen.rows - 1)

      thinking = []
      await renderFrame(renderer)
      await screen.settle()

      const viewport = screen.viewport()
      const visibleShrink = thinkingRows <= screen.rows - 2
      const footerRow = visibleShrink ? screen.rows - 1 - thinkingRows : screen.rows - 1
      expect(screen.rowOf('footer row')).toBe(footerRow)
      expect(viewport[footerRow - 1]).toBe('\u276f')
      expect(branches.at(-1)).toBe(visibleShrink ? 'differential_update' : 'cursor_recovery')
      // No stale thinking rows survive the interrupt.
      expect(viewport.some(line => line.startsWith('thinking '))).toBe(false)
      renderer.destroy()
    },
  )

  test('repeated visible interrupts follow content without forcing the composer down', async () => {
    const screen = new ScreenHarness(80, 24)
    const renderer = new TermRenderer({ stdout: screen.stdout })
    renderer.init()
    const transcript = Array.from({ length: 40 }, (_, i) => `history ${i}`)
    let thinking: string[] = []
    renderer.setRenderCallback(() => ({
      lines: [...transcript, ...thinking, `\u276f ${CURSOR_MARKER}`, 'footer row'],
      bottomAnchor: true,
    }))

    const rows: number[] = []
    for (const height of [6, 14, 3, 21, 9]) {
      thinking = Array.from({ length: height }, (_, i) => `thinking ${i}`)
      await renderFrame(renderer)
      thinking = []
      await renderFrame(renderer)
      await screen.settle()
      rows.push(screen.rowOf('footer row'))
    }

    // Natural placement: new output first uses the vacant rows, then scrolls
    // when necessary. Removing it does not replay the transcript to reanchor.
    expect(rows).toEqual([17, 9, 9, 2, 2])
    renderer.destroy()
  })

  test('streaming growth stays on the differential path and keeps scrollback', async () => {
    const screen = new ScreenHarness(80, 24)
    const branches: string[] = []
    const renderer = new TermRenderer({
      stdout: screen.stdout,
      trace: entry => branches.push(entry.branch),
    })
    renderer.init()
    const transcript = Array.from({ length: 40 }, (_, i) => `history ${i}`)
    let thinking: string[] = []
    renderer.setRenderCallback(() => ({
      lines: [...transcript, ...thinking, `\u276f ${CURSOR_MARKER}`, 'footer row'],
      bottomAnchor: true,
    }))
    await renderFrame(renderer)

    branches.length = 0
    for (let rows = 1; rows <= 25; rows++) {
      thinking = Array.from({ length: rows }, (_, i) => `thinking ${i}`)
      await renderFrame(renderer)
    }
    // Re-anchoring must not turn the streaming hot path into full repaints.
    expect(branches.every(b => b === 'differential_update' || b === 'no_change')).toBe(true)

    thinking = []
    await renderFrame(renderer)
    await screen.settle()
    expect(screen.rowOf('footer row')).toBe(screen.rows - 1)

    // Recovering the visible tail never wipes the existing transcript history.
    const buffer = screen.terminal.buffer.active
    const allRows: string[] = []
    for (let row = 0; row < buffer.length; row++) {
      allRows.push((buffer.getLine(row)?.translateToString(true) ?? '').trimEnd())
    }
    expect(allRows.filter(line => line === 'history 0')).toHaveLength(1)
    expect(allRows).toContain('history 39')
    renderer.destroy()
  })
})
