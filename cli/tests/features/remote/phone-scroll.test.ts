import { expect, test } from 'bun:test'
import { conversationScroll } from '../../../src/features/remote/phone-scroll.js'

function transcript(reducedMotion = false) {
  let resize = () => {}, reading = false, top = 0, time = 0, rafId = 0
  const frames = new Map<number, (time:number) => void>()
  const events = new Map<string, (event?: unknown) => void>(), seatEvents = new Map<string, (event:unknown) => void>()
  let composing = false
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
  const write = { focus() { document.activeElement = this }, ariaLabel: 'Open composer', title: 'Open composer', textContent: 'Message…', onclick() {} }
  const dock = { inert: true, contains(node: object | null) { return node === write } }
  const jump = { hidden: true, onclick() {} }
  const draft = { scrollTop:0, selectionStart:2, selectionEnd:2, closest:(s:string) => s === '#draft', value: 'A draft for later', focus() { document.activeElement = this } }
  const editor = { inert:false, contains(node:object | null) { return node === draft } }
  const seat = {
    height: 200,
    addEventListener(event:string, callback:(event:unknown) => void) { seatEvents.set(event,callback) },
    get offsetHeight() { return reading ? 60 : this.height },
    toggleAttribute(_name: string, value: boolean) {
      reading = value
      top = Math.min(top, Math.max(0, chat.scrollHeight - chat.clientHeight))
    },
  }
  const chat = {
    ownerDocument: document, scrollHeight: 2400, viewportHeight: 800,
    get clientHeight() { return this.viewportHeight - seat.offsetHeight },
    get scrollTop() { return top },
    set scrollTop(value: number) { top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)) },
    focus() { document.activeElement = this },
    addEventListener(event: string, callback: (event?: unknown) => void) { events.set(event, callback) },
  }
  const controller = conversationScroll({ chat, seat, editor, dock, write, jump, draft, isComposing:() => composing })
  controller.update(true, true)
  controller.latest()
  return {
    controller, chat, seat, editor, document, draft, dock, write, jump, events,
    get reading() { return reading },
    get bottom() { return Math.max(0, chat.scrollHeight - chat.clientHeight) },
    scrollTo(top: number) { chat.scrollTop = top; events.get('scroll')?.() },
    scrollBack(pixels: number) { this.scrollTo(this.bottom - pixels) },
    touch(event: string, x = 100, y = 100, rail?: {scrollHeight:number; clientHeight:number}) {
      const points = [{identifier:1, clientX:x, clientY:y}]
      events.get(event)?.(event === 'touchend' ? {changedTouches:points} : {touches:points, target:{closest: () => rail}})
    },
    composing(value:boolean) { composing = value },
    seatSwipe(target:object, dy:number, dx = 0, cancel = false) {
      const touch = {identifier:3,clientX:100,clientY:100}; let prevented = false
      seatEvents.get('touchstart')?.({target,touches:[touch]})
      if (cancel) seatEvents.get('touchcancel')?.({})
      seatEvents.get('touchend')?.({changedTouches:[{...touch,clientX:100+dx,clientY:100+dy}],cancelable:true,preventDefault(){prevented=true}})
      return prevented
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

test('scrolling into history preserves the draft and reading position through live updates; tapping reopens the editor', () => {
  const ui = transcript()
  ui.draft.focus(); ui.scrollBack(600)
  const top = ui.chat.scrollTop
  expect(ui.reading).toBe(true); expect(ui.document.activeElement).toBe(ui.chat)
  ui.chat.scrollHeight += 300; ui.controller.update(true,true); ui.controller.keepLatest()
  expect(ui.chat.scrollTop).toBe(top); expect(ui.editor.inert).toBe(true)
  ui.write.onclick()
  expect(ui.document.activeElement).toBe(ui.draft); expect(ui.draft.value).toBe('A draft for later')
  expect(ui.chat.scrollTop).toBe(top)
})

test('a reader keeps the rendered history even when the live tail rolls over; Latest paints only the newest frame', () => {
  const ui = transcript(true), painted:number[]=[]
  ui.controller.paintHistory(()=>painted.push(0))
  // Scroll position has moved but Safari has not delivered the scroll event yet.
  ui.chat.scrollTop -= 400
  ui.controller.paintHistory(()=>painted.push(1)); ui.controller.keepLatest()
  ui.events.get('scroll')?.(); const top=ui.chat.scrollTop
  ui.controller.paintHistory(()=>painted.push(2)); ui.resize()
  expect(painted).toEqual([0]); expect(ui.chat.scrollTop).toBe(top)
  ui.jump.onclick(); expect(painted).toEqual([0,2]); expect(ui.chat.scrollTop).toBe(ui.bottom)
  ui.scrollBack(600); ui.controller.paintHistory(()=>painted.push(3)); ui.controller.latest()
  expect(painted).toEqual([0,2]) // a different session must not replay the pending old frame
})

test('scrolling down to the live edge resumes painting without another server event', () => {
  const ui=transcript(); let paints=0
  ui.scrollBack(600); ui.controller.paintHistory(()=>{paints++;ui.chat.scrollHeight+=500})
  ui.scrollTo(ui.bottom); expect(paints).toBe(1); expect(ui.chat.scrollTop).toBe(ui.bottom)
})

test('a send folds and releases editor focus immediately, then follows streaming until the user scrolls back', () => {
  const ui = transcript()
  ui.scrollBack(45)
  ui.draft.focus()
  ui.controller.submitted({followLatest:true})
  expect(ui.reading).toBe(true)
  expect(ui.document.activeElement).toBe(ui.chat)
  expect(ui.dock.inert).toBe(false)
  expect(ui.chat.scrollTop).toBe(ui.bottom)
  ui.chat.scrollHeight += 300
  ui.controller.update(true, false)
  ui.controller.keepLatest()
  expect(ui.chat.scrollTop).toBe(ui.bottom)
  ui.scrollBack(600)
  ui.write.onclick()
  const top = ui.chat.scrollTop
  ui.controller.update(true, true) // A run snapshot must not fold a reopened draft.
  expect(ui.reading).toBe(false)
  expect(ui.document.activeElement).toBe(ui.draft)
  expect(ui.chat.scrollTop).toBe(top)
})

test('queue submission and failure recovery do not move history or reopen the keyboard', () => {
  const ui = transcript()
  ui.scrollBack(600)
  ui.write.onclick()
  const top = ui.chat.scrollTop
  ui.controller.submitted({followLatest:false})
  expect(ui.reading).toBe(true)
  expect(ui.chat.scrollTop).toBe(top)
  ui.controller.update(true, true)
  ui.controller.openComposer()
  expect(ui.reading).toBe(false)
  expect(ui.chat.scrollTop).toBe(top)
  expect(ui.document.activeElement).toBe(ui.chat)
  expect(ui.draft.value).toBe('A draft for later')
})

test('small scrolls do not flash controls; a folded composer stays folded through layout, streaming and more scrolling', () => {
  const ui = transcript()
  ui.scrollBack(26)
  expect(ui.reading).toBe(false)
  expect(ui.jump.hidden).toBe(true)
  ui.scrollBack(80)
  expect(ui.reading).toBe(true)
  expect(ui.dock.inert).toBe(false)
  expect(ui.write).toMatchObject({ ariaLabel:'Resume draft', textContent:'Resume draft…' })
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

test('a shorter transcript viewport follows the latest only when already following', () => {
  const ui = transcript()
  ui.chat.viewportHeight -= 140
  ui.resize()
  expect(ui.chat.scrollTop).toBe(ui.bottom)
  ui.scrollBack(400)
  const top = ui.chat.scrollTop
  ui.chat.viewportHeight -= 140
  ui.resize()
  expect(ui.chat.scrollTop).toBe(top)
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

test('swipe the draft down and the dock up without focusing or leaving history', () => {
  const ui = transcript(); ui.scrollBack(600); ui.write.onclick(); const top = ui.chat.scrollTop
  expect(ui.seatSwipe(ui.draft,42)).toBe(true); expect(ui.reading).toBe(true)
  expect(ui.seatSwipe(ui.write,-48)).toBe(true); expect(ui.reading).toBe(false)
  expect(ui.document.activeElement).toBe(ui.chat); expect(ui.chat.scrollTop).toBe(top)
  expect(ui.draft.value).toBe('A draft for later'); expect(ui.draft.selectionStart).toBe(2)
})

test('composer swipes leave taps, sideways movement, native editing, and questions alone', () => {
  const ui = transcript(); ui.draft.focus()
  expect(ui.seatSwipe(ui.draft,12)).toBe(false); expect(ui.seatSwipe(ui.draft,30,60)).toBe(false)
  expect(ui.seatSwipe(ui.draft,50,0,true)).toBe(false)
  ui.draft.scrollTop=35; expect(ui.seatSwipe(ui.draft,50)).toBe(false); ui.draft.scrollTop=0
  ui.draft.selectionEnd=5; expect(ui.seatSwipe(ui.draft,50)).toBe(false); ui.draft.selectionEnd=2
  ui.composing(true); expect(ui.seatSwipe(ui.draft,50)).toBe(false); ui.composing(false)
  ui.controller.update(false,true); expect(ui.seatSwipe(ui.draft,50)).toBe(false); expect(ui.reading).toBe(false)
})

test('a downward drag folds before release and streaming does not pull history back to the bottom', () => {
  const ui = transcript()
  ui.touch('touchstart')
  ui.touch('touchmove', 102, 114)
  ui.scrollBack(14)
  expect(ui.reading).toBe(false)
  ui.touch('touchend', 102, 114)
  ui.scrollBack(120) // Momentum from the short swipe must not fold.
  expect(ui.reading).toBe(false)
  ui.scrollTo(ui.bottom)
  ui.touch('touchstart')
  ui.touch('touchmove', 104, 128) // Native scroll hasn't fired yet.
  expect(ui.reading).toBe(true)
  expect(ui.editor.inert).toBe(true)
  expect(ui.jump.hidden).toBe(false)
  const top = ui.chat.scrollTop
  ui.chat.scrollHeight += 250
  ui.controller.keepLatest()
  ui.resize()
  expect(ui.chat.scrollTop).toBe(top)
  ui.touch('touchend', 104, 128)
  expect(ui.reading).toBe(true)
  ui.write.onclick()
  ui.scrollBack(300)
  expect(ui.reading).toBe(false)
})

test('short conversations fold on a downward pull without intercepting horizontal, nested or question gestures', () => {
  const ui = transcript()
  ui.chat.scrollHeight = 300
  ui.controller.latest()
  ui.touch('touchstart')
  ui.touch('touchmove', 210, 135)
  expect(ui.reading).toBe(false)
  ui.touch('touchcancel')
  ui.touch('touchmove', 100, 140)
  expect(ui.reading).toBe(false)
  ui.touch('touchstart', 100, 100, {scrollHeight:300, clientHeight:100})
  ui.touch('touchmove', 100, 140)
  expect(ui.reading).toBe(false)
  ui.controller.update(false, true)
  ui.touch('touchstart')
  ui.touch('touchmove', 100, 140)
  expect(ui.reading).toBe(false)
  ui.controller.update(true, true)
  ui.touch('touchstart')
  ui.touch('touchmove', 100, 140)
  expect(ui.reading).toBe(true)
  expect(ui.jump.hidden).toBe(true)
  ui.chat.scrollHeight = 1800
  ui.controller.keepLatest()
  expect(ui.chat.scrollTop).toBe(ui.bottom)
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
  expect(ui.dock.inert).toBe(true)
  expect(ui.document.activeElement).toBe(ui.chat)
  expect(ui.jump.hidden).toBe(false)
  expect(ui.chat.scrollTop).toBe(top)
  ui.controller.update(true, false)
  expect(ui.reading).toBe(true)
  expect(ui.write).toMatchObject({ ariaLabel:'Open composer', textContent:'Message…' })
})
