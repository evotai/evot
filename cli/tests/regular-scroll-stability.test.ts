import { expect, test } from 'bun:test'
import { buildToolCard } from '../src/render/output.js'
import { TermRenderer, type RendererTraceEntry } from '../src/term/renderer.js'
import { CURSOR_MARKER } from '../src/term/render-frame.js'
import { buildOutputBlocks, blocksToLines } from '../src/term/viewmodel/index.js'
import type { UIToolCall } from '../src/term/app/types.js'
import { ScreenHarness } from './helpers/screen.js'

async function paint(renderer: TermRenderer, screen: ScreenHarness): Promise<void> {
  renderer.requestRender()
  await Bun.sleep(25)
  await screen.settle()
}

function rows(call: UIToolCall, expanded = true): string[] {
  return blocksToLines(buildOutputBlocks(buildToolCard(call, expanded), { columns: 100 }))
}

test('ordinary terminal: write streaming preserves reading position and completion replaces the preview once', async () => {
  const screen = new ScreenHarness(100, 24)
  const traces: RendererTraceEntry[] = []
  const renderer = new TermRenderer({ stdout: screen.stdout, trace: entry => traces.push(entry) })
  const content = Array.from({ length: 80 }, (_, i) => `const value${i} = ${i};`).join('\n') + '\n'
  let call: UIToolCall = { id: 'scroll-write', name: 'write', status: 'queued', argsComplete: false, args: { path: 'src/live.ts', content } }
  let expanded = false
  let committed: string[] | null = null
  renderer.init()
  renderer.setRenderCallback(() => ({
    lines: [...Array.from({ length: 50 }, (_, i) => `history ${i}`), ...(committed ?? rows(call, expanded)), 'spinner', `> ${CURSOR_MARKER}`, 'footer'],
    committedRows: 50 + (committed?.length ?? 0),
    bottomAnchor: true,
  }))
  try {
    await paint(renderer, screen)
    expanded = true
    await paint(renderer, screen)
    // Ctrl+O itself can legitimately relayout history. What must not happen
    // afterward is a new clear/replay for every generated line or tool status.
    traces.length = 0
    screen.terminal.scrollLines(-35)
    const readingTop = screen.terminal.buffer.active.viewportY
    const readingRows = screen.viewport()
    for (let i = 80; i < 84; i++) {
      call = { ...call, args: { ...call.args, content: `${call.args.content}const value${i} = ${i};\n` } }
      await paint(renderer, screen)
      expect(screen.terminal.buffer.active.viewportY).toBe(readingTop)
      expect(screen.viewport()).toEqual(readingRows)
    }
    for (const change of [
      { argsComplete: true },
      { status: 'running' as const },
      { details: { diff: '@@ -0,0 +1 @@\n+authoritative preview', preview: true } },
    ]) {
      call = { ...call, ...change }
      await paint(renderer, screen)
      expect(screen.terminal.buffer.active.viewportY).toBe(readingTop)
      expect(screen.viewport()).toEqual(readingRows)
    }
    expect(traces.every(e => e.branch === 'differential_update' || e.branch === 'no_change')).toBe(true)
    expect(traces.flatMap(e => e.ansiWrites).join('')).not.toContain('\x1b[3J')

    // Completion can recover the visible tail without clearing history. The
    // next durable commit repairs the provisional preview in scrollback once.
    call = { ...call, status: 'done', result: 'Wrote content', durationMs: 12 }
    await paint(renderer, screen)
    expect(traces.flatMap(e => e.ansiWrites).join('')).not.toContain('\x1b[3J')
    traces.length = 0
    committed = rows(call)
    await paint(renderer, screen)
    expect(traces.map(e => e.branch)).toEqual(['scrollback_shift'])
    const completedRows = screen.viewport()
    const completedTop = screen.terminal.buffer.active.viewportY
    traces.length = 0
    await paint(renderer, screen)
    expect(screen.viewport()).toEqual(completedRows)
    expect(screen.terminal.buffer.active.viewportY).toBe(completedTop)
    expect(traces.every(e => e.branch === 'no_change')).toBe(true)
    const ansi = traces.flatMap(e => e.ansiWrites).join('')
    expect(ansi).not.toContain('\x1b[3J')
    expect(ansi).not.toContain('\x1b[?1049h')
    expect(screen.terminal.buffer.active.type).toBe('normal')
    const buffer = screen.terminal.buffer.active
    const all = Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? '')
    expect(all.filter(line => line === 'history 0')).toHaveLength(1)
    expect(all.join('\n')).toContain('authoritative preview')
    expect(all.join('\n')).not.toContain('const value')
  } finally {
    renderer.destroy()
  }
})

test('write preview is deterministic until a successful diff replaces it', () => {
  const engineDiff = '@@ -1 +1 @@\n-old\n+new'
  for (const name of ['write', 'file_write']) {
    let call: UIToolCall = { id: `stable-${name}`, name, status: 'queued', argsComplete: false,
      args: { path: 'a.ts', content: '/* comment\nconst first = 1;\n' } }
    const prefix = rows(call).slice(0, -4) // omit mutable tail and closing padding
    call = { ...call, args: { ...call.args, content: `${call.args.content}*/\nconst second = 2;\n` } }
    expect(rows(call).slice(0, prefix.length)).toEqual(prefix)
    for (const status of ['running', 'done', 'error'] as const) {
      const completed = { ...call, status, argsComplete: true, result: status === 'error' ? 'Permission denied' : 'Wrote content', details: { diff: engineDiff } }
      const rendered = rows(completed)
      if (status !== 'done') expect(rendered.slice(0, prefix.length)).toEqual(prefix)
      // Only a successful call swaps the streamed body for the engine's diff.
      expect(buildToolCard(completed).some(line => line.diffText === engineDiff)).toBe(status === 'done')
      // Same args render the same bytes on a fresh card (no hidden cache).
      expect(rows({ ...completed, id: `fresh-${name}-${status}` })).toEqual(rendered)
      if (status === 'error') expect(rendered.join('\n')).toContain('Permission denied')
    }
  }
})

test('a growing write body never re-indents rows it already painted', () => {
  // The gutter is sized from the largest line number, so a body that grows past
  // 9, 99 (and in split layout, one line earlier) would widen it and shift every
  // row already on screen. Rows that scrolled out cannot be repainted, so the
  // transcript would keep a permanent one-column jog.
  const body = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  const bodyRows = (content: string, columns: number): string[] => {
    const card = buildToolCard({ id: 'gutter', name: 'write', status: 'queued', argsComplete: false, args: { path: 'a.ts', content } })
    const diffRow = card.filter(l => l.diffText !== undefined)
    expect(diffRow).toHaveLength(1)
    return blocksToLines(buildOutputBlocks(diffRow, { columns }))
  }

  // 121 is the split-diff breakpoint: cover both layouts.
  for (const columns of [80, 140]) {
    for (const n of [2, 9, 10, 11, 99, 100, 101]) {
      const grown = bodyRows(body(n), columns)
      const before = bodyRows(body(n - 1), columns)
      expect(grown.slice(0, before.length)).toEqual(before)
    }
    // The engine's authoritative diff for a new file must land on the same rows.
    const content = body(12)
    const streamed = bodyRows(content, columns)
    const settled = buildToolCard({
      id: 'gutter-done', name: 'write', status: 'done', argsComplete: true, result: 'Wrote a.ts',
      args: { path: 'a.ts', content }, details: { created: true, diff: `@@ -0,0 +1,12 @@\n${Array.from({ length: 12 }, (_, i) => `+line ${i + 1}`).join('\n')}` },
    }).filter(l => l.diffText !== undefined)
    expect(blocksToLines(buildOutputBlocks(settled, { columns }))).toEqual(streamed)
  }
})

test('write progress stays below the stable body and result metadata is not lost', () => {
  const base: UIToolCall = { id: 'write-progress-tail', name: 'write', status: 'running', args: { path: 'a.txt', content: 'one\ntwo' } }
  const running = buildToolCard({ ...base, progress: 'Flushing file', details: { diff: '@@ -1 +1 @@\n-old\n+new' } })
  expect(running.map(line => line.text).join('\n')).toContain('Flushing file')
  expect(running.findIndex(line => line.text.includes('Flushing file'))).toBeGreaterThan(running.findIndex(line => line.diffText !== undefined))
  const done = buildToolCard({ ...base, status: 'done', durationMs: 1200, result: 'Saved', details: { created: true, bytes: 7 } })
  expect(done.map(line => line.text).join('\n')).toContain('created 7 B · 1.2s')
  // Without an engine diff the streamed body stays, still diff-shaped.
  expect(done.some(line => line.diffText?.includes('+one'))).toBe(true)
  expect(done.map(line => line.text).join('\n')).toContain('Saved')
  expect(buildToolCard({ ...base, progress: '__evot_spill_event__ secret' }).some(line => line.text.includes('__evot_spill_event__'))).toBe(false)
})

test('write without retained content still shows its authoritative diff', () => {
  const call: UIToolCall = { id: 'legacy-write', name: 'write', status: 'done', args: { path: 'a.ts' }, details: { diff: '@@ -1 +1 @@\n-old\n+new' } }
  expect(buildToolCard(call).some(line => line.diffText?.includes('+new'))).toBe(true)
})

test('visible shrink preserves actual scrollback and does not scroll during clearing', async () => {
  const screen = new ScreenHarness(100, 24)
  const traces: RendererTraceEntry[] = []
  const renderer = new TermRenderer({ stdout: screen.stdout, trace: e => traces.push(e) })
  let extra = Array.from({ length: 8 }, (_, i) => `thinking ${i}`)
  renderer.init()
  renderer.setRenderCallback(() => ({
    lines: [...Array.from({ length: 50 }, (_, i) => `history ${i}`), ...extra, `> ${CURSOR_MARKER}`, 'footer'], bottomAnchor: true,
  }))
  try {
    await paint(renderer, screen)
    const oldBase = screen.terminal.buffer.active.baseY
    screen.terminal.scrollLines(-15)
    const reading = screen.viewport()
    const top = screen.terminal.buffer.active.viewportY
    traces.length = 0
    extra = []
    await paint(renderer, screen)
    expect(traces.at(-1)?.branch).toBe('differential_update')
    expect(traces.flatMap(e => e.ansiWrites).join('')).not.toContain('\x1b[3J')
    expect(screen.terminal.buffer.active.baseY).toBe(oldBase)
    expect(screen.terminal.buffer.active.viewportY).toBe(top)
    expect(screen.viewport()).toEqual(reading)
    screen.terminal.scrollToBottom()
    expect(screen.rowOf('footer')).toBe(15)
    expect(screen.viewport().slice(16).every(line => line === '')).toBe(true)
    expect(screen.terminal.buffer.active.cursorY).toBe(14)
    // The next append should use free rows rather than snapping to the bottom.
    extra = ['new output']
    await paint(renderer, screen)
    expect(screen.rowOf('footer')).toBe(16)
    expect(screen.terminal.buffer.active.baseY).toBe(oldBase)
  } finally {
    renderer.destroy()
  }
})
