import { expect, test } from 'bun:test'
import { buildAssistantLines, buildThinkingLines, buildToolCard, buildUserMessage } from '../../src/render/output.js'
import { assistantMessageToOutputLines } from '../../src/render/assistant.js'
import { HistoryRenderCache } from '../../src/term/viewmodel/history-cache.js'
import { buildOutputBlocks, blocksToLines } from '../../src/term/viewmodel/index.js'
import { TermRenderer, type RendererDiagnostic, type RendererTraceEntry } from '../../src/term/screen/renderer.js'
import { CURSOR_MARKER } from '../../src/term/screen/render-frame.js'
import { discardedPartialNotice, flushStreaming, createStreamMachineState, reduceRunEvent } from '../../src/term/app/run/stream.js'
import { createInitialState } from '../../src/term/app/run/state.js'
import { createSpinnerState } from '../../src/term/widgets/spinner.js'
import type { UIAssistantBlock } from '../../src/render/message-types.js'
import type { OutputLine } from '../../src/render/output.js'
import { ScreenHarness } from '../helpers/screen.js'
import { withColumns } from '../helpers/stdout-columns.js'

const COLUMNS = 100

/** The frame rows the REPL paints for `history` followed by a live partial. */
function liveFrame(history: OutputLine[], content: UIAssistantBlock[]): string[] {
  const cache = new HistoryRenderCache()
  const historyRows = cache.sync(history, COLUMNS)
  const partial = buildOutputBlocks(
    assistantMessageToOutputLines(content, false, { streaming: true }),
    { prevKind: cache.trailingKind, columns: COLUMNS },
  )
  return [...historyRows, ...blocksToLines(partial)]
}

/** The frame rows after the same partial has been committed to history. */
function committedFrame(history: OutputLine[], content: UIAssistantBlock[]): string[] {
  const cache = new HistoryRenderCache()
  cache.sync(history, COLUMNS)
  return cache.sync([...history, ...assistantMessageToOutputLines(content)], COLUMNS)
}

test('committing a partial message never changes a rendered row, whatever precedes it', () => {
  const restore = withColumns(COLUMNS)
  try {
    const reasoning = Array.from({ length: 20 }, (_, i) => `reasoning row ${i + 1}`).join('\n\n')
    const replies: Record<string, UIAssistantBlock[]> = {
      shortThought: [{ type: 'thinking', contentIndex: 0, text: 'weighing the options' }],
      longThought: [{ type: 'thinking', contentIndex: 0, text: reasoning }],
      adjacentThoughts: [
        { type: 'thinking', contentIndex: 0, text: reasoning },
        { type: 'thinking', contentIndex: 1, text: 'next thought' },
      ],
      answered: [
        { type: 'thinking', contentIndex: 0, text: reasoning },
        { type: 'text', contentIndex: 1, text: '# Result\n\nThe answer is **42**.\n\n| a | b |\n|---|---|\n| 1 | 2 |' },
      ],
    }
    const histories: Record<string, OutputLine[]> = {
      afterUser: buildUserMessage('question'),
      afterTool: [...buildUserMessage('q'), ...buildToolCard({ id: 't', name: 'bash', status: 'done', args: { command: 'ls' }, result: 'a' })],
      // A continuation (length stop, second message in one turn) follows
      // assistant prose: the committed form joins the previous message with no
      // new block-start margin, so the live form must too.
      afterAssistant: [...buildUserMessage('q'), ...buildAssistantLines('first half of the reply')],
      afterThought: buildThinkingLines('previous thought'),
      empty: [],
    }
    for (const [name, history] of Object.entries(histories)) {
      for (const [replyName, reply] of Object.entries(replies)) {
        expect(liveFrame(history, reply), `${name}: ${replyName}`).toEqual(committedFrame(history, reply))
      }
    }
  } finally {
    restore()
  }
})

test('the physical thinking window stays visible as the answer arrives and commits', async () => {
  const restore = withColumns(COLUMNS)
  const screen = new ScreenHarness(COLUMNS, 24)
  const traces: RendererTraceEntry[] = []
  const diagnostics: RendererDiagnostic[] = []
  const renderer = new TermRenderer({
    stdout: screen.stdout,
    trace: entry => traces.push(entry),
    onDiagnostic: diagnostic => diagnostics.push(diagnostic),
  })
  const history = buildUserMessage('q')
  let content: UIAssistantBlock[] = [{
    type: 'thinking', contentIndex: 0,
    text: Array.from({ length: 20 }, (_, i) => `reasoning row ${i + 1}`).join('\n\n'),
  }]
  let committed = false
  renderer.init()
  renderer.setRenderCallback(() => ({
    lines: [
      ...(committed ? committedFrame(history, content) : liveFrame(history, content)),
      `> ${CURSOR_MARKER}`, 'footer',
    ],
    bottomAnchor: true,
  }))
  const paint = async () => {
    renderer.requestRender()
    await Bun.sleep(25)
    await screen.settle()
  }
  try {
    await paint()
    const thoughtRow = screen.rowOf('✻ ↑ 18 rows (ctrl+o)')
    expect(thoughtRow).toBeGreaterThanOrEqual(0)
    const thought = screen.viewport().slice(thoughtRow, thoughtRow + 3)
    expect(thought).toEqual(['✻ ↑ 18 rows (ctrl+o)', '  reasoning row 19', '  reasoning row 20'])
    traces.length = 0
    diagnostics.length = 0

    content = [...content, { type: 'text', contentIndex: 1, text: 'Visible answer' }]
    await paint()
    expect(screen.rowOf('✻ ↑ 18 rows (ctrl+o)')).toBe(thoughtRow)
    expect(screen.viewport().slice(thoughtRow, thoughtRow + 3)).toEqual(thought)
    expect(screen.rowOf('⏺ Visible answer')).toBeGreaterThan(thoughtRow + 2)
    const answered = screen.viewport()

    committed = true
    await paint()
    expect(screen.viewport()).toEqual(answered)
    expect(diagnostics.filter(d => d.kind === 'stale_scrollback' || d.kind === 'full_redraw')).toEqual([])
    const ansi = traces.flatMap(t => t.ansiWrites).join('')
    expect(ansi).not.toContain('\x1b[3J')
    expect(ansi).not.toContain('\x1b[2J')
  } finally {
    renderer.destroy()
    restore()
  }
})

test('a reader scrolled up stays put while a tall reply streams a table, reflows it, and commits', async () => {
  const restore = withColumns(COLUMNS)
  const screen = new ScreenHarness(COLUMNS, 24)
  const traces: RendererTraceEntry[] = []
  const diagnostics: RendererDiagnostic[] = []
  const renderer = new TermRenderer({
    stdout: screen.stdout,
    trace: entry => traces.push(entry),
    onDiagnostic: diagnostic => diagnostics.push(diagnostic),
  })
  const history: OutputLine[] = [...buildUserMessage('q'), ...buildAssistantLines('first half of the reply')]
  const cache = new HistoryRenderCache()
  let markdown = '| Name | Value |\n| --- | --- |\n' + Array.from({ length: 35 }, (_, i) => `| r${i} | x |`).join('\n')
  let content: UIAssistantBlock[] = [{ type: 'text', contentIndex: 0, text: markdown }]
  let committed = false
  renderer.init()
  renderer.setRenderCallback(() => {
    const rows = cache.sync(committed ? [...history, ...assistantMessageToOutputLines(content)] : history, COLUMNS)
    const partial = committed
      ? []
      : blocksToLines(buildOutputBlocks(
        assistantMessageToOutputLines(content, false, { streaming: true }),
        { prevKind: cache.trailingKind, columns: COLUMNS },
      ))
    return { lines: [...rows, ...partial, `> ${CURSOR_MARKER}`, 'footer'], bottomAnchor: true }
  })
  const paint = async () => {
    renderer.requestRender()
    await Bun.sleep(25)
    await screen.settle()
  }
  try {
    await paint()
    screen.terminal.scrollLines(-40)
    const readingTop = screen.terminal.buffer.active.viewportY
    const reading = screen.viewport()
    traces.length = 0

    // A late wide cell widens every column: rows already in scrollback change.
    markdown += '\n| final | a substantially longer cell changes the column geometry |'
    content = [{ type: 'text', contentIndex: 0, text: markdown }]
    await paint()
    expect(screen.terminal.buffer.active.viewportY).toBe(readingTop)
    expect(screen.viewport()).toEqual(reading)
    expect(diagnostics.map(d => d.kind)).toEqual(['stale_scrollback'])

    // Completion moves the same content into history: nothing may repaint.
    committed = true
    await paint()
    expect(screen.terminal.buffer.active.viewportY).toBe(readingTop)
    expect(screen.viewport()).toEqual(reading)
    expect(traces.every(t => t.branch === 'differential_update' || t.branch === 'no_change')).toBe(true)
    const ansi = traces.flatMap(t => t.ansiWrites).join('')
    expect(ansi).not.toContain('\x1b[3J')
    expect(ansi).not.toContain('\x1b[2J')
    expect(diagnostics.filter(d => d.kind === 'full_redraw')).toEqual([])

    screen.terminal.scrollToBottom()
    const bottom = screen.viewport()
    expect(bottom.some(line => line.includes('final'))).toBe(true)
    expect(bottom.at(-1)).toBe('footer')
  } finally {
    renderer.destroy()
    restore()
  }
})

test('a discarded partial reply leaves a visible notice instead of vanishing', () => {
  const initial = createStreamMachineState(createInitialState('model', '/tmp'), createSpinnerState())
  const partial = reduceRunEvent(initial, {
    kind: 'assistant_delta',
    payload: { content_index: 0, content_type: 'text', delta: 'half an answer the user already read' },
  }, { termRows: 24 })

  const retrying = reduceRunEvent(partial.state, {
    kind: 'llm_call_retry',
    payload: { attempt: 1, max_retries: 3, delay_ms: 10, error: 'retryable' },
  }, { termRows: 24 })
  const text = retrying.commitLines.map(line => line.text).join('\n')
  expect(text).not.toContain('half an answer')
  expect(text).toContain('Discarded an incomplete reply (36 chars) — retrying the request')
  expect(retrying.state.appState.currentAssistantContent).toEqual([])

  // Attempts that failed before streaming anything stay silent.
  const silent = reduceRunEvent(retrying.state, {
    kind: 'llm_call_retry',
    payload: { attempt: 2, max_retries: 3, delay_ms: 10, error: 'retryable' },
  }, { termRows: 24 })
  expect(silent.commitLines.map(line => line.text).join('\n')).not.toContain('Discarded')

  expect(discardedPartialNotice([{ type: 'text', contentIndex: 0, text: '   \n' }], 'llm_call_retry')).toEqual([])
  expect(discardedPartialNotice([
    { type: 'tool_call', contentIndex: 0, toolCall: { id: 'x', name: 'bash', status: 'queued', args: {} } },
  ], 'context_compaction_started').map(l => l.text).join()).toContain('1 tool call(s)) — compacting context and retrying')
  expect(flushStreaming(initial).lines).toEqual([])
})
