import { describe, expect, test } from 'bun:test'
import {
  AD_GAP_MS, AD_STEADY_MS, ERASE_STEP_MS, TYPE_STEP_MS,
  createAdSlotState, nextAdSlotRenderDelay, queueAdSlotTransition,
  tickAdSlot, triggerAdSlot, type AdContent,
} from '../../../src/term/viewmodel/ad-slot.js'

const first: AdContent = { id: 'a', kind: 'ad', title: 'Hello', body: '' }
const second: AdContent = { id: 'b', kind: 'ad', title: 'World', body: '' }
const T0 = 100_000

function delay(state: ReturnType<typeof createAdSlotState>, now: number, visible = true) {
  return nextAdSlotRenderDelay(state, tickAdSlot(state, now), now, visible)
}

describe('ad slot repaint scheduling', () => {
  test('no timer for empty, untriggered, hidden or exhausted premium slots', () => {
    expect(delay(createAdSlotState([]), T0)).toBeNull()
    const state = createAdSlotState([first])
    expect(delay(state, T0)).toBeNull()
    triggerAdSlot(state, T0)
    expect(delay(state, T0 + 10, false)).toBeNull()
    const premium = createAdSlotState([{ ...first, kind: 'notice' }], { premium: true })
    triggerAdSlot(premium, T0)
    expect(delay(premium, T0 + AD_STEADY_MS)).toBeNull()
  })

  test('typing gets short wakeups, steady text sleeps until rotation', () => {
    const state = createAdSlotState([first])
    triggerAdSlot(state, T0)
    expect(delay(state, T0)).toBe(80)
    const typedAt = T0 + 5 * TYPE_STEP_MS
    expect(delay(state, typedAt)).toBe(AD_STEADY_MS - 5 * TYPE_STEP_MS)
    // A single item plays once, so rotation ends the slot instead of retyping it.
    expect(delay(state, T0 + AD_STEADY_MS)).toBeNull()
    expect(state.currentId).toBeNull()
  })

  test('a full idle rotation needs only animation frames, not 562 polling frames', () => {
    const state = createAdSlotState([first])
    triggerAdSlot(state, T0)
    let now = T0
    let frames = 0
    while (now < T0 + AD_STEADY_MS) {
      const next = delay(state, now)
      frames++
      if (next === null) break
      now += next
    }
    expect(now).toBe(T0 + AD_STEADY_MS)
    expect(frames).toBeLessThanOrEqual(4)
  })

  test('typing outlives entering phase for long copy', () => {
    const state = createAdSlotState([{ ...first, title: 'x'.repeat(100) }])
    triggerAdSlot(state, T0)
    expect(delay(state, T0 + 1000)).toBe(80)
    // Markdown wrapping can add separator graphemes to the flattened ticker.
    expect(delay(state, T0 + 5000)).toBe(AD_STEADY_MS - 5000)
  })

  test('erase animation sleeps through the blank gap, then starts next item', () => {
    const state = createAdSlotState([first, second])
    triggerAdSlot(state, T0)
    queueAdSlotTransition(state, second.id, T0 + 1000)
    expect(delay(state, T0 + 1000)).toBe(80)
    const eraseDone = T0 + 1000 + 5 * ERASE_STEP_MS
    expect(delay(state, eraseDone)).toBe(AD_GAP_MS)
    expect(delay(state, eraseDone + AD_GAP_MS)).toBe(80)
    expect(state.currentId).toBe(second.id)
  })

  test('new notices wake for preemption even while the current copy is static', () => {
    const state = createAdSlotState([first])
    triggerAdSlot(state, T0)
    // A higher-priority item still waiting jumps the queue once the line settles.
    state.notices.push({ ...second, kind: 'notice', priority: 1 })
    expect(delay(state, T0 + 500)).toBe(701)
    expect(delay(state, T0 + 1201)).toBe(80)
    expect(state.queuedId).toBe(second.id)
  })

  test('hidden slot resumes lifecycle on a state-driven frame', () => {
    const state = createAdSlotState([first, second])
    triggerAdSlot(state, T0)
    expect(delay(state, T0 + 100, false)).toBeNull()
    expect(delay(state, T0 + AD_STEADY_MS)).toBe(80)
    expect(state.queuedId).toBe(second.id)
  })
})
