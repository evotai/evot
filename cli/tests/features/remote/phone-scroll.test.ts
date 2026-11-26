import { expect, test } from 'bun:test'
import { conversationScroll } from '../../../src/features/remote/phone-scroll.js'

function transcript() {
  let resize = () => {}, reading = false, top = 0
  const events = new Map<string, (event?: unknown) => void>()
  const document = {
    activeElement: null as object | null,
    defaultView: { ResizeObserver: class {
      constructor(callback: () => void) { resize = callback }
      observe() {}
    } },
  }
  const write = { inert: true, ariaLabel: 'Open composer', title: 'Open composer', textContent: 'Message…', onclick() {} }
  const jump = { hidden: true, onclick() {} }
  type Pointer = { pointerId:number; isPrimary:boolean; button:number; clientX:number; clientY:number }
  const foldHandle = { hidden:true, onclick(_event: {detail:number}) {}, onpointerdown(_event: Pointer) {},
    onpointerup(_event: Pointer) {}, setPointerCapture(_id: number) {} }
  const draft = { value: 'A draft for later', focus() { document.activeElement = this } }
  const editor = { inert:false, contains(node:object | null) { return node === draft } }
  const seat = {
    height: 200,
    get offsetHeight() { return reading ? 60 : this.height },
    toggleAttribute(_name: string, value: boolean) {
      reading = value
      top = Math.min(top, Math.max(0, chat.scrollHeight - chat.clientHeight))
    },
  }
  const chat = {
    ownerDocument: document, scrollHeight: 2400,
    get clientHeight() { return 800 - seat.offsetHeight },
    get scrollTop() { return top },
    set scrollTop(value: number) { top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)) },
    focus() { document.activeElement = this },
    addEventListener(event: string, callback: (event?: unknown) => void) { events.set(event, callback) },
  }
  const controller = conversationScroll({ chat, seat, editor, write, jump, foldHandle, draft })
  controller.update(true, true)
  controller.latest()
  return {
    controller, chat, seat, editor, document, draft, write, jump, foldHandle, events,
    get reading() { return reading },
    get bottom() { return Math.max(0, chat.scrollHeight - chat.clientHeight) },
    scrollTo(top: number) { chat.scrollTop = top; events.get('scroll')?.() },
    scrollBack(pixels: number) { this.scrollTo(this.bottom - pixels) },
    touch(event: string, x = 100, y = 100) {
      const points = [{identifier:1, clientX:x, clientY:y}]
      events.get(event)?.(event === 'touchend' ? {changedTouches:points} : {touches:points})
    },
    resize() { resize() },
  }
}

test('small scrolls do not flash controls; a folded composer stays folded through layout, streaming and more scrolling', () => {
  const ui = transcript()
  ui.scrollBack(26)
  expect(ui.reading).toBe(false)
  expect(ui.jump.hidden).toBe(true)
  ui.scrollBack(80)
  expect(ui.reading).toBe(true)
  expect(ui.write).toMatchObject({ inert:false, ariaLabel:'Resume draft', textContent:'Resume draft…' })
  expect(ui.jump.hidden).toBe(false)
  const top = ui.chat.scrollTop
  expect(top).toBe(1660) // The expanded transcript can clamp to its new bottom.
  ui.scrollTo(top)
  expect(ui.reading).toBe(true)
  ui.chat.scrollHeight += 100
  ui.controller.keepLatest()
  ui.resize()
  expect(ui.chat.scrollTop).toBe(top)
  ui.scrollTo(ui.bottom)
  expect(ui.reading).toBe(true)
  expect(ui.jump.hidden).toBe(false)
})

test('growing the viewport does not mistake its new bottom for a downward swipe', () => {
  const ui = transcript()
  ui.seat.height = 100
  ui.scrollTo(ui.bottom)
  expect(ui.reading).toBe(false)
  expect(ui.jump.hidden).toBe(true)
  ui.chat.scrollHeight += 210
  ui.controller.keepLatest()
  expect(ui.chat.scrollTop).toBe(ui.bottom)
})

test('tap the collapsed field to focus the original draft without moving history', () => {
  const ui = transcript()
  ui.draft.focus()
  ui.scrollBack(300)
  expect(ui.editor.inert).toBe(true)
  expect(ui.document.activeElement).toBe(ui.chat)
  const top = ui.chat.scrollTop
  ui.write.onclick()
  expect(ui.reading).toBe(false)
  expect(ui.editor.inert).toBe(false)
  expect(ui.document.activeElement).toBe(ui.draft)
  expect(ui.draft.value).toBe('A draft for later')
  ui.resize()
  expect(ui.chat.scrollTop).toBe(top)
  expect(ui.jump.hidden).toBe(false)
})

test('a downward touch folds on release, while a short swipe and its momentum never fold', () => {
  const ui = transcript()
  ui.touch('touchstart')
  ui.scrollBack(40)
  ui.touch('touchend', 100, 140)
  ui.scrollBack(120)
  expect(ui.reading).toBe(false)
  ui.touch('touchstart')
  ui.scrollBack(220)
  expect(ui.reading).toBe(false)
  ui.touch('touchend', 105, 190)
  expect(ui.reading).toBe(true)
  ui.write.onclick()
  ui.scrollBack(300)
  expect(ui.reading).toBe(false)
})

test('short conversations can fold on a downward pull, but not on horizontal, cancelled or question gestures', () => {
  const ui = transcript()
  ui.chat.scrollHeight = 300
  ui.controller.latest()
  ui.touch('touchstart')
  ui.touch('touchend', 210, 120)
  expect(ui.reading).toBe(false)
  ui.touch('touchstart')
  ui.touch('touchcancel')
  ui.touch('touchend', 100, 210)
  expect(ui.reading).toBe(false)
  ui.controller.update(false, true)
  ui.touch('touchstart')
  ui.touch('touchend', 100, 210)
  expect(ui.reading).toBe(false)
  ui.controller.update(true, true)
  ui.touch('touchstart')
  ui.touch('touchend', 100, 210)
  expect(ui.reading).toBe(true)
})

test('the composer handle can be tapped or dragged down and released', () => {
  const ui = transcript()
  const start = { pointerId:1, isPrimary:true, button:0, clientX:60, clientY:500 }
  ui.foldHandle.onpointerdown(start)
  ui.foldHandle.onpointerup({ ...start, clientX:95, clientY:510 })
  ui.foldHandle.onclick({detail:1})
  expect(ui.reading).toBe(false)
  ui.foldHandle.onpointerdown(start)
  expect(ui.reading).toBe(false)
  ui.foldHandle.onpointerup({ ...start, clientY:525 })
  expect(ui.reading).toBe(true)
  ui.write.onclick()
  ui.foldHandle.onclick({detail:0})
  expect(ui.reading).toBe(true)
})

test('manually folding and reopening at the live edge keeps following new output', () => {
  const ui = transcript()
  ui.foldHandle.onclick({detail:0})
  expect(ui.reading).toBe(true)
  ui.write.onclick()
  expect(ui.reading).toBe(false)
  expect(ui.jump.hidden).toBe(true)
  ui.chat.scrollHeight += 200
  ui.controller.keepLatest()
  expect(ui.chat.scrollTop).toBe(ui.bottom)
})

test('Latest opens the editor and pins the bottom without focusing the draft', () => {
  const ui = transcript()
  ui.scrollBack(300)
  ui.document.activeElement = ui.jump
  ui.jump.onclick()
  expect(ui.reading).toBe(false)
  expect(ui.jump.hidden).toBe(true)
  expect(ui.document.activeElement).toBe(ui.chat)
  expect(ui.chat.scrollTop).toBe(ui.bottom)
  ui.seat.height += 40
  ui.resize()
  expect(ui.chat.scrollTop).toBe(ui.bottom)
  ui.chat.scrollHeight += 100
  ui.controller.keepLatest()
  expect(ui.chat.scrollTop).toBe(ui.bottom)
})

test('a pending question can replace the compact composer without snapping to the latest', () => {
  const ui = transcript()
  ui.scrollBack(300)
  ui.document.activeElement = ui.write
  const top = ui.chat.scrollTop
  ui.controller.update(false, true)
  expect(ui.reading).toBe(false)
  expect(ui.write.inert).toBe(true)
  expect(ui.document.activeElement).toBe(ui.chat)
  expect(ui.jump.hidden).toBe(false)
  expect(ui.chat.scrollTop).toBe(top)
  ui.controller.update(true, false)
  expect(ui.reading).toBe(true)
  expect(ui.write).toMatchObject({ ariaLabel:'Open composer', textContent:'Message…' })
})
