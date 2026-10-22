import { expect, test } from 'bun:test'
import { HistoryRenderCache } from '../src/term/viewmodel/history-cache.js'
import { CURSOR_MARKER } from '../src/term/render-frame.js'
import { TermRenderer, type RendererTraceEntry } from '../src/term/renderer.js'
import { ScreenHarness } from './helpers/screen.js'

async function paint(renderer: TermRenderer, screen: ScreenHarness): Promise<void> {
  renderer.requestRender()
  await Bun.sleep(25)
  await screen.settle()
}

function bufferRows(screen: ScreenHarness): string[] {
  const buffer = screen.terminal.buffer.active
  return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true) ?? '')
}

test('widening a long idle session never replays old tool output through the viewport', async () => {
  const screen = new ScreenHarness(80, 24)
  const frames: RendererTraceEntry[] = []
  const renderer = new TermRenderer({ stdout: screen.stdout, trace: frame => frames.push(frame) })
  const history = Array.from({ length: 2000 }, (_, row) => `old tool output ${row}`)
  renderer.init()
  renderer.setRenderCallback(() => ({
    lines: [...history, 'Latest answer is ready.', '', `❯ ${CURSOR_MARKER}Run the targeted tests 1/3 ⇥`, 'footer'],
    committedRows: history.length,
    bottomAnchor: true,
    bottomAnchorStart: history.length,
  }))
  const transientOldRows: string[] = []
  let resizing = false
  // Observe intermediate parser states too. A final-screen assertion alone
  // misses the replay: both the broken and fixed renderer end on the latest
  // answer. SGR is present after each output row in a full repaint.
  const observer = screen.terminal.parser.registerCsiHandler({ final: 'm' }, () => {
    if (resizing && screen.viewport().some(row => row === 'old tool output 0')) {
      transientOldRows.push('old tool output 0')
    }
    return false
  })
  try {
    await paint(renderer, screen)
    const originalScrollback = bufferRows(screen).slice(0, 100)
    const originalBase = screen.terminal.buffer.active.baseY
    resizing = true
    screen.resize(81, 24)
    await paint(renderer, screen)
    expect(transientOldRows).toEqual([])
    const writes = frames.at(-1)!.ansiWrites.join('')
    expect(writes).not.toContain('\x1b[3J')
    expect(writes).not.toContain('old tool output 0')
    expect(writes.length).toBeLessThan(24 * 150)
    expect(screen.terminal.buffer.active.baseY).toBe(originalBase)
    expect(bufferRows(screen).slice(0, 100)).toEqual(originalScrollback)
    expect(screen.rowOf('Latest answer is ready.')).toBe(20)
    expect(screen.rowOf('Run the targeted tests')).toBe(22)
    expect(screen.rowOf('footer')).toBe(23)
    const buffer = screen.terminal.buffer.active
    expect(buffer.cursorY).toBe(22)
    expect(buffer.cursorX).toBe(2)
  } finally {
    observer.dispose()
    renderer.destroy()
    screen.terminal.dispose()
  }
})

test('repeated width and height changes rewrap the tail and keep subsequent diffs addressable', async () => {
  const screen = new ScreenHarness(70, 14)
  const frames: RendererTraceEntry[] = []
  const renderer = new TermRenderer({ stdout: screen.stdout, trace: frame => frames.push(frame) })
  const cache = new HistoryRenderCache()
  const source = Array.from({ length: 60 }, (_, row) => ({
    id: `result-${row}`,
    kind: 'assistant' as const,
    text: `Result ${row}: resizing must keep the latest answer visible without replaying earlier tool output.`,
  }))
  let draft = ''
  let suffix = ''
  renderer.init()
  renderer.setRenderCallback(() => {
    const history = cache.sync(source, renderer.termCols)
    return {
      lines: [...history, `LATEST ANSWER${suffix}`, `❯ ${draft}${CURSOR_MARKER}`, 'footer'],
      committedRows: history.length,
      bottomAnchor: true,
      bottomAnchorStart: history.length,
    }
  })
  try {
    await paint(renderer, screen)
    for (const [columns, rows] of [[71, 14], [65, 14], [90, 18], [61, 10], [72, 14]] as const) {
      screen.resize(columns, rows)
      await paint(renderer, screen)
      const writes = frames.at(-1)!.ansiWrites.join('')
      expect(writes).not.toContain('\x1b[3J')
      expect(frames.at(-1)!.frameState.overwideLines).toEqual([])
      const buffer = screen.terminal.buffer.active
      const view = Array.from({ length: rows }, (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '')
      expect(view.at(-3)).toBe(`LATEST ANSWER${suffix}`)
      expect(view.at(-1)).toBe('footer')
      draft += 'x'
      suffix += '!'
      await paint(renderer, screen)
      expect(frames.at(-1)!.branch).toBe('differential_update')
      const updated = screen.terminal.buffer.active
      expect(updated.getLine(updated.baseY + rows - 3)?.translateToString(true)).toBe(`LATEST ANSWER${suffix}`)
      expect(updated.getLine(updated.baseY + rows - 2)?.translateToString(true)).toBe(`❯ ${draft}`)
      expect(updated.cursorY).toBe(rows - 2)
      expect(updated.cursorX).toBe(2 + draft.length)
      expect(bufferRows(screen).filter(row => row === 'footer')).toHaveLength(1)
    }
  } finally {
    renderer.destroy()
    screen.terminal.dispose()
  }
})

test('a reader scrolled up is not forced back to the latest answer by a resize', async () => {
  const screen = new ScreenHarness(80, 24)
  const renderer = new TermRenderer({ stdout: screen.stdout })
  const history = Array.from({ length: 200 }, (_, row) => `history ${row}`)
  renderer.init()
  renderer.setRenderCallback(() => [...history, `❯ ${CURSOR_MARKER}`, 'footer'])
  try {
    await paint(renderer, screen)
    screen.terminal.scrollLines(-80)
    const before = screen.terminal.buffer.active.viewportY
    const firstRow = screen.viewport()[0]
    screen.resize(81, 24)
    await paint(renderer, screen)
    expect(screen.terminal.buffer.active.viewportY).toBe(before)
    expect(screen.viewport()[0]).toBe(firstRow)
    screen.terminal.scrollToBottom()
    expect(screen.rowOf('footer')).toBe(23)
  } finally {
    renderer.destroy()
    screen.terminal.dispose()
  }
})

for (const concurrent of [false, true]) {
  test(`explicit history erasure still repairs scrollback ${concurrent ? 'during' : 'after'} a resize`, async () => {
    const screen = new ScreenHarness(80, 24)
    const frames: RendererTraceEntry[] = []
    const renderer = new TermRenderer({ stdout: screen.stdout, trace: frame => frames.push(frame) })
    let first = 'revealed-fixture-value'
    const history = Array.from({ length: 80 }, (_, row) => `history ${row}`)
    renderer.init()
    renderer.setRenderCallback(() => ({
      lines: [first, ...history, `❯ ${CURSOR_MARKER}`, 'footer'],
      committedRows: history.length + 1,
    }))
    try {
      await paint(renderer, screen)
      screen.resize(81, 24)
      if (!concurrent) await paint(renderer, screen)
      first = 'masked-fixture-value'
      renderer.invalidateScrollback()
      await paint(renderer, screen)
      expect(frames.at(-1)!.branch).toBe('history_invalidated')
      expect(bufferRows(screen).some(row => row.includes('revealed-fixture-value'))).toBe(false)
      expect(bufferRows(screen)).toContain('masked-fixture-value')
      expect(screen.rowOf('footer')).toBe(23)
    } finally {
      renderer.destroy()
      screen.terminal.dispose()
    }
  })
}
