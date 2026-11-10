import { expect, test } from 'bun:test'
import { ManualCompaction, type ManualCompactionTask } from '../../../src/term/app/run/manual-compaction.js'

function fixture() {
  let aborts = 0
  const task: ManualCompactionTask = { phase: 'planning', result: async () => ({ status: 'nothing_to_compact' }), abort: () => { aborts++ } }
  return { task, aborts: () => aborts }
}

test('start failure leaves no active ownership and allows retry', async () => {
  const owner = new ManualCompaction()
  await expect(owner.run(() => { throw new Error('start failed') }, () => {}, async () => {})).rejects.toThrow('start failed')
  expect(owner.active).toBe(false)
  const f = fixture()
  await owner.run(() => f.task, () => expect(owner.phase).toBe('planning'), async () => {})
  expect(owner.active).toBe(false)
  expect(f.aborts()).toBe(0)
})

test('phase/presentation and result failures abort and release ownership', async () => {
  for (const failure of ['start-hook', 'result', 'rebuild']) {
    const owner = new ManualCompaction()
    const f = fixture()
    if (failure === 'result') f.task.result = async () => { throw new Error(failure) }
    await expect(owner.run(() => f.task, () => {
      if (failure === 'start-hook') throw new Error(failure)
    }, async () => { if (failure === 'rebuild') throw new Error(failure) })).rejects.toThrow(failure)
    expect(owner.active).toBe(false)
    expect(f.aborts()).toBe(1)
  }
})

test('manual summary activity is live, optional for old tasks, and cleared after completion', async () => {
  const owner = new ManualCompaction()
  const old = fixture()
  await owner.run(() => old.task, () => expect(owner.activity).toBeNull(), async () => {})
  let activity: 'waiting' | 'generating' = 'waiting'
  const task: ManualCompactionTask = {
    phase: 'local', get activity() { return activity }, abort() {},
    result: async () => {
      expect(owner.activity).toBe('waiting')
      activity = 'generating'
      expect(owner.activity).toBe('generating')
      return { status: 'nothing_to_compact' }
    },
  }
  await owner.run(() => task, () => {}, async () => {})
  expect(owner.activity).toBeNull()
})

test('ownership spans asynchronous rebuild and rejects overlapping starts', async () => {
  const owner = new ManualCompaction()
  const f = fixture()
  const rebuilding = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const run = owner.run(() => f.task, () => {}, async () => { rebuilding.resolve(); await finish.promise })
  await rebuilding.promise
  expect(owner.active).toBe(true)
  await expect(owner.run(() => { throw new Error('must not start') }, () => {}, async () => {})).rejects.toThrow('already running')
  owner.abort()
  expect(f.aborts()).toBe(1)
  expect(owner.active).toBe(true)
  finish.resolve()
  await run
  expect(owner.active).toBe(false)
  expect(owner.phase).toBeNull()
  owner.abort()
  expect(f.aborts()).toBe(1)
})
