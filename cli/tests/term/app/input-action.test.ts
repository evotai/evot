import { expect, test } from 'bun:test'
import { tabAction, tabActionHint } from '../../../src/term/app/composer/input-action.js'
import { createEditorState, insertText, showCompletions } from '../../../src/term/input/editor.js'

const skills = [{ name: 'x-review', dir: '/fixture/x-review' }]
const options = { busy: true, editing: false, skills, inventory: { models: [], sessions: [] } }

test.each([
  ['next task', 'queue'], ['Review ./missing', 'local'], ['Review ./missing ', 'queue'],
  ['Review @missing', 'local'], ['/x-r', 'local'], ['/x-review', 'local'],
  ['/x-review inspect changes', 'queue'], ['/compact ', 'none'], ['/unknown-command', 'local'],
  ['/model unknown', 'arguments'], ['', 'assist'], [' ', 'assist'],
] as const)('Tab has one predictable meaning for %j', (text, kind) => {
  const action = tabAction(insertText(createEditorState(), text), options)
  expect(action.kind).toBe(kind)
  if (kind === 'queue') expect(tabActionHint(action)).toContain('Tab queue')
  if (kind === 'local' || kind === 'arguments') expect(tabActionHint(action)).toContain('Tab complete')
})

test('idle input only assists and editing never queues; popup keeps precedence', () => {
  const editor = insertText(createEditorState(), 'next task')
  expect(tabAction(editor, { ...options, busy: false }).kind).toBe('assist')
  expect(tabAction(editor, { ...options, editing: true }).kind).toBe('none')
  const popup = showCompletions(editor, [{ label: 'candidate', value: 'candidate' }], 0)
  expect(tabAction(popup, options).kind).toBe('local')
})
