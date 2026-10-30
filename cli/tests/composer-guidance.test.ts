import { expect, test } from 'bun:test'
import { resolveComposerGuidance, allowedSuggestionCommand } from '../src/term/app/composer-guidance.js'
import { resolveRunInteraction, type RunInteractionState } from '../src/term/app/run-interaction.js'
import { buildPromptBlocks } from '../src/term/viewmodel/prompt.js'
import { promptFromSnapshot } from '../src/term/viewmodel/prompt-snapshot.js'
import { createEditorState } from '../src/term/input/editor.js'
import { createInitialState } from '../src/term/app/state.js'

const interaction = (kind: RunInteractionState['kind']) => ({ ...resolveRunInteraction({ active: false, owner: null }), kind })
const policy = (kind: RunInteractionState['kind'], mode: 'normal' | 'log' = 'normal', queuedCount = 0) =>
  resolveComposerGuidance({ interaction: interaction(kind), mode, queuedCount })

function rendered(kind: RunInteractionState['kind'], suggestion = '') {
  const vm = promptFromSnapshot({ editor: createEditorState(), session: createInitialState('test', '/tmp'),
    active: true, logMode: false, dashboardUrl: null, exitHint: false,
    columns: 180, rows: 32, gitBranch: null, backgroundProcessCount: 0,
    interaction: interaction(kind), suggestion })
  return buildPromptBlocks(vm).flatMap(block => block.lines).map(line => line.spans.map(span => span.text).join('')).join('\n')
}

test('sampling and display share one state and mode matrix', () => {
  for (const state of ['idle', 'waiting-loop', 'waiting-background'] as const) {
    expect(policy(state).allowSuggestion).toBe(true)
    expect(policy(state, 'log').allowSuggestion).toBe(false)
  }
  for (const state of ['active', 'retrying', 'compacting', 'local-operation', 'waiting-task'] as const) {
    for (const mode of ['normal', 'log'] as const) expect(policy(state, mode).allowSuggestion).toBe(false)
  }
  expect(policy('idle', 'normal', 1).allowSuggestion).toBe(false)
})

test('waiting, compaction, retries and local operations describe actual input behavior', () => {
  expect(rendered('active')).toContain('Guide the agent while it works')
  expect(rendered('compacting')).toContain('input queues for after compaction')
  expect(rendered('retrying')).toContain('input queues for recovery')
  expect(rendered('local-operation')).toContain('Local operation in progress')
  expect(rendered('waiting-loop')).toContain('type to act now')
  expect(policy('compacting', 'normal', 2).placeholder).not.toContain('Ctrl+G')
  expect(policy('active', 'normal', 2).placeholder).toContain('Ctrl+G')
})

test('ghost text never removes loop controls', () => {
  const loop = rendered('waiting-loop', 'Run the targeted tests')
  expect(loop).toContain('Run the targeted tests')
  expect(loop).toContain('esc twice to stop')
  expect(loop).toContain('/loop 15m')
  expect(rendered('retrying', 'stale suggestion')).not.toContain('stale suggestion')
  expect(rendered('compacting', 'stale suggestion')).not.toContain('stale suggestion')
})

test('only exact registered actions exposed by the current state are acceptable', () => {
  const actions = policy('waiting-loop', 'log').allowedCommands
  for (const command of ['/done', '/loop 15m', '/loop stop']) expect(allowedSuggestionCommand(command, actions)).toBe(true)
  for (const command of ['/new', '/loop stop; rm -rf .', '/loop 15m extra', '/done\n/new']) {
    expect(allowedSuggestionCommand(command, actions)).toBe(false)
  }
  expect(allowedSuggestionCommand('/not_registered', ['/not_registered'])).toBe(false)
  expect(allowedSuggestionCommand('/done', policy('idle').allowedCommands)).toBe(false)
})

test('product guidance and allowed actions remain local state, independent of model input', () => {
  expect(policy('waiting-loop').allowedCommands).toEqual(['/loop 15m', '/loop stop'])
  expect(policy('idle', 'log').allowedCommands).toEqual(['/done'])
  expect(policy('retrying').allowSuggestion).toBe(false)
})
