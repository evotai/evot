import { describe, expect, test } from 'bun:test'
import { messagesToOutputLines } from '../../src/render/output.js'
import { transcriptToMessages } from '../../src/session/transcript.js'
import { assistantMessageToOutputLines } from '../../src/render/assistant.js'
import { buildOutputBlocks } from '../../src/term/viewmodel/output.js'
import { blocksToLines } from '../../src/term/viewmodel/types.js'
import stripAnsi from 'strip-ansi'

describe('transcript conversion', () => {
  test('replay accepts opaque JSON tool arguments without crashing preview reconstruction', () => {
    for (const input of [null, false, 1, 'text', []]) {
      for (const name of ['bash', 'read', 'write', 'edit']) {
        const messages = transcriptToMessages([{
          type: 'assistant', content: [{ type: 'tool_call', id: 'c1', name, input }],
        }])
        const block = messages[0]?.content?.[0]
        if (block?.type !== 'tool_call') throw new Error('missing tool block')
        expect(block.toolCall.args).toEqual({})
        expect(block.toolCall.previewCommand).toBeUndefined()
      }
    }
  })

  test('restores canonical assistant content in provider order', () => {
    const messages = transcriptToMessages([{
      type: 'assistant',
      content: [
        { type: 'thinking', text: 'plan' },
        { type: 'tool_call', id: 'c1', name: 'read', input: { path: 'a' } },
        { type: 'text', text: 'answer' },
      ],
    }])

    expect(messages[0]?.text).toBe('answer')
    expect(messages[0]?.content?.map(block => block.type)).toEqual(['thinking', 'tool_call', 'text'])
    expect(messagesToOutputLines(messages).map(line => line.kind)).toContain('thinking')
  })

  test('resumed reasoning folds in the compact view and is lifted in the expanded view', () => {
    const messages = transcriptToMessages([{
      type: 'assistant',
      content: [{ type: 'thinking', text: 'plan' }],
    }])
    const fold = (expanded?: boolean) =>
      messagesToOutputLines(messages, expanded).filter(line => line.kind === 'thinking').map(line => line.thinkingFold)
    expect(fold()).toEqual(['tail'])
    expect(fold(true)).toEqual([undefined])
  })

  test('resumed reasoning retains the same compact window as the live and committed views', () => {
    const text = Array.from({ length: 20 }, (_, i) => `reasoning row ${i + 1}`).join('\n\n')
    const messages = transcriptToMessages([{
      type: 'assistant',
      content: [{ type: 'thinking', text }, { type: 'text', text: 'answer' }],
    }])
    const content = messages[0]?.content
    if (!content) throw new Error('missing assistant content')
    const render = (lines: ReturnType<typeof messagesToOutputLines>) =>
      blocksToLines(buildOutputBlocks(lines, { columns: 80 })).map(stripAnsi)
    const resumed = render(messagesToOutputLines(messages))
    expect(resumed).toEqual(render(assistantMessageToOutputLines(content)))
    expect(resumed).toEqual(render(assistantMessageToOutputLines(content, false, { streaming: true })))
    expect(resumed).toContain('✻ ↑ 18 rows (ctrl+o)')
    expect(resumed).toContain('  reasoning row 20')
    expect(resumed).toContain('⏺ answer')
  })

  test('restores tool-result details onto the canonical tool block', () => {
    const messages = transcriptToMessages([
      {
        type: 'assistant',
        content: [
          { type: 'text', text: 'running a tool' },
          { type: 'tool_call', id: 'call-1', name: 'bash', input: { command: 'ls' } },
        ],
      },
      {
        type: 'tool_result',
        tool_call_id: 'call-1',
        tool_name: 'bash',
        content: 'done',
        is_error: false,
        details: { diff: 'a\nb' },
      },
    ])

    const block = messages[0]?.content?.find(block => block.type === 'tool_call')
    expect(block?.type === 'tool_call' ? block.toolCall.details : undefined).toEqual({ diff: 'a\nb' })
    expect(block?.type === 'tool_call' ? block.toolCall.status : undefined).toBe('done')
  })

  test('restored tool details render the same semantic status as live cards', () => {
    const messages = transcriptToMessages([
      {
        type: 'assistant',
        content: [
          { type: 'tool_call', id: 'call-edit', name: 'edit', input: { path: 'src/a.ts' } },
        ],
      },
      {
        type: 'tool_result',
        tool_call_id: 'call-edit',
        tool_name: 'edit',
        content: 'Updated src/a.ts.',
        is_error: false,
        details: {
          diff: '@@ -1 +1 @@\n-old\n+new',
          replacement_count: 1,
          added_lines: 1,
          removed_lines: 1,
        },
      },
    ])

    const rendered = messagesToOutputLines(messages).map(line => line.text)
    expect(rendered[0]).toBe('✎ edit  src/a.ts')
    expect(rendered[1]).toBe('  ✓ · 1 replacement · +1 −1')
    expect(rendered.join('\n')).toContain('+new')
  })

  test('tool call without result remains queued', () => {
    const messages = transcriptToMessages([{
      type: 'assistant',
      content: [
        { type: 'tool_call', id: 'c2', name: 'bash', input: { command: 'ls' } },
      ],
    }])

    const block = messages[0]?.content?.find(block => block.type === 'tool_call')
    expect(block?.type === 'tool_call' ? block.toolCall.status : undefined).toBe('queued')
    expect(block?.type === 'tool_call' ? block.toolCall.details : undefined).toBeUndefined()
  })

  test('reads pre-migration content_blocks in mixed existing sessions', () => {
    const messages = transcriptToMessages([{
      type: 'assistant',
      content_blocks: [{ type: 'text', text: 'old answer' }],
    }])

    expect(messages[0]?.text).toBe('old answer')
  })

  test('restores compact transcript markers as expandable resume cards', () => {
    const messages = transcriptToMessages([{
      type: 'compact',
      reason: 'manual',
      summary: 'summary text',
      tokens_before: 12345,
      tokens_after: 4567,
      messages_before: 20,
      messages_after: 4,
      details: {
        method: 'remote_failed_local',
        fallback_reason: 'Upstream error 400: Store must be set to false',
      },
    } as any])

    expect(messages).toHaveLength(1)
    expect(messages[0]?.compaction).toEqual({
      reason: 'manual',
      summary: 'summary text',
      tokensBefore: 12345,
      tokensAfter: 4567,
      messagesBefore: 20,
      messagesAfter: 4,
      method: 'remote_failed_local',
      remoteBlobBytes: undefined,
      fallbackReason: 'Upstream error 400: Store must be set to false',
    })

    const collapsed = messagesToOutputLines(messages).map(line => line.text).join('\n')
    expect(collapsed).toContain('✦ compact  12k → 5k')
    expect(collapsed).toContain('  Upstream error 400: Store must be set to false')
    expect(collapsed).toContain('summary hidden (ctrl+o to expand)')
    expect(collapsed).not.toContain('summary text')

    const expanded = messagesToOutputLines(messages, true).map(line => line.text).join('\n')
    expect(expanded).toContain('✦ compact  12k → 5k')
    expect(expanded).toContain('summary text')
  })

  test('does not replay historical runtime errors on resume', () => {
    const messages = transcriptToMessages([
      {
        type: 'stats',
        kind: 'llm_call_completed',
        data: { error: 'Auth error: HTTP 403', turn: 4 },
      },
      {
        type: 'assistant',
        content: [{ type: 'text', text: 'answer after error' }],
      },
    ])

    expect(messages[0]?.verboseEvents).toBeUndefined()
    const rendered = messagesToOutputLines(messages).map(line => line.text).join('\n')
    expect(rendered).toContain('answer after error')
    expect(rendered).not.toContain('403')
  })

  test('resuming a session does not replay a retry storm card by card', () => {
    // The live stream drops the repeats before they reach scrollback, but a
    // stored transcript still holds every attempt. Without the same collapse on
    // replay, reopening a session brought back the wall of duplicate 529s: eight
    // copies of one sentence for four attempts.
    const err = 'Overloaded: HTTP 529: overloaded_error: Service is temporarily overloaded.'
    const messages = [{
      id: 'a1',
      role: 'assistant' as const,
      text: 'recovered',
      timestamp: 0,
      verboseEvents: [1, 2, 3, 4].flatMap(n => ([
        { kind: 'llm_completed' as const, text: `[LLM] ✗ · claude-opus-5 · turn 27 · 830ms\n    error     ${err}` },
        { kind: 'llm_retry' as const, text: `[LLM] ↻ · retrying in ${n} seconds · attempt ${n}/10\n    error     ${err}` },
      ])),
    }]

    const rendered = messagesToOutputLines(messages).map(line => line.text).join('\n')
    expect(rendered.split('Model provider overloaded').length - 1).toBe(1)
    expect(rendered).not.toContain(err)
    expect(rendered.split('✦ llm  retry').length - 1).toBe(1)
    // The storm is still visible as an event, just once.
    expect(rendered).toContain('attempt 1/10')
    expect(rendered).not.toContain('attempt 4/10')
  })

  test('a failure after a recovered call is still replayed', () => {
    // Collapsing is scoped to one storm. A success between failures ends it, so
    // a later unrelated error is not hidden behind an earlier retry.
    const messages = [{
      id: 'a1',
      role: 'assistant' as const,
      text: 'done',
      timestamp: 0,
      verboseEvents: [
        { kind: 'llm_retry' as const, text: '[LLM] ↻ · retrying in 2 seconds · attempt 1/10\n    error     Overloaded: HTTP 529' },
        { kind: 'llm_completed' as const, text: '[LLM] ✓ · claude-opus-5 · turn 28 · 900ms · 40 tok/s' },
        { kind: 'llm_completed' as const, text: '[LLM] ✗ · claude-opus-5 · turn 29 · 120ms\n    error     API error: HTTP 500' },
      ],
    }]

    const rendered = messagesToOutputLines(messages).map(line => line.text).join('\n')
    expect(rendered.split('Model provider overloaded').length - 1).toBe(1)
    expect(rendered.split('Gateway error, not the model provider').length - 1).toBe(1)
    expect(rendered).toContain('turn 29')
  })
})
