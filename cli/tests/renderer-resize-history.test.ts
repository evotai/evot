import { expect, test } from 'bun:test'
import chalk from 'chalk'
import { buildToolCard, buildUserMessage } from '../src/render/output.js'
import { CURSOR_MARKER } from '../src/term/render-frame.js'
import { TermRenderer } from '../src/term/renderer.js'
import { HistoryRenderCache } from '../src/term/viewmodel/history-cache.js'
import type { OutputLine } from '../src/term/viewmodel/types.js'
import { ScreenHarness } from './helpers/screen.js'

async function paint(renderer: TermRenderer, screen: ScreenHarness): Promise<void> {
  renderer.requestRender()
  await Bun.sleep(25)
  await screen.settle()
}

function bufferRows(screen: ScreenHarness): string[] {
  const buffer = screen.terminal.buffer.active
  return Array.from({ length: buffer.length }, (_, row) =>
    buffer.getLine(row)?.translateToString(true) ?? '',
  )
}

function cardHistory(): OutputLine[] {
  return Array.from({ length: 8 }, (_, row) => [
    ...buildUserMessage(`question ${row}`),
    ...buildToolCard({
      id: `tool-${row}`,
      name: 'bash',
      status: 'done',
      args: { command: `echo result ${row}` },
      result: `result ${row}`,
    }),
  ]).flat()
}

function expectFullWidthBackgrounds(screen: ScreenHarness): void {
  const buffer = screen.terminal.buffer.active
  const fragmented: Array<{ row: number; text: string; coloredColumns: number }> = []
  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row)
    if (!line) continue
    const coloredColumns = Array.from({ length: screen.columns }, (_, column) =>
      line.getCell(column),
    ).filter(cell => cell && !cell.isBgDefault()).length
    if (coloredColumns > 0 && coloredColumns !== screen.columns) {
      fragmented.push({ row, text: line.translateToString(true), coloredColumns })
    }
  }
  expect(fragmented).toEqual([])
}

test('consecutive height resizes preserve one ordered copy of committed history', async () => {
  const previousColorLevel = chalk.level
  chalk.level = 3
  const screen = new ScreenHarness(80, 24)
  const renderer = new TermRenderer({ stdout: screen.stdout })
  const cache = new HistoryRenderCache()
  const source = cardHistory()
  let draft = ''
  renderer.init()
  renderer.setRenderCallback(() => {
    const history = cache.sync(source, renderer.termCols)
    return {
      lines: [...history, 'Latest answer', `❯ ${draft}${CURSOR_MARKER}`, 'footer'],
      committedRows: history.length,
      bottomAnchor: true,
      bottomAnchorStart: history.length,
    }
  })
  try {
    await paint(renderer, screen)
    for (const rows of [12, 30, 16, 24]) {
      screen.resize(80, rows)
      await paint(renderer, screen)
      expectFullWidthBackgrounds(screen)
      for (let row = 0; row < 8; row++) {
        expect(bufferRows(screen).filter(line => line.includes(`question ${row}`))).toHaveLength(1)
        expect(bufferRows(screen).filter(line => line.includes(`echo result ${row}`))).toHaveLength(1)
      }
      expect(bufferRows(screen).filter(line => line === 'footer')).toHaveLength(1)
      expect(screen.viewport().at(-1)).toBe('footer')

      // A resize must not poison the coordinate base used by the next diff.
      draft += 'x'
      await paint(renderer, screen)
      expect(bufferRows(screen).filter(line => line === 'footer')).toHaveLength(1)
      expect(screen.viewport().at(-2)).toBe(`❯ ${draft}`)
    }
  } finally {
    renderer.destroy()
    screen.terminal.dispose()
    chalk.level = previousColorLevel
  }
})

test('consecutive width resizes keep card backgrounds continuous throughout scrollback', async () => {
  const previousColorLevel = chalk.level
  chalk.level = 3
  const screen = new ScreenHarness(80, 24)
  const renderer = new TermRenderer({ stdout: screen.stdout })
  const cache = new HistoryRenderCache()
  const source = cardHistory()
  renderer.init()
  renderer.setRenderCallback(() => {
    const history = cache.sync(source, renderer.termCols)
    return {
      lines: [...history, 'Latest answer', `❯ ${CURSOR_MARKER}`, 'footer'],
      committedRows: history.length,
      bottomAnchor: true,
      bottomAnchorStart: history.length,
    }
  })
  try {
    await paint(renderer, screen)
    expectFullWidthBackgrounds(screen)
    for (const columns of [65, 100, 72, 90, 80]) {
      screen.resize(columns, 24)
      await paint(renderer, screen)
      // Inspect the complete physical buffer, not just the latest viewport:
      // native reflow can leave partial-width continuation rows above it.
      expectFullWidthBackgrounds(screen)
      expect(bufferRows(screen).filter(line => line === 'footer')).toHaveLength(1)
      expect(screen.viewport().at(-1)).toBe('footer')
    }
  } finally {
    renderer.destroy()
    screen.terminal.dispose()
    chalk.level = previousColorLevel
  }
})
