import { expect, test } from 'bun:test'
import { conversationScroll } from '../../../src/features/remote/phone-scroll.js'

function transcript(reducedMotion = false) {
  let resize = () => {}, reading = false, top = 0, time = 0, rafId = 0
  const frames = new Map<number, (time:number) => void>()
  const events = new Map<string, (event?: unknown) => void>()
  const document = {
    activeElement: null as object | null,
    defaultView: {
      performance: {now: () => time}, matchMedia: () => ({matches:reducedMotion}),
      requestAnimationFrame(callback: (time:number) => void) { frames.set(++rafId, callback); return rafId },
      cancelAnimationFrame(id: number) { frames.delete(id) },
      ResizeObserver: class {
        constructor(callback: () => void) { resize = callback }
        observe() {}
      },
    },
  }
  const write = { inert: true, ariaLabel: 'Open composer', title: 'Open composer', textContent: 'Message…', onclick() {} }
  const jump = { hidden: true, onclick() {} }
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
  const controller = conversationScroll({ chat, seat, editor, write, jump, draft })
  controller.update(true, true)
  controller.latest()
  return {
    controller, chat, seat, editor, document, draft, write, jump, events,
    get reading() { return reading },
    get bottom() { return Math.max(0, chat.scrollHeight - chat.clientHeight) },
    scrollTo(top: number) { chat.scrollTop = top; events.get('scroll')?.() },
    scrollBack(pixels: number) { this.scrollTo(this.bottom - pixels) },
    touch(event: string, x = 100, y = 100, rail?: {scrollHeight:number; clientHeight:number}) {
      const points = [{identifier:1, clientX:x, clientY:y}]
      events.get(event)?.(event === 'touchend' ? {changedTouches:points} : {touches:points, target:{closest: () => rail}})
    },
    resize() { resize() },
    frame(ms: number) {
      time += ms
      const next = [...frames.values()]
      frames.clear()
      for (const callback of next) callback(time)
      events.get('scroll')?.()
    },
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
  expect(ui.jump.hidden).toBe(true)
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

test('arriving at the bottom stays folded; another upward pull reveals the preserved draft without focusing it', () => {
  const ui = transcript()
  ui.scrollBack(600)
  ui.scrollBack(170)
  ui.touch('touchstart', 100, 500)
  ui.scrollTo(ui.bottom)
  ui.touch('touchend', 105, 320)
  expect(ui.reading).toBe(true)
  ui.touch('touchstart', 100, 500)
  ui.touch('touchend', 105, 445)
  expect(ui.reading).toBe(false)
  expect(ui.document.activeElement).not.toBe(ui.draft)
  expect(ui.draft.value).toBe('A draft for later')
  expect(ui.jump.hidden).toBe(true)
  ui.chat.scrollHeight += 200
  ui.controller.keepLatest()
  expect(ui.chat.scrollTop).toBe(ui.bottom)
})

test('a continuous swipe can reveal after reaching the bottom, but not from a nested scroll rail', () => {
  const ui = transcript()
  ui.scrollBack(600)
  ui.scrollBack(60)
  ui.touch('touchstart', 100, 500)
  ui.scrollTo(ui.bottom)
  ui.touch('touchend', 105, 380)
  expect(ui.reading).toBe(false)
  // Resume desktop scrolling to fold again without inheriting touch momentum.
  ui.events.get('wheel')?.()
  ui.scrollBack(600)
  ui.scrollTo(ui.bottom)
  expect(ui.reading).toBe(true)
  for (const [x, y] of [[105,490], [220,445]]) {
    ui.touch('touchstart', 100, 500)
    ui.touch('touchend', x, y)
    expect(ui.reading).toBe(true)
  }
  ui.touch('touchstart', 100, 500, {scrollHeight:300, clientHeight:100})
  ui.touch('touchend', 105, 430)
  expect(ui.reading).toBe(true)
})

test('Latest eases to an advancing live edge while keeping the composer folded', () => {
  const ui = transcript()
  ui.scrollBack(600)
  const start = ui.chat.scrollTop
  ui.document.activeElement = ui.jump
  ui.jump.onclick()
  expect(ui.reading).toBe(true)
  expect(ui.jump.hidden).toBe(true)
  expect(ui.document.activeElement).toBe(ui.chat)
  expect(ui.chat.scrollTop).toBe(start)
  ui.frame(100)
  expect(ui.chat.scrollTop).toBeGreaterThan(start)
  expect(ui.chat.scrollTop).toBeLessThan(ui.bottom)
  ui.chat.scrollHeight += 40
  ui.controller.keepLatest()
  expect(ui.chat.scrollTop).toBeLessThan(ui.bottom)
  ui.frame(200)
  expect(ui.chat.scrollTop).toBe(ui.bottom)
  expect(ui.reading).toBe(true)
  expect(ui.editor.inert).toBe(true)
  ui.chat.scrollHeight += 100
  ui.controller.keepLatest()
  expect(ui.chat.scrollTop).toBe(ui.bottom)
  ui.write.onclick()
  expect(ui.reading).toBe(false)
  expect(ui.chat.scrollTop).toBe(ui.bottom)
})

test('manual scrolling interrupts Latest, and reduced motion scrolls once without reopening', () => {
  const ui = transcript()
  ui.scrollBack(600)
  ui.jump.onclick()
  ui.frame(100)
  ui.events.get('wheel')?.()
  const top = ui.chat.scrollTop
  ui.frame(300)
  expect(ui.chat.scrollTop).toBe(top)
  expect(ui.reading).toBe(true)
  expect(ui.jump.hidden).toBe(false)
  const reduced = transcript(true)
  reduced.scrollBack(600)
  reduced.jump.onclick()
  expect(reduced.reading).toBe(true)
  expect(reduced.chat.scrollTop).toBe(reduced.bottom)
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
