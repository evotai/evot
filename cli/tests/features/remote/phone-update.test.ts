import { expect, test } from 'bun:test'
import { draftCarry, reloadForRecovery } from '../../../src/features/remote/phone-update.js'

function memory() {
  const items = new Map<string, string>()
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value) }, removeItem: (key: string) => { items.delete(key) } }
}

test('recover an outdated page once, only after repeated failure and if local work is safe', () => {
  const opts = {page:'aaaaaaaaaaaaaaaa', gateway:'bbbbbbbbbbbbbbbb', failures:2, protectedWork:false, storage:memory(), saveDraft:()=>true}
  for (const blocked of [{failures:1}, {gateway:opts.page}, {gateway:null}, {protectedWork:true}, {saveDraft:()=>false}])
    expect(reloadForRecovery({...opts, ...blocked})).toBe(false)
  expect(reloadForRecovery(opts)).toBe(true)
  expect(reloadForRecovery(opts)).toBe(false)
})

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
  expect(blocked.keep('window-a', 'x')).toBe(false)
  expect(blocked.take('window-a')).toBe('')
})
