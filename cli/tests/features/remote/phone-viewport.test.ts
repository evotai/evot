import { expect, test } from 'bun:test'
import { fitConversationViewport } from '../../../src/features/remote/phone-viewport.js'

test('fit the Remote conversation to the visual viewport even when opening the keyboard leaves the layout unchanged', () => {
  const viewport = Object.assign(new EventTarget(), {height: 844, offsetTop: 0, scale: 1})
  const properties = new Map<string, string>()
  const conversation = {
    ownerDocument: {defaultView: {visualViewport: viewport}},
    style: {setProperty: properties.set.bind(properties), removeProperty: properties.delete.bind(properties)},
  }
  fitConversationViewport(conversation)
  expect(properties.get('--remote-viewport-height')).toBe('844px')
  viewport.height = 470.8
  viewport.dispatchEvent(new Event('resize'))
  viewport.offsetTop = 35
  viewport.dispatchEvent(new Event('scroll'))
  expect(properties.get('--remote-viewport-height')).toBe('470px')
  expect(properties.get('--remote-viewport-top')).toBe('35px')

  viewport.scale = 1.5
  viewport.dispatchEvent(new Event('resize'))
  expect(properties.size).toBe(0)
  viewport.scale = 1
  viewport.height = 844
  viewport.offsetTop = 0
  viewport.dispatchEvent(new Event('resize'))
  expect([...properties.values()]).toEqual(['844px', '0px'])
})
