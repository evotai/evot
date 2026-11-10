import { describe, expect, test } from 'bun:test'
import { assistantMessageToOutputLines } from '../../src/render/assistant.js'
import { appendAssistantDelta } from '../../src/term/app/run/assistant-content.js'
import type { UIAssistantBlock } from '../../src/render/message-types.js'

const thinking = (text: string): UIAssistantBlock => ({ type: 'thinking', contentIndex: 0, text })
const textBlock = (text: string): UIAssistantBlock => ({ type: 'text', contentIndex: 1, text })
const toolBlock = (): UIAssistantBlock => ({
  type: 'tool_call',
  contentIndex: 2,
  toolCall: { id: 'call-1', name: 'read', args: { path: 'src/a.rs' }, status: 'running' },
})

describe('live assistant block render cache', () => {
  test('repainting unchanged content reuses rendered lines by reference', () => {
    const content = [thinking('planning the change'), textBlock('Hello **world**'), toolBlock()]
    const first = assistantMessageToOutputLines(content, false, { streaming: true })
    const second = assistantMessageToOutputLines(content, false, { streaming: true })
    expect(second).toEqual(first)
    // Same OutputLine objects — the Markdown pipeline did not run again.
    for (let i = 0; i < first.length; i++) expect(second[i]).toBe(first[i]!)
  })

  test('a delta re-renders only the block it touches', () => {
    const content = [thinking('done thinking'), textBlock('Hello')]
    const before = assistantMessageToOutputLines(content, false, { streaming: true })
    const updated = appendAssistantDelta(content, { content_index: 1, content_type: 'text', delta: ' world' })
    // Untouched block keeps object identity across the immutable update…
    expect(updated[0]).toBe(content[0]!)
    const after = assistantMessageToOutputLines(updated, false, { streaming: true })
    // …so its rendered lines are reused, while the grown block re-renders.
    expect(after[0]).toBe(before[0]!)
    expect(after.at(-1)!.text).toContain('world')
  })

  test('render option changes invalidate the cache', () => {
    const content = [textBlock('same text')]
    const streaming = assistantMessageToOutputLines(content, false, { streaming: true })
    const settled = assistantMessageToOutputLines(content, false, { streaming: false })
    expect(settled[0]).not.toBe(streaming[0]!)
    const expanded = assistantMessageToOutputLines(content, true, { streaming: false })
    expect(expanded[0]).not.toBe(settled[0]!)
  })

  test('tool card updates re-render because the block object is replaced', () => {
    const running = toolBlock()
    const before = assistantMessageToOutputLines([running], false, {})
    const finished: UIAssistantBlock = {
      type: 'tool_call',
      contentIndex: 2,
      toolCall: { id: 'call-1', name: 'read', args: { path: 'src/a.rs' }, status: 'done', durationMs: 12 },
    }
    const after = assistantMessageToOutputLines([finished], false, {})
    expect(after.map(line => line.text).join('\n')).not.toBe(before.map(line => line.text).join('\n'))
  })
})
