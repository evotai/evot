import { describe, expect, test } from 'bun:test'
import { promptFromSnapshot, type PromptSnapshot } from '../src/term/viewmodel/prompt-snapshot.js'
import { createEditorState, insertText } from '../src/term/input/editor.js'
import { createInitialState } from '../src/term/app/state.js'

function snapshot(): PromptSnapshot {
  return {
    editor: createEditorState(), session: createInitialState('shared', '/work'),
    active: true, logMode: false,
    dashboardUrl: null, exitHint: false, columns: 80, rows: 24, gitBranch: 'main', backgroundProcessCount: 2,
    config: {
      provider: 'second', protocol: 'openai', envPath: '', hasApiKey: true, baseUrl: null, thinkingLevel: 'high',
      availableModels: [
        { provider: 'first', model: 'shared', spec: 'first:shared' },
        { provider: 'second', model: 'shared', spec: 'second:shared' },
      ],
    },
  }
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
