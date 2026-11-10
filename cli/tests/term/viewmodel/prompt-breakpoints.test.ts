import { describe, expect, test } from 'bun:test'
import {
  atLeastHeight,
  atLeastWidth,
  heightTier,
  widthTier,
} from '../../../src/term/viewmodel/breakpoints.js'

describe('width tiers', () => {
  test('name the boundaries the layout already used', () => {
    // 30 is where rails start paying for themselves, 65 where the full
    // placeholder fits. Tiering must not move either.
    expect(widthTier(29)).toBe('xs')
    expect(widthTier(30)).toBe('sm')
    expect(widthTier(64)).toBe('sm')
    expect(widthTier(65)).toBe('md')
    expect(widthTier(200)).toBe('md')
  })

  test('atLeastWidth reads as "at least this much space"', () => {
    expect(atLeastWidth('md', 'sm')).toBe(true)
    expect(atLeastWidth('sm', 'sm')).toBe(true)
    expect(atLeastWidth('xs', 'sm')).toBe(false)
  })
})

describe('height tiers', () => {
  test('name the boundaries the layout already used', () => {
    // 10 is where a border stops eating the transcript, 20 where blank rows
    // can centre a draft, 36 where the completion viewport grows.
    expect(heightTier(9)).toBe('xs')
    expect(heightTier(10)).toBe('sm')
    expect(heightTier(19)).toBe('sm')
    expect(heightTier(20)).toBe('md')
    expect(heightTier(35)).toBe('md')
    expect(heightTier(36)).toBe('lg')
  })

  test('atLeastHeight orders every tier', () => {
    expect(atLeastHeight('lg', 'md')).toBe(true)
    expect(atLeastHeight('md', 'md')).toBe(true)
    expect(atLeastHeight('sm', 'md')).toBe(false)
    expect(atLeastHeight('xs', 'sm')).toBe(false)
  })
})

describe('degenerate dimensions', () => {
  test('clamp to the smallest tier rather than throwing', () => {
    for (const value of [0, 1, -5]) {
      expect(widthTier(value)).toBe('xs')
      expect(heightTier(value)).toBe('xs')
    }
  })
})
