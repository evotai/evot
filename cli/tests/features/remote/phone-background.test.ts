import { expect, mock, test } from 'bun:test'
import { backgroundPanel } from '../../../src/features/remote/phone-background.js'

test('the header and open output follow live task status, then clear when the task finishes', () => {
  const chip = { hidden:true, ariaLabel:'', onclick() {} }
  const statusButton = { hidden:true, onclick() {} }
  const count = { textContent:'' }
  const panel = {
    open:false, onclose() {},
    showModal() { this.open = true },
    close() { this.open = false; this.onclose() },
  }
  const output = { hidden:true, textContent:'', scrollHeight:60, scrollTop:0, clientHeight:60 }
  const subtitle = { textContent:'' }
  const mark = () => ({hidden:true, running:false, toggleAttribute(_attr: string, enabled: boolean) { this.running = enabled }})
  const activity = mark(), outputActivity = mark()
  const nodes = new Map<string, object>([
    ['bgChip', chip], ['bgStatus', statusButton], ['bgCount', count], ['bgPanel', panel], ['bgOutput', output], ['bgSubtitle', subtitle],
    ['bgTitle', {}], ['bgActivity', activity], ['bgOutputActivity', outputActivity],
    ['bgTasks', {querySelectorAll: () => []}], ['allTasks', {}], ['closeBg', {}],
  ])
  const refresh = mock(() => {})
  const ui = backgroundPanel({ getElementById: (id: string) => nodes.get(id) }, refresh)
  const task = { id:'shell-id', title:'Run tests', status:'running · 3s' }
  ui.setConnected(true)
  ui.render({ tasks:[task] })
  expect(activity.running).toBe(true)
  expect(chip).toMatchObject({ hidden:false, ariaLabel:'Background: 1 task running' })
  expect(count.textContent).toBe('1 task running')
  expect(statusButton.hidden).toBe(false)
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
  chip.onclick()
  expect(ui.selected).toBe(task.id)
  expect(output.textContent).toBe('Loading task output…')

  ui.setConnected(false)
  expect(activity.running).toBe(false)
  expect(outputActivity.running).toBe(false)
  ui.render(null)
  expect(chip).toMatchObject({ hidden:true, ariaLabel:'' })
  expect(statusButton.hidden).toBe(true)
  expect(count.textContent).toBe('')
  expect(panel.open).toBe(false)
  expect(ui.selected).toBeNull()
  expect(output.textContent).toBe('')
})
