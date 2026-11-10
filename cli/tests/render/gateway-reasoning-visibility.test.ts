import { describe, expect, test } from 'bun:test'
import stripAnsi from 'strip-ansi'
import { assistantMessageToOutputLines } from '../../src/render/assistant.js'
import { appendAssistantDelta, completedAssistantContent, upsertAssistantToolCall } from '../../src/term/app/run/assistant-content.js'
import type { UIAssistantBlock } from '../../src/render/message-types.js'
import { buildOutputBlocks } from '../../src/term/viewmodel/output.js'
import { blocksToLines } from '../../src/term/viewmodel/types.js'

function render(content: UIAssistantBlock[], streaming: boolean, expanded = false): string {
  return stripAnsi(blocksToLines(buildOutputBlocks(
    assistantMessageToOutputLines(content, expanded, { streaming }),
    { columns: 80 },
  )).join('\n'))
}

// Text/tool/thinking order and placeholder match the gateway diagnostic SSE.
// These are UI events after decoding, not a fixture claiming to be raw SSE.
function toolTurn(): UIAssistantBlock[] {
  const content = appendAssistantDelta([], {
    content_index: 0, content_type: 'text', delta: 'Inspect decoder.rs first.',
  })
  return upsertAssistantToolCall(content, 1, {
    id: 'diagnostic-read', name: 'read', args: { path: 'decoder.rs' }, status: 'running',
  })
}

describe('gateway reasoning visibility', () => {
  test('placeholder is hidden without mutating content used for replay', () => {
    const content = appendAssistantDelta(toolTurn(), {
      content_index: 2, content_type: 'thinking', delta: '...',
    })
    for (const streaming of [true, false]) {
      const text = render(content, streaming)
      expect(text).toContain('Inspect decoder.rs first.')
      expect(text).toContain('read')
      expect(text).not.toContain('✻')
    }
    expect(content[2]).toEqual({ type: 'thinking', contentIndex: 2, text: '...' })
  })

  test('a later real delta replaces the cached invisible view immediately', () => {
    const placeholder = appendAssistantDelta(toolTurn(), {
      content_index: 2, content_type: 'thinking', delta: '...',
    })
    expect(render(placeholder, true)).not.toContain('✻')
    const updated = appendAssistantDelta(placeholder, {
      content_index: 2, content_type: 'thinking', delta: '检查协议转换是否丢失摘要。',
    })
    const live = render(updated, true)
    expect(live).toContain('检查协议转换是否丢失摘要。')
    expect(live.indexOf('read')).toBeLessThan(live.indexOf('✻'))
    // Finishing the block retains the visible original text in compact view.
    expect(render(updated, false)).toBe(live)
    expect(render(updated, false, true)).toContain('检查协议转换是否丢失摘要。')
  })

  test('the fifth turn summary from the reported session survives completion in compact and expanded views', () => {
    const text = '**Analyzing git diff and streaming behavior**\n\n**Detailing theme and interface redesign changes**\n\n'
    const streamed = appendAssistantDelta([], {
      content_index: 0, content_type: 'thinking', delta: text,
    })
    const completed = completedAssistantContent([{ type: 'thinking', text }], streamed)
    for (const visible of [render(streamed, true), render(completed, false), render(completed, false, true)]) {
      expect(visible).toContain('Analyzing git diff and streaming behavior')
      expect(visible).toContain('Detailing theme and interface redesign changes')
    }
    expect(render(completed, false)).toBe(render(streamed, true))
  })
})
