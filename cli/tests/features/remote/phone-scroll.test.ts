import { expect, test } from 'bun:test'
import { conversationScroll } from '../../../src/features/remote/phone-scroll.js'

function transcript(reducedMotion = false) {
  let resize = () => {}, reading = false, top = 0
  const events = new Map<string, () => void>()
  const moves: {top:number; behavior:string}[] = []
  const document = {
    activeElement: null as object | null,
    defaultView: {
      matchMedia: () => ({matches:reducedMotion}),
      ResizeObserver: class {
        constructor(callback: () => void) { resize = callback }
        observe() {}
      },
    },
  }
  const write = {
    hidden: true, ariaLabel: 'Open composer', title: 'Open composer', hasDraft: false,
    toggleAttribute(_name: string, value: boolean) { this.hasDraft = value },
    onclick() {},
  }
  const jump = { hidden: true, onclick() {} }
  const draft = { value: 'A draft for later', focus() { document.activeElement = this } }
  const actions = { contains(node: object | null) { return node === write || node === jump } }
  const seat = {
    height: 200,
    contains(node: object | null) { return node === draft || actions.contains(node) },
    get offsetHeight() { return reading ? 60 : this.height },
    toggleAttribute(_name: string, value: boolean) { reading = value },
  }
  const chat = {
    ownerDocument: document, scrollHeight: 2400,
    get clientHeight() { return 800 - seat.offsetHeight },
    get scrollTop() { return top },
    set scrollTop(value: number) { top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)) },
    focus() { document.activeElement = this },
    addEventListener(event: string, callback: () => void) { events.set(event, callback) },
    scrollTo(move: {top:number; behavior:string}) { moves.push(move) },
  }
  const controller = conversationScroll({ chat, seat, actions, write, jump, draft })
  controller.update(true, true)
  controller.latest()
  return {
    controller, chat, seat, document, draft, write, jump, moves, events,
    get reading() { return reading },
    scrollTo(top: number) { chat.scrollTop = top; events.get('scroll')?.() },
    scrollBack(pixels: number) { this.scrollTo(chat.scrollHeight - chat.clientHeight - pixels) },
    resize() { resize() },
  }
}

test('folds without moving the transcript and ignores live updates until the reader returns', () => {
  const ui = transcript()
  ui.scrollBack(180)
  expect(ui.reading).toBe(false) // Stop following immediately, fold once there is room.
  expect(ui.jump.hidden).toBe(false)
  ui.scrollBack(220)
  expect(ui.reading).toBe(true)
  expect(ui.write).toMatchObject({ hidden: false, ariaLabel: 'Resume draft', hasDraft:true })
  expect(ui.jump.hidden).toBe(false)
  const top = ui.chat.scrollTop
  expect(top).toBe(1580)
  ui.chat.scrollHeight += 100
  ui.controller.keepLatest()
  ui.resize()
  expect(ui.chat.scrollTop).toBe(top)

  ui.scrollBack(8)
  expect(ui.reading).toBe(false)
  expect(ui.jump.hidden).toBe(true)
  expect(ui.chat.scrollTop + ui.chat.clientHeight).toBe(ui.chat.scrollHeight)
  ui.seat.height += 40
  ui.resize()
  expect(ui.chat.scrollTop + ui.chat.clientHeight).toBe(ui.chat.scrollHeight)
})

test('restores draft focus in place, leaves active controls alone, and jumps without opening the editor', () => {
  const ui = transcript()
  ui.draft.focus()
  ui.scrollBack(300)
  expect(ui.reading).toBe(false)
  expect(ui.jump.hidden).toBe(false)
  ui.chat.focus()
  ui.scrollBack(360)
  expect(ui.reading).toBe(true)
  const top = ui.chat.scrollTop
  ui.write.onclick()
  expect(ui.reading).toBe(false)
  expect(ui.document.activeElement).toBe(ui.draft)
  expect(ui.draft.value).toBe('A draft for later')
  expect(ui.chat.scrollTop).toBe(top)

  ui.document.activeElement = ui.jump
  ui.jump.onclick()
  expect(ui.document.activeElement).toBe(ui.chat)
  expect(ui.jump.hidden).toBe(true)
  expect(ui.chat.scrollTop).toBe(top)
  expect(ui.moves).toEqual([{top:ui.chat.scrollHeight - ui.chat.clientHeight, behavior:'smooth'}])
})

test('Latest scrolls to the expanded bottom and follows only after arriving', () => {
  const ui = transcript()
  ui.scrollBack(300)
  ui.jump.onclick()
  const firstTarget = ui.chat.scrollHeight - ui.chat.clientHeight
  expect(ui.reading).toBe(false)
  expect(ui.moves).toEqual([{top:firstTarget, behavior:'smooth'}])
  ui.scrollTo(firstTarget - 100)
  ui.chat.scrollHeight += 50
  ui.controller.keepLatest()
  ui.resize()
  expect(ui.chat.scrollTop).toBe(firstTarget - 100)
  ui.scrollTo(firstTarget)
  expect(ui.moves[1]).toEqual({top:firstTarget + 50, behavior:'smooth'})
  ui.scrollTo(firstTarget + 50)
  ui.chat.scrollHeight += 100
  ui.controller.keepLatest()
  expect(ui.chat.scrollTop + ui.chat.clientHeight).toBe(ui.chat.scrollHeight)
})

test('manual input cancels Latest scrolling and reduced motion skips the animation', () => {
  const ui = transcript()
  ui.scrollBack(300)
  ui.jump.onclick()
  const top = ui.chat.scrollTop
  ui.events.get('wheel')?.()
  ui.controller.keepLatest()
  expect(ui.chat.scrollTop).toBe(top)
  expect(ui.jump.hidden).toBe(false)

  const reduced = transcript(true)
  reduced.scrollBack(300)
  reduced.jump.onclick()
  expect(reduced.moves).toEqual([])
  expect(reduced.chat.scrollTop + reduced.chat.clientHeight).toBe(reduced.chat.scrollHeight)
})

test('a pending question can replace the compact composer without snapping to the latest', () => {
  const ui = transcript()
  ui.scrollBack(300)
  ui.document.activeElement = ui.write
  const top = ui.chat.scrollTop
  ui.controller.update(false, true)
  expect(ui.reading).toBe(false)
  expect(ui.write.hidden).toBe(true)
  expect(ui.document.activeElement).toBe(ui.chat)
  expect(ui.jump.hidden).toBe(false)
  expect(ui.chat.scrollTop).toBe(top)
  ui.controller.update(true, false)
  expect(ui.reading).toBe(true)
  expect(ui.write).toMatchObject({ ariaLabel:'Open composer', hasDraft:false })
})
