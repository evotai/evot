import { expect, test } from 'bun:test'
import { sessionRecovery, temporaryDisconnect, pairingFeedback } from '../../../src/features/remote/phone-recovery.js'

function fixture() {
  let time = 0, ids = 0, selected = true, loseReply = false
  const rows = {rows:[{session:'chat'}] as {session:string, terminal?:string, unshared?:boolean}[], unavailable:false, failed:false}
  const opens:unknown[] = [], statuses:string[] = []
  const recovery = sessionRecovery({now:() => time, onResume:() => { statuses.push('resuming') }, requestId:() => String(++ids), lookup:async () => rows,
    open:async (body:unknown) => { opens.push(body); if (loseReply) throw new TypeError('offline'); return {terminal:'new'} }})
  return {rows, opens, statuses, run:() => recovery.recover('old','chat',() => selected), tick:(ms:number) => time+=ms,
    lose:(v:boolean) => loseReply=v, leave:() => selected=false}
}

test('wait out a restart, attach to an existing owner before opening History', async () => {
  const f = fixture(); await f.run(); f.tick(900); await f.run(); expect(f.opens).toEqual([])
  f.rows.rows = [{terminal:'live',session:'chat'}]; f.tick(100)
  expect(await f.run()).toMatchObject({terminal:'live'}); expect(f.opens).toEqual([]); expect(f.statuses).toEqual([])
})
test('a moved session in the drawer is followed immediately even when another terminal is unavailable', async () => {
  const f = fixture(); f.rows.unavailable = true
  f.rows.rows = [{session:'other',terminal:'old'},{session:'chat',terminal:'new'}]
  expect(await f.run()).toMatchObject({session:'chat',terminal:'new'}); expect(f.opens).toEqual([])
})
test('a lost open reply retries the same saved session with the same request and backoff', async () => {
  const f = fixture(); await f.run(); f.tick(1000); f.lose(true)
  await expect(f.run()).rejects.toThrow('offline'); f.lose(false)
  await f.run(); expect(f.opens).toHaveLength(1); f.tick(2000)
  expect(await f.run()).toEqual({terminal:'new'}); expect(f.statuses).toHaveLength(2); expect(f.opens).toEqual(Array(2).fill({session:'chat',requestId:'1'}))
})
test('an inconclusive directory, private or missing chat, and a stale selection never launch a window', async () => {
  const f = fixture(); await f.run(); f.tick(8000); f.rows.unavailable = true; await f.run()
  f.tick(30000); f.rows.unavailable = false; f.rows.rows = [{session:'other'}]; await f.run()
  f.tick(30000); f.rows.rows = [{session:'chat',unshared:true}]; await f.run()
  f.tick(30000); f.rows.rows = [{session:'chat'}]; const pending = f.run(); f.leave(); await pending
  expect(f.opens).toEqual([])
})
test('ordinary recovery is status-only; authentication and approval are explicit actions', () => {
  expect(pairingFeedback(new TypeError('offline'))).toEqual({status:'Reconnecting…',retry:true,action:null})
  expect(pairingFeedback({name:'TimeoutError'})).toMatchObject({retry:true,action:null})
  expect(pairingFeedback({signIn:true})).toMatchObject({retry:false,action:'Sign in'})
  expect(pairingFeedback({approvalExpired:true})).toMatchObject({retry:false,action:'Request approval'})
  expect(pairingFeedback({name:'SecurityError'})).toMatchObject({retry:false,action:null})
})
test('a transient gateway outage retries automatically, account and device denials do not', () => {
  for (const status of [408,410,425,429,502,503]) expect(temporaryDisconnect({status})).toBe(true)
  for (const status of [400,401,403]) expect(temporaryDisconnect({status})).toBe(false)
})
