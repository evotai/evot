import { describe, expect, test } from 'bun:test'

import { byPriority, nextToPlay, type Playable } from '../../../src/term/viewmodel/playback.js'

const items: Playable[] = [
  { id: 'low', priority: 1, key: 'low' },
  { id: 'high', priority: 9, key: 'high' },
  { id: 'mid', priority: 5, key: 'mid' },
  { id: 'tie', priority: 5, key: 'tie' },
]

describe('playback', () => {
  test('orders by priority, keeping input order on ties', () => {
    expect(byPriority(items).map(item => item.id)).toEqual(['high', 'mid', 'tie', 'low'])
  })

  test('plays each item once, highest priority first, then stops', () => {
    const played = new Set<string>()
    const seen: string[] = []
    for (;;) {
      const next = nextToPlay(items, played)
      if (!next) break
      seen.push(next.id)
      played.add(next.key)
    }
    expect(seen).toEqual(['high', 'mid', 'tie', 'low'])
    expect(nextToPlay(items, played)).toBeNull()
  })

  test('exceptId skips the item currently playing', () => {
    const next = nextToPlay(items, new Set(), 'high')
    expect(next?.id).toBe('mid')
  })

  test('a changed key is a new item and plays again', () => {
    const played = new Set(['notice-v1'])
    const revised: Playable[] = [{ id: 'notice', priority: 1, key: 'notice-v2' }]
    expect(nextToPlay(revised, played)?.id).toBe('notice')
  })
})
