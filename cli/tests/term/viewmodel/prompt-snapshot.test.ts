import { describe, expect, test } from 'bun:test'
import { promptFromSnapshot, type PromptSnapshot } from '../../../src/term/viewmodel/prompt-snapshot.js'
import { createEditorState, insertText } from '../../../src/term/input/editor.js'
import { createInitialState } from '../../../src/term/app/run/state.js'
import { applyEvent } from '../../../src/term/app/run/reducer.js'
import { buildPromptFooterBlocks } from '../../../src/term/viewmodel/prompt-footer.js'

function snapshot(): PromptSnapshot {
  return {
    editor: createEditorState(), session: createInitialState('shared', '/work'),
    active: true, logMode: false,
    dashboardUrl: null, exitHint: false, columns: 80, rows: 24, gitBranch: 'main', backgroundProcessCount: 2,
    config: {
      provider: 'second', protocol: 'openai', envPath: '', hasApiKey: true, baseUrl: null, thinkingLevel: 'high',
      availableModels: [
        { provider: 'first', model: 'shared', spec: 'first:shared' },
        { provider: 'second', model: 'shared', spec: 'second:shared', thinking_levels: ['off', 'low', 'high'] },
        { provider: 'first', model: 'target', spec: 'first:target', thinking_levels: ['medium', 'high'] },
      ],
    },
  }
}

function footerText(input: PromptSnapshot): string {
  return buildPromptFooterBlocks(promptFromSnapshot(input))
    .flatMap(block => block.lines.flatMap(line => line.spans.map(span => span.text))).join('')
}

describe('prompt snapshot projection', () => {
  test('provider follows the active pair, not the first same-named model', () => {
    const input = snapshot()
    const output = promptFromSnapshot(input)
    expect(output.provider).toBe('second')
    expect(output.model).toBe('shared')
    expect(output.thinkingLevel).toBe('high')
    expect(output.lines).toBe(input.editor.lines)
  })

  test('shows the receiving model while busy and distinguishes it from the next model when idle', () => {
    const input = snapshot()
    input.columns = 140
    input.session.lastCallModel = { model: 'target', provider: 'first', thinkingLevel: 'medium' }
    const running = promptFromSnapshot({ ...input, busy: true })
    expect(running).toMatchObject({ model: 'target', provider: 'first', thinkingLevel: 'medium' })
    expect(running.nextModel).toBeUndefined()
    const footer = footerText({ ...input, busy: false })
    expect(footer).toContain('last: target')
    expect(footer).toContain('next: shared')
    const narrow = footerText({ ...input, busy: false, columns: 20 })
    expect(narrow).not.toContain('last:')
    expect(narrow).toContain('next: shared')
  })

  test('shows the selected handoff target without a next-model hint', () => {
    const input = { ...snapshot(), columns: 140 }
    input.session = { ...input.session, model: 'target', lastCallModel: { model: 'target', provider: 'first', thinkingLevel: 'medium' } }
    input.config = { ...input.config!, provider: 'first', thinkingLevel: 'medium' }
    expect(promptFromSnapshot(input)).toMatchObject({ model: 'target', provider: 'first', thinkingLevel: 'medium' })
    const footer = footerText(input)
    expect(footer).not.toContain('last:')
    expect(footer).not.toContain('next:')
  })

  test('qualifies same-ID handoffs and does not shadow an idle manual effort change', () => {
    const input = snapshot()
    input.session.lastCallModel = { model: 'shared', provider: 'first', thinkingLevel: 'medium' }
    expect(promptFromSnapshot(input)).toMatchObject({ model: 'first:shared', nextModel: 'second:shared' })
    input.session.lastCallModel = { model: 'shared', provider: 'second', thinkingLevel: 'medium' }
    expect(promptFromSnapshot(input).thinkingLevel).toBe('high')
  })

  test('manual selection after an ordinary run shows the newly selected model and effort', () => {
    const input = snapshot()
    input.columns = 140
    const event = { event_id: 'e', run_id: 'r', session_id: 's', turn: 1, created_at: '' }
    const started = applyEvent(createInitialState('shared', '/work'), {
      ...event, kind: 'llm_call_started', payload: {
        turn: 1, attempt: 0, injected_count: 0, model: 'shared', provider: 'second', thinking_level: 'low',
        message_count: 1, message_bytes: 10, system_prompt_tokens: 0, tool_count: 0,
      },
    })
    const finished = applyEvent(started, {
      ...event, kind: 'run_finished', payload: {
        text: '', usage: { input: 0, output: 0 }, turn_count: 1, duration_ms: 1, transcript_count: 0,
      },
    })
    input.session = { ...finished, model: 'target' }
    input.config = { ...input.config!, provider: 'first' }
    expect(promptFromSnapshot(input)).toMatchObject({ model: 'target', thinkingLevel: 'high' })
    const footer = footerText(input)
    expect(footer).not.toContain('last:')
    expect(footer).not.toContain('next:')
    expect(footer).toContain('high')
  })

  test('only models with selectable effort show an off badge during a run', () => {
    const input = { ...snapshot(), columns: 140, busy: true }
    input.session.lastCallModel = { model: 'shared', provider: 'first', thinkingLevel: 'off' }
    expect(promptFromSnapshot(input).thinkingLevel).toBe('')
    expect(footerText(input)).not.toContain('thinking off')
    input.session.lastCallModel = { model: 'shared', provider: 'second', thinkingLevel: 'off' }
    expect(promptFromSnapshot(input).thinkingLevel).toBe('off')
    expect(footerText(input)).toContain(' off')
  })

  test('background hint and placeholder use the same editor snapshot', () => {
    const input = snapshot()
    expect(promptFromSnapshot(input).backgroundPanelDownAvailable).toBe(true)
    input.editor = insertText(input.editor, 'draft')
    const output = promptFromSnapshot(input)
    expect(output.placeholder).toBe(false)
    expect(output.backgroundPanelDownAvailable).toBe(false)
    expect(output.backgroundProcessCount).toBe(2)
  })

  test('context uses session stats and missing configuration stays explicit', () => {
    const input = snapshot()
    input.config = undefined
    input.session.sessionTokens.contextTokens = 123
    input.session.sessionTokens.contextWindow = 456
    input.active = false
    const output = promptFromSnapshot(input)
    expect(output.contextTokens).toBe(123)
    expect(output.contextWindow).toBe(456)
    expect(output.provider).toBe('')
    expect(output.thinkingLevel).toBe('')
    expect(output.active).toBe(false)
  })
})
