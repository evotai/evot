import { expect, test } from 'bun:test'
import { taskKeys } from '../../../src/features/remote/phone-task-keys.js'
import legacy from '../../fixtures/contracts/remote-composer-legacy.json'

function harness() {
  const button = () => ({hidden:true, disabled:false, lastElementChild:{textContent:''}, toggleAttribute(){},
    onclick(){}, click(){ if (!this.disabled && !this.hidden) this.onclick() }})
  const stop = button()
  const actions: unknown[] = []
  const keys = taskKeys(stop, { act:(a:unknown) => actions.push(a),
    pull:(id:string) => actions.push({pull:id}), clear:() => actions.push('clear'), dismissMenu:() => actions.push('dismiss')})
  const press = (key:string, value='', extra={}) => keys.keydown({key, target:{value}, preventDefault(){}, ...extra})
  return {stop, actions, press, render:keys.render}
}

test('only Escape is intercepted, even while a background task is present', () => {
  const {stop, actions, press, render} = harness()
  render(legacy,false); expect(stop.disabled).toBe(true)
  const running = {...legacy, canStop:true, background:{tasks:[{id:'fixture'}]}}
  render(running,false); expect(stop.hidden).toBe(false)
  expect(press('ArrowDown')).toBe(false)
  for (const ch of ['b','t','k']) expect(press(ch,'draft',{ctrlKey:true})).toBe(false)
  expect(actions).toEqual([])
  render(running,true); expect(press('Escape')).toBe(false)
  render(null,false); expect(stop.hidden).toBe(true)
})

test('Esc pulls back first, then interrupts with the draft intact; idle input is no longer steer', () => {
  const {render, press, stop, actions} = harness(), run = {...legacy, input:'steer', canStop:true}
  render(run, false, false, 'pending'); expect(stop.lastElementChild.textContent).toBe('Pull back')
  press('Escape'); expect(actions).toEqual([{pull:'pending'}])
  render(run, false, 'restored draft'); stop.click(); press('Escape')
  expect(actions).toEqual([{pull:'pending'}, {kind:'stop'}])
  render(legacy, false, 'restored draft'); expect(stop.lastElementChild.textContent).toBe('Clear draft')
  render({...run, input:null, ask:{id:'new'}}, false); expect(press('Escape')).toBe(false)
  expect(stop.hidden).toBe(true) // the question panel owns Escape, never the composer
})

test('Esc dismisses a visible hint before pullback or stopping, with the same label on touch', () => {
  const {stop, render, press, actions} = harness(), run = {...legacy,input:'steer',canStop:true}
  render(run,false,false,'draft',true); expect(stop.lastElementChild.textContent).toBe('Dismiss')
  stop.click(); render(run,false,false,'draft',false); press('Escape')
  render(run,false,false,undefined,true); press('Escape'); render(run,false); press('Escape')
  expect(actions).toEqual(['dismiss',{pull:'draft'},'dismiss']); press('Escape'); expect(actions.at(-1)).toEqual({kind:'stop'})
})

test('stop confirmation cannot carry over to a successor run, a changed task set or a reconnect', () => {
  const {stop, render, press, actions} = harness()
  const run = {...legacy, canStop:true, generation:1}
  render(run, false); stop.click(); expect(stop.lastElementChild.textContent).toBe('Confirm stop')
  render({...run, generation:2}, false); expect(stop.lastElementChild.textContent).toBe('Stop run')
  const parked = {...legacy, stopBackgroundTarget:'a'}
  render(parked, false); press('Escape'); press('Escape', '', {repeat:true})
  render({...parked, stopBackgroundTarget:'b'}, false); stop.click()
  render(null, false); render(parked, false); stop.click()
  expect(actions).toEqual([])
  stop.click(); expect(actions).toEqual([{kind:'stop-background', target:'a'}])
})
