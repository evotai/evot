import { expect, test } from 'bun:test'
import { InterruptConfirmation } from '../../../src/term/app/run/interrupt-confirmation.js'

test('confirmation requires two presses for the same live operation within five seconds', () => {
  let now = 100
  const confirmation = new InterruptConfirmation(() => now)
  const run = {}
  expect(confirmation.press(run)).toBe(false)
  expect(confirmation.pending(run)).toBe(true)
  expect(confirmation.pending({})).toBe(false)
  now += 4999
  expect(confirmation.press(run)).toBe(true)
  expect(confirmation.pending(run)).toBe(false)
  expect(confirmation.press(run)).toBe(false)
  now += 5000
  expect(confirmation.press(run)).toBe(false)
  expect(confirmation.press({})).toBe(false)
  confirmation.clear()
  expect(confirmation.press(run)).toBe(false)
})

test('an armed window never applies to a missing owner', () => {
  const confirmation = new InterruptConfirmation(() => 0)
  expect(confirmation.press(null)).toBe(false)
  expect(confirmation.pending(null)).toBe(false)
  expect(confirmation.press(null)).toBe(false)
})
