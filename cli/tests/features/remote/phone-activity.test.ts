import { expect, test } from 'bun:test'
import { registerActivityMarks } from '../../../src/features/remote/phone-activity.js'
import { SPINNER_INTERVAL_MS, spinnerFrames } from '../../../src/ui/activity-frames.js'

class Mark {
  isConnected = true
  running = true
  textContent = ''
  hasAttribute() { return this.running }
  connectedCallback() {}
  disconnectedCallback() {}
  attributeChangedCallback() {}
}

test('visible Remote marks show the TUI frames on one clock, independent of CSS motion', () => {
  const frames = spinnerFrames('darwin')
  let Element = Mark, tick: (() => void) | undefined, onVisibility: (() => void) | undefined
  let intersect: ((entries: {target:Mark; isIntersecting:boolean}[]) => void) | undefined
  let started = 0
  const document = {
    hidden: false,
    addEventListener(_name: string, fn: () => void) { onVisibility = fn },
    defaultView: {
      HTMLElement: Mark,
      customElements: { define(_name: string, element: typeof Mark) { Element = element } },
      IntersectionObserver: class {
        constructor(fn: typeof intersect) { intersect = fn }
        observe() {}
        unobserve() {}
      },
      setInterval(fn: () => void, delay: number) {
        expect(delay).toBe(SPINNER_INTERVAL_MS)
        tick = fn
        return ++started
      },
      clearInterval(id: number | undefined) { if (id !== undefined) tick = undefined },
    },
  }
  registerActivityMarks(document, frames)
  const run = new Element(), background = new Element()
  run.connectedCallback()
  background.connectedCallback()
  expect(tick).toBeUndefined()
  intersect?.([{target:run, isIntersecting:true}, {target:background, isIntersecting:true}])
  expect(started).toBe(1)
  const cycle = [run.textContent]
  for (let i = 1; i < frames.length; i++) {
    tick?.()
    expect(background.textContent).toBe(run.textContent)
    cycle.push(run.textContent)
  }
  expect(cycle).toEqual(frames)
  run.running = false
  run.attributeChangedCallback()
  expect(run.textContent).toBe('·')
  document.hidden = true
  onVisibility?.()
  expect(tick).toBeUndefined()
  document.hidden = false
  onVisibility?.()
  expect(tick).toBeDefined()
  background.disconnectedCallback()
  expect(tick).toBeUndefined()
})
