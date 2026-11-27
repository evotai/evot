import {expect,test} from 'bun:test'
import {turnStartFeedback} from '../../../src/features/remote/phone-turn-start.js'

function fixture() {
  let timeout: (() => void) | undefined
  const feedback = turnStartFeedback(()=>{}, {setTimeout(fn:()=>void){timeout=fn},clearTimeout(){timeout=undefined}})
  return {feedback, expire:()=>timeout?.()}
}
const idle = {generation:4, active:false, status:'Ready'}

test('spinner spans sending, HTTP admission and stale idle snapshots, until the host takes over',()=>{
  const {feedback,expire}=fixture(), send=feedback.begin(idle,false)
  expect(feedback.label).toBe('Sending…'); send.accepted(); feedback.observe(idle)
  expect(feedback.label).toBe('Waiting for the computer to start…')
  feedback.observe({...idle,active:true}); expect(feedback.label).toBeUndefined()
  expire(); send.accepted(); expect(feedback.label).toBeUndefined()
})
test('a fast finish or question beats a late receipt; a failed or abandoned send cannot affect its successor',()=>{
  const {feedback,expire}=fixture()
  for (const next of [{...idle,generation:5,status:'Completed'},{...idle,ask:{}}]) {
    const send=feedback.begin(idle,false); feedback.observe(next); send.accepted(); expect(feedback.label).toBeUndefined()
  }
  const abandoned=feedback.begin(idle,true); expect(feedback.label).toBe('Uploading…'); feedback.clear()
  const next=feedback.begin(idle,false); abandoned.accepted(); abandoned.failed(); expect(feedback.label).toBe('Sending…')
  next.failed(); expect(feedback.label).toBeUndefined()
  feedback.begin(idle,false).accepted(); expire(); expect(feedback.label).toBeUndefined()
})
