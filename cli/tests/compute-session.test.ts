import { expect, test } from 'bun:test'
import { ComputeSession, type ComputeSessionApi, type ComputeSessionHost } from '../src/compute/session.js'
import type { SelectorState } from '../src/term/selector.js'
import type { ComputeMachine } from '../src/compute/types.js'
import { machine } from './helpers/compute-fixtures.js'

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

function harness(machines: ComputeMachine[], api: Partial<ComputeSessionApi> = {}) {
  let overlay: SelectorState | null = null
  const turns: Array<{ userLine: string; prompt: string }> = []
  const errors: string[] = []
  let rows = [...machines]
  const host: ComputeSessionHost = {
    isComputeOverlay: () => overlay !== null,
    computeOverlayState: () => overlay,
    showSelector: state => { overlay = state },
    currentSessionId: () => 's1',
    closeOverlay: () => { overlay = null },
    requestRender: () => {},
    notifyError: text => { errors.push(text) },
    notify: () => {},
    collectAnswers: async () => null,
    runComputeTurn: (userLine, prompt) => { turns.push({ userLine, prompt }) },
    cwd: () => '/work/evot',
    destroyed: () => false,
  }
  const session = new ComputeSession(host, {
    list: async () => rows,
    discover: async () => [],
    probe: async target => ({ target, check: { checked_at: '', status: 'ok', message: '' }, profile: null }),
    create: async () => { throw new Error('no create') },
    update: async (id, patch) => {
      rows = rows.map(row => row.id === id ? { ...row, ...patch } as ComputeMachine : row)
      return rows.find(row => row.id === id)!
    },
    delete: async id => { rows = rows.filter(row => row.id !== id); return true },
    check: async id => {
      const row = rows.find(r => r.id === id)!
      return { ...row, last_check: { checked_at: new Date().toISOString(), status: 'unreachable', message: 'Operation timed out' } }
    },
    ...api,
  })
  return { session, turns, errors, view: () => overlay }
}

test('/compute with no machines goes straight to adding one', async () => {
  const h = harness([])
  await h.session.command('/compute')
  expect(h.view()).toBeNull()
  expect(h.turns).toHaveLength(1)
  expect(h.turns[0]!.userLine).toBe('/compute')
  expect(h.turns[0]!.prompt).toContain('<command name="compute"')
  expect(h.turns[0]!.prompt).toContain('Project: evot')
  expect(h.session.unfinishedFlow()).toBe(false)
})

test('/compute with machines opens the list', async () => {
  const h = harness([machine(), machine({ id: 'm2', name: 'gpu-1' })])
  await h.session.command('/compute')
  await flush()
  expect(h.turns).toHaveLength(0)
  expect(h.view()?.items.map(row => row.label)).toEqual(['big-1', 'gpu-1'])
  expect(h.view()?.title).toBe('Compute')
})

test('space pauses, r records a failed check, d d deletes', async () => {
  const h = harness([machine(), machine({ id: 'm2', name: 'gpu-1' })])
  h.session.open()
  await flush()
  await h.session.handleKey({ type: 'char', char: ' ' })
  await flush()
  expect(h.view()?.items[0]?.status?.text).toBe('Paused')

  await h.session.handleKey({ type: 'char', char: 'r' })
  await flush()
  expect(h.errors).toEqual(['big-1: Operation timed out'])
  expect(h.view()?.items[0]?.preview).toContain('# Latest issue')

  await h.session.handleKey({ type: 'char', char: 'd' })
  expect(h.view()?.subtitle).toBe('Press d again to delete')
  await h.session.handleKey({ type: 'char', char: 'd' })
  await flush()
  expect(h.view()?.items.map(row => row.label)).toEqual(['gpu-1'])
})

test('e closes the list and starts an edit turn; n starts discovery', async () => {
  const h = harness([machine()])
  h.session.open()
  await flush()
  await h.session.handleKey({ type: 'char', char: 'e' })
  expect(h.view()).toBeNull()
  expect(h.turns[0]!.userLine).toBe('/compute edit big-1')
  expect(h.turns[0]!.prompt).toContain('Edit compute machine m1.')

  h.session.open()
  await flush()
  await h.session.handleKey({ type: 'char', char: 'n' })
  expect(h.turns[1]!.userLine).toBe('/compute')
  expect(h.turns[1]!.prompt).toContain('call compute_discover first')
})

test('an unfinished flow keeps its tools for follow-ups in the same session only', async () => {
  const h = harness([])
  h.session.create('/compute add box', 'add box')
  const extension = h.session.followUpExtension('s1')
  expect(extension).toBeDefined()
  expect(h.session.unfinishedFlow(extension)).toBe(true)
  expect(h.session.followUpExtension('other')).toBeUndefined()
  expect(h.session.cancelFlow()).toBe(false)
  h.session.create('/compute add box', 'add box')
  expect(h.session.cancelFlow()).toBe(true)
})
