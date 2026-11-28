import {test,expect} from 'bun:test'
import {runInterrupt} from '../../../src/features/remote/phone-interrupt.js'

const run = {sessionId:'a', generation:4,input:'steer'}, idle = {...run,generation:5,input:'send'}
function fixture() {
  const ack = Promise.withResolvers<typeof idle | null>(), sync = Promise.withResolvers<void>()
  const events:string[]=[]
  const stop = runInterrupt({lock:(busy:boolean)=>events.push(busy?'stopping':'unlock'),post:()=>ack.promise,
    replace:()=>events.push('replace'),refresh:()=>{events.push('refresh');return sync.promise},error:()=>events.push('error')})
  return {ack,sync,events,stop}
}
test('live stop unlocks ordinary send without waiting for POST, late reply cannot rewind the next turn',async()=>{
  const {ack,events,stop}=fixture(), req=stop.request(run,{kind:'stop'})
  stop.observe(run); expect(stop.pending).toBe(true)
  await stop.request(run,{kind:'stop'}); stop.observe(idle); expect(stop.pending).toBe(false)
  stop.observe({...run,generation:6}); ack.resolve(idle); await req
  expect(events).toEqual(['stopping','unlock'])
})
test('post-stop snapshot replaces the stale stream immediately; legacy or ambiguous receipts need fresh host state',async()=>{
  for (const result of ['state','empty','error']) {
    const {ack,sync,stop,events}=fixture(), req=stop.request(run,{kind:'stop'})
    if (result==='error') ack.reject(Error('offline')); else ack.resolve(result==='state'?idle:null)
    await new Promise(resolve=>setImmediate(resolve))
    if(result==='state') expect(events).toEqual(['stopping','replace','unlock'])
    else { expect(events.at(-1)).toBe('refresh'); expect(stop.pending).toBe(true); sync.resolve() }
    await req; expect(stop.pending).toBe(false)
  }
})
