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
    state='suspended'; currentTime=0; destination={}
    async resume() { this.state='running' }
    createOscillator() { return {frequency:{value:0},connect:()=>({connect(){}}),start(){plays++},stop(){}} }
    createGain() { return {gain:{setValueAtTime(){},linearRampToValueAtTime(){}}} }
  }
  const document={hidden:false, addEventListener:(k:string,fn:()=>void)=>events.set(k,fn),defaultView:{AudioContext:Audio,
    localStorage:{get length(){return values.size},key:(i:number)=>[...values.keys()][i],getItem:(k:string)=>values.get(k),setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)},
    addEventListener(){},setTimeout(fn:()=>void){tick=fn;return 1},clearTimeout(){tick=()=>{}}}}
  const button={hidden:true,ownerDocument:document,onclick(){},setAttribute(_:string,v:string){pressed=v}}
  const reminder=completionReminder(button,()=>pending.promise,()=>{})
  reminder.select(a);reminder.setPaired(true)
  return {reminder,button,values,get pressed(){return pressed},get plays(){return plays}, tick:()=>tick(), async settle(...online:typeof a[]) {
    pending.resolve({online});await Promise.resolve();pending=Promise.withResolvers()
  }}
}
test('only opted-in sessions chime; refresh, window moves and re-pair restore the switch without replay',async()=>{
  const p=page(); p.button.onclick(); expect(p.pressed).toBe('true'); await p.settle(a,b)
  p.reminder.select(b);expect(p.pressed).toBe('false');p.tick();await p.settle(a,{...b,finishedRound:4});expect(p.plays).toBe(0)
  p.tick();await p.settle({...a,finishedRound:2},b);expect(p.plays).toBe(2)
  const reload=page(p.values);expect(reload.pressed).toBe('true');await reload.settle({...a,finishedRound:6});expect(reload.plays).toBe(0)
  reload.tick();reload.reminder.setPaired(false);await reload.settle({...a,finishedRound:7});expect(reload.plays).toBe(0)
  reload.reminder.select({...a,terminal:'moved'});reload.reminder.setPaired(true);expect(reload.pressed).toBe('true')
  await reload.settle({...a,terminal:'moved',finishedRound:9});expect(reload.plays).toBe(0)
  reload.button.onclick();expect(page(p.values).pressed).toBe('false')
})
test('a fresh window keeps the preference when its first session ID arrives',()=>{
  const p=page();p.reminder.select({...a,session:null});p.button.onclick();p.reminder.select(a)
  expect(p.pressed).toBe('true');expect(page(p.values).pressed).toBe('true')
  p.reminder.select({...a,session:'other'});expect(p.pressed).toBe('false')
})
