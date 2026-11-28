import { expect, test } from 'bun:test'
import { navigation } from '../../../src/features/remote/phone-navigation.js'

const first = 'aaaaaaaa-1111-2222-3333-444444444444'
const second = 'bbbbbbbb-1111-2222-3333-444444444444'
function entry() {
  return { state: {} as Record<string, unknown>, replaceState(state: Record<string, unknown>) { this.state = state } }
}
function storage() {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) }
}

test('reload keeps the chosen session, a new environment visit opens the picker and a QR wins over the old view', () => {
  const page = entry(), tab = storage()
  tab.setItem('evot.terminal', second) // old clients kept an implicit default
  const view = navigation(null, false, page, tab)
  expect(view.target).toBeNull()
  view.select(second, 'session-b')
  expect(navigation(null, false, page, tab).target).toEqual({terminal: second, session: 'session-b'})
  expect(navigation(null, false, entry(), tab).target).toBeNull()
  expect(navigation(first, false, page, tab).target).toEqual({terminal: first, session: null})
})

test('an address survives reload, copying to another tab and sign-in without relying on history state', () => {
  const url = new URL('https://remote.example/'), tab = storage()
  const page = { state:{} as Record<string,unknown>, replaceState(state:Record<string,unknown>, _:string, href:string) { this.state=state; url.href=href } }
  const open = (returning=false)=>navigation(null,returning,page,tab,()=>100,url)
  const initial = open(); expect(initial.target).toBeNull(); initial.select(first)
  expect(url.searchParams.get('window')).toBe(first); expect(url.searchParams.has('session')).toBe(false)
  const session='project/a + b'; initial.select(first, session); const bookmark=url.href
  page.state={}; expect(open().target).toEqual({terminal:first,session}); expect(url.href).toBe(bookmark)
  open().select(second,'other'); url.href=bookmark
  expect(open().target).toEqual({terminal:first,session}) // address wins over a stale entry
  open().redirect(); page.state={}; url.search=''; expect(open(true).target?.session).toBe(session); expect(url.href).toBe(bookmark)
  url.search='?window=invalid&session=x'; expect(open().target).toBeNull(); expect(url.search).toBe('')
  url.href=bookmark; open().select(null); expect(url.href).toBe('https://remote.example/')
})

test('account verification restores only an unexpired same-tab destination and consumes it once', () => {
  const tab = storage(), source = navigation(first, false, entry(), tab, () => 100)
  source.redirect()
  expect(navigation(null, true, entry(), tab, () => 200).target).toEqual({terminal: first, session: null})
  expect(navigation(null, true, entry(), tab, () => 200).target).toBeNull()
  source.redirect()
  expect(navigation(null, true, entry(), tab, () => 300100).target).toBeNull()
  source.redirect()
  expect(navigation(second, true, entry(), tab, () => 200).target?.terminal).toBe(second)
})
