import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fixture from '../../fixtures/contracts/restart-checkpoint-v1.json'
import { composerSnapshot, decodeRestartCheckpoint, savedDraft, type RestartCheckpoint } from '../../../src/term/app/restart/checkpoint.js'
import { takeRestartCheckpoint, writeRestartCheckpoint } from '../../../src/term/app/restart/checkpoint-file.js'
import { restartWait, type RestartFacts } from '../../../src/term/app/restart/policy.js'
import { createPendingQueueState, PendingQueue } from '../../../src/term/app/queue/pending-queue.js'
import { draft } from '../../helpers/prompt-queue.js'

const homes: string[] = []
const home = () => { const dir = mkdtempSync(join(tmpdir(), 'evot-restart-')); homes.push(dir); return dir }
afterEach(() => { for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const idle: RestartFacts = { interaction: 'idle', question: false, undeliveredResults: 0, queueBusy: false, local: false }

test('a safe restart waits for work that lives only in this process, and never for ready queued messages', () => {
  expect(restartWait(idle)).toBeNull()
  expect(restartWait({ ...idle, interaction: 'active' })).toBe('turn')
  expect(restartWait({ ...idle, interaction: 'retrying' })).toBe('turn')
  expect(restartWait({ ...idle, interaction: 'compacting' })).toBe('turn')
  expect(restartWait({ ...idle, interaction: 'waiting-background' })).toBe('background')
  expect(restartWait({ ...idle, undeliveredResults: 1 })).toBe('background')
  expect(restartWait({ ...idle, interaction: 'waiting-loop' })).toBe('loop')
  expect(restartWait({ ...idle, queueBusy: true })).toBe('queue')
  expect(restartWait({ ...idle, local: true })).toBe('local')
  // A question outranks the turn it belongs to: that is what the user must act on.
  expect(restartWait({ ...idle, interaction: 'active', question: true })).toBe('question')
})

test('the v1 fixture reads back completely; unknown fields are ignored', () => {
  const checkpoint = decodeRestartCheckpoint(fixture)
  expect(checkpoint.remote).toEqual({ terminal: 'd97f1deb-3efd-4124-b055-22f688f82696', phoneScope: null, share: '88fe71b01c52125d1f09709e', gateway: true })
  expect(checkpoint.draft?.images[0]?.[1]).toEqual({ id: 1, base64: 'iVBORw0KGgo=', mediaType: 'image/png', filePath: '/tmp/shot.png' })
  expect(checkpoint.queue.map(prompt => [prompt.queue, prompt.paused, prompt.phoneDraftId ?? null])).toEqual([['follow_up', false, null], ['steering', true, 'draft-7']])
  expect(checkpoint).not.toHaveProperty('futureField')
})

test('the current writer produces exactly what the v1 reader accepts', () => {
  const snapshot = { ...draft('typed [Image #1]'), chunks: [[2, 'chunk']] as [number, string][],
    images: [[1, { id: 1, base64: 'AA==', mediaType: 'image/png' }]] as [number, { id: number; base64: string; mediaType: string }][] }
  const written: RestartCheckpoint = {
    version: 1, session: null, remote: { terminal: 'd97f1deb-3efd-4124-b055-22f688f82696', phoneScope: 'a'.repeat(24), share: 'off', gateway: false },
    draft: savedDraft(snapshot), queue: [{ queue: 'follow_up', text: 'x', expandedText: '<x/>', paused: false, draft: savedDraft(draft('x')) }],
  }
  const read = decodeRestartCheckpoint(JSON.parse(JSON.stringify(written)))
  expect(read).toEqual(written)
  // Undo and history positions are process-local; the restored composer starts fresh.
  expect(composerSnapshot(read.draft!)).toMatchObject({ text: 'typed [Image #1]', chunks: [[2, 'chunk']], undo: [], history: { index: 0, length: 0 } })
})

test('a missing, future or malformed version is refused as a whole', () => {
  const { version: _, ...unversioned } = fixture
  expect(() => decodeRestartCheckpoint(unversioned)).toThrow('Unsupported restart checkpoint version: null')
  expect(() => decodeRestartCheckpoint({ ...fixture, version: 2 })).toThrow('Unsupported restart checkpoint version: 2')
  expect(() => decodeRestartCheckpoint({ ...fixture, remote: { ...fixture.remote, terminal: '../evil' } })).toThrow('Remote handoff')
  expect(() => decodeRestartCheckpoint({ ...fixture, queue: [{ text: 'no kind' }] })).toThrow('queued message')
})

test('the checkpoint file is private, atomic, read once, and only taken from the restart directory', () => {
  const root = home()
  const path = writeRestartCheckpoint(root, decodeRestartCheckpoint(fixture))
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(statSync(join(root, 'restart')).mode & 0o777).toBe(0o700)
  expect(readdirSync(join(root, 'restart')).filter(name => name.endsWith('.tmp'))).toEqual([])
  expect(takeRestartCheckpoint(root, path).checkpoint?.session).toBe(fixture.session)
  expect(existsSync(path)).toBe(false)
  expect(takeRestartCheckpoint(root, path)).toEqual({ checkpoint: null, error: 'Restart checkpoint was already used.' })
  const outside = join(root, 'secret.json')
  writeFileSync(outside, JSON.stringify(fixture))
  expect(takeRestartCheckpoint(root, outside).error).toContain('outside the restart directory')
  expect(existsSync(outside)).toBe(true)
  expect(takeRestartCheckpoint(root, undefined)).toEqual({ checkpoint: null, error: null })
})

test('a corrupt checkpoint is reported and removed; an abandoned one is pruned by the next write', () => {
  const root = home()
  const path = writeRestartCheckpoint(root, decodeRestartCheckpoint(fixture))
  writeFileSync(path, '{"version":1')
  expect(takeRestartCheckpoint(root, path).error).toBeTruthy()
  expect(existsSync(path)).toBe(false)
  const abandoned = writeRestartCheckpoint(root, decodeRestartCheckpoint(fixture))
  const old = new Date(Date.now() - 2 * 24 * 3600_000)
  utimesSync(abandoned, old, old)
  writeRestartCheckpoint(root, decodeRestartCheckpoint(fixture))
  expect(existsSync(abandoned)).toBe(false)
})

test('restored messages rejoin in order; ready ones dispatch, paused ones wait for the user', () => {
  const queue = new PendingQueue(createPendingQueueState())
  const prompts = [
    { queue: 'follow_up' as const, text: 'A', expandedText: 'A', snapshot: draft('A'), paused: false },
    { queue: 'steering' as const, text: 'B', expandedText: 'B', snapshot: draft('B'), paused: true, phoneDraftId: 'p-1' },
  ]
  const [a, b] = queue.restore('session-a', prompts)
  expect(queue.visible('session-a')).toEqual([a!, b!])
  expect([a!.paused, b!.paused, b!.phoneDraftId]).toEqual([false, true, 'p-1'])
  expect(queue.next(queue.state.chain)).toBe(a)
  queue.remove(a!, a!.version)
  expect(queue.next(queue.state.chain)).toBeUndefined()
  expect(queue.restore('session-a', [])).toEqual([])
})
