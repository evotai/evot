import { expect, test } from 'bun:test'
import { draftCarry, pageUpdates } from '../../../src/features/remote/phone-update.js'

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

test('a page reloads once for a newer served build and never loops on a cached old page', () => {
  const storage = memory()
  let reloads = 0
  const check = pageUpdates('build-1', storage, () => { reloads++ })
  expect(check(null)).toBe(false) // an older gateway sends no build
  expect(check('build-1')).toBe(false)
  expect(check('build-2')).toBe(true)
  expect(check('build-2')).toBe(false)
  expect(reloads).toBe(1)
  // The reloaded page came back old from a cache: it does not reload again for that build.
  expect(pageUpdates('build-1', storage, () => { reloads++ })('build-2')).toBe(false)
  expect(pageUpdates('build-2', storage, () => { reloads++ })('build-3')).toBe(true)
  expect(reloads).toBe(2)
})
