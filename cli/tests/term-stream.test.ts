import { describe, expect, test } from 'bun:test'
import stripAnsi from 'strip-ansi'
import { createSpinnerState } from '../src/term/spinner.js'
import { createInitialState } from '../src/term/app/state.js'
import { createStreamMachineState, reduceRunEvent, flushStreaming } from '../src/term/app/stream.js'
import { buildToolCard } from '../src/render/output.js'
import { assistantToolCalls, findAssistantToolCall } from '../src/term/app/assistant-content.js'
import type { OutputLine } from '../src/render/output.js'

describe('term stream machine', () => {
  test('automatic compaction phases drive method-specific spinner labels', () => {
    const initial = createStreamMachineState(createInitialState('model', '/tmp'), createSpinnerState())
    const cases = [
      ['planning', 'compact'],
      ['remote', 'compact_remote'],
      ['local_fallback', 'compact_local_fallback'],
      ['local', 'compact_local'],
    ] as const

    let state = initial
    for (const [phase, toolName] of cases) {
      const update = reduceRunEvent(state, {
        kind: 'context_compaction_phase',
        payload: { phase },
      }, { termRows: 24 })
      state = update.state
      expect(state.spinnerState.phase).toBe('executing')
      expect(state.spinnerState.toolName).toBe(toolName)
    }

    const complete = reduceRunEvent(state, {
      kind: 'context_compaction_phase',
      payload: { phase: 'complete' },
    }, { termRows: 24 })
    expect(complete.state.spinnerState.phase).toBe('preparing')
  })

  test('summary activity changes the spinner without exposing summary deltas', () => {
    let state = createStreamMachineState(createInitialState('model', '/tmp'), createSpinnerState())
    for (const [activity, toolName] of [['waiting', 'compact_waiting'], ['generating', 'compact_generating']] as const) {
      const update = reduceRunEvent(state, {
        kind: 'context_compaction_phase', payload: { phase: 'local', activity },
      }, { termRows: 24 })
      state = update.state
      expect(state.spinnerState.toolName).toBe(toolName)
      expect(state.spinnerState.tokenCount).toBe(0)
      expect(update.commitLines).toEqual([])
      expect(update.rerenderStatus).toBe(true)
    }
    const complete = reduceRunEvent(state, {
      kind: 'context_compaction_phase', payload: { phase: 'complete' },
    }, { termRows: 24 })
    expect(complete.state.spinnerState.phase).toBe('preparing')
    expect(complete.state.spinnerState.toolName).toBeNull()
  })

  test('long quota wait shows one model-specific error card and deduplicates re-probes', () => {
    const initial = createStreamMachineState(createInitialState('claude-fable-5', '/tmp'), createSpinnerState())
    const event = {
      kind: 'quota_waiting',
      payload: {
        delay_ms: 1_800_000,
        error: 'HTTP 429: rate_limit_error: Rate limit exceeded. Please retry later.',
      },
    }
    const waiting = reduceRunEvent(initial, event, { termRows: 24 })

    expect(waiting.noticeLines).toHaveLength(1)
    expect(waiting.noticeLines[0]?.text).toContain('quota unavailable')
    expect(waiting.state.spinnerState.phase).toBe('quota_waiting')
    expect(waiting.state.spinnerState.waitRetryAt).toBeGreaterThan(Date.now())
    const text = waiting.commitLines.map(line => line.text).join('\n')
    expect(text).toContain('✦ llm  claude-fable-5')
    expect(text).toContain('quota unavailable · retry in 30m')
    expect(text).toContain('Rate limited')
    expect(text).not.toContain('attempt 1/10')
    expect(waiting.writeLines.some(line => line.text.includes('HTTP 429'))).toBe(true)
    expect(waiting.state.appState.verboseEvents).toEqual([])
    expect(waiting.rerenderStatus).toBe(true)

    const repeated = reduceRunEvent(waiting.state, event, { termRows: 24 })
    expect(repeated.commitLines).toEqual([])
    expect(repeated.noticeLines).toEqual([])
    expect(repeated.state.spinnerState.waitRetryAt).toBeGreaterThan(Date.now())

    const changed = reduceRunEvent(waiting.state, {
      kind: 'quota_waiting',
      payload: {
        delay_ms: 1_800_000,
        error: 'HTTP 429: rate_limit_error: Rate limit exceeded. request_id=abc',
      },
    }, { termRows: 24 })
    expect(changed.commitLines).toEqual([])
  })

  test('the quota card re-arms on a fresh call, not on a mid-storm attempt', () => {
    // The retry work moved this reset from "any llm_call_started" to "attempt 0",
    // which the quota path shares. A bounded retry re-emits the start event with
    // attempt > 0; treating that as a new call would let one quota wait print its
    // card again mid-storm.
    const qerr = 'HTTP 429: rate_limit_error: Rate limit exceeded.'
    const event = { kind: 'quota_waiting', payload: { delay_ms: 60_000, error: qerr } }
    let state = createStreamMachineState(createInitialState('claude-opus-5', '/tmp'), createSpinnerState())

    const first = reduceRunEvent(state, event, { termRows: 24 })
    expect(first.commitLines.length).toBeGreaterThan(0)
    state = first.state

    state = reduceRunEvent(state, {
      kind: 'llm_call_started',
      payload: { model: 'claude-opus-5', turn: 1, attempt: 2 },
    }, { termRows: 24 }).state
    expect(state.quotaWaitShown).toBe(true)
    expect(reduceRunEvent(state, event, { termRows: 24 }).commitLines).toEqual([])

    state = reduceRunEvent(state, {
      kind: 'llm_call_started',
      payload: { model: 'claude-opus-5', turn: 2, attempt: 0 },
    }, { termRows: 24 }).state
    expect(state.quotaWaitShown).toBe(false)
    expect(reduceRunEvent(state, event, { termRows: 24 }).commitLines.length).toBeGreaterThan(0)
  })

  test('quota wait sanitizes provider ANSI before committing a card', () => {
    const initial = createStreamMachineState(createInitialState('claude-fable-5', '/tmp'), createSpinnerState())
    const waiting = reduceRunEvent(initial, {
      kind: 'quota_waiting',
      payload: {
        delay_ms: 60_000,
        error: '\x1b[31mHTTP 429\x1b]8;;https://evil.example\x07click\x1b]8;;\x07',
      },
    }, { termRows: 24 })
    const text = waiting.commitLines.map(line => line.text).join('\n')
    expect(text).toContain('Rate limited')
    expect(text).not.toContain('\x1b')
    expect(text).not.toContain(']8;;')
  })

  test('post-wait assistant deltas mark the logical call active again', () => {
    const initial = createStreamMachineState(createInitialState('claude-fable-5', '/tmp'), createSpinnerState())
    const waiting = reduceRunEvent(initial, {
      kind: 'quota_waiting',
      payload: {
        delay_ms: 1_800_000,
        error: 'HTTP 429: rate_limit_error: Rate limit exceeded. Please retry later.',
      },
    }, { termRows: 24 })
    expect(waiting.state.activeLlmCall).toBe(false)

    const streaming = reduceRunEvent(waiting.state, {
      kind: 'assistant_delta',
      payload: { content_index: 0, content_type: 'text', delta: 'hello' },
    }, { termRows: 24 })
    expect(streaming.state.activeLlmCall).toBe(true)
    expect(streaming.state.spinnerState.phase).toBe('responding')
  })

  test('outage waiting replaces the normal spinner without committing retry cards', () => {
    const initial = createStreamMachineState(createInitialState('model', '/tmp'), createSpinnerState())
    const waiting = reduceRunEvent(initial, {
      kind: 'outage_waiting',
      payload: { delay_ms: 60_000, error: 'API error: Upstream request failed.' },
    }, { termRows: 24 })

    expect(waiting.state.spinnerState.phase).toBe('outage_waiting')
    expect(waiting.state.spinnerState.waitRetryAt).toBeGreaterThan(Date.now())
    expect(waiting.commitLines).toEqual([])
    expect(waiting.writeLines.some(line => line.text.includes('Upstream request failed'))).toBe(true)
    expect(waiting.state.appState.verboseEvents).toEqual([])
    expect(waiting.rerenderStatus).toBe(true)
  })

  test('assistant delta keeps the whole message in the dynamic zone (no mid-stream commit)', () => {
    const appState = createInitialState('model', '/tmp')
    const spinner = createSpinnerState()
    let state = createStreamMachineState(appState, spinner)

    const update = reduceRunEvent(state, {
      kind: 'assistant_delta',
      payload: { content_index: 0, content_type: 'text', delta: 'hello\n\nworld' },
    }, { termRows: 24 })

    state = update.state
    // Plan A: the message streams in place. A completed paragraph is NOT drained
    // to scrollback mid-stream (that caused the dynamic zone to empty/refill and
    // the spinner below to jump). Everything stays in the pending text.
    expect(update.commitLines.length).toBe(0)
    expect(state.appState.currentAssistantContent.filter(block => block.type === 'text').map(block => block.text).join('')).toBe('hello\n\nworld')
    expect(state.appState.currentAssistantContent.filter(block => block.type === 'text').map(block => block.text).join('')).toBe('hello\n\nworld')
  })

  test('assistant delta without complete block does not commit', () => {
    const appState = createInitialState('model', '/tmp')
    const spinner = createSpinnerState()
    let state = createStreamMachineState(appState, spinner)

    const update = reduceRunEvent(state, {
      kind: 'assistant_delta',
      payload: { content_index: 0, content_type: 'text', delta: 'hello world' },
    }, { termRows: 24 })

    state = update.state
    expect(update.commitLines.length).toBe(0)
    expect(state.appState.currentAssistantContent.filter(block => block.type === 'text').map(block => block.text).join('')).toBe('hello world')
  })

  test('assistant_completed flushes remaining text', () => {
    const appState = createInitialState('model', '/tmp')
    const spinner = createSpinnerState()
    let state = createStreamMachineState(appState, spinner)

    let update = reduceRunEvent(state, {
      kind: 'assistant_delta',
      payload: { content_index: 0, content_type: 'text', delta: 'hello world' },
    }, { termRows: 24 })
    state = update.state
    expect(update.commitLines.length).toBe(0)
    expect(state.appState.currentAssistantContent.filter(block => block.type === 'text').map(block => block.text).join('')).toBe('hello world')

    update = reduceRunEvent(state, {
      kind: 'assistant_completed',
      payload: {},
    }, { termRows: 24 })
    state = update.state
    expect(update.commitLines.length).toBeGreaterThan(0)
    expect(state.appState.currentAssistantContent.filter(block => block.type === 'text').map(block => block.text).join('')).toBe('')
    expect(state.appState.currentAssistantContent.filter(block => block.type === 'text').map(block => block.text).join('')).toBe('')
  })

  test('retrying overflow compaction discards the abandoned partial response', () => {
    const initial = createStreamMachineState(createInitialState('model', '/tmp'), createSpinnerState())
    const partial = reduceRunEvent(initial, {
      kind: 'assistant_delta',
      payload: { content_index: 0, content_type: 'text', delta: 'abandoned partial' },
    }, { termRows: 24 })

    const compacting = reduceRunEvent(partial.state, {
      kind: 'context_compaction_started',
      payload: {
        reason: 'overflow',
        estimated_tokens: 1100,
        context_window: 1000,
        will_retry: true,
      },
    }, { termRows: 24 })

    expect(compacting.commitLines.map(line => line.text).join('\n')).not.toContain('abandoned partial')
    expect(compacting.state.appState.currentAssistantContent).toEqual([])
  })

  test('provider retry discards the abandoned attempt preview', () => {
    const initial = createStreamMachineState(createInitialState('model', '/tmp'), createSpinnerState())
    const partial = reduceRunEvent(initial, {
      kind: 'assistant_delta',
      payload: { content_index: 0, content_type: 'text', delta: 'failed attempt' },
    }, { termRows: 24 })

    const retrying = reduceRunEvent(partial.state, {
      kind: 'llm_call_retry',
      payload: { attempt: 1, max_retries: 3, delay_ms: 10, error: 'retryable' },
    }, { termRows: 24 })

    expect(retrying.commitLines.map(line => line.text).join('\n')).not.toContain('failed attempt')
    expect(retrying.state.appState.currentAssistantContent).toEqual([])
  })

  test('a new LLM call discards an incomplete prior attempt preview', () => {
    const initial = createStreamMachineState(createInitialState('model', '/tmp'), createSpinnerState())
    const partial = reduceRunEvent(initial, {
      kind: 'assistant_delta',
      payload: { content_index: 0, content_type: 'text', delta: 'unaccepted attempt' },
    }, { termRows: 24 })

    const restarted = reduceRunEvent(partial.state, {
      kind: 'llm_call_started',
      payload: { attempt: 0 },
    }, { termRows: 24 })

    expect(restarted.commitLines.map(line => line.text).join('\n')).not.toContain('unaccepted attempt')
    expect(restarted.state.appState.currentAssistantContent).toEqual([])
  })

  test('non-retrying threshold compaction preserves accepted partial content', () => {
    const initial = createStreamMachineState(createInitialState('model', '/tmp'), createSpinnerState())
    const partial = reduceRunEvent(initial, {
      kind: 'assistant_delta',
      payload: { content_index: 0, content_type: 'text', delta: 'accepted answer' },
    }, { termRows: 24 })

    const compacting = reduceRunEvent(partial.state, {
      kind: 'context_compaction_started',
      payload: {
        reason: 'threshold',
        estimated_tokens: 900,
        context_window: 1000,
        will_retry: false,
      },
    }, { termRows: 24 })

    expect(compacting.commitLines.map(line => line.text).join('\n')).toContain('accepted answer')
    expect(compacting.state.appState.currentAssistantContent).toEqual([])
  })

  test('assistant_completed with length stop appends a truncation notice', () => {
    const appState = createInitialState('model', '/tmp')
    const spinner = createSpinnerState()
    let state = createStreamMachineState(appState, spinner)

    let update = reduceRunEvent(state, {
      kind: 'assistant_delta',
      payload: { content_index: 0, content_type: 'text', delta: 'a partial answer that got cut off' },
    }, { termRows: 24 })
    state = update.state

    update = reduceRunEvent(state, {
      kind: 'assistant_completed',
      payload: { stop_reason: 'length' },
    }, { termRows: 24 })
    state = update.state

    const committed = update.commitLines.map(l => l.text).join('\n')
    expect(committed).toContain('a partial answer that got cut off')
    expect(committed).toContain('maximum output token limit')
    expect(update.commitLines.some(l => l.kind === 'error')).toBe(true)
  })

  test('assistant_completed surfaces the provider incomplete reason', () => {
    const state = createStreamMachineState(createInitialState('model', '/tmp'), createSpinnerState())

    const update = reduceRunEvent(state, {
      kind: 'assistant_completed',
      payload: {
        stop_reason: 'length',
        error_message: 'response incomplete: max_output_tokens',
      },
    }, { termRows: 24 })

    const committed = update.commitLines.map(l => l.text).join('\n')
    expect(committed).toContain('incomplete response (max_output_tokens)')
    expect(committed).not.toContain('reached the maximum output token limit')
  })

  test('assistant_completed with normal stop appends no truncation notice', () => {
    const appState = createInitialState('model', '/tmp')
    const spinner = createSpinnerState()
    let state = createStreamMachineState(appState, spinner)

    let update = reduceRunEvent(state, {
      kind: 'assistant_delta',
      payload: { content_index: 0, content_type: 'text', delta: 'a complete answer' },
    }, { termRows: 24 })
    state = update.state

    update = reduceRunEvent(state, {
      kind: 'assistant_completed',
      payload: { stop_reason: 'stop' },
    }, { termRows: 24 })

    const committed = update.commitLines.map(l => l.text).join('\n')
    expect(committed).toContain('a complete answer')
    expect(committed).not.toContain('maximum output token limit')
  })

  test('no mid-stream commit: whole message flushed once at assistant_completed', () => {
    const appState = createInitialState('model', '/tmp')
    const spinner = createSpinnerState()
    let state = createStreamMachineState(appState, spinner)
    const allCommitted: string[] = []

    for (const delta of ['Hello ', 'world.\n\n', 'Second paragraph.']) {
      const update = reduceRunEvent(state, {
        kind: 'assistant_delta',
        payload: { content_index: 0, content_type: 'text', delta },
      }, { termRows: 24 })
      state = update.state
      for (const line of update.commitLines) allCommitted.push(line.text)
    }

    // Plan A: nothing commits mid-stream; the full message stays pending.
    expect(allCommitted.length).toBe(0)
    expect(state.appState.currentAssistantContent.filter(block => block.type === 'text').map(block => block.text).join('')).toBe('Hello world.\n\nSecond paragraph.')

    const update = reduceRunEvent(state, {
      kind: 'assistant_completed',
      payload: {},
    }, { termRows: 24 })
    state = update.state
    for (const line of update.commitLines) allCommitted.push(line.text)

    const fullText = allCommitted.join('\n')
    expect(fullText).toContain('Hello world')
    expect(fullText).toContain('Second paragraph')
    // Each block appears exactly once — flushed only at the turn boundary.
    expect((fullText.match(/Hello world/g) || []).length).toBe(1)
    expect((fullText.match(/Second paragraph/g) || []).length).toBe(1)

    const final = flushStreaming(state)
    expect(final.lines.length).toBe(0)
  })

  test('pendingText mirrors the whole streaming message', () => {
    const appState = createInitialState('model', '/tmp')
    const spinner = createSpinnerState()
    let state = createStreamMachineState(appState, spinner)
    // Short multi-paragraph reply that fits the viewport: stays fully pending.
    const text = 'Para one.\n\nPara two.\n\nPara three.'

    const update = reduceRunEvent(state, {
      kind: 'assistant_delta',
      payload: { content_index: 0, content_type: 'text', delta: text },
    }, { termRows: 24 })

    state = update.state
    expect(update.commitLines.length).toBe(0)
    expect(state.appState.currentAssistantContent.filter(block => block.type === 'text').map(block => block.text).join('')).toBe(text)
    expect(state.appState.currentAssistantContent.filter(block => block.type === 'text').map(block => block.text).join('')).toBe(text)
  })

  test('streaming a multi-paragraph reply never commits or empties the dynamic zone mid-stream', () => {
    // Regression for streaming jank: the whole message must stream in place so
    // the dynamic zone never drains-and-refills at paragraph boundaries (which
    // made the spinner/prompt below jump up and back down on every \n\n).
    const appState = createInitialState('model', '/tmp')
    const spinner = createSpinnerState()
    let state = createStreamMachineState(appState, spinner)
    const full = [
      'First paragraph explaining the setup.',
      '## Section',
      'Second paragraph with **bold** and some detail that runs on a while.',
      '- point one\n- point two',
      'Final wrap-up sentence.',
    ].join('\n\n')

    const deltas: string[] = []
    for (let i = 0; i < full.length; i += 5) deltas.push(full.slice(i, i + 5))

    let midStreamCommits = 0
    let emptyContentFrames = 0
    let prevContentLen = 0
    for (const d of deltas) {
      const update = reduceRunEvent(state, {
        kind: 'assistant_delta',
        payload: { content_index: 0, content_type: 'text', delta: d },
      }, { termRows: 40 })
      state = update.state
      midStreamCommits += update.commitLines.filter(l => l.kind === 'assistant' && l.text).length
      if (state.appState.currentAssistantContent.filter(block => block.type === 'text').map(block => block.text).join('').length === 0 && prevContentLen > 0) emptyContentFrames++
      prevContentLen = state.appState.currentAssistantContent.filter(block => block.type === 'text').map(block => block.text).join('').length
    }

    expect(midStreamCommits).toBe(0)
    expect(emptyContentFrames).toBe(0)
    expect(state.appState.currentAssistantContent.filter(block => block.type === 'text').map(block => block.text).join('')).toBe(full)

    // Everything flushes once at the turn boundary.
    const done = reduceRunEvent(state, { kind: 'assistant_completed', payload: {} }, { termRows: 40 })
    const flushed = done.commitLines.filter(l => l.kind === 'assistant').map(l => l.text).join('\n')
    expect(flushed).toContain('First paragraph')
    expect(flushed).toContain('Final wrap-up')
  })

  test('tool_started keeps the partial assistant message stable', () => {
    const appState = createInitialState('model', '/tmp')
    const spinner = createSpinnerState()
    let state = createStreamMachineState(appState, spinner)

    // Simulate a tool_started which flushes text
    let update = reduceRunEvent(state, {
      kind: 'assistant_delta',
      payload: { content_index: 0, content_type: 'text', delta: 'Before tool.' },
    }, { termRows: 18 })
    state = update.state

    update = reduceRunEvent(state, {
      kind: 'tool_started',
      payload: { tool_name: 'bash', args: {} },
    }, { termRows: 18 })
    state = update.state
    // Execution updates the tool block in place; it must not move assistant
    // content into scrollback while the partial message is still live.
    expect(update.commitLines).toHaveLength(0)
    expect(state.appState.currentAssistantContent[0]).toMatchObject({
      type: 'text',
      text: 'Before tool.',
    })

    // Now add more text after tool
    update = reduceRunEvent(state, {
      kind: 'assistant_delta',
      payload: { content_index: 1, content_type: 'text', delta: 'After tool.' },
    }, { termRows: 18 })
    state = update.state

    // Flush produces a clean block (no continuation spacer needed —
    // the tool call visually separates the two assistant blocks)
    const flushed = flushStreaming(state)
    expect(flushed.lines.length).toBeGreaterThan(0)
    expect(flushed.lines.map(line => line.text).join('\n')).toContain('Before tool')
    expect(flushed.lines.map(line => line.text).join('\n')).toContain('After tool')
  })

  test('long open code fence stays in the partial message without scrollback migration', () => {
    const appState = createInitialState('model', '/tmp')
    const spinner = createSpinnerState()
    let state = createStreamMachineState(appState, spinner)
    // 15 lines at termRows 18 exceeds the overflow threshold (max(8, 18-6)=12),
    // so the safety valve drains leading blocks to keep the tail on screen.
    const text = 'Intro\n\n```\n' + Array.from({ length: 12 }, (_, i) => `x_${i} = ${i}`).join('\n')

    const update = reduceRunEvent(state, {
      kind: 'assistant_delta',
      payload: { content_index: 0, content_type: 'text', delta: text },
    }, { termRows: 18 })

    state = update.state
    // The whole block remains in one dynamic AssistantMessage, matching pi.
    expect(update.commitLines).toHaveLength(0)
    const partial = state.appState.currentAssistantContent
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    expect(partial).toContain('Intro')
    expect(partial).toContain('x_11 = 11')
  })

  test('streaming keeps a tall table intact in the dynamic message', () => {
    // Regression: a table taller than the viewport, preceded by non-pipe lines
    // (a numbered list) that used to reset the old pipe-table guard's counter.
    // The whole assistant message remains dynamic, so each frame reparses a
    // complete table prefix and the renderer can diff/reflow it like pi instead
    // of committing an orphan tail without its header/separator.
    const appState = createInitialState('model', '/tmp')
    const spinner = createSpinnerState()
    let state = createStreamMachineState(appState, spinner)

    const msg =
      '分析：\n\n1. 第一点\n2. 第二点\n3. 第三点\n\n' +
      '| 类别 | 总量 | 训练 | 覆盖 |\n|------|------|------|------|\n' +
      Array.from({ length: 10 }, (_, i) => `| item_${i} | ${i} | ${i} 步 | ok |`).join('\n')

    // Feed char-by-char through the real reducer at a small viewport. No delta
    // may move part of the table into committed history while it is streaming.
    const committed: OutputLine[] = []
    for (const ch of msg) {
      const update = reduceRunEvent(state, { kind: 'assistant_delta', payload: { content_index: 0, content_type: 'text', delta: ch } }, { termRows: 10 })
      state = update.state
      committed.push(...update.commitLines)
    }
    const flush = flushStreaming(state)
    committed.push(...flush.lines)

    const assistant = committed.filter(l => l.kind === 'assistant').map(l => l.text)
    // No committed assistant line is a raw pipe row (the torn-table signature).
    const rawPipeRows = assistant.filter(l => /^\s*\|.*\|\s*$/.test(l))
    expect(rawPipeRows).toEqual([])
    // The table rendered as a box-drawn grid instead.
    const boxLines = assistant.filter(l => /[┌│├└]/.test(l))
    expect(boxLines.length).toBeGreaterThan(0)
    // Every data row survived inside the rendered table.
    const joined = assistant.join('\n')
    for (let i = 0; i < 10; i++) expect(joined).toContain(`item_${i}`)
  })

  test('short message with an open code fence stays fully pending (no overflow)', () => {
    const appState = createInitialState('model', '/tmp')
    const spinner = createSpinnerState()
    let state = createStreamMachineState(appState, spinner)
    // Well under the overflow threshold: the whole thing streams in place.
    const text = 'Intro\n\n```\nx_0 = 0\nx_1 = 1'

    const update = reduceRunEvent(state, {
      kind: 'assistant_delta',
      payload: { content_index: 0, content_type: 'text', delta: text },
    }, { termRows: 24 })

    state = update.state
    expect(update.commitLines.length).toBe(0)
    expect(state.appState.currentAssistantContent.filter(block => block.type === 'text').map(block => block.text).join('')).toBe(text)
    expect(state.appState.currentAssistantContent.filter(block => block.type === 'text').map(block => block.text).join('')).toBe(text)
  })

  test('assistant_completed authoritative snapshot is committed once', () => {
    const appState = createInitialState('model', '/tmp')
    const spinner = createSpinnerState()
    let state = createStreamMachineState(appState, spinner)

    state = reduceRunEvent(state, {
      kind: 'assistant_delta',
      payload: { content_index: 0, content_type: 'text', delta: 'partial' },
    }, { termRows: 24 }).state

    const completed = reduceRunEvent(state, {
      kind: 'assistant_completed',
      payload: { content: [{ type: 'text', text: 'authoritative' }] },
    }, { termRows: 24 })

    expect(completed.commitLines.filter(line => line.kind === 'assistant').map(line => line.text).join('\n'))
      .toContain('authoritative')
    expect(completed.commitLines.map(line => line.text).join('\n')).not.toContain('partial')
    expect(completed.state.appState.currentAssistantContent).toEqual([])
    expect(completed.state.appState.messages.at(-1)?.content).toEqual([
      { type: 'text', contentIndex: 0, text: 'authoritative' },
    ])
    expect(flushStreaming(completed.state).lines).toHaveLength(0)
  })

  test('turn_started preserves partial content as a fallback when completion is missing', () => {
    const appState = createInitialState('model', '/tmp')
    const spinner = createSpinnerState()
    let state = createStreamMachineState(appState, spinner)

    state = reduceRunEvent(state, {
      kind: 'assistant_delta',
      payload: { content_index: 0, content_type: 'text', delta: 'unfinished' },
    }, { termRows: 24 }).state

    const nextTurn = reduceRunEvent(state, {
      kind: 'turn_started',
      payload: {},
    }, { termRows: 24 })

    expect(nextTurn.commitLines.filter(line => line.kind === 'assistant').map(line => line.text).join('\n'))
      .toContain('unfinished')
    expect(nextTurn.state.appState.currentAssistantContent).toEqual([])
  })

  test('llm_call_completed does not flush a tool-bearing ordered message', () => {
    const appState = createInitialState('model', '/tmp')
    appState.currentAssistantContent = [
      { type: 'thinking', contentIndex: 0, text: 'plan' },
      {
        type: 'tool_call',
        contentIndex: 1,
        toolCall: { id: 'call-1', name: 'read', args: {}, status: 'running' },
      },
      { type: 'text', contentIndex: 2, text: 'after' },
    ]
    const state = createStreamMachineState(appState, createSpinnerState())

    const completed = reduceRunEvent(state, {
      kind: 'llm_call_completed',
      payload: {},
    }, { termRows: 24 })

    expect(completed.commitLines.filter(line => ['thinking', 'assistant', 'tool'].includes(line.kind)))
      .toHaveLength(0)
    expect(completed.state.appState.currentAssistantContent.map(block => block.type))
      .toEqual(['thinking', 'tool_call', 'text'])
  })

  test('no duplicate commits across llm_call_completed and assistant_completed', () => {
    const appState = createInitialState('model', '/tmp')
    const spinner = createSpinnerState()
    let state = createStreamMachineState(appState, spinner)
    const allCommitted: OutputLine[] = []

    // 1. llm_call_started
    let update = reduceRunEvent(state, {
      kind: 'llm_call_started',
      payload: { model: 'test', messages: [] },
    }, { termRows: 24 })
    state = update.state
    allCommitted.push(...update.commitLines)

    // 2. assistant deltas
    for (const delta of ['Hello ', 'world.']) {
      update = reduceRunEvent(state, {
        kind: 'assistant_delta',
        payload: { content_index: 0, content_type: 'text', delta },
      }, { termRows: 24 })
      state = update.state
      allCommitted.push(...update.commitLines)
    }

    // 3. llm_call_completed
    update = reduceRunEvent(state, {
      kind: 'llm_call_completed',
      payload: { model: 'test', input_tokens: 10, output_tokens: 5 },
    }, { termRows: 24 })
    state = update.state
    allCommitted.push(...update.commitLines)

    // 4. assistant_completed
    update = reduceRunEvent(state, {
      kind: 'assistant_completed',
      payload: {},
    }, { termRows: 24 })
    state = update.state
    allCommitted.push(...update.commitLines)

    // 5. run_finished
    update = reduceRunEvent(state, {
      kind: 'run_finished',
      payload: {},
    }, { termRows: 24 })
    state = update.state
    allCommitted.push(...update.commitLines)

    // 6. Final flush in repl loop
    const final = flushStreaming(state)
    allCommitted.push(...final.lines)

    // Count how many times assistant text appears
    const assistantLines = allCommitted.filter(l => l.kind === 'assistant')
    const assistantText = assistantLines.map(l => l.text).join('\n')
    const helloCount = (assistantText.match(/Hello world/g) || []).length
    expect(helloCount).toBe(1)
  })

  test('tool execution does not commit or duplicate the partial assistant message', () => {
    const appState = createInitialState('model', '/tmp')
    const spinner = createSpinnerState()
    let state = createStreamMachineState(appState, spinner)
    const allCommitted: OutputLine[] = []

    // 1. assistant deltas before tool
    for (const delta of ['Before ', 'tool.']) {
      const update = reduceRunEvent(state, {
        kind: 'assistant_delta',
        payload: { content_index: 0, content_type: 'text', delta },
      }, { termRows: 24 })
      state = update.state
      allCommitted.push(...update.commitLines)
    }

    // 2. tool_started keeps the partial message in the dynamic zone.
    let update = reduceRunEvent(state, {
      kind: 'tool_started',
      payload: { tool_name: 'bash', args: {} },
    }, { termRows: 24 })
    state = update.state
    expect(update.commitLines).toHaveLength(0)

    // 3. tool_finished
    update = reduceRunEvent(state, {
      kind: 'tool_finished',
      payload: { tool_name: 'bash', args: {}, is_error: false, content: 'ok' },
    }, { termRows: 24 })
    state = update.state
    allCommitted.push(...update.commitLines)

    // 4. More deltas after tool
    for (const delta of ['After ', 'tool.']) {
      update = reduceRunEvent(state, {
        kind: 'assistant_delta',
        payload: { content_index: 1, content_type: 'text', delta },
      }, { termRows: 24 })
      state = update.state
      allCommitted.push(...update.commitLines)
    }

    // 5. assistant_completed — should flush "After tool."
    update = reduceRunEvent(state, {
      kind: 'assistant_completed',
      payload: {},
    }, { termRows: 24 })
    state = update.state
    allCommitted.push(...update.commitLines)

    // 6. Final flush
    const final = flushStreaming(state)
    allCommitted.push(...final.lines)

    // "Before tool." appears exactly once
    const allAssistant = allCommitted.filter(l => l.kind === 'assistant').map(l => l.text).join('\n')
    expect((allAssistant.match(/Before tool/g) || []).length).toBe(1)
    // "After tool." appears exactly once
    expect((allAssistant.match(/After tool/g) || []).length).toBe(1)
  })

  test('conflicting delta type cannot replace an existing content index', () => {
    const appState = createInitialState('model', '/tmp')
    const spinner = createSpinnerState()
    let state = createStreamMachineState(appState, spinner)

    state = reduceRunEvent(state, {
      kind: 'assistant_delta',
      payload: { content_index: 0, content_type: 'text', delta: 'visible text' },
    }, { termRows: 24 }).state
    state = reduceRunEvent(state, {
      kind: 'assistant_delta',
      payload: { content_index: 0, content_type: 'thinking', delta: 'misclassified' },
    }, { termRows: 24 }).state

    expect(state.appState.currentAssistantContent).toEqual([
      { type: 'text', contentIndex: 0, text: 'visible text' },
    ])
  })

  test('thinking after text remains a distinct ordered content block', () => {
    const appState = createInitialState('model', '/tmp')
    const spinner = createSpinnerState()
    let state = createStreamMachineState(appState, spinner)

    let update = reduceRunEvent(state, {
      kind: 'assistant_delta',
      payload: { content_index: 0, content_type: 'text', delta: '每条都停在 `' },
    }, { termRows: 24 })
    state = update.state

    update = reduceRunEvent(state, {
      kind: 'assistant_delta',
      payload: { content_index: 1, content_type: 'thinking', delta: '` 里的推理中途:\n- 第 1 题' },
    }, { termRows: 24 })
    state = update.state

    expect(state.appState.currentAssistantContent.map(block => block.type)).toEqual(['text', 'thinking'])
    const flushed = flushStreaming(state)
    const visible = flushed.lines.map(line => line.text).join('\n')
    expect(visible).toContain('每条都停在')
    expect(visible).toContain('里的推理中途')
  })

  test('thinking before visible text commits as markdown thinking content', () => {
    const appState = createInitialState('model', '/tmp')
    const spinner = createSpinnerState()
    let state = createStreamMachineState(appState, spinner)

    let update = reduceRunEvent(state, {
      kind: 'assistant_delta',
      payload: { content_index: 0, content_type: 'thinking', delta: 'internal reasoning\nline 2' },
    }, { termRows: 24 })
    state = update.state

    update = reduceRunEvent(state, {
      kind: 'assistant_delta',
      payload: { content_index: 1, content_type: 'text', delta: 'final answer' },
    }, { termRows: 24 })
    state = update.state

    expect(update.commitLines).toHaveLength(0)
    expect(state.appState.currentAssistantContent.map(block => block.type)).toEqual(['thinking', 'text'])
    const flushed = flushStreaming(state)
    expect(flushed.lines.filter(l => l.kind === 'thinking').map(l => l.text)).toEqual([
      'internal reasoning',
      'line 2',
    ])
    expect(flushed.lines.some(l => l.kind === 'assistant')).toBe(true)
  })

  test('tool progress updates its matching live card', () => {
    const appState = createInitialState('model', '/tmp')
    appState.currentAssistantContent = [{
      type: 'tool_call',
      contentIndex: 0,
      toolCall: {
        id: 'call-bash',
        name: 'bash',
        args: { command: 'sleep 1' },
        status: 'running',
        startedAt: Date.now(),
      },
    }]
    const state = createStreamMachineState(appState, createSpinnerState())
    const update = reduceRunEvent(state, {
      kind: 'tool_progress',
      payload: { tool_call_id: 'call-bash', tool_name: 'bash', text: 'line 1\nline 2' },
    }, { termRows: 24 })

    const progressBlock = update.state.appState.currentAssistantContent[0]
    expect(progressBlock?.type === 'tool_call' ? progressBlock.toolCall.progress : undefined).toBe('line 1\nline 2')
    expect(update.rerenderStatus).toBe(true)
  })

  test('tool lifecycle does not alter footer token stats', () => {
    const appState = createInitialState('model', '/tmp')
    appState.sessionTokens = {
      inputTokens: 120000,
      outputTokens: 2400,
      cacheReadTokens: 64000,
      contextTokens: 98000,
      contextWindow: 272000,
    }
    appState.currentAssistantContent = [{
      type: 'tool_call',
      contentIndex: 0,
      toolCall: {
        id: 'call-read',
        name: 'read',
        args: { path: 'src/a.ts' },
        status: 'running',
        startedAt: Date.now(),
      },
    }]
    let state = createStreamMachineState(appState, createSpinnerState())

    state = reduceRunEvent(state, {
      kind: 'tool_progress',
      payload: { tool_call_id: 'call-read', tool_name: 'read', text: 'reading' },
    }, { termRows: 24 }).state
    state = reduceRunEvent(state, {
      kind: 'tool_finished',
      payload: { tool_call_id: 'call-read', tool_name: 'read', content: 'done', is_error: false },
    }, { termRows: 24 }).state

    expect(state.appState.sessionTokens).toEqual({
      inputTokens: 120000,
      outputTokens: 2400,
      cacheReadTokens: 64000,
      contextTokens: 98000,
      contextWindow: 272000,
    })
  })

  test('tool completion preserves progress metadata and lets final metadata win', () => {
    const appState = createInitialState('model', '/tmp')
    appState.currentAssistantContent = [
      {
        type: 'tool_call', contentIndex: 0, toolCall: {
          id: 'call-edit',
          name: 'edit',
          args: { path: 'src/a.ts' },
          status: 'running',
          startedAt: Date.now(),
        },
      },
      {
        type: 'tool_call', contentIndex: 1, toolCall: {
          id: 'call-read',
          name: 'read',
          args: { path: 'src/b.ts' },
          status: 'queued',
        },
      },
    ]
    let state = createStreamMachineState(appState, createSpinnerState())

    state = reduceRunEvent(state, {
      kind: 'tool_progress',
      payload: {
        tool_call_id: 'call-edit',
        tool_name: 'edit',
        text: '',
        details: { diff: '@@ -1 +1 @@\n-old\n+new', phase: 'preview' },
      },
    }, { termRows: 24 }).state
    state = reduceRunEvent(state, {
      kind: 'tool_finished',
      payload: {
        tool_call_id: 'call-edit',
        tool_name: 'edit',
        content: 'Updated src/a.ts.',
        is_error: false,
        duration_ms: 9,
        details: { replacement_count: 1, added_lines: 1, removed_lines: 1, phase: 'final' },
      },
    }, { termRows: 24 }).state

    const completed = findAssistantToolCall(state.appState.currentAssistantContent, 'call-edit')
    expect(completed?.details).toEqual({
      diff: '@@ -1 +1 @@\n-old\n+new',
      phase: 'final',
      replacement_count: 1,
      added_lines: 1,
      removed_lines: 1,
    })
    const card = completed ? buildToolCard(completed) : []
    expect(card[1]!.text).toBe('  ✓ · 1 replacement · +1 −1')
    expect(card.map(line => line.text).join('\n')).toContain('+new')
  })

  test('spill progress commits visible event line', () => {
    const state = createStreamMachineState(createInitialState('model', '/tmp'), createSpinnerState())
    const update = reduceRunEvent(state, {
      kind: 'tool_progress',
      payload: {
        tool_call_id: 'call-bash',
        tool_name: 'bash',
        text: '__evot_spill_event__ {"kind":"write","path":"/tmp/spill.txt","size_bytes":120000,"preview_bytes":4000}',
      },
    }, { termRows: 24 })
    const text = update.commitLines.map(l => l.text).join('\n')
    expect(text).toContain('\u21aa 117.2 KB written \u00b7 3.9 KB preview \u00b7 bash')
    expect(text).toContain('/tmp/spill.txt')
  })

  test('heartbeat progress preserves the card output', () => {
    const appState = createInitialState('model', '/tmp')
    appState.currentAssistantContent = [{
      type: 'tool_call',
      contentIndex: 0,
      toolCall: {
        id: 'call-bash',
        name: 'bash',
        args: {},
        status: 'running',
        progress: 'line 1\nline 2',
      },
    }]
    const state = createStreamMachineState(appState, createSpinnerState())
    const update = reduceRunEvent(state, {
      kind: 'tool_progress',
      payload: { tool_call_id: 'call-bash', tool_name: 'bash', text: 'Running... 60s' },
    }, { termRows: 24 })

    const heartbeatBlock = update.state.appState.currentAssistantContent[0]
    expect(heartbeatBlock?.type === 'tool_call' ? heartbeatBlock.toolCall.progress : undefined).toBe('line 1\nline 2')
  })

  test('a task_output heartbeat also preserves the card output', () => {
    // `task_output` says "Waiting" rather than "Running"; if that spelling were
    // not recognized as a heartbeat it would overwrite streamed partial output.
    const appState = createInitialState('model', '/tmp')
    appState.currentAssistantContent = [{
      type: 'tool_call',
      contentIndex: 0,
      toolCall: {
        id: 'call-task',
        name: 'task_output',
        args: {},
        status: 'running',
        progress: 'line-1\nline-2',
      },
    }]
    const state = createStreamMachineState(appState, createSpinnerState())
    const update = reduceRunEvent(state, {
      kind: 'tool_progress',
      payload: { tool_call_id: 'call-task', tool_name: 'task_output', text: 'Waiting... 6s' },
    }, { termRows: 24 })

    const block = update.state.appState.currentAssistantContent[0]
    expect(block?.type === 'tool_call' ? block.toolCall.progress : undefined).toBe('line-1\nline-2')
  })

  test('real streamed output still replaces the progress body', () => {
    // The filter must be narrow: anything that is not a bare heartbeat is real
    // output and has to land.
    const appState = createInitialState('model', '/tmp')
    appState.currentAssistantContent = [{
      type: 'tool_call',
      contentIndex: 0,
      toolCall: {
        id: 'call-task',
        name: 'task_output',
        args: {},
        status: 'running',
        progress: 'old',
      },
    }]
    const state = createStreamMachineState(appState, createSpinnerState())
    const update = reduceRunEvent(state, {
      kind: 'tool_progress',
      payload: { tool_call_id: 'call-task', tool_name: 'task_output', text: 'Waiting for peer... 6s left' },
    }, { termRows: 24 })

    const block = update.state.appState.currentAssistantContent[0]
    expect(block?.type === 'tool_call' ? block.toolCall.progress : undefined).toBe('Waiting for peer... 6s left')
  })

  test('tool lifecycle keeps a stable headline and second-line status', () => {
    const queued = buildToolCard({ id: 'call-1', name: 'read', args: { path: 'src/a.rs' }, status: 'queued' })
    expect(queued.map(line => line.text)).toEqual([
      '◫ read  src/a.rs',
      '  ○ · preparing arguments',
    ])

    const running = buildToolCard({
      id: 'call-1',
      name: 'read',
      args: { path: 'src/a.rs' },
      status: 'running',
      startedAt: 1_000,
      progress: 'partial output',
    }, false, 2_500)
    expect(running[0]!.text).toBe('◫ read  src/a.rs')
    expect(running[1]!.text).toBe('  ● · running')
    expect(running.map(line => line.text).join('\n')).toContain('partial output')

    const completed = buildToolCard({
      id: 'call-1',
      name: 'read',
      args: { path: 'src/a.rs' },
      status: 'done',
      result: 'done',
      durationMs: 12,
    })
    expect(completed[0]!.text).toBe('◫ read  src/a.rs')
    expect(completed[1]!.text).toBe('  ✓ · 1 line')
  })

  test('queued write streams its full diff body while edit stays a stable summary', () => {
    const content = Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join('\n')
    const writeCall = {
      id: 'call-write',
      name: 'write',
      args: { path: 'src/a.txt', content },
      status: 'queued' as const,
      argsComplete: false,
    }
    const write = buildToolCard(writeCall)
    const writeText = stripAnsi(write.map(line => line.text).join('\n'))
    expect(writeText).toContain('✎ write  src/a.txt')
    expect(write.at(-1)?.text).toBe('  ○ · generating 25 lines')
    // The whole body is on screen from the first streamed line — never folded.
    expect(writeText).toContain('+line 1')
    expect(writeText).toContain('+line 25')
    expect(writeText).not.toContain('ctrl+o to expand')

    const expandedWriteText = stripAnsi(buildToolCard(writeCall, true).map(line => line.text).join('\n'))
    expect(expandedWriteText).toContain('+line 25')

    const edit = buildToolCard({
      id: 'call-edit',
      name: 'edit',
      args: {
        path: 'src/a.ts',
        edits: [{ oldText: 'old line', newText: 'new line' }],
      },
      status: 'queued',
      argsComplete: false,
    })
    const editText = edit.map(line => line.text).join('\n')
    expect(editText).toContain('✎ edit  src/a.ts\n  ○ · preparing 1 replacement')
    expect(editText).not.toContain('-old line')
    expect(editText).not.toContain('+new line')
  })

  test('streamed write argument deltas update the visible content preview', () => {
    let state = createStreamMachineState(createInitialState('model', '/tmp'), createSpinnerState())
    state = reduceRunEvent(state, {
      kind: 'assistant_tool_call',
      payload: { content_index: 0, tool_call_id: 'call-write-live', tool_name: 'write', phase: 'start' },
    }, { termRows: 24 }).state

    state = reduceRunEvent(state, {
      kind: 'assistant_tool_call',
      payload: {
        content_index: 0,
        tool_call_id: 'call-write-live',
        tool_name: 'write',
        phase: 'delta',
        delta: '{"path":"src/live.ts","content":"const one = 1\\n',
      },
    }, { termRows: 24 }).state

    let call = findAssistantToolCall(state.appState.currentAssistantContent, 'call-write-live')
    expect(call?.args.content).toBe('const one = 1\n')
    expect(stripAnsi(call ? buildToolCard(call).map(line => line.text).join('\n') : '')).toContain('const one = 1')

    state = reduceRunEvent(state, {
      kind: 'assistant_tool_call',
      payload: {
        content_index: 0,
        tool_call_id: 'call-write-live',
        tool_name: 'write',
        phase: 'delta',
        delta: 'const two = 2"}',
      },
    }, { termRows: 24 }).state

    call = findAssistantToolCall(state.appState.currentAssistantContent, 'call-write-live')
    const text = stripAnsi(call ? buildToolCard(call).map(line => line.text).join('\n') : '')
    expect(text).toContain('generating 2 lines')
    expect(text).toContain('const one = 1')
    expect(text).toContain('const two = 2')
  })

  test('running write keeps its content layout when the diff arrives', () => {
    const base = {
      id: 'call-write-running',
      name: 'write',
      args: { path: 'src/a.ts', content: 'const one = 1\nconst two = 2' },
      status: 'running' as const,
      argsComplete: true,
      startedAt: 1_000,
    }

    // tool_started fired, engine preview diff not delivered yet: the streamed
    // content must stay visible instead of collapsing to a bare status row.
    const noDiff = stripAnsi(buildToolCard(base).map(line => line.text).join('\n'))
    expect(noDiff).toContain('● · running')
    expect(noDiff).toContain('const one = 1')

    // The authoritative diff must not reformat code already in scrollback.
    const withDiff = stripAnsi(buildToolCard({
      ...base,
      details: { diff: '@@ -0,0 +1,2 @@\n+const one = 1\n+const two = 2', preview: true },
    }).map(line => line.text).join('\n'))
    expect(withDiff).toBe(noDiff)
  })

  test('write preview sanitizes terminal controls from model output', () => {
    const card = buildToolCard({
      id: 'call-write-controls',
      name: 'write',
      args: { path: 'src/a.txt', content: 'safe\x1b]133;A\x07visible' },
      status: 'queued',
      argsComplete: false,
    })
    const text = card.map(line => line.text).join('\n') + card.map(line => line.diffText).join('\n')

    expect(text).toContain('safe�]133;A�visible')
    // Only the renderer's own SGR styling may survive; the injected OSC and
    // BEL never do.
    expect(text).not.toContain('\x1b]133')
    expect(text).not.toContain('\x07')
  })

  test('completed edit keeps the final authoritative diff unchanged', () => {
    const diff = '@@ -1 +1 @@\n-old\n+new'
    const completed = buildToolCard({
      id: 'call-edit',
      name: 'edit',
      args: { path: 'src/a.ts', edits: [] },
      status: 'done',
      details: { diff },
      durationMs: 12,
    })
    const completedText = completed.map(line => line.text).join('\n')
    expect(completedText).toContain('-old')
    expect(completedText).toContain('+new')
    expect(completedText).toMatch(/✓\n/)
    expect(completedText).not.toContain('applying changes')
  })

  test('llm retry renders as a visible card with backoff and error', () => {
    const appState = createInitialState('model', '/tmp')
    const spinner = createSpinnerState()
    const state = createStreamMachineState(appState, spinner)
    const update = reduceRunEvent(state, {
      kind: 'llm_call_retry',
      payload: {
        attempt: 1,
        max_retries: 3,
        retry_delay_ms: 1200,
        error: 'network error',
      },
    }, { termRows: 24 })
    const text = update.commitLines.map(l => l.text).join('\n')
    expect(text).toContain('✦ llm  retry')
    expect(text).toContain('\u21bb \u00b7 retrying in 1 second \u00b7 attempt 1/3')
    expect(text).toContain('Connection interrupted')
  })

  test('llm stats route to writeLines (screen.log only), not commitLines', () => {
    const appState = createInitialState('model', '/tmp')
    const spinner = createSpinnerState()
    let state = createStreamMachineState(appState, spinner)

    const started = reduceRunEvent(state, {
      kind: 'llm_call_started',
      payload: { model: 'test', messages: [] },
    }, { termRows: 24 })
    state = started.state
    const startedCommit = started.commitLines.map(l => l.text).join('\n')
    const startedWrite = started.writeLines.map(l => l.text).join('\n')
    expect(startedCommit).not.toContain('[LLM]')
    expect(startedWrite).toContain('[LLM] \u25cf \u00b7 test')

    const completed = reduceRunEvent(state, {
      kind: 'llm_call_completed',
      payload: { model: 'test', usage: { input: 10, output: 5, cache_read: 0, cache_write: 0 }, metrics: { duration_ms: 1000, ttfb_ms: 400, streaming_ms: 600 } },
    }, { termRows: 24 })
    state = completed.state
    const completedCommit = completed.commitLines.map(l => l.text).join('\n')
    const completedWrite = completed.writeLines.map(l => l.text).join('\n')
    expect(completedCommit).not.toContain('[LLM]')
    expect(completedWrite).toContain('[LLM] \u2713')
  })

  test('llm_call_completed sets footer context tokens from real usage', () => {
    const appState = createInitialState('model', '/tmp')
    const spinner = createSpinnerState()
    let state = createStreamMachineState(appState, spinner)

    // Pre-call estimate lands first via llm_call_started.
    state = reduceRunEvent(state, {
      kind: 'llm_call_started',
      payload: { model: 'test', messages: [], estimated_context_tokens: 95000, context_window: 160000 },
    }, { termRows: 24 }).state
    expect(state.appState.currentRunStats.contextTokens).toBe(95000)

    // On completion the footer must switch to the provider's real usage,
    // matching the compaction trigger: input + cache_read + cache_write + output.
    // (A count wildly above the estimate is rejected instead; see typed-reducer.)
    const completed = reduceRunEvent(state, {
      kind: 'llm_call_completed',
      payload: {
        model: 'test',
        usage: { input: 100000, output: 2000, cache_read: 8000, cache_write: 1000 },
        metrics: { duration_ms: 1000 },
      },
    }, { termRows: 24 })
    expect(completed.state.appState.currentRunStats.contextTokens).toBe(111000)
    expect(completed.state.appState.sessionTokens.contextTokens).toBe(111000)
  })

  test('llm_call_completed without usage keeps prior context tokens', () => {
    const appState = createInitialState('model', '/tmp')
    const spinner = createSpinnerState()
    let state = createStreamMachineState(appState, spinner)
    state = reduceRunEvent(state, {
      kind: 'llm_call_started',
      payload: { model: 'test', messages: [], estimated_context_tokens: 7000, context_window: 160000 },
    }, { termRows: 24 }).state

    const completed = reduceRunEvent(state, {
      kind: 'llm_call_completed',
      payload: { model: 'test', metrics: { duration_ms: 1000 } },
    }, { termRows: 24 })
    expect(completed.state.appState.currentRunStats.contextTokens).toBe(7000)
  })

  test('llm retry surfaces in commitLines as a card', () => {
    const appState = createInitialState('model', '/tmp')
    const spinner = createSpinnerState()
    const state = createStreamMachineState(appState, spinner)
    const update = reduceRunEvent(state, {
      kind: 'llm_call_retry',
      payload: { attempt: 1, max_retries: 3, retry_delay_ms: 500, error: 'rate limited' },
    }, { termRows: 24 })
    const text = update.commitLines.map(l => l.text).join('\n')
    expect(text).toContain('✦ llm  retry')
    expect(text).toContain('Rate limited')
  })

  test('a retry storm commits one card and advances the spinner in place', () => {
    // An overloaded upstream (529) is a bounded retry, so it used to emit a
    // fresh pair of cards per attempt: `✗ turn 27` plus `↻ attempt n/10`, each
    // carrying the same error text. Ten attempts buried the transcript under
    // twenty cards and twenty copies of one sentence. The countdown and the
    // attempt counter are the only things that change, and both now live on the
    // spinner, which repaints.
    const err = 'Overloaded: HTTP 529: overloaded_error: Service is temporarily overloaded.'
    let state = createStreamMachineState(createInitialState('claude-opus-5', '/tmp'), createSpinnerState())

    const first = reduceRunEvent(state, {
      kind: 'llm_call_retry',
      payload: { attempt: 1, max_retries: 10, retry_delay_ms: 2000, error: err },
    }, { termRows: 24 })
    state = first.state
    const firstText = first.commitLines.map(l => l.text).join('\n')
    expect(firstText).toContain('✦ llm  retry')
    expect(firstText).toContain('Model provider overloaded')
    expect(state.spinnerState.phase).toBe('retrying')
    expect(state.spinnerState.retryAttempt).toBe(1)
    expect(state.spinnerState.retryMaxAttempts).toBe(10)

    // Attempts 2..4: nothing new reaches scrollback.
    for (const [attempt, delay] of [[2, 3000], [3, 9000], [4, 18000]] as const) {
      const next = reduceRunEvent(state, {
        kind: 'llm_call_retry',
        payload: { attempt, max_retries: 10, retry_delay_ms: delay, error: err },
      }, { termRows: 24 })
      state = next.state
      expect(next.commitLines).toEqual([])
      expect(state.spinnerState.retryAttempt).toBe(attempt)
      expect(state.spinnerState.phase).toBe('retrying')
    }

    // The failed attempt beside each retry is the other half of the doubling.
    const failed = reduceRunEvent(state, {
      kind: 'llm_call_completed',
      payload: { model: 'claude-opus-5', turn: 27, error: err, metrics: { duration_ms: 830 } },
    }, { termRows: 24 })
    expect(failed.commitLines).toEqual([])
  })

  test('the first attempt prints the provider sentence once, not twice', () => {
    // Even before any suppression kicks in, one attempt produced two cards
    // carrying the same text: `✗ turn 27` from the failed call and `↻ attempt
    // 1/10` from the retry. The retry keeps only what it alone knows.
    const err = 'Overloaded: HTTP 529: overloaded_error: Service is temporarily overloaded.'
    let state = createStreamMachineState(createInitialState('claude-opus-5', '/tmp'), createSpinnerState())

    const failed = reduceRunEvent(state, {
      kind: 'llm_call_completed',
      payload: { model: 'claude-opus-5', turn: 27, error: err, metrics: { duration_ms: 830 } },
    }, { termRows: 24 })
    state = failed.state

    const retry = reduceRunEvent(state, {
      kind: 'llm_call_retry',
      payload: { attempt: 1, max_retries: 10, retry_delay_ms: 2000, error: err },
    }, { termRows: 24 })

    const text = [...failed.commitLines, ...retry.commitLines].map(l => l.text).join('\n')
    expect(text.split('Model provider overloaded').length - 1).toBe(1)
    // Both cards still appear; only the repeated sentence is gone.
    expect(text).toContain('✦ llm  claude-opus-5')
    expect(text).toContain('✦ llm  retry')
    expect(text).toContain('attempt 1/10')
  })

  test('a fresh call re-arms the retry card, a mid-storm attempt does not', () => {
    // `llm_call_started` re-fires on every bounded attempt — only a long wait
    // suppresses it — so resetting on the event kind alone would clear the flag
    // on attempt 2 and restore the storm. Attempt 0 is what marks a new call.
    const err = 'Overloaded: HTTP 529'
    let state = createStreamMachineState(createInitialState('claude-opus-5', '/tmp'), createSpinnerState())

    state = reduceRunEvent(state, {
      kind: 'llm_call_retry',
      payload: { attempt: 1, max_retries: 10, retry_delay_ms: 2000, error: err },
    }, { termRows: 24 }).state
    expect(state.retryCardShown).toBe(true)

    // The re-attempt's own start event must not re-arm the card.
    state = reduceRunEvent(state, {
      kind: 'llm_call_started',
      payload: { model: 'claude-opus-5', turn: 27, attempt: 1 },
    }, { termRows: 24 }).state
    expect(state.retryCardShown).toBe(true)

    const suppressed = reduceRunEvent(state, {
      kind: 'llm_call_retry',
      payload: { attempt: 2, max_retries: 10, retry_delay_ms: 3000, error: err },
    }, { termRows: 24 })
    expect(suppressed.commitLines).toEqual([])

    // A genuinely new call starts at attempt 0 and earns a card again.
    state = reduceRunEvent(suppressed.state, {
      kind: 'llm_call_started',
      payload: { model: 'claude-opus-5', turn: 28, attempt: 0 },
    }, { termRows: 24 }).state
    expect(state.retryCardShown).toBe(false)
    expect(state.spinnerState.phase).toBe('waiting')

    const announced = reduceRunEvent(state, {
      kind: 'llm_call_retry',
      payload: { attempt: 1, max_retries: 10, retry_delay_ms: 2000, error: err },
    }, { termRows: 24 })
    expect(announced.commitLines.map(l => l.text).join('\n')).toContain('✦ llm  retry')
  })

  test('a recovered call keeps reporting its own errors', () => {
    // The suppression is scoped to a live storm. Once a call succeeds and a
    // later one fails on its own, that failure is news again — silently
    // dropping it would hide a real error behind an unrelated earlier retry.
    let state = createStreamMachineState(createInitialState('claude-opus-5', '/tmp'), createSpinnerState())
    state = reduceRunEvent(state, {
      kind: 'llm_call_retry',
      payload: { attempt: 1, max_retries: 10, retry_delay_ms: 2000, error: 'Overloaded: HTTP 529' },
    }, { termRows: 24 }).state
    state = reduceRunEvent(state, {
      kind: 'llm_call_started',
      payload: { model: 'claude-opus-5', turn: 28, attempt: 0 },
    }, { termRows: 24 }).state

    const failed = reduceRunEvent(state, {
      kind: 'llm_call_completed',
      payload: { model: 'claude-opus-5', turn: 28, error: 'API error: HTTP 500', metrics: { duration_ms: 120 } },
    }, { termRows: 24 })
    // A bare 500 is the gateway's own failure, and the card says so.
    expect(failed.commitLines.map(l => l.text).join('\n')).toContain('Gateway error, not the model provider')
  })

  test('overflow card preserves the diagnosis before compaction starts', () => {
    const err = 'Context overflow: HTTP 400: invalid_request_error: prompt is too long'
    const state = createStreamMachineState(createInitialState('test', '/tmp'), createSpinnerState())
    const failed = reduceRunEvent(state, {
      kind: 'llm_call_completed',
      payload: { model: 'test', turn: 1, error: err, metrics: { duration_ms: 24900 } },
    }, { termRows: 24 })
    const text = failed.commitLines.map(l => l.text).join('\n')
    expect(text).toContain('Context limit exceeded')
    expect(text).not.toContain('Invalid request')
    const terminal = reduceRunEvent(failed.state, { kind: 'error', payload: { message: err } }, { termRows: 24 })
    expect(terminal.commitLines.map(l => l.text).join('\n')).not.toContain('Context limit exceeded')
    expect(terminal.writeLines.some(line => line.text.includes(err))).toBe(true)
  })

  test('a privacy block is one card, and the terminal error does not repeat it', () => {
    const err = 'Invalid request: privacy blocked this request: it contains PRIVATE_KEY. Nothing was sent; run /privacy to review the rule.'
    const state = createStreamMachineState(createInitialState('test', '/tmp'), createSpinnerState())
    const failed = reduceRunEvent(state, {
      kind: 'llm_call_completed',
      payload: { model: 'test', turn: 1, error: err, metrics: { duration_ms: 2 } },
    }, { termRows: 24 })
    const text = failed.commitLines.map(l => l.text).join('\n')
    expect(text).toContain('⊘ privacy  blocked request')
    expect(text).toContain('/privacy PRIVATE_KEY mask')
    expect(text).not.toContain('Invalid request')
    const terminal = reduceRunEvent(failed.state, { kind: 'error', payload: { message: err } }, { termRows: 24 })
    expect(terminal.commitLines.map(l => l.text).join('\n')).not.toContain('privacy')
    expect(terminal.writeLines.some(line => line.text.includes(err))).toBe(true)

    // Raised before any LLM card (no call completed): the error alone shows it.
    const alone = reduceRunEvent(createStreamMachineState(createInitialState('test', '/tmp'), createSpinnerState()),
      { kind: 'error', payload: { message: err } }, { termRows: 24 })
    expect(alone.commitLines[0]?.text).toBe('⊘ privacy  blocked request')
  })

  test('an unconfigured model reports the configuration gap instead of an outage', () => {
    // Production: evot asked for a model with no channel behind it. llmproxy
    // answered 503 "No permitted model backend is configured.", which used to
    // render as "Service busy" — vocabulary for a transient outage that also
    // invited ten pointless retries. The card must name the real gap.
    const err = 'Model not found: HTTP 404: model_not_found: Model not found.'
    const state = createStreamMachineState(createInitialState('k3', '/tmp'), createSpinnerState())
    const failed = reduceRunEvent(state, {
      kind: 'llm_call_completed',
      payload: { model: 'k3', turn: 1, error: err, metrics: { duration_ms: 4000 } },
    }, { termRows: 24 })
    const text = failed.commitLines.map(l => l.text).join('\n')
    expect(text).toContain('Model not found')
    expect(text).not.toContain('Service busy')

    // The run's terminal error event carries the same message as the card, so
    // it is deduplicated from scrollback and keeps the raw detail in screen.log.
    const terminal = reduceRunEvent(failed.state, { kind: 'error', payload: { message: err } }, { termRows: 24 })
    const visible = terminal.commitLines.map(l => l.text).join('\n')
    expect(visible).not.toContain('Model not found')
    expect(terminal.writeLines.some(line => line.text.includes(err))).toBe(true)
  })

  test('an exhausted storm still reports the failure that ended the run', () => {
    // The risk in suppressing per-attempt cards: if the storm never recovers,
    // the user must still learn why the run died. The final `✗` card is indeed
    // suppressed, but the terminal `error` event commits the message — so the
    // outcome is one visible sentence instead of none, and instead of ten.
    const err = 'Overloaded: HTTP 529: overloaded_error: Service is temporarily overloaded.'
    let state = createStreamMachineState(createInitialState('claude-opus-5', '/tmp'), createSpinnerState())

    state = reduceRunEvent(state, {
      kind: 'llm_call_retry',
      payload: { attempt: 1, max_retries: 10, retry_delay_ms: 2000, error: err },
    }, { termRows: 24 }).state

    const failed = reduceRunEvent(state, {
      kind: 'llm_call_completed',
      payload: { model: 'claude-opus-5', turn: 27, error: err, metrics: { duration_ms: 830 } },
    }, { termRows: 24 })
    expect(failed.commitLines).toEqual([])

    const terminal = reduceRunEvent(failed.state, {
      kind: 'error',
      payload: { message: err },
    }, { termRows: 24 })
    const visible = terminal.commitLines.map(l => l.text).join('\n')
    expect(visible).toContain('Model provider overloaded')
    expect(visible.split('Model provider overloaded').length - 1).toBe(1)
    expect(terminal.writeLines.some(line => line.text.includes(err))).toBe(true)
  })

  test('llm error card and following error event do not duplicate the message', () => {
    const msg = 'API error: HTTP 520: error code: 520'
    let state = createStreamMachineState(createInitialState('claude-opus-4-6', '/tmp'), createSpinnerState())
    const u1 = reduceRunEvent(state, {
      kind: 'llm_call_completed',
      payload: { model: 'claude-opus-4-6', turn: 5, error: msg, metrics: { duration_ms: 43800 } },
    }, { termRows: 24 })
    state = u1.state
    const u2 = reduceRunEvent(state, { kind: 'error', payload: { message: msg } }, { termRows: 24 })
    const tui = [...u1.commitLines, ...u2.commitLines].map(l => l.text).join('\n')
    // Message shows exactly once in the TUI (the llm card), and the redundant
    // standalone error line is routed to screen.log instead.
    expect(tui.split('Model provider unavailable').length - 1).toBe(1)
    expect(tui).toContain('✦ llm  claude-opus-4-6')
    expect(u2.writeLines.some(l => l.text.includes('HTTP 520'))).toBe(true)
  })

  test('revoked cloud session reports a signal and keeps the raw error out of the TUI', () => {
    const raw = 'Auth error: session_revoked: this session was signed out; run evot login again'
    let state = createStreamMachineState(createInitialState('cloud-model', '/tmp'), createSpinnerState())

    const completed = reduceRunEvent(state, {
      kind: 'llm_call_completed',
      payload: { model: 'cloud-model', turn: 1, error: raw, metrics: { duration_ms: 10 } },
    }, { termRows: 24, cloudProvider: true })
    state = completed.state
    const terminal = completed.commitLines.map(line => stripAnsi(line.text)).join('\n')
    expect(completed.sessionRevoked).toBe(true)
    // An expired scoped key is recoverable, so the reducer stays silent: the
    // REPL owns the whole narrative in one collapsing status line. Emitting a
    // card here would strand a stale "restoring" line above its own outcome.
    expect(terminal).not.toContain('session_revoked')
    expect(terminal).not.toContain('Error:')
    // Raw gateway detail still lands in screen.log for diagnosis.
    expect(completed.writeLines.some(line => line.text.includes('session_revoked'))).toBe(true)

    const duplicate = reduceRunEvent(state, {
      kind: 'error',
      payload: { message: raw },
    }, { termRows: 24, cloudProvider: true })
    expect(duplicate.sessionRevoked).toBe(false)
    expect(duplicate.commitLines).toEqual([])
    expect(duplicate.writeLines.some(line => line.text.includes('session_revoked'))).toBe(true)
  })

  test('ordinary provider auth errors keep the generic BYOK error path', () => {
    for (const raw of [
      'Auth error: invalid API key',
      'Auth error: session_revoked: custom gateway session ended',
    ]) {
      const state = createStreamMachineState(createInitialState('byok-model', '/tmp'), createSpinnerState())
      const update = reduceRunEvent(state, {
        kind: 'llm_call_completed',
        payload: { model: 'byok-model', turn: 1, error: raw, metrics: { duration_ms: 10 } },
      }, { termRows: 24, cloudProvider: false })
      const terminal = update.commitLines.map(line => stripAnsi(line.text)).join('\n')
      // BYOK keys are user-managed: evot has nothing to re-mint, so these stay
      // visible errors instead of entering the cloud recovery path.
      expect(update.sessionRevoked).toBe(false)
      expect(terminal).toContain('Authentication failed')
      expect(terminal).not.toContain('custom gateway session ended')
    }
  })

  test('run_finished preserves partial assistant content on abnormal termination', () => {
    const appState = createInitialState('model', '/tmp')
    const spinner = createSpinnerState()
    let state = createStreamMachineState(appState, spinner)

    state = reduceRunEvent(state, {
      kind: 'assistant_delta',
      payload: { content_index: 0, content_type: 'text', delta: 'last partial line' },
    }, { termRows: 24 }).state

    const finished = reduceRunEvent(state, {
      kind: 'run_finished',
      payload: {},
    }, { termRows: 24 })

    expect(finished.commitLines.filter(line => line.kind === 'assistant').map(line => line.text).join('\n'))
      .toContain('last partial line')
    expect(finished.state.appState.currentAssistantContent).toEqual([])
  })

  test('run_finished emits no run summary', () => {
    const appState = createInitialState('model', '/tmp')
    const spinner = createSpinnerState()
    const state = createStreamMachineState(appState, spinner)
    const update = reduceRunEvent(state, {
      kind: 'run_finished',
      payload: {},
    }, { termRows: 24 })
    // The end-of-run summary block was removed; run_finished only flushes any
    // pending assistant text and never appends a summary.
    expect(update.commitLines.some(l => (l.kind as string) === 'run_summary')).toBe(false)
  })

  test('flushStreaming emits ordered assistant content', () => {
    const appState = createInitialState('model', '/tmp')
    appState.currentAssistantContent = [{ type: 'text', contentIndex: 0, text: 'pending text' }]
    const spinner = createSpinnerState()
    const state = createStreamMachineState(appState, spinner)
    const flushed = flushStreaming(state)
    expect(flushed.lines.length).toBeGreaterThan(0)
    expect(flushed.state.appState.currentAssistantContent).toEqual([])
  })

  test('streams parallel tool calls independently before execution', () => {
    const appState = createInitialState('model', '/tmp')
    const spinner = createSpinnerState()
    let state = createStreamMachineState(appState, spinner)

    state = reduceRunEvent(state, {
      kind: 'assistant_tool_call',
      payload: {
        content_index: 0,
        tool_call_id: 'call-read',
        tool_name: 'read',
        phase: 'start',
      },
    }, { termRows: 24 }).state
    for (const delta of ['{"path":"src/', 'a.rs"}']) {
      state = reduceRunEvent(state, {
        kind: 'assistant_tool_call',
        payload: {
          content_index: 0,
          tool_call_id: 'call-read',
          tool_name: 'read',
          phase: 'delta',
          delta,
        },
      }, { termRows: 24 }).state
    }
    state = reduceRunEvent(state, {
      kind: 'assistant_tool_call',
      payload: {
        content_index: 1,
        tool_call_id: 'call-edit',
        tool_name: 'edit',
        phase: 'end',
        args: { path: 'src/b.rs', edits: [] },
      },
    }, { termRows: 24 }).state

    const calls = assistantToolCalls(state.appState.currentAssistantContent)
    expect(calls).toHaveLength(2)
    expect(findAssistantToolCall(state.appState.currentAssistantContent, 'call-read')?.args).toEqual({ path: 'src/a.rs' })
    expect(findAssistantToolCall(state.appState.currentAssistantContent, 'call-edit')?.name).toBe('edit')

    state = reduceRunEvent(state, {
      kind: 'assistant_completed',
      payload: {
        content: [
          { type: 'tool_call', id: 'call-read', name: 'read', input: { path: 'src/a.rs' } },
          { type: 'tool_call', id: 'call-edit', name: 'edit', input: { path: 'src/b.rs', edits: [] } },
        ],
      },
    }, { termRows: 24 }).state
    expect(assistantToolCalls(state.appState.currentAssistantContent)).toHaveLength(2)
    expect(findAssistantToolCall(state.appState.currentAssistantContent, 'call-read')?.argsComplete).toBe(true)
    const assistantMessage = state.appState.messages[state.appState.messages.length - 1]
    const callIds = assistantMessage?.content
      ?.filter(block => block.type === 'tool_call')
      .map(block => block.type === 'tool_call' ? block.toolCall.id : '')
    expect(callIds).toEqual(['call-read', 'call-edit'])

    state = reduceRunEvent(state, {
      kind: 'tool_started',
      payload: {
        tool_call_id: 'call-edit',
        tool_name: 'edit',
        args: { path: 'src/b.rs', edits: [] },
      },
    }, { termRows: 24 }).state

    expect(findAssistantToolCall(state.appState.currentAssistantContent, 'call-edit')?.status).toBe('running')
    expect(state.spinnerState.phase).toBe('executing')
    expect(state.spinnerState.toolName).toBe('edit')
    expect(findAssistantToolCall(state.appState.currentAssistantContent, 'call-edit')?.startedAt).toBeNumber()
    expect(findAssistantToolCall(state.appState.currentAssistantContent, 'call-read')?.startedAt).toBeUndefined()
  })

  test('tool argument deltas stay in the responding phase until execution starts', () => {
    let state = createStreamMachineState(createInitialState('model', '/tmp'), createSpinnerState())
    state = reduceRunEvent(state, {
      kind: 'assistant_tool_call',
      payload: { content_index: 0, tool_call_id: 'call-edit', tool_name: 'edit', phase: 'start' },
    }, { termRows: 24 }).state
    expect(state.spinnerState.phase).toBe('responding')

    state = reduceRunEvent(state, {
      kind: 'assistant_tool_call',
      payload: {
        content_index: 0,
        tool_call_id: 'call-edit',
        tool_name: 'edit',
        phase: 'delta',
        delta: '{"path":"src/a.ts"',
      },
    }, { termRows: 24 }).state
    expect(state.spinnerState.phase).toBe('responding')

    state = reduceRunEvent(state, {
      kind: 'assistant_tool_call',
      payload: {
        content_index: 0,
        tool_call_id: 'call-edit',
        tool_name: 'edit',
        phase: 'end',
        args: { path: 'src/a.ts', edits: [] },
      },
    }, { termRows: 24 }).state
    expect(state.spinnerState.phase).toBe('responding')

    state = reduceRunEvent(state, {
      kind: 'tool_started',
      payload: { tool_call_id: 'call-edit', tool_name: 'edit', args: { path: 'src/a.ts', edits: [] } },
    }, { termRows: 24 }).state
    expect(state.spinnerState.phase).toBe('executing')
  })

  test('tool execution resets provider stream timing', () => {
    const initial = createStreamMachineState(createInitialState('m', '/tmp'), {
      ...createSpinnerState(),
      phase: 'responding',
      streaming: true,
      lastTokenAt: 123,
      streamStartedAt: 100,
      tokenCount: 8,
    })
    const update = reduceRunEvent(initial, {
      kind: 'tool_started',
      payload: { tool_name: 'read', tool_call_id: 'call-1' },
    } as any, { termRows: 24 })
    expect(update.state.spinnerState.phase).toBe('executing')
    expect(update.state.spinnerState.streaming).toBe(false)
    expect(update.state.spinnerState.lastTokenAt).toBeNull()
    expect(update.state.spinnerState.tokenCount).toBe(0)
  })

  test('spinner enters executing phase only when tool_started arrives', () => {
    // A decoded call is still queued; execution starts at tool_started.
    const appState = createInitialState('model', '/tmp')
    const spinner = createSpinnerState()
    let state = createStreamMachineState(appState, spinner)
    expect(state.spinnerState.phase).toBe('preparing')

    state = reduceRunEvent(state, {
      kind: 'assistant_tool_call',
      payload: { content_index: 0, tool_call_id: 'call-read', tool_name: 'read', phase: 'end', args: { path: 'src/a.rs' } },
    }, { termRows: 24 }).state

    // Queued, not yet running — model output phase, not execution.
    expect(findAssistantToolCall(state.appState.currentAssistantContent, 'call-read')?.status).toBe('queued')
    expect(state.spinnerState.phase).toBe('responding')

    state = reduceRunEvent(state, {
      kind: 'tool_started',
      payload: { tool_call_id: 'call-read', tool_name: 'read', args: { path: 'src/a.rs' } },
    }, { termRows: 24 }).state
    expect(findAssistantToolCall(state.appState.currentAssistantContent, 'call-read')?.status).toBe('running')
    expect(state.spinnerState.phase).toBe('executing')
  })

  test('spinner returns to preparing when a tool finishes and another is still queued', () => {
    // Serial tools: queued B has not started, so do not claim it is executing.
    let state = createStreamMachineState(createInitialState('model', '/tmp'), createSpinnerState())
    for (const [contentIndex, id, name] of [[0, 'call-read', 'read'], [1, 'call-edit', 'edit']] as const) {
      state = reduceRunEvent(state, {
        kind: 'assistant_tool_call',
        payload: { content_index: contentIndex, tool_call_id: id, tool_name: name, phase: 'end', args: {} },
      }, { termRows: 24 }).state
    }
    state = reduceRunEvent(state, {
      kind: 'tool_started',
      payload: { tool_call_id: 'call-read', tool_name: 'read', args: {} },
    }, { termRows: 24 }).state
    state = reduceRunEvent(state, {
      kind: 'tool_finished',
      payload: { tool_call_id: 'call-read', tool_name: 'read', content: 'ok', is_error: false },
    }, { termRows: 24 }).state

    expect(findAssistantToolCall(state.appState.currentAssistantContent, 'call-read')?.status).toBe('done')
    expect(findAssistantToolCall(state.appState.currentAssistantContent, 'call-edit')?.status).toBe('queued')
    expect(state.spinnerState.phase).toBe('preparing')
  })

  test('large streamed tool args stay as raw fragments and finalize once', () => {
    const appState = createInitialState('model', '/tmp')
    const spinner = createSpinnerState()
    let state = createStreamMachineState(appState, spinner)
    const chunk = 'x'.repeat(16 * 1024)
    const raw = JSON.stringify({ path: 'a', oldText: chunk, newText: chunk })

    state = reduceRunEvent(state, {
      kind: 'assistant_tool_call',
      payload: { content_index: 0, tool_call_id: 'call-edit', tool_name: 'edit', phase: 'start' },
    }, { termRows: 24 }).state
    for (let offset = 0; offset < raw.length; offset += 128) {
      state = reduceRunEvent(state, {
        kind: 'assistant_tool_call',
        payload: {
          content_index: 0,
          tool_call_id: 'call-edit',
          tool_name: 'edit',
          phase: 'delta',
          delta: raw.slice(offset, offset + 128),
        },
      }, { termRows: 24 }).state
    }

    const streaming = findAssistantToolCall(state.appState.currentAssistantContent, 'call-edit')
    expect(streaming?.partialArgs?.length).toBe(raw.length)
    expect(streaming?.args.oldText).toBe(chunk)

    state = reduceRunEvent(state, {
      kind: 'assistant_tool_call',
      payload: {
        content_index: 0,
        tool_call_id: 'call-edit',
        tool_name: 'edit',
        phase: 'end',
        args: { path: 'a', oldText: chunk, newText: chunk },
      },
    }, { termRows: 24 }).state

    const finalized = findAssistantToolCall(state.appState.currentAssistantContent, 'call-edit')
    expect(finalized?.partialArgs).toBeUndefined()
    expect(finalized?.argsComplete).toBe(true)
  })

  test('last tool completion flushes the ordered assistant message once', () => {
    const appState = createInitialState('model', '/tmp')
    appState.currentAssistantContent = [
      { type: 'thinking', contentIndex: 0, text: 'plan' },
      {
        type: 'tool_call',
        contentIndex: 1,
        toolCall: { id: 'call-1', name: 'read', args: {}, status: 'running' },
      },
      { type: 'text', contentIndex: 2, text: 'answer' },
    ]
    const state = createStreamMachineState(appState, createSpinnerState())

    const finished = reduceRunEvent(state, {
      kind: 'tool_finished',
      payload: { tool_call_id: 'call-1', tool_name: 'read', content: 'ok', is_error: false },
    }, { termRows: 24 })

    const visible = finished.commitLines.map(line => line.text).join('\n')
    expect(visible.indexOf('plan')).toBeLessThan(visible.indexOf('read'))
    expect(visible.indexOf('read')).toBeLessThan(visible.indexOf('answer'))
    expect(finished.state.appState.currentAssistantContent).toEqual([])
    expect(flushStreaming(finished.state).lines).toHaveLength(0)
  })

  test('live cards preserve model order while tools finish out of order', () => {
    const appState = createInitialState('model', '/tmp')
    const spinner = createSpinnerState()
    let state = createStreamMachineState(appState, spinner)

    for (const [contentIndex, id, name] of [[0, 'call-read', 'read'], [1, 'call-edit', 'edit']] as const) {
      state = reduceRunEvent(state, {
        kind: 'assistant_tool_call',
        payload: { content_index: contentIndex, tool_call_id: id, tool_name: name, phase: 'start' },
      }, { termRows: 24 }).state
      state = reduceRunEvent(state, {
        kind: 'tool_started',
        payload: { tool_call_id: id, tool_name: name, args: {} },
      }, { termRows: 24 }).state
    }

    state = reduceRunEvent(state, {
      kind: 'tool_finished',
      payload: { tool_call_id: 'call-edit', tool_name: 'edit', content: 'edited', is_error: false },
    }, { termRows: 24 }).state

    expect(assistantToolCalls(state.appState.currentAssistantContent).map(call => call.id)).toEqual(['call-read', 'call-edit'])
    expect(findAssistantToolCall(state.appState.currentAssistantContent, 'call-read')?.status).toBe('running')
    expect(findAssistantToolCall(state.appState.currentAssistantContent, 'call-edit')?.status).toBe('done')
  })
})

describe('judge review of a tool-call window', () => {
  const ctx = { termRows: 24 }
  const call = (id: string, relevance: number, name = 'read') => ({ tool_call_id: id, tool_name: name, arguments: `{"path":"${id}.md"}`, relevance })
  const initial = () => createStreamMachineState({ ...createInitialState('model', '/tmp'), judge: 'jev-latest' }, createSpinnerState())

  test('a clean window is silent on screen and recorded in the log', () => {
    const update = reduceRunEvent(initial(), {
      kind: 'tool_calls_reviewed',
      payload: { calls: [call('a', 0.9), call('b', 0.8), call('c', 0.35), call('d', 0.95), call('e', 0.7), call('f', 0.88)] },
    }, ctx)
    expect(update.commitLines).toHaveLength(0)
    expect(update.noticeLines).toHaveLength(0)
    const log = update.writeLines.map(line => stripAnsi(line.text)).join('\n')
    expect(log).toContain('[JEV] review · 6 calls · 1 off-task')
    expect(log).toContain('35%  read')
  })

  test('an off-task window is one notice line naming the calls', () => {
    const update = reduceRunEvent(initial(), {
      kind: 'tool_calls_reviewed',
      payload: { calls: [call('a', 0.9), call('notes', 0.14), call('c', 0.8), call('ls', 0.22, 'bash'), call('e', 0.7), call('f', 0.88)] },
    }, ctx)
    const text = update.commitLines.map(line => stripAnsi(line.text)).join('\n')
    expect(text).toContain('⚑ jev: 2 of the last 6 tool calls look off-task')
    expect(text).toContain('read path=notes.md 14%')
    expect(text).toContain('bash path=ls.md 22%')
    expect(update.noticeLines).toHaveLength(1)
  })
})
