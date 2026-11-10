import { describe, expect, test } from 'bun:test'
import stripAnsi from 'strip-ansi'
import type { RunEvent } from '../../src/native/contracts/query-event.js'
import { RunThinking, thinkingDuration } from '../../src/render/run-thinking.js'
import { buildRunFooterLine } from '../../src/render/run-footer.js'
import { assistantMessageToOutputLines } from '../../src/render/assistant.js'
import { buildOutputBlocks, blocksToLines } from '../../src/term/viewmodel/index.js'

function event(kind: string, payload: Record<string, unknown> = {}): RunEvent {
  return { kind, payload, event_id: 'e', run_id: 'r', session_id: 's', turn: 1, created_at: '' }
}
function delta(content_type: 'thinking' | 'text', text: string, content_index = 0): RunEvent {
  return event('assistant_delta', { content_type, delta: text, content_index })
}
function rows(output: ReturnType<typeof assistantMessageToOutputLines>): string[] {
  return blocksToLines(buildOutputBlocks(output, { columns: 80 })).map(stripAnsi)
}

describe('run thinking timing for the final footer', () => {
  test('empty following deltas do not finish visible reasoning', () => {
    const timing = new RunThinking()
    timing.observe(delta('thinking', 'plan'), 100)
    timing.observe(delta('thinking', ' more'), 200)
    timing.observe(delta('text', ''), 300)
    timing.observe(delta('text', '\n '), 400)
    timing.observe(delta('text', 'answer', 1), 8100)
    expect(timing.finish(10000)).toBe(8000)
  })

  test('tool execution and gaps between turns do not count as thinking', () => {
    const timing = new RunThinking()
    timing.observe(delta('thinking', 'first'), 100)
    timing.observe(event('assistant_tool_call'), 2100)
    expect(timing.finish(2100)).toBe(2000)
    timing.observe(event('tool_finished'), 50000)
    timing.observe(event('turn_started'), 60000)
    expect(timing.finish(60000)).toBe(2000)
    timing.observe(delta('thinking', 'second'), 70000)
    timing.observe(delta('text', 'done', 1), 73000)
    expect(timing.finish(100000)).toBe(5000)
  })

  test('empty thinking and runs without reasoning produce no timing', () => {
    const timing = new RunThinking()
    timing.observe(delta('thinking', ''), 0)
    timing.observe(delta('text', 'hello'), 5000)
    expect(timing.finish(6000)).toBeNull()
  })

  test('short reasoning is reported as less than a second, not zero seconds', () => {
    const timing = new RunThinking()
    timing.observe(delta('thinking', 'plan'), 100)
    timing.observe(delta('text', 'done', 1), 200)
    expect(thinkingDuration(timing.finish(200) ?? 0)).toBe('<1s')
  })

  test('errors, retries and stream termination settle timing exactly once', () => {
    for (const kind of ['error', 'llm_call_retry', 'run_finished', 'assistant_completed', 'llm_call_completed', 'quota_waiting', 'outage_waiting']) {
      const timing = new RunThinking()
      timing.observe(delta('thinking', 'plan'), 0)
      timing.observe(event(kind), 2000)
      expect(timing.finish(10000)).toBe(2000)
    }
    const timing = new RunThinking()
    timing.observe(delta('thinking', 'plan'), 0)
    expect(timing.finish(2000)).toBe(2000)
    expect(timing.finish(5000)).toBe(2000)
    timing.reset()
    expect(timing.finish()).toBeNull()
  })

  test('finished thinking retains its text without adding a timing card or status row', () => {
    const timing = new RunThinking()
    timing.observe(delta('thinking', 'plan'), 0)
    timing.observe(delta('text', 'Done.', 1), 8000)
    const content = [
      { type: 'thinking' as const, contentIndex: 0, text: 'plan' },
      { type: 'text' as const, contentIndex: 1, text: 'Done.' },
    ]
    const expected = ['', '✻ plan', '', '⏺ Done.']
    expect(rows(assistantMessageToOutputLines(content, false, { streaming: true }))).toEqual(expected)
    expect(rows(assistantMessageToOutputLines(content))).toEqual(expected)
    expect(rows(assistantMessageToOutputLines(content, true)).join('\n')).toContain('plan')
    const footer = buildRunFooterLine(0, 10000, 2, timing.finish(10000))
    expect(stripAnsi(footer?.text ?? '')).toContain('2 turns · thought 8s · done')
    expect(buildRunFooterLine(0, 10000, 2)?.text).not.toContain('thought')
  })
})
