import { expect, mock, test } from 'bun:test'
import { backgroundPanel } from '../../../src/features/remote/phone-background.js'

test('the header and open output follow live task status, then clear when the task finishes', () => {
  const chip = { hidden:true, ariaLabel:'', onclick() {} }
  const count = { textContent:'' }
  const panel = {
    open:false, onclose() {},
    showModal() { this.open = true },
    close() { this.open = false; this.onclose() },
  }
  const output = { hidden:true, textContent:'', scrollHeight:60, scrollTop:0, clientHeight:60 }
  const subtitle = { textContent:'' }, activity = { hidden:true }
  const nodes = new Map<string, object>([
    ['bgChip', chip], ['bgCount', count], ['bgPanel', panel], ['bgOutput', output], ['bgSubtitle', subtitle],
    ['bgTitle', {}], ['bgOutputActivity', activity], ['bgTasks', {}], ['allTasks', {}], ['closeBg', {}],
  ])
  const refresh = mock(() => {})
  const ui = backgroundPanel({ getElementById: (id: string) => nodes.get(id) }, refresh)
  const task = { id:'shell-id', title:'Run tests', status:'running · 3s' }
  ui.render({ tasks:[task] })
  expect(chip).toMatchObject({ hidden:false, ariaLabel:'Background: 1 task running' })
  expect(count.textContent).toBe('1 task running')
  chip.onclick()
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(ui.selected).toBe(task.id)

  ui.render({ tasks:[task], output:{ id:task.id, text:'Compiling…' } })
  expect(subtitle.textContent).toBe('Run tests · running · 3s')
  expect(activity.hidden).toBe(false)
  expect(output).toMatchObject({ hidden:false, textContent:'Compiling…' })
  ui.render({ tasks:[{ ...task, status:'running · 10s' }], output:{ id:task.id, text:'Testing…' } })
  expect(subtitle.textContent).toBe('Run tests · running · 10s')
  expect(output.textContent).toBe('Testing…')

  ui.render(null)
  expect(chip).toMatchObject({ hidden:true, ariaLabel:'' })
  expect(count.textContent).toBe('')
  expect(panel.open).toBe(false)
  expect(ui.selected).toBeNull()
  expect(output.textContent).toBe('')
})
