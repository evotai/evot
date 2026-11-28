import { expect, test } from 'bun:test'
import { draftCarry } from '../../../src/features/remote/phone-update.js'

function memory() {
  const items = new Map<string, string>()
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value) }, removeItem: (key: string) => { items.delete(key) } }
}

test('a draft rides one reload or re-pairing for its own window, and expires', () => {
  let now = 1_000
  const storage = memory(), drafts = draftCarry(storage, () => now)
  drafts.keep('window-a', 'half a sentence')
  expect(drafts.take('window-b')).toBe('') // another window's draft stays put
  expect(drafts.take('window-a')).toBe('half a sentence')
  expect(drafts.take('window-a')).toBe('')
  drafts.keep('window-a', '')
  drafts.keep(null, 'no window yet')
  expect(drafts.take('window-a')).toBe('')
  drafts.keep('window-a', 'stale'); now += 11 * 60 * 1000
  expect(drafts.take('window-a')).toBe('')
  const blocked = draftCarry({ getItem() { throw Error('blocked') }, setItem() { throw Error('blocked') }, removeItem() {} })
  blocked.keep('window-a', 'x')
  expect(blocked.take('window-a')).toBe('')
})
