import type { TranscriptItem } from '../../src/native/contracts/results.js'
import type { UIMessage } from '../../src/term/app/types.js'
import { SuggestionContext, type WorkflowRuntime } from '../../src/term/app/suggestion/context.js'

/** Adapt existing display-shaped test fixtures at the test boundary only. */
export function context(messages: readonly UIMessage[] = [], runtime?: WorkflowRuntime) {
  const source = new SuggestionContext()
  source.restore(messages.flatMap<TranscriptItem>(message => {
    if (message.role === 'user') return [{ type: 'user', text: message.text }]
    if (message.role !== 'assistant') return []
    return [{ type: 'assistant', stop_reason: message.content?.some(block => block.type === 'tool_call') ? 'toolUse' : 'stop',
      content: message.content?.map(block => block.type === 'tool_call'
        ? { type: 'tool_call', id: block.toolCall.id, name: block.toolCall.name, input: block.toolCall.args }
        : block) ?? [{ type: 'text', text: message.text }],
    }]
  }))
  return source.snapshot(runtime)
}
