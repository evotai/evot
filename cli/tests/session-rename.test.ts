import { describe, expect, test } from 'bun:test'
import stripAnsi from 'strip-ansi'
import { editSessionName, sessionNameError } from '../src/term/app/session-rename-editor.js'
import { saveSessionRename } from '../src/term/app/session-rename.js'
import { ResumeSessionCache } from '../src/term/app/resume-cache.js'
import { formatSessionItems } from '../src/term/app/resume.js'
import { createResumeWindow } from '../src/term/app/selector-windows.js'
import { handleSelectorControl } from '../src/term/app/selector-control.js'
import { selectorType, type SelectorState } from '../src/term/selector.js'
import { buildSelectorRegionLines } from '../src/term/viewmodel/selector.js'
import type { SessionMeta } from '../src/native/contracts/results.js'

const session: SessionMeta = { session_id: 's1', title: 'Original task', cwd: '/work', model: 'test', turns: 2, created_at: '', updated_at: '' }
function window(): SelectorState { return createResumeWindow(formatSessionItems([session], '/work'), undefined, true) }
function editing(): SelectorState {
  const action = handleSelectorControl(window(), { type: 'char', char: 'e' })
  if (action.kind !== 'update') throw new Error('Expected editor')
  return action.state
}

describe('session name editor', () => {
  test('validates Unicode lengths, emptiness, multiline and terminal controls', () => {
    for (const value of ['', ' ', 'a\nb', '\x1b[31m', '中'.repeat(121)]) expect(sessionNameError(value)).toBeDefined()
    expect(sessionNameError('中'.repeat(120))).toBeUndefined()
    expect(sessionNameError('名字 😀')).toBeUndefined()
  })
  test('edits by Unicode scalar and isolates editing keys from selector operations', () => {
    let state = editing()
    expect(state.rename?.text).toBe('Original task')
    for (const event of [{ type: 'ctrl', key: 'u' }, { type: 'paste', text: '名字😀' }, { type: 'left' }, { type: 'delete' }] as const) {
      const action = handleSelectorControl(state, event)
      if (action.kind !== 'update') throw new Error('Expected editing')
      state = action.state
    }
    expect(state.rename?.text).toBe('名字')
    expect(handleSelectorControl(state, { type: 'ctrl', key: 'd' }).kind).toBe('update')
    const save = handleSelectorControl(state, { type: 'enter' })
    expect(save.kind).toBe('rename-session')
    if (save.kind !== 'rename-session') throw new Error('Expected save')
    expect(save.title).toBe('名字')
    expect(save.sessionId).toBe('s1')
    expect(save.state.rename?.saving).toBe(true)
    expect(handleSelectorControl(save.state, { type: 'enter' }).kind).toBe('update')
  })
  test('cancel restores query, focus and rows; empty lists cannot rename', () => {
    const original = { ...selectorType(window(), 'Original'), listFocused: true }
    const opened = handleSelectorControl(original, { type: 'char', char: 'e' })
    if (opened.kind !== 'update') throw new Error('Expected editor')
    const cancelled = handleSelectorControl(opened.state, { type: 'escape' })
    if (cancelled.kind !== 'update') throw new Error('Expected cancel')
    expect(cancelled.state.query).toBe(original.query)
    expect(cancelled.state.focusIndex).toBe(original.focusIndex)
    expect(cancelled.state.rename).toBeUndefined()
    expect(handleSelectorControl(createResumeWindow([], undefined, true), { type: 'char', char: 'e' })).toEqual({ kind: 'none' })
  })
  test('name validation keeps input for correction and saving prevents duplicate input', () => {
    const value = { sessionId: 's1', text: ' ', cursor: 1 }
    expect(editSessionName(value, { type: 'enter' }).kind).toBe('edit')
    const saving = { ...value, saving: true }
    expect(editSessionName(saving, { type: 'paste', text: 'other' })).toEqual({ kind: 'edit', value: saving })
  })
  test('renders lowercase shortcuts and prefilled editable title', () => {
    const list = buildSelectorRegionLines(window(), 120).map(stripAnsi).join('\n')
    expect(list).toContain('e rename')
    expect(list).not.toContain('ctrl+r')
    expect(list).toContain('enter')
    expect(list).not.toMatch(/Ctrl\+|Enter|Esc/)
    const editor = buildSelectorRegionLines(editing(), 80).map(stripAnsi).join('\n')
    expect(editor).toContain('Rename session')
    expect(editor).toContain('Original task')
    expect(editor).toContain('enter save · esc cancel')
  })
})

describe('rename effects and search caches', () => {
  test('success updates metadata, preview and full-text search, and preserves filter', async () => {
    let stored = session
    const client = {
      listSessions: async () => [stored],
      listSessionsWithText: async () => [{ ...stored, search_text: `${stored.custom_title ?? ''} Original task body`, user_prompts: [] }],
      sessionWithText: async () => ({ ...stored, search_text: `${stored.custom_title ?? ''} Original task body`, user_prompts: [] }),
    }
    const cache = new ResumeSessionCache(client)
    await cache.text()
    let current: SelectorState | undefined = editing()
    const token = { sessionId: 's1', text: 'Production alerts', cursor: 17, saving: true }
    current = { ...current, query: 'Production', rename: token }
    await saveSessionRename({
      renameSession: async (_, title) => { stored = { ...stored, custom_title: title }; return stored },
      current: () => current,
      publish: state => { current = state }, cache, cwd: '/work',
    }, token, token.text)
    expect(current?.rename).toBeUndefined()
    expect(current?.query).toBe('Production')
    expect(current?.items.find(item => item.id === 's1')?.preview?.[0]).toBe(token.text)
    expect(cache.metadata?.[0]?.custom_title).toBe(token.text)
    expect((await cache.text())[0]?.search_text).toContain(token.text)
  })
  test('failed save retains text and permits retry', async () => {
    const cache = new ResumeSessionCache({ listSessions: async () => [], listSessionsWithText: async () => [], sessionWithText: async () => null })
    const token = { sessionId: 's1', text: 'New title', cursor: 9, saving: true }
    let current: SelectorState = { ...window(), rename: token }
    await saveSessionRename({ renameSession: async () => { throw new Error('Disk full') }, current: () => current, publish: state => { current = state }, cache, cwd: '/work' }, token, token.text)
    expect(current.rename?.text).toBe('New title')
    expect(current.rename?.saving).toBe(false)
    expect(current.rename?.error).toBe('Disk full')
  })
  test('late completion does not reopen a closed selector', async () => {
    const cache = new ResumeSessionCache({ listSessions: async () => [session], listSessionsWithText: async () => [], sessionWithText: async () => null })
    let publishes = 0
    const token = { sessionId: 's1', text: 'New title', cursor: 9, saving: true }
    await saveSessionRename({ renameSession: async () => ({ ...session, custom_title: token.text }), current: () => undefined, publish: () => { publishes++ }, cache, cwd: '/work' }, token, token.text)
    expect(publishes).toBe(0)
  })
  test('in-flight metadata cannot roll back a successful rename', async () => {
    let resolve: (rows: SessionMeta[]) => void = () => {}
    const cache = new ResumeSessionCache({ listSessions: () => new Promise(done => { resolve = done }), listSessionsWithText: async () => [], sessionWithText: async () => null })
    cache.replace([session])
    const oldLoad = cache.all()
    cache.rename({ ...session, custom_title: 'Pinned' })
    resolve([session])
    await oldLoad
    expect(cache.metadata?.[0]?.custom_title).toBe('Pinned')
  })
})
