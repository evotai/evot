import { expect, test } from 'bun:test'
import type { SessionMeta, SessionWithText } from '../../../src/native/index.js'
import { startFixtureRelay } from '../../helpers/remote-relay.js'
import { phoneCatalog } from '../../../src/features/remote/catalog.js'
import { windowRows } from '../../../src/features/remote/phone-directory.js'
import { profileKey, registerTerminal, type SessionBadge } from '../../../src/features/remote/discovery.js'
import { phoneWorkspace } from '../../../src/features/remote/workspace.js'

test('the Mac windows view keeps gateway order and appends status-only windows', () => {
  const now = Date.UTC(2026, 8, 18), stamp = (minutes:number) => now - minutes * 60000
  const online = [ {session:'working', phase:'working', updatedAt:stamp(4)}, {session:'idle', phase:'idle', updatedAt:stamp(1)} ]
  const rows = windowRows(online, [{phase:'idle', updatedAt:now}], '', now)
  expect(rows.map((r: {session?:string}) => r.session)).toEqual(['working', 'idle', undefined])
  expect(rows[2]).toMatchObject({kind:'private', age:'now'})
  expect(rows[1]).toMatchObject({kind:'live', age:'1m ago'})
})

test('sorts saved metadata before taking the first page', async () => {
  const home = '/fixture/'+crypto.randomUUID()
  const bus = registerTerminal(home, {snapshot(){throw Error('unused')}, act(){}},
    () => ({session:'', workspace:'fixture', phase:'idle', title:'New'}))
  try {
    const rows = ['old','latest','middle'].map((session_id,i) => ({session_id, cwd:'/fixture', updated_at:['2026-01-01','2026-01-03','2026-01-02'][i]+'T00:00:00Z'} as SessionMeta))
    const ws = phoneWorkspace(bus, {listSessions:async()=>rows, deleteSession:async()=>true, listSessionsWithText:async()=>[]}, home, '/fixture', 'scope')
    const page = await ws.list(false, {limit:2,query:''})
    expect(page.history.map(r=>r.session)).toEqual(['latest','middle'])
  } finally { bus.close() }
})

test('one profile-wide list puts live sessions first, shows unshared windows as status only, hides unused drafts and paginates after ranking', async () => {
  const home = '/fixture/' + crypto.randomUUID(), cwd = '/code/a/project', other = '/code/b/project'
  const rows = [
    {session_id:'elsewhere', cwd:other, title:'Outside', turns:3},
    {session_id:'empty', cwd, title:'Opened, never used', turns:0},
    {session_id:'branch', parent_session_id:'parent', cwd, title:'Fork title', turns:1, updated_at:'2026-01-03T00:00:00Z'},
    {session_id:'active', cwd, title:'Automatic title', custom_title:'  Renamed\n  session  ', turns:0},
    {session_id:'parent', cwd, title:'Original … latest', turns:2, updated_at:'2026-01-01T00:00:00Z'},
    {session_id:'private', cwd:'/secret', title:'hidden title', turns:0},
    {session_id:'task', cwd, source:'automation'},
  ] as SessionMeta[]
  const host = {snapshot(){throw Error('unexpected transcript read')},act(){}}
  const owner = registerTerminal(home, host, () => ({workspace:'project', project:profileKey(cwd), title:'Stale snippet', session:'active', phase:'working', updatedAt:99}))
  const sibling = registerTerminal(home, host, () => ({workspace:'project', project:profileKey(other), title:'Old', session:'elsewhere', phase:'idle'}))
  const hidden = registerTerminal(home, host, () => ({workspace:'secret', title:'hidden title', session:'private', phase:'idle'}))
  const mirror = registerTerminal(home, host, () => ({workspace:'project', title:'Mirror', session:'active', phase:'idle'}))
  try {
    owner.share('scope'); sibling.share('scope'); mirror.share('scope')
    const asked: number[] = [], scans: number[] = []
    const ws = phoneWorkspace(owner, {listSessions:async limit => { asked.push(limit); return limit ? rows.slice(0, limit) : rows }, deleteSession:async()=>true,
      listSessionsWithText:async () => { scans.push(1); return [{...rows.find(r=>r.session_id==='parent')!, search_text:'Explain the Original planner bug', user_prompts:['why does the planner choke']} as SessionWithText] }}, home, cwd, 'scope')
    const page = { limit:40, query:'' }
    const result = await ws.catalog(page)
    expect(result.rows[0]).toMatchObject({session:'active',title:'Renamed session',phase:'working',terminal:owner.id})
    expect(result.online.filter(w=>w.session === 'active').map(w=>w.title)).toEqual(['Renamed session','Renamed session'])
    expect(result.rows.map(r=>r.session)).toEqual(['active','elsewhere','private','branch','parent'])
    expect(result.rows[2]).toMatchObject({session:'private', title:'hidden title', unshared:true})
    expect(result.rows[2]!.terminal).toBeUndefined()
    const first = await ws.catalog({...page,limit:2}); expect(first.count).toBe(5); expect(first.more).toBe(true); expect(first.rows).toEqual(result.rows.slice(0,2))
    expect(result.more).toBe(false)
    expect(asked).toEqual([80]) // the first page reads a bounded number of newest sessions, once; a smaller page reuses it
    await ws.catalog({...page,query:'outside'}); expect(asked).toEqual([80, 0]) // search scans everything
    // Transcript words find a session whose title never mentions them; all words must match.
    expect((await ws.catalog({...page,query:'planner choke'})).rows.map(r=>r.session)).toEqual(['parent'])
    expect((await ws.catalog({...page,query:'planner nowhere'})).rows).toEqual([])
    expect(scans).toEqual([1])
    // A page that read as many rows as it asked for may hide more on disk, even when filtering emptied it.
    const tiny = await phoneWorkspace(owner, {listSessions:async limit => rows.slice(0, limit || undefined), deleteSession:async()=>true, listSessionsWithText:async()=>[]}, home, cwd, 'scope').catalog({limit:1, query:''})
    expect(tiny.more).toBe(true)
    expect((await ws.catalog({...page,query:'outside'})).rows).toEqual([result.rows[1]!])
    expect(JSON.stringify(result)).not.toMatch(/Stale snippet|never used/)
    expect(JSON.stringify(result.online)).not.toMatch(/secret|hidden/)
  } finally { owner.close(); sibling.close(); hidden.close(); mirror.close() }
})

test('unsaved windows appear immediately and newer activity wins within each tier', () => {
  const w = (terminal:string, phase:'working'|'idle', updatedAt:number) => ({terminal, phase, updatedAt, session:'', workspace:'scratch', title:terminal})
  const live = [w('open-new', 'idle', 90), w('run-old', 'working', 1), w('open-old', 'idle', 80), w('run-new', 'working', 2)]
  const page = {limit:3, query:''}
  const first = phoneCatalog([], live, page)
  expect(first.count).toBe(4)
  expect(first.rows.map(r=>r.terminal)).toEqual(['run-new','run-old','open-new'])
  expect(first.online.map(w=>w.terminal)).toEqual(['run-new','run-old','open-new','open-old'])
  expect(phoneCatalog([], live, {...page, query:'open'}).rows.map(r=>r.terminal)).toEqual(['open-new','open-old'])
})

test('profile gateway discovers a new live window; another profile and an opted-out window stay hidden', async () => {
  const home='/fixture/'+crypto.randomUUID(), host={snapshot(){throw Error('unexpected read')},act(){throw Error('unexpected action')}}
  const badge:SessionBadge={workspace:'private-project',title:'private-title',session:'private-id',phase:'idle',updatedAt:2}
  const gateway=registerTerminal(home,host,()=>({...badge,session:'gateway',title:'gateway',workspace:'fixture'}))
  const scope = 'e'.repeat(24), ws=phoneWorkspace(gateway,{listSessions:async()=>[], deleteSession:async()=>true, listSessionsWithText:async()=>[]},home,'/fixture',scope)
  const release = await startFixtureRelay(home, scope, gateway)
  expect((await ws.list(true)).privateWindows).toEqual([])
  const window=registerTerminal(home,host,()=>badge,undefined,{
    session:()=>badge.session, currentScope:()=>scope,
  })
  try {
    for(const phase of ['idle','working','input'] as const){
      badge.phase=phase
      const list=await ws.list(true)
      expect(list.privateWindows).toEqual([])
      expect(list.online).toEqual([expect.objectContaining({...badge,terminal:window.id})])
    }
    gateway.route('other'); expect(JSON.stringify(await ws.catalog({query:'',limit:40}))).not.toContain('private-')
    gateway.route(null); gateway.share(scope); expect((await ws.list(true)).online.some(t=>t.terminal===window.id)).toBe(false)
    gateway.route(scope); window.share(null)
    expect(JSON.stringify(await ws.list(true))).not.toContain('private-')
    expect((await gateway.request(window.id,'/state')).status).toBe(403)
  } finally { release(); gateway.close(); window.close() }
})
