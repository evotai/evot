import { expect, test } from 'bun:test'
import { taskKeys } from '../../../src/features/remote/phone-task-keys.js'
import legacy from '../../fixtures/contracts/remote-composer-legacy.json'

function harness() {
  const esc = {hidden:true, disabled:false, textContent:'', title:'', toggleAttribute(){}, onclick(){}}
  const actions: unknown[] = []
  const keys = taskKeys(esc, { act:(a:unknown) => actions.push(a), pull:(id:string) => actions.push({pull:id}),
    interruptAsk:() => actions.push('interrupt question'), clear:() => actions.push('clear'), dismissMenu:() => actions.push('dismiss')})
  const press = (key:string, extra={}) => keys.keydown({key, preventDefault(){}, ...extra})
  return {esc, actions, press, render:keys.render, compact:keys.setCompact}
}
const run = {...legacy,input:'steer',canStop:true,generation:1}

test('idle Esc stays hidden, and only an unmodified non-IME Escape interrupts', () => {
  const {esc, actions, press, render} = harness()
  render(legacy,false); expect(esc.hidden).toBe(true)
  render(run,false); expect(esc.hidden).toBe(false); expect(esc.textContent).toBe('Esc')
  expect(press('ArrowDown')).toBe(false)
  for (const mod of ['isComposing','metaKey','ctrlKey','altKey','shiftKey']) expect(press('Escape',{[mod]:true})).toBe(false)
  render(run,true); expect(press('Escape')).toBe(false)
  render(run,true,'',null,false,true); press('Escape'); expect(actions).toEqual([])
  expect(esc.textContent).toBe('Esc again'); esc.onclick(); expect(actions).toEqual([{kind:'stop'}])
})

test('one key dismisses a hint, pulls back, then interrupts; idle draft and question actions remain reachable', () => {
  const {render, press, esc, actions} = harness()
  render(run,false,false,'draft',true); esc.onclick()
  render(run,false,false,'draft'); press('Escape')
  render(run,false,'unfinished'); esc.onclick(); press('Escape')
  render(legacy,false,'unfinished'); esc.onclick()
  render({...run,input:null,ask:{id:'new'}},false); esc.onclick()
  expect(actions).toEqual(['dismiss',{pull:'draft'},{kind:'stop'},'clear','interrupt question'])
})

test('the status key follows compact mode without clearing a hidden draft or dismissing a hidden hint', () => {
  const {render, press, esc, actions, compact} = harness()
  render(run,false,'unfinished','pending',true); compact(true)
  expect(esc.title).toContain('Stop run'); esc.onclick(); expect(esc.textContent).toBe('Esc again')
  press('Escape'); expect(actions).toEqual([{kind:'stop'}])
  render(run,false,false,'pending'); esc.onclick(); expect(actions.at(-1)).toEqual({pull:'pending'})
  render(legacy,false,'unfinished'); expect(esc.hidden).toBe(true); expect(press('Escape')).toBe(false)
  compact(false); expect(esc.hidden).toBe(false); expect(esc.title).toContain('Clear draft')
})

test('confirmation cannot carry over to a successor run, a changed task set or a reconnect', () => {
  const {esc, render, press, actions} = harness()
  render(run,false); esc.onclick(); expect(esc.textContent).toBe('Esc again')
  render({...run,generation:2},false); expect(esc.textContent).toBe('Esc')
  const parked = {...legacy,stopBackgroundTarget:'a'}
  render(parked,false); press('Escape'); press('Escape',{repeat:true})
  render({...parked,stopBackgroundTarget:'b'},false); esc.onclick()
  render(null,false); render(parked,false); esc.onclick(); expect(actions).toEqual([])
  esc.onclick(); expect(actions).toEqual([{kind:'stop-background',target:'a'}])
})
