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
import { PendingQueue, currentQueueTarget } from '../../../src/term/app/queue/pending-queue.js'
import { draft, queueFixture } from '../../helpers/prompt-queue.js'
import { ConversationTail } from '../../../src/term/app/remote/conversation.js'
import { commandChoices, phoneShortcut } from '../../../src/features/remote/phone-commands.js'
import type { RemoteSnapshot } from '../../../src/features/remote/protocol.js'
import legacyComposer from '../../fixtures/contracts/remote-composer-legacy.json'
import { getEditorText, insertText } from '../../../src/term/input/editor.js'
import { PARKED_CHECK_MS, PARKED_EXIT_MS, parkedExpired, tmuxAttached } from '../../../src/term/app/remote/parked-exit.js'
import { PromptSuggestion } from '../../../src/term/app/suggestion/controller.js'
import { context as suggestionContext } from '../../helpers/suggestion-context.js'
import type { SuggestionOutcome } from '../../../src/native/contracts/ports.js'
import { inlineSuggestion } from '../../../src/features/remote/phone-composer-keys.js'

function harness(findSession: (id: string) => Promise<SessionMeta | null> = async () => null, listSessions: () => Promise<SessionMeta[]> = async () => []) {
  const st = createReplState('fixture','/fixture')
  const runOwnership = new RunOwnership(), calls: string[] = []
  let request = Promise.withResolvers<SuggestionOutcome>()
  const suggestions = new PromptSuggestion({
    key: () => 'fixture', eligible: () => true, draft: () => getEditorText(st.editor), context: suggestionContext, changed() {},
    start() {
      calls.push('suggest'); request = Promise.withResolvers<SuggestionOutcome>()
      const { promise } = request
      return { abort() {}, outcome: () => promise, result: async () => (await promise).candidates[0] ?? null }
    },
  })
  async function finishSuggestion(candidates: string[]) {
    request.resolve({ status: candidates.length ? 'ready' : 'empty', candidates }); await new Promise(resolve => setImmediate(resolve))
  }
  const submissions: Parameters<RemoteDeps['submit']['submitConversationText']>[] = []
  const askDeps = {sessionHook:{ state() {} }, renderer:{ requestRender() {} }, freezeTerminalTitle() {}, unfreezeTerminalTitle() {}, scrollback:{commitLines() {}, commitSystem() {}}} as unknown as AskDeps
  const asks = createAskController(st, askDeps)
  st.configInfo = {provider:'local', protocol:'openai', envPath:'/private/settings', hasApiKey:true, baseUrl:'https://private.invalid', thinkingLevel:'low',
    availableModels:['fixture','another'].map(model => ({spec:'local:'+model,provider:'local',model,thinking_levels:['low','high']}))}
  const modelSelection = createModelSelectionController(st, {
    agent:{setProvider(){}, setThinkingLevel:(level:string) => { st.configInfo!.thinkingLevel = level; return level }},
    runCtl:{requestModelHandoff:(spec:string,effort?:string) => { st.pendingModelHandoff = {spec,effort,submitted:true}; return true }},
    renderer:{requestRender(){}}, refreshConfigInfo(){}, scrollback:{commitStatusLine(){}},
  } as unknown as ModelSelectionDeps)
  const pendingQueue = new PendingQueue(st.pendingQueue)
  const shells = { target:'["fixture",["a"]]', afterRefresh:'' }
  const runInteractionInput = () => ({active:st.isLoading, phase:st.spinnerState.phase, owner:1,
    backgroundTasks:st.backgroundWaitSince !== null ? 1 : 0, backgroundOwner:shells.target})
  const activity = createActivityController(st, {manualCompaction:{active:false},loopSession:{waiting:false},runInteraction:new RunInteraction(),
    awaitedTaskSummary:()=>undefined, runInteractionInput,
  } as unknown as ActivityDeps)
  const remote = createRemoteController(st, { activity, asks, pendingQueue, suggest:{suggestionInputReady:()=>true}, queueLifecycle:{reconcile(){ if (st.streamRef) pendingQueue.reconcile(st.streamRef) }}, agent:{cwd:'/fixture',findSession,listSessions,listSessionsWithText:async()=>[],deleteSession:async()=>true,cloudUnshareSession:async()=>{}}, cloudSessions:{remoteFor:()=>undefined,forget(){}}, resumeCache:{remove(){}}, suggestions, gitInfo:{getBranch:()=>'main'}, replCommands:{commitLines(){}, replaceLine:()=>true, requestRender(){}}, readAuthIdentity:()=>null, rendererTrace:{isEnabled:false}, scrollback:{commitLocalNotice(){}}, modelSelection, runOwnership, backgroundTerminals:{presentation:()=>undefined,
      stopTarget:()=>shells.target,
      refresh:()=>{if (shells.afterRefresh) shells.target = shells.afterRefresh}, stopAll:(target:string)=>calls.push('stop:'+target)},composer:{cycleThinkingLevel(){calls.push('cycle'); return true}, toggleExpanded(){st.expanded=!st.expanded}, mutateEditor:(f:(e:typeof st.editor)=>typeof st.editor)=>{st.editor=f(st.editor)}}, pendingImages:{awaiting:false},
    exitAfterCleanup:(code:number) => calls.push('exit:'+code),
    submit:{ submitConversationText:(...args: Parameters<RemoteDeps['submit']['submitConversationText']>) => {
      submissions.push(args); calls.push(args[1] + ':' + args[0])
    } },
    runCtl:{ runInteractionInput, interruptStream:() => { runOwnership.revoke(); asks.resolvePendingAsk(); st.isLoading = false; st.streamMachine = null; calls.push('stop') } },
  } as unknown as RemoteDeps)
  function run() { st.isLoading = true; st.streamMachine = createStreamMachineState(st.appState,st.spinnerState); return runOwnership.begin() }
  return {st,remote,asks,run,calls,submissions,shells,pendingQueue,suggestions,finishSuggestion}
}

test('three open sessions retain their picker titles/order as each terminal changes state or closes', async () => {
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
    expect(byTitle(after)).toEqual({'First 0 … latest 0':'Busy', 'Renamed session':'Retrying', 'First 2 … latest 2':'Running'})
    expect(after.rows[0]!.title).toBe('Renamed session') // latest activity among active windows
    b.remote.dispose(); a.st.overlay = {kind:'none'}; c.st.isLoading = false; c.st.backgroundWaitSince = Date.now()
    const closed = await list()
    expect(closed.rows.map(r=>[r.title,windowStatusLabel(r)])).toEqual([['First 2 … latest 2','Background task'], ['First 0 … latest 0','Open'], ['Renamed session','Saved']])
    expect(closed.online).toHaveLength(2)
    await c.remote.command('off'); expect((await state(c)).status).toBe(403)
    await a.remote.command('off'); expect((await state(a)).status).toBe(409)
    const hidden = await list(); expect(hidden.online).toHaveLength(0)
    // Windows that stopped sharing stay listed from saved metadata, status only, ahead of plain history.
    expect(hidden.rows.map(r=>[r.session, windowStatusLabel(r), r.unshared ?? false, r.terminal])).toEqual([['alpha','Open, not shared',true,undefined],['gamma','Open, not shared',true,undefined],['beta','Saved',false,undefined]])
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

test('opening prompt names an unsaved session until metadata arrives; a late title never names its successor', async () => {
  let reads = 0
  const {promise,resolve} = Promise.withResolvers<SessionMeta | null>()
  const {st,remote} = harness(async id => { reads++; return id === 'a' ? promise : {session_id:id,title:'From metadata'} as SessionMeta })
  expect(remote.snapshot().title).toBe('New conversation')
  st.conversationTail.append('user','First\n  request'); expect(remote.snapshot().title).toBe('First request')
  st.sessionId = 'a'
  for (let i = 0; i < 35; i++) st.conversationTail.append('user', `Later ${i}`)
  expect(remote.snapshot().title).toBe('First request'); remote.snapshot(); expect(reads).toBe(1)
  st.sessionId = 'b'; st.conversationTail.replace([]); expect(remote.snapshot().title).toBe('Session b')
  resolve({session_id:'a',title:'Previous title'} as SessionMeta)
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
  expect(() => remote.act({kind:'cancel-ask', generation, id})).toThrow()
  remote.act({kind:'cancel-ask', generation, id:newId}); expect(await again).toBeNull()
  expect(remote.snapshot()).toMatchObject({ask:null,input:'steer',generation})
  expect(st.conversationTail.view(false).at(-1)?.text).toContain('Cancelled.')
  expect(() => remote.act({kind:'cancel-ask', generation, id:newId})).toThrow(); expect(calls).toEqual([])
  const interrupted = asks.collectAskUserAnswers({questions:qs}), current = remote.snapshot().ask!.id
  expect(() => remote.act({kind:'stop', generation, askId:id})).toThrow()
  expect(() => remote.act({kind:'interrupt-ask', generation, id:newId})).toThrow()
  remote.act({kind:'interrupt-ask', generation, id:current}); expect(await interrupted).toBeNull(); expect(calls).toEqual(['stop'])
  const next = run(); expect(() => remote.act({kind:'stop',generation})).toThrow()
  const local = asks.presentAskQuestions(qs,'idle',true)
  expect(remote.snapshot()).toMatchObject({ask:null,input:null,canStop:false}); expect(() => remote.act({kind:'stop',generation:next})).toThrow()
  asks.resolvePendingAsk(); await local
})

test('pullback removes only the observed pending steer; consumption is never mistaken for a stop', () => {
  const {st, remote, run, calls, pendingQueue} = harness(), generation = run()
  const native = queueFixture(), target = currentQueueTarget(st)
  st.streamRef = native.stream; pendingQueue.begin(target)
  const enqueue = (phoneDraftId?:string) => pendingQueue.accept({queue:'steering', target, text:'same text',
    expandedText:'same text', snapshot:draft('same text'), phoneDraftId})
  const a = crypto.randomUUID(), b = crypto.randomUUID()
  enqueue(a); enqueue(b); const local = enqueue(); pendingQueue.attach(native.stream)
  expect(remote.snapshot().pendingDrafts).toEqual([a,b])
  expect(remote.snapshot().promptQueue).toStrictEqual([{state:'now',draftId:a},{state:'now',draftId:b},{state:'now'}])
  expect(() => remote.act({kind:'pull-draft',generation,draftId:a})).toThrow()
  expect(() => remote.act({kind:'pull-draft',generation,draftId:b})).toThrow() // TUI posted a newer prompt
  pendingQueue.remove(local,local.version)
  remote.act({kind:'pull-draft',generation,draftId:b})
  expect(remote.snapshot().input).toBe('steer')
  native.consume('steering') // races the phone's next Esc
  expect(() => remote.act({kind:'pull-draft',generation,draftId:a})).toThrow()
  expect(pendingQueue.visible(target)).toEqual([]); expect(calls).toEqual([])
  remote.act({kind:'stop', generation})
  const idle = remote.snapshot(); expect(idle.input).toBe('send')
  expect(() => remote.act({kind:'steer',generation,text:'next'})).toThrow()
  remote.act({kind:'send',generation:idle.generation,text:'next'})
  expect(calls).toEqual(['stop','send:next'])
})

test('Tab queues only during the observed run; Shift+Tab uses the host ladder, stale picks never advance it', () => {
  const {remote,run,calls,st} = harness(), first = remote.snapshot()
  const queue = {kind:'queue' as const, text:'later', generation:first.generation}
  expect(() => remote.act(queue)).toThrow()
  remote.act({kind:'suggest',generation:first.generation}); st.editor = insertText(st.editor,'private draft')
  expect(() => remote.act({kind:'suggest',generation:first.generation})).toThrow()
  const generation = run(), active = remote.snapshot(); expect(active.composerKeys?.queue).toBe(true)
  remote.act({...queue,generation}); remote.act({kind:'cycle-effort',generation,revision:active.models.revision})
  expect(() => remote.act({kind:'cycle-effort',generation,revision:'stale'})).toThrow()
  expect(calls).toEqual(['suggest','queue:later','cycle'])
})

test('explicit empty-input suggestions are available during a run without reading or changing local drafts', () => {
  const {remote,run,calls,st} = harness(), generation = run()
  remote.act({kind:'suggest',generation}); expect(calls).toEqual(['suggest'])
  st.editor = insertText(st.editor,'local only'); expect(remote.snapshot().composerKeys?.suggest).toBe(false)
  expect(remote.snapshot().suggestion).toBeUndefined(); expect(() => remote.act({kind:'suggest',generation})).toThrow()
})

test('stop all is scoped to the observed idle task set, even if it changes inside a turn generation', () => {
  const {st, remote, run, calls, shells} = harness()
  st.backgroundWaitSince = Date.now()
  const {generation, stopBackgroundTarget:target} = remote.snapshot()
  expect(target).toMatch(/^[a-f0-9]{64}$/)
  const action = {kind:'stop-background' as const, target:target!, generation}
  remote.act(action)
  expect(calls).toEqual(['stop:'+shells.target])
  shells.afterRefresh = '["fixture",["b"]]'
  expect(() => remote.act(action)).toThrow('changed')
  expect(() => remote.act(action)).toThrow()
  st.overlay = {kind:'help'}; expect(remote.snapshot().stopBackgroundTarget).toBeUndefined()
  st.overlay = {kind:'none'}; run(); expect(remote.snapshot().stopBackgroundTarget).toBeUndefined()
  expect(calls).toHaveLength(1)
})

test('Tab Suggest mirrors TUI pending → empty → retry → candidate and cycling, never local draft completion', async () => {
  const { st, remote, suggestions, finishSuggestion, calls } = harness()
  const tab = () => remote.act({ kind:'suggest', generation:remote.snapshot().generation })
  const preview = () => inlineSuggestion(remote.snapshot(), true, '')
  tab(); expect(preview()?.text).toContain('suggesting…')
  await finishSuggestion([])
  expect(preview()).toMatchObject({ candidate:'', text:expect.stringContaining('nothing to suggest') })
  tab(); expect(preview()?.text).toContain('suggesting…')
  await finishSuggestion(['Run the tests.', 'Review the diff.'])
  expect(preview()).toMatchObject({ candidate:suggestions.text(), text:'Run the tests.' })
  tab(); expect(preview()?.text).toBe('Review the diff.')
  expect(calls).toEqual(['suggest','suggest']) // cycling didn't start another request or send a message
  st.editor = insertText(st.editor, 'private draft')
  suggestions.complete('private draft'); expect(preview()).toBeNull()
  await finishSuggestion(['private suffix']); expect(suggestions.text()).toBe('private suffix'); expect(preview()).toBeNull()
  expect(remote.snapshot().suggestion).toBeUndefined(); expect(remote.snapshot().suggestionHint).toBeUndefined()
})

test('ordered snapshots use the TUI card, only serializing its displayed text and tone', () => {
  const {st,remote,run,calls} = harness()
  remote.act({kind:'send',generation:0,text:'start'}); expect(() => remote.act({kind:'send',generation:0,text:'/clear'})).toThrow()
  // The drawer's "Ask evot" sends a session search: an agent turn, like the TUI's. Lookups, pickers and other commands stay local.
  remote.act({kind:'send',generation:0,text:'/sessions databend planner bug'})
  expect(calls).toContain('send:/sessions databend planner bug')
  for (const text of ['/sessions', '/sessions 01a20c97', '/sessions   ', '/sessions --all', '/model x'])
    expect(() => remote.act({kind:'send',generation:0,text})).toThrow()
  calls.splice(0)
  calls.push('send:start')
  const generation = run(); st.streamMachine!.activeLlmCall = true
  expect(() => remote.act({kind:'steer',generation,text:'/sessions planner'})).toThrow('finish')
  st.appState.currentAssistantContent = [{type:'thinking',contentIndex:0,text:'Visible reasoning'}, {type:'text',contentIndex:1,text:'public text'},
    {type:'tool_call',contentIndex:2,toolCall:{name:'read',id:'1',args:{path:'fixture.ts',privateField:'private-arg'},progress:'reading\nfixture',result:'private-result',status:'running'}}]
  remote.act({kind:'steer',generation,text:'shorter'}); expect(calls).toEqual(['send:start','steer:shorter'])
  expect(() => remote.act({kind:'send',generation,text:'wrong mode'})).toThrow()
  expect(remote.snapshot()).toMatchObject({live:'public text',liveBlocks:[{kind:'thinking',text:'Visible reasoning'},{kind:'text',text:'public text'},{kind:'tool',state:'pending',text:expect.stringContaining('fixture.ts')}]})
  expect(JSON.stringify(remote.snapshot())).not.toContain('private-')
  remote.act({kind:'tool-view',expanded:true,generation}); expect(st.expanded).toBe(true)
  expect(remote.snapshot().liveBlocks?.at(-1)?.text).toContain('reading')
})

test('remote skills use the current registry on send and steer, even after the browser saw a stale catalog', () => {
  const {st,remote,run,submissions} = harness()
  st.skillEntries = [{name:'harden',dir:'/fixture/harden',command:{arguments:['changes']}}]
  const {generation,commands} = remote.snapshot()
  expect(commands).toContainEqual(expect.objectContaining({name:'/harden',arguments:['changes']}))
  expect(JSON.stringify(commands)).not.toContain('/fixture')
  remote.act({kind:'send',generation,text:'/ha xx'})
  const active = run(); remote.act({kind:'steer',generation:active,text:'/ha xx'})
  for (const mode of ['send','steer']) expect(submissions).toContainEqual(['/ha xx', mode, undefined, expect.stringContaining('/fixture/harden/SKILL.md'), undefined])
  st.skillEntries = []
  expect(() => remote.act({kind:'steer',generation:active,text:'/ha xx'})).toThrow('Unknown command')
  expect(submissions).toHaveLength(2)
})

test('composer commands, suggestions and task shortcuts are additive for old windows and old phones', async () => {
  const old = legacyComposer as RemoteSnapshot
  expect(commandChoices('/ha', old.commands).items).toEqual([])
  expect(phoneShortcut('/new', old.commands)).toBeNull()
  expect(inlineSuggestion(old,true,'')).toBeNull()
  const {remote, st, pendingQueue, finishSuggestion} = harness()
  remote.act({ kind:'suggest', generation:old.generation }); await finishSuggestion([])
  const current = remote.snapshot()
  expect(current.suggestionHint).toContain('nothing to suggest'); expect(current.suggestion).toBeUndefined()
  // The legacy composer reads these fields directly, ignoring unfamiliar snapshot fields.
  const legacyFields = (s: RemoteSnapshot) => [s.suggestion, s.sessionId, s.generation, s.title, s.status, s.input, s.canStop,
    s.messages, s.live, s.ask, s.models.active, s.models.effort, s.models.pending, s.models.revision,
    s.models.options[0]?.spec, s.models.options[0]?.levels]
  expect(legacyFields(current)).toStrictEqual(legacyFields(old))
  const id = crypto.randomUUID()
  pendingQueue.accept({queue:'steering', target:currentQueueTarget(st), text:'original', expandedText:'private', snapshot:draft('original'), phoneDraftId:id})
  const after = remote.snapshot()
  expect(after.pendingDrafts).toEqual([id]); expect(old.pendingDrafts).toBeUndefined()
  expect(old.promptQueue).toBeUndefined(); expect(after.promptQueue).toStrictEqual([{state:'paused',draftId:id}])
  expect(after.pendingSteers).toEqual([id]); expect(old.composerKeys).toBeUndefined()
  remote.act({kind:'pull-steer',generation:after.generation,draftId:id})
  expect(remote.snapshot().pendingDrafts).toEqual([])
  expect(legacyFields(after)).toStrictEqual(legacyFields(current))
})

test('paired picker selects only advertised models and tiers, synchronizes both ways and distinguishes a pending handoff', () => {
  const {st,remote,run} = harness()
  const start = remote.snapshot().models
  expect(start.next).toBe('local:another')
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

test('/remote startup is one status row rewritten in place, ending in the outcome', async () => {
  const { remoteStatus } = await import('../../../src/term/host/remote.js')
  const { stripVTControlCharacters } = await import('node:util')
  const committed: string[] = [], rows: string[] = []
  const status = remoteStatus({ commitLines: lines => committed.push(...lines.map(l => l.id)), replaceLine: (_id, text) => { rows.push(stripVTControlCharacters(text)); return true }, requestRender() {} })
  status.phase('Installing cloudflared 2026.11.2, Cloudflare\'s tunnel connector…')
  status.phase('Installing cloudflared 2026.11.2, Cloudflare\'s tunnel connector', { done: 19 * 1048576, total: 19 * 1048576 })
  status.phase('Registering this computer with evot Connect…')
  status.finish('success', 'Online at evot-abc.evot.ai.')
  status.phase('late phase is ignored')
  expect(committed).toHaveLength(1) // a single scrollback row
  expect(rows.at(-2)).toContain('Registering this computer')
  expect(rows.some(r => /19\.0 \/ 19\.0 MB · 100%/.test(r))).toBe(true)
  expect(rows.at(-1)).toMatch(/✓ Remote {2}Online at evot-abc\.evot\.ai\./)
  expect(status.active).toBe(false)
})

test('a parked window exits only when idle, unwatched for 5 minutes, without a draft or an attached terminal', () => {
  const now = 1_000_000_000, quiet = { lastWatched: now - PARKED_EXIT_MS, idle: true, draft: false, attached: false }
  expect(parkedExpired(quiet, now)).toBe(true)
  expect(parkedExpired({ ...quiet, lastWatched: now - PARKED_EXIT_MS + 1 }, now)).toBe(false)
  for (const blocker of [{ idle: false }, { draft: true }, { attached: true }]) expect(parkedExpired({ ...quiet, ...blocker }, now)).toBe(false)
  // Without a tmux pane to ask, the window counts as attached and stays.
  expect(tmuxAttached({})).toBe(true)
  expect(tmuxAttached({ TMUX: '/nonexistent/socket,1,0', TMUX_PANE: '%0' })).toBe(true)
})

test('only a phone-opened window arms the idle exit; following it keeps it alive and disposal disarms it', () => {
  const home = mkdtempSync(join(tmpdir(),'evot-park-')), prev = { ...process.env }
  const ticks: (() => void)[] = [], realSet = globalThis.setInterval, realClear = globalThis.clearInterval
  const cleared: unknown[] = []
  globalThis.setInterval = ((fn: () => void, ms: number) => { expect(ms).toBe(PARKED_CHECK_MS); ticks.push(fn); return { unref() {} } }) as unknown as typeof setInterval
  globalThis.clearInterval = ((t: unknown) => { cleared.push(t) }) as typeof clearInterval
  try {
    process.env.EVOT_HOME = home
    const local = harness(); local.remote.register()
    expect(ticks).toHaveLength(0) // a window the user opened is never closed for them
    local.remote.dispose()
    process.env.EVOT_PHONE_TERMINAL = crypto.randomUUID(); process.env.EVOT_PHONE_SCOPE = 'a'.repeat(24)
    delete process.env.TMUX; delete process.env.TMUX_PANE
    const phone = harness(); phone.remote.register()
    expect(ticks).toHaveLength(1)
    const tick = ticks[0]!, past = Date.now() - PARKED_EXIT_MS - 1
    phone.st.remoteWatchedAt = past; phone.run(); tick()
    expect(phone.calls).not.toContain('exit:0') // a running turn counts as activity
    expect(phone.st.remoteWatchedAt).toBeGreaterThan(past)
    phone.st.isLoading = false; phone.st.streamMachine = null
    phone.st.remoteWatchedAt = past; phone.remote.snapshot(); tick()
    expect(phone.calls).not.toContain('exit:0') // a phone just followed it
    phone.st.remoteWatchedAt = past; phone.st.editor = insertText(phone.st.editor, 'unsent'); tick()
    expect(phone.calls).not.toContain('exit:0') // never discard a draft
    phone.st.editor = createReplState('fixture','/fixture').editor
    phone.st.remoteWatchedAt = past; tick()
    expect(phone.calls).not.toContain('exit:0') // no tmux pane to ask: treated as attached
    process.env.TMUX = '/fixture,1,0'; process.env.TMUX_PANE = '%0'
    const realWhich = Bun.which, realSpawn = Bun.spawnSync
    Object.assign(Bun, { which: () => '/fixture/tmux', spawnSync: () => ({ exitCode: 0, stdout: Buffer.from('0\n') }) })
    try { phone.st.remoteWatchedAt = past; tick() } finally { Object.assign(Bun, { which: realWhich, spawnSync: realSpawn }) }
    expect(phone.calls).toContain('exit:0')
    phone.remote.dispose()
    expect(cleared).toHaveLength(1)
  } finally {
    globalThis.setInterval = realSet; globalThis.clearInterval = realClear
    for (const key of Object.keys(process.env)) if (!(key in prev)) delete process.env[key]
    Object.assign(process.env, prev)
    rmSync(privateSocketDirectory(home), {recursive:true, force:true}); rmSync(home, {recursive:true, force:true})
  }
})
