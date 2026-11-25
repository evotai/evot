import { expect, test } from 'bun:test'
import { askEditText, askGoTo, askResponses, askSelect, createAskState, focusOption, getUIState, handleAskKeyEvent } from '../../../src/ui/ask.js'
import { parseRemoteAction } from '../../../src/features/remote/protocol.js'

const choice = { header:'Scope', question:'Which scope?', options:[{label:'Small'},{label:'Large'}] }
const detail = { header:'Detail', question:'Why?', options:[] }

test('tapping an option submits the same single answer as its TUI number key', () => {
  const state = createAskState([choice]), tap = askSelect(focusOption(state,1)), key = handleAskKeyEvent(state,'char','2')
  expect(tap.done).toBe(true); expect(key.action).toBe('submit')
  if (key.action === 'submit') expect(askResponses(tap.state)).toEqual(askResponses(key.state))
})

test('touch tabs retain custom drafts independently of confirmed answers and review never submits on navigation', () => {
  let state = createAskState([choice,detail])
  state = askEditText(state,'my alternative')
  state = askSelect(focusOption(state,0)).state
  expect(state.currentTab).toBe(1)
  expect(askSelect(state).state).toBe(state) // blank custom input
  state = askEditText(state,'中文\n备注')
  state = askGoTo(state,2)
  expect(state.onSubmitTab).toBe(true); expect(state.submitted).toBe(false)
  const wire = () => ({kind:'answer', generation:1, id:'q', answers:askResponses(state).map(r=>r.answer)})
  expect(wire().answers).toEqual(['Small','Skipped']); expect(parseRemoteAction(wire())).toEqual(wire())
  state = askGoTo(state,0); expect(getUIState(state).otherText).toBe('my alternative')
  state = askSelect(focusOption(state,choice.options.length)).state
  expect(getUIState(state).otherText).toBe('中文\n备注')
  state = askSelect(state).state; expect(state.onSubmitTab).toBe(true)
  expect(wire().answers).toEqual(['my alternative','中文\n备注']); expect(parseRemoteAction(wire())).toEqual(wire())
})
