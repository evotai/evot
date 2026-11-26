import { expect, test } from 'bun:test'
import { fitConversationViewport } from '../../../src/features/remote/phone-viewport.js'

function fixture(phone = true) {
  const viewport = Object.assign(new EventTarget(), {height: 844, offsetTop: 0, scale: 1})
  const properties = new Map<string, string>(), attributes = new Set<string>()
  const doc = Object.assign(new EventTarget(), {activeElement: null as unknown,
    defaultView: {visualViewport: viewport, matchMedia: () => ({matches: phone})}})
  const conversation = {
    ownerDocument: doc,
    style: {setProperty: properties.set.bind(properties), removeProperty: properties.delete.bind(properties)},
    toggleAttribute: (name: string, on: boolean) => { if (on) attributes.add(name); else attributes.delete(name); return on },
  }
  fitConversationViewport(conversation)
  return { viewport, properties, attributes, doc }
}

test('fit the Remote conversation to the visual viewport even when opening the keyboard leaves the layout unchanged', () => {
  const { viewport, properties, attributes } = fixture()
  expect(properties.get('--remote-viewport-height')).toBe('844px')
  expect(attributes.has('data-tight')).toBe(false)
  viewport.height = 470.8
  viewport.dispatchEvent(new Event('resize'))
  expect(attributes.has('data-tight')).toBe(true) // keyboard open: the draft outranks the transcript
  viewport.offsetTop = 35
  viewport.dispatchEvent(new Event('scroll'))
  expect(properties.get('--remote-viewport-height')).toBe('470px')
  expect(properties.get('--remote-viewport-top')).toBe('35px')

  viewport.scale = 1.5
  viewport.dispatchEvent(new Event('resize'))
  expect(properties.size).toBe(0)
  expect(attributes.size).toBe(0)
  viewport.scale = 1
  viewport.height = 844
  viewport.offsetTop = 0
  viewport.dispatchEvent(new Event('resize'))
  expect([...properties.values()]).toEqual(['844px', '0px'])
})

test('a phone switches to the typing layout as the field gains focus, before the keyboard resizes the page', async () => {
  const draft = { tagName: 'DIV', isContentEditable: true }
  const phone = fixture()
  phone.doc.activeElement = draft
  phone.doc.dispatchEvent(new Event('focusin'))
  expect(phone.attributes.has('data-tight')).toBe(true) // the viewport is still full height
  phone.doc.activeElement = null
  phone.doc.dispatchEvent(new Event('focusout'))
  await new Promise(resolve => setTimeout(resolve, 1))
  expect(phone.attributes.has('data-tight')).toBe(false)

  const desktop = fixture(false) // a mouse or a wide tablet keeps its status line while typing
  desktop.doc.activeElement = draft
  desktop.doc.dispatchEvent(new Event('focusin'))
  expect(desktop.attributes.has('data-tight')).toBe(false)
})
