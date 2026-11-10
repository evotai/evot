import { test, expect } from 'bun:test'
import { runInNewContext } from 'node:vm'

const url = (file: string) => new URL(`../../../src/app/assets/console/ui/${file}`, import.meta.url)
const source = await Bun.file(url('theme.js')).text()
const palette = await Bun.file(url('theme.css')).text()
const chat = await Bun.file(url('chat-theme.css')).text()
const trace = await Bun.file(url('trace-theme.css')).text()

function mount(saved: string | null, legacy: string | null = null, storageAvailable = true) {
  const data: Record<string, string> = {}
  let ready: (() => void) | undefined
  let observe: (() => void) | undefined
  const buttons: Array<{ dataset: Record<string, string>; textContent: string; attributes: Record<string, string>; click?: () => void; setAttribute: (key: string, value: string) => void; addEventListener: (event: string, handler: () => void) => void }> = []
  function addButton() {
    const attributes: Record<string, string> = {}
    const button = {
      dataset: {} as Record<string, string>, textContent: '', attributes,
      click: undefined as (() => void) | undefined,
      setAttribute(key: string, value: string) { attributes[key] = value },
      addEventListener(event: string, handler: () => void) { if (event === 'click') this.click = handler },
    }
    buttons.push(button)
    return button
  }
  const root = { dataset: {} as Record<string, string> }
  const document = {
    documentElement: root,
    body: {},
    addEventListener(event: string, handler: () => void) { if (event === 'DOMContentLoaded') ready = handler },
    querySelectorAll() { return buttons },
  }
  const window = {
    get localStorage() {
      if (!storageAvailable) throw new Error('storage disabled')
      return {
        getItem(key: string) { return key === 'evot-theme' ? saved : legacy },
        setItem(key: string, value: string) { data[key] = value },
      }
    },
  }
  class MutationObserver {
    constructor(callback: () => void) { observe = callback }
    observe() {}
  }
  runInNewContext(source, { document, window, MutationObserver })
  const beforeReady = root.dataset.theme
  ready?.()
  return { root, buttons, data, beforeReady, addButton, sync: () => observe?.() }
}

test('product palette is shared; chat and trace only own component styles', () => {
  expect(palette).toContain('--page: #151517;')
  expect(palette).toContain('--bg: #232324;')
  expect(palette).toContain('--ink: #f9fafb;')
  expect(palette).toContain(':root[data-theme="light"] {')
  expect(palette).toContain('--page: #ffffff;')
  expect(chat).toContain('var(--side-bg)')
  expect(chat).not.toContain('--page:')
  expect(trace).toContain('var(--ink)')
  expect(trace).not.toContain('--page:')
})

test('legacy chat preference applies before paint and works on dynamically mounted pages', () => {
  const page = mount(null, 'light')
  expect(page.beforeReady).toBe('light')
  const chat = page.addButton()
  page.sync()
  expect(chat.textContent).toBe('Dark mode')
  expect(chat.attributes['aria-pressed']).toBe('true')
  chat.click?.()
  expect(page.root.dataset.theme).toBeUndefined()
  expect(page.data['evot-theme']).toBe('dark')
  const models = page.addButton()
  page.sync()
  expect(models.textContent).toBe('Light mode')
  models.click?.()
  expect(page.root.dataset.theme).toBe('light')
  expect(chat.attributes['aria-label']).toBe('Switch to dark mode')
  expect(page.data['evot-theme']).toBe('light')
})

test('saved product preference takes priority; private browsing still toggles', () => {
  expect(mount('dark', 'light').beforeReady).toBeUndefined()
  const page = mount(null, null, false)
  const button = page.addButton()
  page.sync()
  button.click?.()
  expect(page.root.dataset.theme).toBe('light')
  expect(button.attributes['aria-pressed']).toBe('true')
})
