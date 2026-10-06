import { expect, test } from 'bun:test'
import { BackgroundScheduler } from '../src/background/scheduler.js'
import { registerDashboard, type ServerState } from '../src/term/app/server.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

const owned: ServerState = { port: 8082, address: 'http://127.0.0.1:8082', channels: [], envFile: '/tmp/test.env', startedAt: 1, owned: true }

test('background jobs are single-flight and cancellable, with no late restart', async () => {
  const scheduler = new BackgroundScheduler()
  const pending = deferred<void>()
  let calls = 0
  let signal: AbortSignal | undefined
  scheduler.register({ name: 'slow', intervalMs: 60_000, immediate: false,
    run: async abort => { calls++; signal = abort; await pending.promise } })
  const first = scheduler.trigger('slow')
  const second = scheduler.trigger('slow')
  expect(first).toBe(second)
  await Promise.resolve()
  expect(calls).toBe(1)
  scheduler.dispose()
  expect(signal?.aborted).toBe(true)
  pending.resolve()
  await first
  await scheduler.trigger('slow')
  expect(calls).toBe(1)
})

test('one failed job does not stop others or prevent an explicit retry', async () => {
  const scheduler = new BackgroundScheduler()
  let errors = 0
  let good = 0
  scheduler.register({ name: 'bad', intervalMs: 60_000, immediate: false, run: () => { throw new Error('failed') }, onError: () => { errors++ } })
  scheduler.register({ name: 'good', intervalMs: 60_000, immediate: false, run: () => { good++ } })
  await Promise.all([scheduler.trigger('bad'), scheduler.trigger('good')])
  await scheduler.trigger('bad')
  expect(errors).toBe(2)
  expect(good).toBe(1)
  scheduler.dispose()
})

test('occupied port never publishes a dashboard; a later successful attempt does', async () => {
  const scheduler = new BackgroundScheduler()
  let available = false
  let current: ServerState | null = null
  let stops = 0
  const dispose = registerDashboard(scheduler, {
    attempt: async () => available ? owned : null,
    stop: async () => { stops++ }, publish: state => { current = state },
  })
  await scheduler.trigger('dashboard')
  expect(current).toBeNull()
  available = true
  await scheduler.trigger('dashboard')
  expect(current).toEqual(owned)
  dispose()
  expect(current).toBeNull()
  expect(stops).toBe(1)
  scheduler.dispose()
})

test('closing while binding prevents late dashboard publication and stops the acquired server', async () => {
  const scheduler = new BackgroundScheduler()
  const binding = deferred<ServerState | null>()
  const published: (ServerState | null)[] = []
  let stops = 0
  const dispose = registerDashboard(scheduler, {
    attempt: () => binding.promise, stop: async () => { stops++ }, publish: state => { published.push(state) },
  })
  const running = scheduler.trigger('dashboard')
  await Promise.resolve()
  dispose()
  binding.resolve(owned)
  await running
  expect(published).toEqual([null])
  expect(stops).toBeGreaterThan(0)
  scheduler.dispose()
})
