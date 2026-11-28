import { expect, test } from 'bun:test'
import type { SessionMeta, SessionWithText } from '../../../src/native/index.js'
import { startFixtureRelay } from '../../helpers/remote-relay.js'
import { phoneCatalog } from '../../../src/features/remote/catalog.js'
import { directoryGroups, hasOpenWindow, openPlace, windowStatusLabel } from '../../../src/features/remote/phone-directory.js'
import { profileKey, registerTerminal, type SessionBadge } from '../../../src/features/remote/discovery.js'
import { phoneWorkspace } from '../../../src/features/remote/workspace.js'
import legacyCatalog from '../../fixtures/contracts/remote-session-list-legacy.json'

test('the drawer keeps chronological groups even for running work and omits anonymous window placeholders', () => {
  const now = new Date(2026, 8, 18, 12).getTime(), day = 86400000
  const data = {
    rows: [
      {session:'working', terminal:'live', phase:'working', updatedAt:now - day},
      {session:'yesterday', terminal:'idle', phase:'idle', updatedAt:now - day},
      {session:'saved', updatedAt:now},
      {session:'open', terminal:'open', phase:'idle', updatedAt:now - 60000},
    ],
    privateWindows:[{phase:'idle', updatedAt:now}],
  }
  const options = {now}
  const groups = directoryGroups(data, '', options)
  expect(groups.map(({title, rows}) => [title, rows.map(r => r.session)])).toEqual([
    ['Today', ['saved', 'open']], ['Yesterday', ['working', 'yesterday']],
  ])
  expect(groups[1].rows[0].timeLabel).toBe(`Yesterday · ${localClock(now - day)}`)
  expect(directoryGroups(data, 'work', options).flatMap(group => group.rows.map(row => row.session)))
    .toEqual(['saved', 'open', 'working', 'yesterday'])
})

test('the drawer preserves live statuses without exposing an older window as a selectable session', () => {
  const now = Date.UTC(2026, 8, 18, 12)
  const data = {
    rows: [
      { terminal:'bg', phase:'working', runState:'waiting-background', updatedAt:now, completed:true },
      { terminal:'retry', phase:'working', runState:'retrying', updatedAt:now },
      { terminal:'ask', phase:'input', updatedAt:now },
      { session:'unshared', unshared:true, updatedAt:now },
    ],
    privateWindows: [{ phase:'working', updatedAt:now }],
  }
  const [today] = directoryGroups(data, '', {now})
  expect(today.key).toBe('today')
  expect(today.rows.map(windowStatusLabel)).toEqual(['Background task', 'Retrying', 'Needs input', 'Open, not shared'])
  expect(today.rows.every(hasOpenWindow)).toBe(true)
})

const localClock = (instant: number) =>
  Intl.DateTimeFormat(undefined, {hour:'2-digit', minute:'2-digit', hourCycle:'h23'}).format(instant)

test('session times and day labels follow midnight on the phone for epoch and ISO timestamps', () => {
  const now = new Date(2027, 0, 1, 0, 2).getTime()
  const recent = now - 5 * 60000, older = new Date(2026, 11, 30, 12).getTime()
  const data = {
    rows: [{updatedAt:now}, {updated:new Date(recent).toISOString()}, {updatedAt:older}, {updated:'unknown'}],
    privateWindows: [{updatedAt:recent}],
  }
  const groups = directoryGroups(data, '', {now})
  expect(groups.map(({title,rows}) => [title, rows.map(r => r.age)])).toEqual([
    ['Today', ['00:02']],
    ['Yesterday', ['23:57']],
    ['Earlier', [`${Intl.DateTimeFormat(undefined, {year:'numeric',month:'short',day:'numeric'}).format(older)} · 12:00`]],
    ['Other', ['']],
  ])
  expect(groups[1].rows[0].timeLabel).toBe(`Yesterday · ${localClock(recent)}`)
})

test('yesterday is a local calendar day even after the spring DST transition', () => {
  const now = new Date(2026, 2, 9, 0, 30).getTime()
  const yesterday = new Date(2026, 2, 8, 12).getTime()
  const rows = [{updatedAt:yesterday}]
  expect(directoryGroups({rows}, '', {now})).toEqual([
    {key:'yesterday', title:'Yesterday', rows:[expect.objectContaining({age:localClock(yesterday)})]},
  ])
})

test('an idle window the phone opened reads as a saved session; a busy one and a local one stay open', () => {
  const now = Date.UTC(2026, 8, 18), stamp = (minutes: number) => now - minutes * 60000
  const window = (session: string, phase: SessionBadge['phase'], phoneCreated: boolean, minutes: number) =>
    ({ session, phase, phoneCreated, terminal: crypto.randomUUID(), workspace: 'w', title: session, updatedAt: stamp(minutes) })
  const live = [window('parked', 'idle', true, 1), window('phone-running', 'working', true, 5), window('local', 'idle', false, 9), window('viewed', 'idle', true, 2)]
  const saved = { session_id: 'saved', cwd: '/w', updated_at: new Date(stamp(30)).toISOString(), turns: 2 } as SessionMeta
  const page = phoneCatalog([saved], live, { limit: 10, query: '' })
  expect(page.rows.map(r => [r.session, windowStatusLabel(r)])).toEqual([
    ['parked', 'Saved'], ['viewed', 'Saved'], ['phone-running', 'Running'], ['local', 'Open'], ['saved', 'Saved']])
  expect(page.rows.filter(hasOpenWindow).map(r => r.session)).toEqual(['phone-running', 'local'])
  // Still followable: tapping a parked row attaches to its window instead of starting another.
  expect(page.rows.find(r => r.session === 'parked')?.terminal).toBe(live[0]!.terminal)
  expect(page.online).toHaveLength(4)
})

test('the completion mark is additive to the legacy catalog, including for a parked window', () => {
  const window = { ...legacyCatalog.online[0]!, phase:'idle' as const }
  const page = { limit:40, query:'' }
  expect(windowStatusLabel(legacyCatalog.rows[0])).toBe('Open')
  expect(JSON.parse(JSON.stringify(phoneCatalog([], [window], page)))).toEqual(legacyCatalog)

  const catalog = phoneCatalog([], [{ ...window, completed:true }], page)
  expect(windowStatusLabel(catalog.rows[0])).toBe('Completed')
  // The old drawer still sees an idle, followable window with the same target.
  const { completed, ...legacyRow } = JSON.parse(JSON.stringify(catalog)).rows[0]
  expect(completed).toBe(true)
  expect(legacyRow).toEqual(legacyCatalog.rows[0])

  const parked = phoneCatalog([], [{ ...window, completed:true, phoneCreated:true }], page).rows[0]!
  expect(parked).toMatchObject({ parked:true, terminal:window.terminal })
  expect(windowStatusLabel(parked)).toBe('Completed')
})

test('the gateway badge follows the hosted session without changing order or the preferred follow target', () => {
  const host = {...legacyCatalog.online[0]!, phase:'idle' as const, gateway:true}
  const mirror = {...host, terminal:'mirror', gateway:false, phase:'working' as const}
  const other = {...host, session:'s2', terminal:'other', gateway:false, updatedAt:host.updatedAt + 1}
  const page = {limit:40, query:''}
  const rows = phoneCatalog([], [host, mirror, other], page).rows
  expect(rows.map(r=>[r.terminal,r.gateway])).toEqual([['other',undefined],['mirror',true]])
  const moved = phoneCatalog([], [{...host,gateway:false}, mirror, {...other,gateway:true}], {...page,query:'gateway'}).rows
  expect(moved.map(r=>r.terminal)).toEqual(['other'])
  // A legacy reader still sees the same idle, followable row; old catalogs need no badge.
  const {gateway,...legacyRow} = JSON.parse(JSON.stringify(phoneCatalog([], [host], page))).rows[0]
  expect(gateway).toBe(true); expect(legacyRow).toEqual(legacyCatalog.rows[0])
})

test('an empty shared gateway is discoverable without exposing other unused windows', () => {
  const empty = {...legacyCatalog.online[0]!,session:'',title:'New conversation',hasConversation:false,phase:'idle' as const,phoneCreated:true}
  const host = {...empty,gateway:true}, page = {limit:40,query:'gateway'}
  const list = phoneCatalog([], [host,{...empty,terminal:'unused'}],page)
  expect(list.rows).toHaveLength(1); expect(list.rows[0]).toMatchObject({terminal:host.terminal,gateway:true})
  expect(list.rows[0]?.parked).toBeUndefined()
  expect(phoneCatalog([], [empty],page).rows).toEqual([])
})

test('open rows carry only an icon place: tmux when the window says so, a visible terminal otherwise', () => {
  const window = { ...legacyCatalog.online[0]!, phase:'idle' as const }
  const page = { limit:40, query:'' }
  // A legacy window without the field renders exactly as before, as an ordinary open window.
  expect(openPlace(legacyCatalog.rows[0])).toBe('desktop')
  const tmux = phoneCatalog([], [{ ...window, tmux:true }], page).rows[0]!
  const { tmux: flag, ...legacyRow } = JSON.parse(JSON.stringify(tmux))
  expect(flag).toBe(true)
  expect(legacyRow).toEqual(legacyCatalog.rows[0])
  expect(openPlace(tmux)).toBe('tmux')
  // An idle phone-opened window is listed as saved: no icon, and no stale tmux flag.
  const parked = phoneCatalog([], [{ ...window, tmux:true, phoneCreated:true }], page).rows[0]!
  expect([parked.tmux, openPlace(parked)]).toEqual([undefined, null])
  expect(openPlace({ session:'saved', updated:'2026-09-18T12:00:00.000Z' })).toBeNull()
  expect(openPlace({ kind:'private' })).toBe('desktop')
})

test('empty windows stay discoverable but do not take slots; a first real prompt counts even before save', () => {
  const old = {...legacyCatalog.online[0]!,phase:'idle' as const}
  const live = [
    {...old,terminal:'fresh',session:'',title:'New conversation'},
    {...old,terminal:'placeholder',title:`Session ${old.session}`},
    {...old,terminal:'hosting',hasConversation:false,title:'Hosting services',phase:'busy' as const},
    {...old,terminal:'first-turn',session:'',hasConversation:true,title:'New conversation'},
  ]
  const empty = {session_id:'occupied-empty',turns:0,cwd:'/fixture'} as SessionMeta
  const page = phoneCatalog([empty],live,{limit:1,query:''},new Set([empty.session_id]))
  expect(page.online).toHaveLength(4)
  expect(page).toMatchObject({count:1,more:false,rows:[{terminal:'first-turn'}]})
  expect(phoneCatalog([empty],live,{limit:1,query:'Hosting'}).count).toBe(0)
  const {hasConversation,...legacyBadge} = phoneCatalog([],[{...old,hasConversation:true}],{limit:1,query:''}).online[0]!
  expect(hasConversation).toBe(true); expect(legacyBadge).toEqual(old)
})

test('a legacy idle window replaying old history does not outrank a newer saved conversation', () => {
  const w = {...legacyCatalog.online[0]!,phase:'idle' as const}
  const saved = {session_id:w.session,turns:1,cwd:'/test',updated_at:'2026-01-01T00:00:00Z'} as SessionMeta
  const newer = {...saved,session_id:'newer',updated_at:'2026-01-02T00:00:00Z'}
  expect(phoneCatalog([saved,newer],[w],{limit:2,query:''}).rows.map(r=>r.session)).toEqual(['newer',w.session])
})

test('blank first-run metadata does not hide the live opening title in Sessions or search', () => {
  const window = { terminal: 'phone', session: 's', workspace: 'w', phase: 'working' as const, title: 'Plan the migration' }
  const saved = { session_id: 's', cwd: '/w', turns: 0 } as SessionMeta
  const page = phoneCatalog([saved], [window], { limit: 10, query: 'migration' })
  expect(page.rows[0]?.title).toBe(window.title)
  expect(page.online[0]?.title).toBe(window.title)
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

test('one profile-wide list sorts all sessions by activity, hides unused drafts and paginates after ranking', async () => {
  const home = '/fixture/' + crypto.randomUUID(), cwd = '/code/a/project', other = '/code/b/project'
  const rows = [
    {session_id:'elsewhere', cwd:other, title:'Outside', turns:3},
    {session_id:'empty', cwd, title:'Opened, never used', turns:0},
    {session_id:'branch', parent_session_id:'parent', cwd, title:'Fork title', turns:1, updated_at:'2026-01-03T00:00:00Z'},
    {session_id:'active', cwd, title:'Automatic title', custom_title:'  Renamed\n  session  ', turns:0},
    {session_id:'parent', cwd, title:'Original … latest', turns:2, updated_at:'2026-01-01T00:00:00Z'},
    {session_id:'private', cwd:'/secret', title:'hidden title', turns:1},
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
    expect(result.rows[2]).toMatchObject({session:'active',title:'Renamed session',phase:'working',terminal:owner.id})
    expect(result.online.filter(w=>w.session === 'active').map(w=>w.title)).toEqual(['Renamed session','Renamed session'])
    expect(result.rows.map(r=>r.session)).toEqual(['branch','parent','active','elsewhere','private'])
    expect(result.rows[4]).toMatchObject({session:'private', title:'hidden title', unshared:true})
    expect(result.rows[4]!.terminal).toBeUndefined()
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
    expect((await ws.catalog({...page,query:'outside'})).rows).toEqual([result.rows[3]!])
    expect(JSON.stringify(result)).not.toMatch(/Stale snippet|never used/)
    expect(JSON.stringify(result.online)).not.toMatch(/secret|hidden/)
  } finally { owner.close(); sibling.close(); hidden.close(); mirror.close() }
})

test('unsaved conversations appear immediately and newer activity wins before pagination', () => {
  const w = (terminal:string, phase:'working'|'idle', updatedAt:number) => ({terminal, phase, updatedAt, session:'', workspace:'scratch', title:terminal})
  const live = [w('open-new', 'idle', 90), w('run-old', 'working', 1), w('open-old', 'idle', 80), w('run-new', 'working', 2)]
  const page = {limit:3, query:''}
  const first = phoneCatalog([], live, page)
  expect(first.count).toBe(4)
  expect(first.rows.map(r=>r.terminal)).toEqual(['open-new','open-old','run-new'])
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
    gateway.share(scope)
    expect((await ws.catalog({query:'remote gateway',limit:40})).rows.map(r=>[r.terminal,r.gateway])).toEqual([[gateway.id,true]])
    gateway.share(null)
    expect((await ws.catalog({query:'remote gateway',limit:40})).rows).toEqual([])
    gateway.route('other'); expect(JSON.stringify(await ws.catalog({query:'',limit:40}))).not.toContain('private-')
    gateway.route(null); gateway.share(scope); expect((await ws.list(true)).online.some(t=>t.terminal===window.id)).toBe(false)
    gateway.route(scope); window.share(null)
    expect(JSON.stringify(await ws.list(true))).not.toContain('private-')
    expect((await gateway.request(window.id,'/state')).status).toBe(403)
  } finally { release(); gateway.close(); window.close() }
})
