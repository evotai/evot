import { buildToolCard } from '../../../src/render/output.js'
import { describe, expect, test } from 'bun:test'
import { decodeQueryEvent, isHostToolEvent } from '../../../src/native/contracts/query-event.js'
import { applyEvent, MAX_RETAINED_MESSAGES } from '../../../src/term/app/run/reducer.js'
import { createInitialState } from '../../../src/term/app/run/state.js'
import { assistantToolCalls } from '../../../src/term/app/run/assistant-content.js'
import { createStreamMachineState, reduceRunEvent } from '../../../src/term/app/run/stream.js'
import { createSpinnerState } from '../../../src/term/widgets/spinner.js'
import currentPayloads from '../../fixtures/contracts/run-payloads-current.json'
import type { AppState } from '../../../src/term/app/run/state.js'

function apply(state: AppState, kind: string, payload: Record<string, unknown>): AppState {
  const event = decodeQueryEvent(JSON.stringify({
    event_id: 'e', run_id: 'r', session_id: 's', turn: 1, created_at: '', kind, payload,
  }))
  if (isHostToolEvent(event)) throw new Error('expected run event')
  return applyEvent(state, event)
}

function queued() {
  return apply(createInitialState('model', '/tmp'), 'assistant_tool_call', {
    content_index: 0, tool_call_id: 'call', tool_name: 'custom', phase: 'end', args: { path: 'file' },
  })
}

describe('typed run reducer', () => {
  test('stats and verbose output share the same reception-rate policy', () => {
    for (const streaming_ms of [0, 100, 3000]) {
      const state = apply(createInitialState('model', '/tmp'), 'llm_call_completed', {
        turn: 1, attempt: 0, usage: { input: 3, output: 600 },
        metrics: { duration_ms: 15000, ttfb_ms: 1000, ttft_ms: 2000, streaming_ms, chunk_count: 10 },
      })
      expect(state.currentRunStats.llmCallDetails[0].tokPerSec).toBe(streaming_ms === 3000 ? 200 : 0)
      expect(state.verboseEvents.at(-1)?.text.includes('tok/s')).toBe(streaming_ms === 3000)
    }
  })

  test('bash countdown updates in place and disappears when the tool finishes', () => {
    const queuedState = apply(createInitialState('model', '/tmp'), 'assistant_tool_call', {
      content_index: 0, tool_call_id: 'bash', tool_name: 'bash', phase: 'end', args: { command: 'sleep 30' },
    })
    let state = apply(queuedState, 'tool_started', {
      tool_call_id: 'bash', tool_name: 'bash', args: { command: 'sleep 30' },
    })
    for (const remaining of [10, 9, 1]) {
      const text = `Moves to background in ${remaining}s; command keeps running.`
      state = apply(state, 'tool_progress', { tool_call_id: 'bash', tool_name: 'bash', text })
      const tool = assistantToolCalls(state.currentAssistantContent)[0]!
      expect(tool.progress).toBe(text)
      const lines = buildToolCard(tool).map(line => line.text).join('\n')
      expect(lines).toContain(text)
      expect(lines.match(/Moves to background/g)).toHaveLength(1)
    }
    state = apply(state, 'tool_finished', {
      tool_call_id: 'bash', tool_name: 'bash', content: 'Background task started', is_error: false,
      details: { task_id: 'task', status: 'running' }, duration_ms: 10000,
    })
    const tool = assistantToolCalls(state.currentAssistantContent)[0]!
    expect(buildToolCard(tool).map(line => line.text).join('\n')).not.toContain('Moves to background')
  })

  test('current Rust payload fixtures flow through decoder, stream and reducer', () => {
    let state = createStreamMachineState(createInitialState('model', '/tmp'), createSpinnerState())
    for (const fixture of currentPayloads) {
      const event = decodeQueryEvent(JSON.stringify({
        event_id: 'e', run_id: 'r', session_id: 's', turn: 1, created_at: '', ...fixture,
      }))
      if (isHostToolEvent(event)) throw new Error('expected run event')
      state = reduceRunEvent(state, event, { termRows: 24 }).state
      for (const tool of assistantToolCalls(state.appState.currentAssistantContent)) {
        expect(typeof tool.args).toBe('object')
        expect(tool.args).not.toBeNull()
        expect(Array.isArray(tool.args)).toBe(false)
      }
    }
    expect(state.appState.isLoading).toBe(false)
    expect(state.appState.error).toBe('fixture failure')
  })

  test('non-object final tool arguments cannot enter UI object state', () => {
    for (const args of [null, false, 1, 'text', []]) {
      const state = apply(queued(), 'assistant_tool_call', {
        content_index: 0, tool_call_id: 'call', tool_name: 'custom', phase: 'end', args,
      })
      expect(assistantToolCalls(state.currentAssistantContent)[0]?.args).toEqual({ path: 'file' })
    }
  })

  test('execution preserves existing arguments when wire JSON is not an object', () => {
    for (const args of [null, false, 1, 'text', []]) {
      const state = apply(queued(), 'tool_started', { tool_call_id: 'call', tool_name: 'custom', args })
      const tool = assistantToolCalls(state.currentAssistantContent)[0]
      expect(tool?.args).toEqual({ path: 'file' })
      expect(tool?.status).toBe('running')
    }
    const state = apply(queued(), 'tool_started', {
      tool_call_id: 'call', tool_name: 'custom', args: { path: 'changed' },
    })
    expect(assistantToolCalls(state.currentAssistantContent)[0]?.args).toEqual({ path: 'changed' })
  })

  test('authoritative completion and streaming use the same argument projection', () => {
    for (const input of [null, false, 'text', []]) {
      const state = apply(createInitialState('model', '/tmp'), 'assistant_completed', {
        content: [{ type: 'tool_call', id: 'call', name: 'custom', input }], stop_reason: 'tool_use',
      })
      expect(assistantToolCalls(state.currentAssistantContent)[0]?.args).toEqual({})
    }
  })

  test('completed messages are retained as a bounded tail with the newest last', () => {
    let state = createInitialState('model', '/tmp')
    for (let i = 0; i < MAX_RETAINED_MESSAGES + 5; i++) {
      state = apply(state, 'assistant_completed', {
        content: [{ type: 'text', text: `answer ${i}` }], stop_reason: 'end_turn',
      })
    }
    expect(state.messages).toHaveLength(MAX_RETAINED_MESSAGES)
    expect(state.messages.at(-1)?.text).toBe(`answer ${MAX_RETAINED_MESSAGES + 4}`)
    expect(state.messages[0]?.text).toBe('answer 5')
  })

  test('unknown events are inert and optional usage defaults remain zero', () => {
    const initial = createInitialState('model', '/tmp')
    expect(apply(initial, 'future_event', { data: true })).toBe(initial)
    const state = apply(initial, 'llm_call_completed', { turn: 1, attempt: 0, usage: { input: 3, output: 4 } })
    expect(state.sessionTokens.inputTokens).toBe(3)
    expect(state.sessionTokens.outputTokens).toBe(4)
    expect(state.sessionTokens.cacheReadTokens).toBe(0)
    expect(state.sessionTokens.cacheWriteTokens).toBe(0)
  })

  test('legacy retry and compaction projections remain supported', () => {
    const initial = createInitialState('model', '/tmp')
    // Older internal/replay callers need not use the current wire decoder.
    const event = { event_id: 'e', run_id: 'r', session_id: 's', turn: 1, created_at: '' }
    const retried = applyEvent(initial, { ...event, kind: 'api_retry', payload: { attempt: 1, delay_ms: 100, error: 'busy' } })
    expect(retried.verboseEvents.at(-1)?.kind).toBe('llm_retry')
    const compacted = applyEvent(initial, { ...event, kind: 'context_compaction_completed', payload: {
      result: { type: 'compacted', before_message_count: 10, after_message_count: 4, before_tokens: 100, after_tokens: 25, messages_evicted: 6, current_run_reclaimed: 0 },
    } })
    expect(compacted.currentRunStats.compactHistory).toEqual([{ beforeTokens: 100, afterTokens: 25 }])
  })

  test('first llm_call_started of a process prints the context line from its own window', () => {
    const initial = createInitialState('model', '/tmp')
    const started = apply(initial, 'llm_call_started', {
      turn: 1, attempt: 0, injected_count: 0, model: 'kimi-k3', message_count: 3, message_bytes: 1,
      estimated_context_tokens: 120_000, system_prompt_tokens: 4_000, tool_count: 0, context_window: 1_000_000,
    })
    const text = started.verboseEvents.at(-1)?.text ?? ''
    expect(text).toContain('context')
    expect(text).toContain('120k / 1M')
  })

  test('implausible provider usage keeps the engine estimate for the footer', () => {
    const initial = createInitialState('model', '/tmp')
    const started = apply(initial, 'llm_call_started', {
      turn: 33, attempt: 0, injected_count: 0, model: 'kimi-k3', message_count: 257, message_bytes: 1,
      estimated_context_tokens: 302_000, system_prompt_tokens: 4_000, tool_count: 0, context_window: 1_000_000,
    })
    expect(started.sessionTokens.contextTokens).toBe(302_000)

    // A gateway summed the whole run's prompt tokens into the last response.
    const bogus = apply(started, 'llm_call_completed', {
      turn: 33, attempt: 0, usage: { input: 305_000, output: 9_000, cache_read: 4_900_000, cache_write: 0 },
    })
    expect(bogus.sessionTokens.contextTokens).toBe(302_000)
    expect(bogus.currentRunStats.contextTokens).toBe(302_000)
    // Billing counters still record what the provider charged.
    expect(bogus.sessionTokens.cacheReadTokens).toBe(4_900_000)

    // A count consistent with the request replaces the estimate.
    const real = apply(started, 'llm_call_completed', {
      turn: 33, attempt: 0, usage: { input: 20_000, output: 2_000, cache_read: 290_000, cache_write: 0 },
    })
    expect(real.sessionTokens.contextTokens).toBe(312_000)

    // Without any estimate the provider count is taken as is.
    const noEstimate = apply(initial, 'llm_call_completed', {
      turn: 1, attempt: 0, usage: { input: 30_000, output: 100, cache_read: 0, cache_write: 0 },
    })
    expect(noEstimate.sessionTokens.contextTokens).toBe(30_100)
  })

  test('auto compaction completed refreshes the footer context to the post-compaction size', () => {
    const initial = createInitialState('model', '/tmp')
    const event = { event_id: 'e', run_id: 'r', session_id: 's', turn: 1, created_at: '' }
    const before = {
      ...initial,
      currentRunStats: { ...initial.currentRunStats, contextTokens: 5_200_000, contextWindow: 1_000_000 },
      sessionTokens: { ...initial.sessionTokens, contextTokens: 5_200_000, contextWindow: 1_000_000 },
    }
    const compacted = applyEvent(before, { ...event, kind: 'context_compaction_completed', payload: {
      reason: 'overflow',
      context_window: 1_000_000,
      result: {
        type: 'compacted', before_message_count: 258, after_message_count: 37,
        before_tokens: 297_000, after_tokens: 24_000, messages_evicted: 222, current_run_reclaimed: 0,
      },
    } })
    expect(compacted.sessionTokens.contextTokens).toBe(24_000)
    expect(compacted.sessionTokens.contextWindow).toBe(1_000_000)
    expect(compacted.currentRunStats.contextTokens).toBe(24_000)

    const noOp = applyEvent(before, { ...event, kind: 'context_compaction_completed', payload: {
      reason: 'threshold', result: { type: 'no_op' },
    } })
    expect(noOp.sessionTokens.contextTokens).toBe(5_200_000)
  })
})
