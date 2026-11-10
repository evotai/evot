import { describe, expect, test } from 'bun:test'
import { RenderWakeup, type WakeupClock } from '../../../src/term/screen/render-wakeup.js'

function fixture() {
  const jobs: Array<{ callback: () => void; delay: number; cancelled: boolean }> = []
  let renders = 0
  const clock: WakeupClock = {
    schedule(callback, delay) {
      const job = { callback, delay, cancelled: false }
      jobs.push(job)
      return () => { job.cancelled = true }
    },
  }
  return { wakeup: new RenderWakeup(() => renders++, clock), jobs, renders: () => renders }
}

describe('render wakeup lifetime', () => {
  test('replacement cancels the previous timer and rejects a stale callback', () => {
    const f = fixture()
    f.wakeup.replace(80)
    f.wakeup.replace(45_000)
    expect(f.jobs.map(job => job.delay)).toEqual([80, 45_000])
    expect(f.jobs[0]?.cancelled).toBe(true)
    f.jobs[0]?.callback()
    expect(f.renders()).toBe(0)
    f.jobs[1]?.callback()
    f.jobs[1]?.callback()
    expect(f.renders()).toBe(1)
  })

  test('hidden content clears its timer without a replacement', () => {
    const f = fixture()
    f.wakeup.replace(80)
    f.wakeup.replace(null)
    expect(f.jobs).toHaveLength(1)
    expect(f.jobs[0]?.cancelled).toBe(true)
    f.jobs[0]?.callback()
    expect(f.renders()).toBe(0)
  })

  test('disposal is terminal and idempotent', () => {
    const f = fixture()
    f.wakeup.replace(80)
    f.wakeup.dispose()
    f.wakeup.dispose()
    f.wakeup.replace(1)
    f.jobs[0]?.callback()
    expect(f.jobs).toHaveLength(1)
    expect(f.jobs[0]?.cancelled).toBe(true)
    expect(f.renders()).toBe(0)
  })

  test('a completed wakeup can schedule its next deadline', () => {
    const f = fixture()
    f.wakeup.replace(80)
    f.jobs[0]?.callback()
    f.wakeup.replace(900)
    f.jobs[1]?.callback()
    expect(f.renders()).toBe(2)
  })
})
