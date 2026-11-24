import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sharingScope } from '../../../src/features/remote/transport.js'
import { DeviceStore } from '../../../src/features/remote/devices.js'
import { testDevice } from '../../helpers/remote-device.js'
import { privateSocketDirectory } from '../../../src/features/remote/discovery.js'
import type { SessionMeta } from '../../../src/native/index.js'
import type { PhoneWorkspace } from '../../../src/features/remote/workspace.js'
import { windowStatusLabel } from '../../../src/features/remote/phone-directory.js'
import { createReplState } from '../../../src/term/host/state.js'
import { createRemoteController, type RemoteDeps } from '../../../src/term/host/remote.js'
import { createActivityController, type ActivityDeps } from '../../../src/term/host/activity.js'
import { RunInteraction } from '../../../src/term/app/run/run-interaction.js'
import { createAskController, type AskDeps } from '../../../src/term/host/ask.js'
import { createStreamMachineState } from '../../../src/term/app/run/stream.js'
import { RunOwnership } from '../../../src/term/app/run/run-ownership.js'
import { createModelSelectionController, type ModelSelectionDeps } from '../../../src/term/host/model-selection.js'
import { ConversationTail } from '../../../src/term/app/remote/conversation.js'
import { getEditorText, insertText } from '../../../src/term/input/editor.js'

function harness(findSession: (id: string) => Promise<SessionMeta | null> = async () => null, listSessions: () => Promise<SessionMeta[]> = async () => []) {
  const st = createReplState('fixture','/fixture')
  const runOwnership = new RunOwnership(), calls: string[] = []
  const askDeps = {sessionHook:{ state() {} }, renderer:{ requestRender() {} }, freezeTerminalTitle() {}, unfreezeTerminalTitle() {}, scrollback:{commitLines() {}}} as unknown as AskDeps
  const asks = createAskController(st, askDeps)
  st.configInfo = {provider:'local', protocol:'openai', envPath:'/private/settings', hasApiKey:true, baseUrl:'https://private.invalid', thinkingLevel:'low',
    availableModels:['fixture','another'].map(model => ({spec:'local:'+model,provider:'local',model,thinking_levels:['low','high']}))}
  const modelSelection = createModelSelectionController(st, {
    agent:{setProvider(){}, setThinkingLevel:(level:string) => { st.configInfo!.thinkingLevel = level; return level }},
    runCtl:{requestModelHandoff:(spec:string,effort?:string) => { st.pendingModelHandoff = {spec,effort,submitted:true}; return true }},
    renderer:{requestRender(){}}, refreshConfigInfo(){}, scrollback:{commitStatusLine(){}},
  } as unknown as ModelSelectionDeps)
  const activity = createActivityController(st, {manualCompaction:{active:false},loopSession:{waiting:false},runInteraction:new RunInteraction(),
    awaitedTaskSummary:()=>undefined, runInteractionInput:()=>({active:st.isLoading,phase:st.spinnerState.phase,owner:1,backgroundTasks:st.backgroundWaitSince !== null ? 1 : 0}),
  } as unknown as ActivityDeps)
  const remote = createRemoteController(st, { activity, asks, agent:{cwd:'/fixture',findSession,listSessions,listSessionsWithText:async()=>[],deleteSession:async()=>true,cloudUnshareSession:async()=>{}}, cloudSessions:{remoteFor:()=>undefined,forget(){}}, resumeCache:{remove(){}}, gitInfo:{getBranch:()=>'main'}, readAuthIdentity:()=>null, rendererTrace:{isEnabled:false}, scrollback:{commitLocalNotice(){}}, modelSelection, runOwnership, backgroundTerminals:{presentation:()=>undefined},composer:{toggleExpanded(){st.expanded=!st.expanded}, mutateEditor:(f:(e:typeof st.editor)=>typeof st.editor)=>{st.editor=f(st.editor)}}, pendingImages:{awaiting:false},
    submit:{ submitConversationText:(text:string, steer:boolean) => calls.push(steer ? 'steer:'+text : 'send:'+text) },
    runCtl:{ runInteractionInput:()=>({active:st.isLoading,owner:1,phase:st.spinnerState.phase,backgroundTasks:st.backgroundWaitSince !== null ? 1 : 0}), interruptStream:() => { runOwnership.revoke(); asks.resolvePendingAsk(); calls.push('stop') } },
  } as unknown as RemoteDeps)
  function run() { st.isLoading = true; st.streamMachine = createStreamMachineState(st.appState,st.spinnerState); return runOwnership.begin() }
  return {st,remote,asks,run,calls}
}

test('three open Mac sessions retain their picker titles/order as each terminal changes state or closes', async () => {
  const rows = ['alpha','beta','gamma'].map((session_id,i) => ({session_id, cwd:'/fixture', title:`First ${i} … latest ${i}`, turns:1,
    custom_title:i === 1 ? ' Renamed   session ' : undefined} as SessionMeta))
  const byId = async (id: string) => rows.find(m => m.session_id === id) ?? null
  const peers = rows.map(m => { const peer = harness(byId,async()=>rows); peer.st.sessionId = m.session_id; return peer })
  const home = mkdtempSync(join(tmpdir(),'evot-profile-')), prev = process.env.EVOT_HOME, local = process.env.EVOT_REMOTE_LOCAL_TEST
  const scope = sharingScope(home, '/private/settings', 'local')
  try {
    process.env.EVOT_HOME = home
    process.env.EVOT_REMOTE_LOCAL_TEST = '1'
    const [a,b,c] = peers
    const device = await testDevice()
    new DeviceStore(join(home,'remote',scope)).approve(device.key) // pre-existing grant in a new fixture profile
    a.remote.register(); b.remote.register()
    await a.remote.command('') // the only /remote; c starts after the gateway
    const gateway = a.st.remoteListener!, address = gateway.address
    c.remote.register()
    const post = (path:string, body:unknown) => fetch(address+path,{method:'POST',headers:{origin:address,'Content-Type':'application/json'},body:JSON.stringify(body)})
    expect((await fetch(address+'/sessions?catalog')).status).toBe(401)
    // A new phone's request lands in the gateway composer as a draft; a draft in progress is left alone.
    const stranger = await testDevice(), knock = async () => {
      const c = await (await post('/device/challenge',{key:stranger.key})).json() as {nonce:string}
      return await (await post('/device/prove',{nonce:c.nonce,signature:await stranger.sign(c.nonce)})).json() as {code:string}
    }
    const first = await knock()
    expect(getEditorText(a.st.editor)).toBe(`/remote approve ${first.code}`)
    expect(a.st.editor.cursorCol).toBe(`/remote approve ${first.code}`.length)
    a.st.editor = insertText({...a.st.editor, lines:[''], cursorLine:0, cursorCol:0}, 'my draft')
    expect(a.remote.snapshot().title).toBeDefined(); await a.remote.command(`deny ${first.code}`)
    const second = await knock(); expect(second.code).not.toBe(first.code)
    expect(getEditorText(a.st.editor)).toBe('my draft')
    await a.remote.command(`deny ${second.code}`); a.st.editor = {...a.st.editor, lines:[''], cursorLine:0, cursorCol:0}
    const challenge = await (await post('/device/challenge',{key:device.key})).json() as {nonce:string}
    const proof = await (await post('/device/prove',{nonce:challenge.nonce,signature:await device.sign(challenge.nonce)})).json() as {token:string}
    expect(typeof proof.token).toBe('string')
    const headers = {authorization:`Bearer ${proof.token}`}
    const state = (peer:typeof a) => fetch(address+'/state',{headers:{...headers,'X-Evot-Terminal':peer.st.terminalBus!.id}})
    for (const p of peers) expect(await (await state(p)).json()).toMatchObject({sessionId:p.st.sessionId, place:{name:'fixture', path:'/fixture', branch:'main'}})
    // Folder picker: the gateway cwd and every saved session's cwd, by opaque id; a phone cannot name a path.
    const folders = await (await fetch(address+'/folders',{headers})).json() as {folders:{id:string,name:string,path:string}[]}
    expect(folders.folders.map(f=>[f.name,f.path,f.id.length])).toEqual([['fixture','/fixture',20]])
    const badFolder = await fetch(address+'/open',{method:'POST',headers:{...headers,origin:address,'Content-Type':'application/json'},body:JSON.stringify({session:null,requestId:crypto.randomUUID(),folder:'/etc'})})
    expect(badFolder.status).toBe(400)
    const unknownFolder = await fetch(address+'/open',{method:'POST',headers:{...headers,origin:address,'Content-Type':'application/json'},body:JSON.stringify({session:null,requestId:crypto.randomUUID(),folder:'f'.repeat(20)})})
    expect(unknownFolder.status).toBe(409)
    const follow = await fetch(address+'/open',{method:'POST',headers:{...headers,origin:address,'Content-Type':'application/json'},body:JSON.stringify({session:'beta',requestId:crypto.randomUUID()})})
    expect(await follow.json()).toEqual({terminal:b.st.terminalBus!.id}) // attach, don't resume a duplicate
    b.run(); c.run(); const answer = c.asks.collectAskUserAnswers({questions:[{header:'test',question:'Synthetic question?',options:[]}]})
    const list = async () => {
      const r = await fetch(address+'/sessions?catalog&limit=40', {headers})
      expect(r.status).toBe(200)
      return await r.json() as Awaited<ReturnType<PhoneWorkspace['catalog']>>
    }
    // Work in progress leads, idle windows follow, saved history ends the list; titles come from metadata.
    const byTitle = (page: Awaited<ReturnType<typeof list>>) => Object.fromEntries(page.rows.map(r=>[r.title, windowStatusLabel(r)]))
    const before = await list()
    expect(before.online).toHaveLength(3)
    expect(byTitle(before)).toEqual({'First 0 … latest 0':'Open', 'Renamed session':'Running', 'First 2 … latest 2':'Needs input'})
    expect(before.rows.map(windowStatusLabel)[2]).toBe('Open')
    b.st.conversationTail.append('user','Not my title'); expect(b.remote.snapshot().title).toBe('Renamed session')
    c.asks.resolvePendingAsk(); await answer; c.st.overlay = {kind:'none'}
    b.st.spinnerState.phase = 'retrying'; a.st.overlay = {kind:'help'}
    const after = await list()
    expect(byTitle(after)).toEqual({'First 0 … latest 0':'Busy on Mac', 'Renamed session':'Retrying', 'First 2 … latest 2':'Running'})
    expect(after.rows[0]!.title).toBe('Renamed session') // latest activity among active windows
    b.remote.dispose(); a.st.overlay = {kind:'none'}; c.st.isLoading = false; c.st.backgroundWaitSince = Date.now()
    const closed = await list()
    expect(closed.rows.map(r=>[r.title,windowStatusLabel(r)])).toEqual([['First 2 … latest 2','Background task'], ['First 0 … latest 0','Open'], ['Renamed session','Saved']])
    expect(closed.online).toHaveLength(2)
    await c.remote.command('off'); expect((await state(c)).status).toBe(403)
    await a.remote.command('off'); expect((await state(a)).status).toBe(409)
    const hidden = await list(); expect(hidden.online).toHaveLength(0)
    // Windows that stopped sharing stay listed from saved metadata, status only, ahead of plain history.
    expect(hidden.rows.map(r=>[r.session, windowStatusLabel(r), r.unshared ?? false, r.terminal])).toEqual([['alpha','Open on Mac',true,undefined],['gamma','Open on Mac',true,undefined],['beta','Saved',false,undefined]])
    const open = await fetch(address+'/open',{method:'POST',headers:{...headers,origin:address,'Content-Type':'application/json'},body:JSON.stringify({session:'gamma',requestId:crypto.randomUUID()})})
    expect(open.status).toBe(409) // hidden session cannot be resumed as a second process
    b.remote.register(); expect((await state(b)).status).toBe(200) // hidden gateway still serves new windows
    await c.remote.command(''); expect((await state(c)).status).toBe(200)
    await a.remote.command('shutdown'); expect(a.st.remoteListener).toBeNull()
    expect(gateway.active()).toBe(false)
    expect(gateway.access.authorized(headers.authorization)).toBe(false)
    expect((await a.st.terminalBus!.request(b.st.terminalBus!.id,'/state')).status).toBe(403)
  } finally {
    for (const p of peers) p.remote.dispose()
    if (prev === undefined) delete process.env.EVOT_HOME; else process.env.EVOT_HOME = prev
    if (local === undefined) delete process.env.EVOT_REMOTE_LOCAL_TEST; else process.env.EVOT_REMOTE_LOCAL_TEST = local
    rmSync(privateSocketDirectory(home), {recursive:true, force:true}); rmSync(home, {recursive:true, force:true})
  }
})

test('a late title lookup never names the next window session; the transcript never supplies the title', async () => {
  let reads = 0
  const {promise,resolve} = Promise.withResolvers<SessionMeta | null>()
  const {st,remote} = harness(async id => { reads++; return id === 'a' ? promise : {session_id:id,title:'From metadata'} as SessionMeta })
  st.sessionId = 'a'; st.conversationTail.append('user','A moving tail')
  expect(remote.snapshot().title).toBe('(untitled)'); remote.snapshot(); expect(reads).toBe(1)
  st.sessionId = 'b'; remote.snapshot(); resolve({session_id:'a',title:'Previous title'} as SessionMeta)
  await Bun.sleep(0)
  expect(remote.snapshot().title).toBe('From metadata'); expect(reads).toBe(2)
  st.sessionId = null; expect(remote.snapshot().title).toBe('New conversation')
})

test('actions target the observed turn, never a successor or a local setup dialog', async () => {
  const {st,remote,asks,run,calls} = harness(), generation = run()
  const qs = [{ header:'Scope', question:'Which change?', options:[{label:'Small',description:'Few files'}] }]
  const waiting = asks.collectAskUserAnswers({questions:qs}), id = remote.snapshot().ask!.id
  remote.act({ kind:'answer', generation, id, answers:['Small'] })
  expect(await waiting).toEqual([{header:'Scope',question:'Which change?',answer:'Small'}]); expect(st.overlay.kind).toBe('none')
  const again = asks.collectAskUserAnswers({questions:qs}), newId = remote.snapshot().ask!.id
  expect(newId).not.toBe(id)
  expect(() => remote.act({ kind:'answer', generation, id, answers:['Large'] })).toThrow()
  expect(() => remote.act({ kind:'answer', generation, id:newId, answers:[] })).toThrow()
  remote.act({ kind:'stop', generation }); expect(await again).toBeNull(); expect(calls).toEqual(['stop'])
  const next = run(); expect(() => remote.act({kind:'stop',generation})).toThrow()
  const local = asks.presentAskQuestions(qs,'idle',true)
  expect(remote.snapshot()).toMatchObject({ask:null,input:null,canStop:false}); expect(() => remote.act({kind:'stop',generation:next})).toThrow()
  asks.resolvePendingAsk(); await local
})

test('ordered snapshots use the TUI card, only serializing its displayed text and tone', () => {
  const {st,remote,run,calls} = harness()
  remote.act({kind:'send',generation:0,text:'start'}); expect(() => remote.act({kind:'send',generation:0,text:'/clear'})).toThrow()
  const generation = run(); st.streamMachine!.activeLlmCall = true
  st.appState.currentAssistantContent = [{type:'thinking',contentIndex:0,text:'Visible reasoning'}, {type:'text',contentIndex:1,text:'public text'},
    {type:'tool_call',contentIndex:2,toolCall:{name:'read',id:'1',args:{path:'fixture.ts',privateField:'private-arg'},progress:'reading\nfixture',result:'private-result',status:'running'}}]
  remote.act({kind:'steer',generation,text:'shorter'}); expect(calls).toEqual(['send:start','steer:shorter'])
  expect(() => remote.act({kind:'send',generation,text:'wrong mode'})).toThrow()
  expect(remote.snapshot()).toMatchObject({live:'public text',liveBlocks:[{kind:'thinking',text:'Visible reasoning'},{kind:'text',text:'public text'},{kind:'tool',state:'pending',text:expect.stringContaining('fixture.ts')}]})
  expect(JSON.stringify(remote.snapshot())).not.toContain('private-')
  remote.act({kind:'tool-view',expanded:true,generation}); expect(st.expanded).toBe(true)
  expect(remote.snapshot().liveBlocks?.at(-1)?.text).toContain('reading')
})

test('paired picker selects only advertised models and tiers, synchronizes both ways and distinguishes a pending handoff', () => {
  const {st,remote,run} = harness()
  const start = remote.snapshot().models
  const change = {kind:'select-model' as const, generation:0, spec:'local:another', effort:'high', revision:start.revision}
  expect(() => remote.act({...change,spec:'unknown:route'})).toThrow()
  expect(() => remote.act({...change,effort:'not-a-tier'})).toThrow()
  remote.act(change); expect(st.appState.model).toBe('another'); expect(st.configInfo?.thinkingLevel).toBe('high')
  expect(() => remote.act(change)).toThrow(); expect(JSON.stringify(start)).not.toContain('private')
  // Local TUI picks and live model/effort changes feed the same snapshot.
  st.appState.model = 'fixture'; st.configInfo!.thinkingLevel = 'low'
  const before = remote.snapshot().models; expect(before.active).toBe('local:fixture')
  const generation = run(); remote.act({...change, generation, revision:before.revision})
  expect(remote.snapshot().models).toMatchObject({active:'local:fixture',pending:{spec:'local:another',effort:'high'}})
})

test('status mirrors the spinner even while input is locked; waits do not pretend to generate', () => {
  const {st,remote,run} = harness(); run(); st.overlay = {kind:'help'}
  st.spinnerState = {...st.spinnerState,phase:'thinking',tokenCount:12}; st.streamMachine!.activeLlmCall = true
  expect(remote.snapshot()).toMatchObject({input:null,status:'Thinking…',active:true}); expect(remote.snapshot().statusDetail).toContain('12')
  st.spinnerState = {...st.spinnerState, phase:'retrying',retryAttempt:2,retryMaxAttempts:5,waitRetryAt:Date.now()+5000}
  expect(remote.snapshot().status).toContain('attempt 2/5'); expect(remote.snapshot().statusDetail).not.toContain('tokens')
  st.overlay = {kind:'none'}; st.isLoading = false; st.streamMachine = null; st.backgroundWaitSince = Date.now()-25_000
  expect(remote.snapshot()).toMatchObject({status:'Background task running · resumes when finished',canStop:false,active:true})
})

test('replaying a new session replaces, rather than splices, its bounded conversation tail', () => {
  const history = new ConversationTail(); history.append('user','old session')
  history.replace([{id:'s',timestamp:0,role:'system',text:'private notice'}, {id:'u',timestamp:1,role:'user',text:'new conversation'}]);
  expect(history.messages).toEqual([{role:'user',text:'new conversation'}])
  for (let i=0;i<40;i++) history.append('assistant','x'.repeat(9000))
  expect(history.messages.length).toBe(32); expect(history.messages[0]?.text.length).toBeLessThan(9000)
})
