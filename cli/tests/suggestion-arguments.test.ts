import { expect, test } from 'bun:test'
import { argumentCompletion, validCommandInput, type CommandInventory } from '../src/term/app/suggestion/arguments.js'

import { context } from './helpers/suggestion-context.js'
import { createSuggestionInput } from '../src/term/app/suggestion/input.js'
import { PromptSuggestion } from '../src/term/app/suggestion/controller.js'
import { createEditorState, insertText } from '../src/term/input/editor.js'

const inventory: CommandInventory = {
  models: [{ value: 'local:fast', label: 'Fast' }, { value: 'local:deep', label: 'Deep' }],
  sessions: [{ value: '01234567-abcd-0000-0000-000000000001', label: 'Fix tests' }],
}

test('model and session arguments come only from the live inventory', () => {
  const model = argumentCompletion('/model', 6, inventory)
  expect(model?.items.map(item => item.value)).toEqual([' local:fast', ' local:deep'])
  expect(argumentCompletion('/model local:f', 14, inventory)?.items.map(item => item.value)).toEqual(['local:fast'])
  expect(argumentCompletion('/sessions 0123', 14, inventory)?.items[0]?.value).toBe(inventory.sessions[0]!.value)
  expect(argumentCompletion('/resume find tests', 18, inventory)).toBeNull()
  expect(argumentCompletion('/loo', 4, inventory)).toBeNull()
  expect(argumentCompletion('/model missing', 14, inventory)?.items).toEqual([])
})

test('finite model identifiers take precedence over path-like spelling without a model request', () => {
  const editor = insertText(createEditorState(), '/model tests/model')
  let shown: string[] = []
  const controller = new PromptSuggestion({ key: () => 's', eligible: () => true, context, changed: () => {}, start: () => { throw new Error('must not request the model') } })
  const input = createSuggestionInput({
    controller, eligible: () => true, editor: () => editor, replace: () => {}, changed: () => {},
    inventory: () => ({ models: [{ value: 'tests/model-one', label: 'Known model' }], sessions: [] }),
    showArguments: completion => { shown = completion.items.map(item => item.value) },
  })
  expect(input.handle({ type: 'tab' })).toBe(true)
  expect(shown).toEqual(['tests/model-one'])
})

test('validation rejects invented entities and invalid intervals without executing anything', () => {
  expect(validCommandInput('/model local:fast', inventory)).toBe(true)
  expect(validCommandInput('/model invented', inventory)).toBe(false)
  expect(validCommandInput('/resume 01234567', inventory)).toBe(true)
  expect(validCommandInput('/resume abcdef12', inventory)).toBe(false)
  expect(validCommandInput('/resume fix tests', inventory)).toBe(true)
  expect(validCommandInput('/loop 0s check CI', inventory)).toBe(false)
  expect(validCommandInput('/loop 2h check CI', inventory)).toBe(false)
  expect(validCommandInput('/loop 5m check CI', inventory)).toBe(true)
  expect(validCommandInput('/loop status', inventory)).toBe(true)
  expect(validCommandInput('ordinary prose', inventory)).toBe(true)
})
