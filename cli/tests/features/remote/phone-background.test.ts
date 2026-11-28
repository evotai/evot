import { expect, mock, test } from 'bun:test'
import { backgroundPanel } from '../../../src/features/remote/phone-background.js'

test('the composer status row opens live background output and clears when the task finishes', () => {
  const statusButton = { hidden:true, textContent:'', ariaLabel:'', onclick() {} }
  const panel = {
    open:false, onclose() {},
    showModal() { this.open = true },
    close() { this.open = false; this.onclose() },
  }
  const output = { hidden:true, textContent:'', scrollHeight:60, scrollTop:0, clientHeight:60 }
  const subtitle = { textContent:'' }
  const mark = () => ({hidden:true, running:false, toggleAttribute(_attr: string, enabled: boolean) { this.running = enabled }})
  const outputActivity = mark()
  const nodes = new Map<string, object>([
    ['bgStatus', statusButton], ['bgPanel', panel], ['bgOutput', output], ['bgSubtitle', subtitle],
    ['bgTitle', {}], ['bgOutputActivity', outputActivity],
    ['bgTasks', {querySelectorAll: () => []}], ['allTasks', {}], ['closeBg', {}],
  ])
  const refresh = mock(() => {})
  const ui = backgroundPanel({ getElementById: (id: string) => nodes.get(id) }, refresh)
  const task = { id:'shell-id', title:'Run tests', status:'running · 3s' }
  ui.setConnected(true)
  ui.render({ tasks:[task] })
  expect(statusButton).toMatchObject({hidden:false, textContent:'1 task', ariaLabel:'Open background tasks: 1 task running'})
  statusButton.onclick()
  expect(panel.open).toBe(true)
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(ui.selected).toBe(task.id)
  expect(output).toMatchObject({ hidden:false, textContent:'Loading task output…' })
  ui.setConnected(false)
  expect(output.textContent).toBe('Reconnecting to load task output…')
  ui.setConnected(true)
  ui.render({ tasks:[task] })
  expect(output.textContent).toBe('No task output available yet.')
  ui.render({ tasks:[task], output:{ id:task.id, text:'Compiling…' } })
  expect(subtitle.textContent).toBe('Run tests · running · 3s')
  expect(outputActivity).toMatchObject({hidden:false, running:true})
  expect(output).toMatchObject({ hidden:false, textContent:'Compiling…' })
  ui.render({ tasks:[{ ...task, status:'running · 10s' }], output:{ id:task.id, text:'Testing…' } })
  expect(subtitle.textContent).toBe('Run tests · running · 10s')
  expect(output.textContent).toBe('Testing…')
  panel.close()
  expect(ui.selected).toBeNull()
  expect(refresh).toHaveBeenCalledTimes(2)
  statusButton.onclick()
  expect(ui.selected).toBe(task.id)
  expect(output.textContent).toBe('Loading task output…')

  ui.setConnected(false)
  expect(outputActivity.running).toBe(false)
  ui.render(null)
  expect(statusButton).toMatchObject({hidden:true, textContent:'', ariaLabel:''})
  expect(panel.open).toBe(false)
  expect(ui.selected).toBeNull()
  expect(output.textContent).toBe('')
})
