import { expect, test } from 'bun:test'
import { completionReminder, roundCompletions } from '../../../src/features/remote/phone-reminder.js'

const badge = (terminal:string, session:string, finishedRound:number|null) => ({terminal,session,finishedRound})
const a=badge('window-a','a',1), b=badge('window-b','b',3)
test('a new window or conversation establishes a baseline, not a notification', () => {
  const first = roundCompletions(new Map(), [a,b,{terminal:'old'}]); expect(first.finished).toBe(false); expect(first.seen.size).toBe(2)
  expect(roundCompletions(first.seen,[{...a,session:'new',finishedRound:4}]).finished).toBe(false)
  expect(roundCompletions(first.seen,[a,{...b,finishedRound:4}]).finished).toBe(true)
})
function page(values = new Map<string,string>()) {
  let plays=0, tick=()=>{}, pressed='', pending=Promise.withResolvers<{online:typeof a[]}>()
  const events=new Map<string,()=>void>()
  class Audio {
    paused=true; currentTime=0
    async play() { this.paused=false; plays++ }
    pause() { this.paused=true }
    removeAttribute() {} load() {}
  }
  const audioSession={type:'auto'}
  const document={hidden:false, addEventListener:(k:string,fn:()=>void)=>events.set(k,fn),defaultView:{Audio,URL,navigator:{audioSession},
    localStorage:{get length(){return values.size},key:(i:number)=>[...values.keys()][i],getItem:(k:string)=>values.get(k),setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)},
    addEventListener(){},setTimeout(fn:()=>void){tick=fn;return 1},clearTimeout(){tick=()=>{}}}}
  const button={hidden:true,ownerDocument:document,onclick(){},setAttribute(_:string,v:string){pressed=v}}
  const reminder=completionReminder(button,()=>pending.promise,()=>{})
  reminder.select(a);reminder.setPaired(true)
  return {reminder,button,values,audioSession,hide(value:boolean){document.hidden=value;events.get('visibilitychange')?.()},get pressed(){return pressed},get plays(){return plays}, tick:()=>tick(), async settle(...online:typeof a[]) {
    pending.resolve({online});await Promise.resolve();pending=Promise.withResolvers()
  }}
}
test('only opted-in sessions chime; refresh, window moves and re-pair restore the switch without replay',async()=>{
  const p=page(); p.button.onclick(); expect(p.pressed).toBe('true'); expect(p.plays).toBe(1); await p.settle(a,b)
  p.reminder.select(b);expect(p.pressed).toBe('false');p.tick();await p.settle(a,{...b,finishedRound:4});expect(p.plays).toBe(1)
  p.tick();await p.settle({...a,finishedRound:2},b);expect(p.plays).toBe(2)
  const reload=page(p.values);expect(reload.pressed).toBe('true');await reload.settle({...a,finishedRound:6});expect(reload.plays).toBe(0)
  reload.tick();reload.reminder.setPaired(false);await reload.settle({...a,finishedRound:7});expect(reload.plays).toBe(0)
  reload.reminder.select({...a,terminal:'moved'});reload.reminder.setPaired(true);expect(reload.pressed).toBe('true')
  await reload.settle({...a,terminal:'moved',finishedRound:9});expect(reload.plays).toBe(0)
  reload.button.onclick();expect(page(p.values).pressed).toBe('false')
})
test('the open chat chimes on its completion frame without waiting for inventory or replaying it', async () => {
  const p=page(); p.button.onclick()
  const frame=(finishedRound:number|null) => p.reminder.observe(a.terminal,{sessionId:a.session,finishedRound})
  frame(null); expect(p.plays).toBe(1)
  frame(1); expect(p.plays).toBe(2)
  await p.settle({...a,finishedRound:null}); frame(1); expect(p.plays).toBe(2)
  p.tick(); await p.settle(a); expect(p.plays).toBe(2)
  p.button.onclick(); frame(2); expect(p.plays).toBe(2)
})
test('opt-in requests playback and a still-running background tab chimes without replay on return', async () => {
  const p=page(); expect(p.audioSession.type).toBe('auto'); p.button.onclick(); expect(p.audioSession.type).toBe('playback')
  await p.settle(a); p.reminder.observe(a.terminal,{sessionId:a.session,finishedRound:1})
  p.hide(true); await p.settle({...a,finishedRound:2}); expect(p.plays).toBe(2)
  p.hide(false); await p.settle({...a,finishedRound:2}); expect(p.plays).toBe(2)
  p.button.onclick(); expect(p.audioSession.type).toBe('auto')
})
test('a fresh window keeps the preference when its first session ID arrives',()=>{
  const p=page();p.reminder.select({...a,session:null});p.button.onclick();p.reminder.select(a)
  expect(p.pressed).toBe('true');expect(page(p.values).pressed).toBe('true')
  p.reminder.select({...a,session:'other'});expect(p.pressed).toBe('false')
})
