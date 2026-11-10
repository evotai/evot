import { readdirSync } from 'node:fs'
import stripAnsi from 'strip-ansi'
import { describe, expect, test } from 'bun:test'
import { handleSelectorControl } from '../../../src/term/app/selector/selector-control.js'
import { createAppSelectorState, isBackgroundSelector, isCommandSelector, SELECTOR_OWNER } from '../../../src/ui/selector-identity.js'
import { createQueueSelectorState } from '../../../src/term/app/queue/queue-manage.js'
import { createSkillSelectorState } from '../../../src/term/app/selector/skill-window.js'
import { createBackgroundPanelState, createBackgroundOutputState, refreshBackgroundPanelState, refreshBackgroundOutputState } from '../../../src/term/app/background/background-panel.js'
import { createSelectorState, selectorClearQuery, selectorExpandItems, selectorRemoveItem, selectorType } from '../../../src/ui/selector.js'
import { buildOverlayBlocks } from '../../../src/term/viewmodel/overlays.js'
import { blocksToLines } from '../../../src/term/viewmodel/types.js'
import type { BackgroundProcess } from '../../../src/native/index.js'

const items = [{ id: 'provider:model', label: 'Model' }]
const enter = { type: 'enter' } as const
const remove = { type: 'delete' } as const

const process: BackgroundProcess = {
  task_id: 'task-1', command: 'sleep 30', cwd: '/tmp', output_path: '/tmp/output',
  status: 'running', exit_code: null, elapsed_ms: 10,
  output_file_truncated: false, stopped_by_user: false,
}

describe('selector ownership boundary', () => {
  test('display titles and model presentation cannot grant business behavior', () => {
    for (const title of ['Models', 'Select model', 'Resume session', 'Prompt queue', 'Skills', 'Background', 'Background output']) {
      for (const owner of [undefined, Symbol('model')]) {
        const state = { ...createSelectorState(title, items), owner, presentation: 'model' as const }
        expect(handleSelectorControl(state, enter)).toEqual({ kind: 'none' })
        expect(handleSelectorControl(state, remove)).toEqual({ kind: 'none' })
        expect(handleSelectorControl(state, { type: 'ctrl', key: 'd' })).toEqual({ kind: 'none' })
        expect(isCommandSelector(state)).toBe(false)
        expect(isBackgroundSelector(state)).toBe(false)
      }
    }
  })

  test('model and resume actions depend on ownership even with conflicting titles', () => {
    const model = createAppSelectorState('model', 'Resume session', items)
    expect(handleSelectorControl(model, enter)).toEqual({ kind: 'select-model', spec: 'provider:model' })
    expect(handleSelectorControl(model, remove)).toEqual({ kind: 'none' })
    const resume = createAppSelectorState('resume', 'Models', items)
    expect(handleSelectorControl(resume, enter)).toEqual({ kind: 'resume', sessionId: 'provider:model' })
    const armed = handleSelectorControl(resume, remove)
    expect(armed.kind).toBe('update')
    if (armed.kind !== 'update') return
    const confirmed = handleSelectorControl({ ...armed.state, title: 'Renamed again' }, remove)
    expect(confirmed.kind).toBe('delete-session')
  })

  test('queue factory retains actions and footer after renaming', () => {
    const entry = { queue: 'follow_up' as const, id: 'q1', version: 1, text: 'later' }
    const state = { ...createQueueSelectorState([entry]), title: 'Models' }
    expect(state.owner).toBe(SELECTOR_OWNER.queue)
    expect(handleSelectorControl(state, enter)).toEqual({ kind: 'queue-edit', entry })
    expect(handleSelectorControl(state, remove).kind).toBe('queue-remove')
    expect(handleSelectorControl(state, { type: 'char', char: 'x' }).kind).toBe('none')
    const text = blocksToLines(buildOverlayBlocks({ kind: 'selector', state }, 80)).join('\n')
    expect(stripAnsi(text)).toContain('ctrl+d remove')
    const generic = createSelectorState('Prompt queue', items)
    const genericText = blocksToLines(buildOverlayBlocks({ kind: 'selector', state: generic }, 80)).join('\n')
    expect(stripAnsi(genericText)).not.toContain('ctrl+d remove')
  })

  test('informational and background factories never dispatch generic business actions', () => {
    for (const state of [
      createSkillSelectorState([{ name: 'review', dir: '/skills/review' }]),
      createBackgroundPanelState([process]),
      createBackgroundOutputState(process, 'hello'),
    ]) {
      const renamed = { ...state, title: 'Resume session' }
      expect(handleSelectorControl(renamed, enter)).toEqual({ kind: 'none' })
      expect(handleSelectorControl(renamed, remove)).toEqual({ kind: 'none' })
    }
  })

  test('refresh, filtering, clearing and removal preserve opaque ownership', () => {
    let state = createAppSelectorState('resume', 'Any title', items, items, 'Model')
    expect(state.owner).toBe(SELECTOR_OWNER.resume)
    state = selectorType(state, 'x')
    expect(state.owner).toBe(SELECTOR_OWNER.resume)
    state = selectorExpandItems(state, items)
    expect(state.owner).toBe(SELECTOR_OWNER.resume)
    state = selectorClearQuery(state)
    expect(state.owner).toBe(SELECTOR_OWNER.resume)
    state = selectorRemoveItem(state, 0)
    expect(state.owner).toBe(SELECTOR_OWNER.resume)
    expect(isCommandSelector(state)).toBe(true)
  })

  test('background list and output remain distinct after refresh', () => {
    const list = refreshBackgroundPanelState({ ...createBackgroundPanelState([process]), title: 'Renamed' }, [process])
    const output = refreshBackgroundOutputState({ ...createBackgroundOutputState(process, ''), title: 'Renamed' }, process, 'new tail')
    expect(list.owner).toBe(SELECTOR_OWNER.background)
    expect(output.owner).toBe(SELECTOR_OWNER.backgroundOutput)
    expect(isBackgroundSelector(list)).toBe(true)
    expect(isBackgroundSelector(output)).toBe(true)
    expect(isCommandSelector(output)).toBe(false)
  })

  test('empty unowned lists fail closed while owned actionable lists can close', () => {
    expect(handleSelectorControl(createSelectorState('Models', []), enter)).toEqual({ kind: 'none' })
    expect(handleSelectorControl(createAppSelectorState('model', 'Models', []), enter)).toEqual({ kind: 'close' })
  })

  test('routing sources do not reintroduce title-based identity', async () => {
    for (const path of ['repl.ts', 'app/selector/selector-control.ts', 'app/background/background-terminals.ts', 'viewmodel/overlays.ts', 'viewmodel/selector.ts']) {
      const source = await Bun.file(new URL(`../../../src/term/${path}`, import.meta.url)).text()
      expect(source).not.toMatch(/\b(?:state|overlay\.state|action\.state)\.title\s*(?:===|!==|\.startsWith\()/)
      expect(source).not.toMatch(/is\w*(?:Selector|Panel|Output)Title\(/)
    }
    const hostDir = new URL('../../../src/term/host/', import.meta.url)
    const hostFiles = readdirSync(hostDir).filter(name => name.endsWith('.ts')).map(name => new URL(name, hostDir))
    for (const url of [new URL('../../../src/term/repl.ts', import.meta.url), ...hostFiles]) {
      const source = await Bun.file(url).text()
      expect(source).not.toMatch(/\b(?:state|overlay\.state|action\.state)\.title\s*(?:===|!==|\.startsWith\()/)
      expect(source).not.toMatch(/is\w*(?:Selector|Panel|Output)Title\(/)
      expect(source).not.toMatch(/\.presentation\s*===\s*['"]model['"]/)
    }
    const generic = await Bun.file(new URL('../../../src/ui/selector.ts', import.meta.url)).text()
    expect(generic).not.toContain('selector-identity')
    expect(generic).not.toContain('SELECTOR_OWNER')
  })
})
