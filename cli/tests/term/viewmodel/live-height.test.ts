import { describe, expect, test } from 'bun:test'
import { updateLiveHeight } from '../../../src/term/viewmodel/live-height.js'

describe('updateLiveHeight', () => {
  test('absorbs parser shrink so the live footer position stays monotonic', () => {
    let maxHeight = 0
    const totals: number[] = []
    for (const height of [8, 10, 9, 7, 11]) {
      const update = updateLiveHeight(maxHeight, height, true)
      maxHeight = update.maxHeight
      totals.push(height + update.padding)
    }
    expect(totals).toEqual([8, 10, 10, 10, 11])
  })

  test('caps padding after an unusually large reflow', () => {
    expect(updateLiveHeight(100, 20, true)).toEqual({ maxHeight: 28, padding: 8 })
    expect(updateLiveHeight(100, 20, true, 3)).toEqual({ maxHeight: 23, padding: 3 })
  })

  test('resets while a fresh call has no visible partial content', () => {
    expect(updateLiveHeight(12, 8, false)).toEqual({ maxHeight: 0, padding: 0 })
  })

  test('sanitizes invalid dimensions', () => {
    expect(updateLiveHeight(Number.NaN, Number.POSITIVE_INFINITY, true)).toEqual({ maxHeight: 0, padding: 0 })
  })
})
