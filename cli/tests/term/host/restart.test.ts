import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReplState } from '../../../src/term/host/state.js'
import { createRestartController, type RestartDeps } from '../../../src/term/host/restart.js'
import { PendingQueue } from '../../../src/term/app/queue/pending-queue.js'
import { RESTART_CHECKPOINT_ENV } from '../../../src/term/app/restart/checkpoint-file.js'
import type { ComposerSnapshot } from '../../../src/term/app/composer/snapshot.js'
import type { RemoteHandoff, RestartCheckpoint } from '../../../src/term/app/restart/checkpoint.js'
import { draft } from '../../helpers/prompt-queue.js'

let home = '', previousHome: string | undefined
beforeAll(() => { previousHome = process.env.EVOT_HOME; home = mkdtempSync(join(tmpdir(), 'evot-restart-host-')); process.env.EVOT_HOME = home })
afterAll(() => {
  if (previousHome === undefined) delete process.env.EVOT_HOME; else process.env.EVOT_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

const gateway: RemoteHandoff = { terminal: 'd97f1deb-3efd-4124-b055-22f688f82696', phoneScope: null, share: '88fe71b01c52125d1f09709e', gateway: true }

function harness({ installed = true } = {}) {
  const st = createReplState('fixture', '/fixture')
  st.sessionId = 'session-a'
  const queue = new PendingQueue(st.pendingQueue)
  const world = { background: 0, undelivered: 0, composer: draft('') as ComposerSnapshot }
  const calls = { restarted: [] as Record<string, string>[], dispatched: 0, notices: [] as string[], resumed: [] as (RemoteHandoff | null)[], restored: [] as ComposerSnapshot[] }
  const deps = {
    agent: { pendingProcessWakeNotifications: () => world.undelivered },
    installedBuild: { canRestartInPlace: () => installed, outdated: () => true },
    composer: { snapshot: () => world.composer, restore: (snapshot: ComposerSnapshot) => { calls.restored.push(snapshot) } },
    manualCompaction: { active: false },
    pendingImages: { awaiting: false },
    pendingQueue: queue,
    queueLifecycle: { dispatchNext: () => { calls.dispatched++ } },
    remoteCtl: { handoff: () => gateway, resume: async (previous: RemoteHandoff | null) => { calls.resumed.push(previous) } },
    renderer: { requestRender() {} },
    runCtl: { runInteractionInput: () => ({ active: st.isLoading, owner: st.isLoading ? 1 : null, backgroundTasks: world.background }) },
    scrollback: { commitSystem: (_id: string, text: string) => { calls.notices.push(text.trim()) } },
    restartAfterCleanup: (handoff: Record<string, string> = {}) => { calls.restarted.push(handoff) },
  } satisfies RestartDeps
  const restart = createRestartController(st, deps)
  const enqueue = (text: string, paused = false) => {
    const [entry] = queue.restore('session-a', [{ queue: 'follow_up', text, expandedText: text, snapshot: draft(text), paused }])
    return entry!
  }
  const checkpoint = (index = -1): RestartCheckpoint =>
    JSON.parse(readFileSync(calls.restarted.at(index)![RESTART_CHECKPOINT_ENV]!, 'utf8'))
  return { st, queue, world, calls, restart, enqueue, checkpoint }
}

test('idle: /restart hands the composer, queue and Remote role to the next image', async () => {
  const h = harness()
  h.world.composer = draft('unsent thought')
  h.enqueue('next task'); h.enqueue('later', true)
  h.restart.command('safe')
  expect(h.restart.holdsQueue()).toBe(true) // nothing dispatches into the handover gap
  expect(h.calls.restarted).toEqual([])
  await Bun.sleep(150)
  expect(h.calls.restarted).toHaveLength(1)
  const saved = h.checkpoint()
  expect(saved).toMatchObject({ version: 1, session: 'session-a', remote: gateway, draft: { text: 'unsent thought' } })
  expect(saved.queue.map(prompt => [prompt.text, prompt.paused])).toEqual([['next task', false], ['later', true]])
  // Handed over, so cleanup does not announce them as discarded.
  expect(h.queue.state.entries).toEqual([])
})

test('a running turn finishes first; the restart happens before the next queued message', async () => {
  const h = harness()
  h.st.isLoading = true
  h.enqueue('after the turn')
  h.restart.command('safe')
  expect(h.calls.notices.at(-1)).toContain('Restart scheduled after the current turn')
  expect(h.restart.holdsQueue()).toBe(false)
  expect(h.restart.control.status()).toMatchObject({ restart: 'pending', waitingFor: 'turn', session: 'session-a', outdated: true })
  h.restart.command('safe') // asking again neither repeats the notice nor restarts early
  expect(h.calls.notices.filter(text => text.includes('scheduled'))).toHaveLength(1)
  await Bun.sleep(600)
  expect(h.calls.restarted).toEqual([])
  h.st.isLoading = false
  expect(h.restart.holdsQueue()).toBe(true) // the settled run must not dispatch into the old image
  await Bun.sleep(700)
  expect(h.calls.restarted).toHaveLength(1)
  expect(h.checkpoint().queue.map(prompt => [prompt.text, prompt.paused])).toEqual([['after the turn', false]])
})

test('background tasks and their undelivered results keep the window on its build', async () => {
  const h = harness()
  h.world.background = 1
  expect(h.restart.control.request({ action: 'restart' })).toMatchObject({ accepted: true, status: { restart: 'pending', waitingFor: 'background' } })
  expect(h.calls.notices.at(-1)).toContain('Requested with evot restart')
  h.world.background = 0; h.world.undelivered = 1
  await Bun.sleep(600)
  expect(h.calls.restarted).toEqual([])
  h.world.undelivered = 0
  await Bun.sleep(700)
  expect(h.calls.restarted).toHaveLength(1)
})

test('cancel releases the queue; a window not started from an install refuses instead of exiting', async () => {
  const h = harness()
  h.st.isLoading = true
  h.restart.control.request({ action: 'restart' })
  expect(h.restart.control.request({ action: 'cancel' })).toMatchObject({ accepted: true, status: { restart: 'none' } })
  expect(h.calls.dispatched).toBe(1)
  h.st.isLoading = false
  await Bun.sleep(600)
  expect(h.calls.restarted).toEqual([])
  expect(h.restart.control.request({ action: 'cancel' }).accepted).toBe(false)

  const dev = harness({ installed: false })
  expect(dev.restart.control.request({ action: 'restart' })).toMatchObject({ accepted: false, status: { restart: 'none' } })
  dev.restart.command('safe')
  expect(dev.calls.notices.at(-1)).toContain('/restart now')
  await Bun.sleep(150)
  expect(dev.calls.restarted).toEqual([])
})

test('work that starts in the handover gap postpones the restart to its end', async () => {
  const h = harness()
  h.restart.command('safe')
  h.st.isLoading = true
  await Bun.sleep(150)
  expect(h.calls.restarted).toEqual([])
  expect(h.restart.control.status()).toMatchObject({ restart: 'pending', waitingFor: 'turn' })
  h.st.isLoading = false
  await Bun.sleep(700)
  expect(h.calls.restarted).toHaveLength(1)
})

test('/restart now interrupts at once and holds queued messages for the user', () => {
  const h = harness()
  h.st.isLoading = true
  h.enqueue('was waiting on the run')
  h.restart.command('now')
  expect(h.calls.restarted).toHaveLength(1)
  expect(h.checkpoint().queue.map(prompt => prompt.paused)).toEqual([true])
  // Not an installed build: the old behaviour, an exit, with nothing written.
  const dev = harness({ installed: false })
  dev.restart.command('now')
  expect(dev.calls.restarted).toEqual([{}])
})

test('the next image restores the draft and queue, resumes Remote, and continues only its own session', () => {
  const h = harness()
  const prompt = { queue: 'follow_up' as const, text: 'go on', expandedText: 'go on', paused: false, draft: { text: 'go on', cursorLine: 0, cursorCol: 5, chunks: [], images: [] } }
  const checkpoint: RestartCheckpoint = { version: 1, session: 'session-a', remote: gateway, draft: { ...prompt.draft, text: 'mine' }, queue: [prompt] }
  h.restart.restore({ checkpoint, error: null })
  expect(h.calls.restored.map(snapshot => snapshot.text)).toEqual(['mine'])
  expect(h.queue.visible('session-a').map(entry => [entry.text, entry.paused])).toEqual([['go on', false]])
  expect(h.calls.resumed).toEqual([gateway])
  expect(h.calls.dispatched).toBe(1)
  expect(h.calls.notices.at(-1)).toBe('Restarted on the installed build · restored the draft and 1 queued message.')

  const other = harness()
  other.restart.restore({ checkpoint: { ...checkpoint, session: 'another' }, error: null })
  expect(other.queue.visible('session-a').map(entry => entry.paused)).toEqual([true])
  other.restart.restore({ checkpoint: null, error: 'Restart checkpoint was already used.' })
  expect(other.calls.notices.at(-1)).toBe('Restart: Restart checkpoint was already used.')
})
