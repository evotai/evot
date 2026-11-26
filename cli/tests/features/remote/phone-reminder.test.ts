import { expect, test } from 'bun:test'
import { completionReminder, roundCompletions } from '../../../src/features/remote/phone-reminder.js'

const badge = (terminal: string, finishedRound: number | null) => ({terminal, finishedRound})

test('all live sessions contribute to the same reminder, without replaying old or legacy results', () => {
  const first = roundCompletions(new Map(), [badge('A', 5), badge('B', null), {terminal:'old'}])
  expect(first.finished).toBe(false)
  expect(first.seen.has('old')).toBe(false)
  const unrelated = roundCompletions(first.seen, [badge('A', 5), {...badge('B', null), phase:'idle'}, badge('new', 7)])
  expect(unrelated.finished).toBe(false) // Status changed; the new window may contain an old result.
  const end = roundCompletions(unrelated.seen, [badge('A', 5), badge('B', 1), badge('new', 7)])
  expect(end.finished).toBe(true)
  expect(roundCompletions(end.seen, [badge('A', 5), badge('B', 1), badge('new', 7)]).finished).toBe(false)
  expect(roundCompletions(end.seen, [badge('A', 6), badge('B', 2)]).finished).toBe(true)
})

test('one tap enables ongoing sound until disabled; hidden pages pause and unpair discards a late result', async () => {
  let plays = 0, unlocks = 0, loads = 0, pressed = '', tick = () => {}, visibility = () => {}
  let pending = Promise.withResolvers<{online: ReturnType<typeof badge>[]}>()
  class Audio {
    state = 'running'
    currentTime = 0
    destination = {}
    async resume() { unlocks++ }
    createOscillator() { return {frequency:{value:0}, connect:() => ({connect() {}}), start() { plays++ }, stop() {}} }
    createGain() { return {gain:{setValueAtTime() {}, linearRampToValueAtTime() {}}} }
  }
  const document = {hidden:false, defaultView:{AudioContext:Audio, setTimeout(callback: () => void) { tick = callback; return 1 },
    clearTimeout() { tick = () => {} }}, addEventListener(_name: string, callback: () => void) { visibility = callback }}
  const button = {hidden:true, ownerDocument:document, onclick() {}, setAttribute(_name: string, value: string) { pressed = value }}
  const reminder = completionReminder(button, () => { loads++; return pending.promise }, () => {})
  const settle = async (...online: ReturnType<typeof badge>[]) => {
    pending.resolve({ online })
    await Promise.resolve()
    pending = Promise.withResolvers()
  }
  reminder.setPaired(true)
  expect(button.hidden).toBe(false)
  expect(loads).toBe(0)
  button.onclick()
  expect(pressed).toBe('true')
  expect(unlocks).toBe(1)
  await settle(badge('A', 1), badge('B', null))
  expect(plays).toBe(0)
  tick(); await settle(badge('A', 1), badge('B', 7))
  expect(plays).toBe(2) // Two notes, one chime.
  reminder.setPaired(true) // Navigating to any other conversation does not reset the toggle.
  tick(); await settle(badge('A', 2), badge('B', 7))
  expect(plays).toBe(4)
  document.hidden = true; visibility(); tick()
  expect(loads).toBe(3)
  document.hidden = false; visibility()
  expect(loads).toBe(4)
  button.onclick()
  await settle(badge('A', 3), badge('B', 8))
  expect(pressed).toBe('false')
  expect(plays).toBe(4)
  button.onclick(); await settle(badge('A', 3), badge('B', 8))
  tick(); reminder.setPaired(false); await settle(badge('A', 4), badge('B', 9))
  expect(button.hidden).toBe(true)
  expect(pressed).toBe('false')
  expect(plays).toBe(4)
})
