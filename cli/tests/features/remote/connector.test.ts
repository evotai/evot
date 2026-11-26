import { expect, test } from 'bun:test'
import { ConnectRetryable } from '../../../src/features/remote/cloud-connect.js'
import { superviseConnector } from '../../../src/features/remote/connector.js'

function processFixture() {
  const exit = Promise.withResolvers<void>()
  return { exit: exit.resolve, exited: exit.promise, kill: exit.resolve }
}

function delays() {
  const events: { ms: number; resume: () => void }[] = []
  return {
    events,
    wait(ms: number, signal: AbortSignal) {
      const { promise, resolve } = Promise.withResolvers<void>()
      events.push({ ms, resume: resolve })
      signal.addEventListener('abort', resolve, { once: true })
      return promise
    },
  }
}

const flush = () => new Promise(resolve => setImmediate(resolve))

test('a transient failure recovering a lost connector retries rather than giving up', async () => {
  const original = processFixture(), replacement = processFixture(), delay = delays()
  let registrations = 0, launches = 0, recovering = 0
  const failures: string[] = []
  const stop = superviseConnector({
    start: () => original, active: () => true, delay: delay.wait,
    recovering: () => { recovering++ }, failed: reason => failures.push(reason),
    refresh: async () => {
      if (++registrations < 3) throw new ConnectRetryable('temporarily unreachable')
      return () => { launches++; return replacement }
    },
  })
  try {
    original.exit()
    for (const [index, ms] of [12_000, 24_000, 48_000].entries()) {
      await flush()
      expect(delay.events[index]?.ms).toBe(ms)
      delay.events[index]?.resume()
    }
    await flush()
    expect({ registrations, launches, recovering, failures }).toEqual({ registrations: 3, launches: 1, recovering: 1, failures: [] })
  } finally { stop() }
})

test('a connector allocation that finishes after shutdown cannot relaunch', async () => {
  const original = processFixture(), delay = delays()
  const allocated = Promise.withResolvers<() => ReturnType<typeof processFixture>>()
  const entered = Promise.withResolvers<void>()
  let launches = 0
  const stop = superviseConnector({
    start: () => original, active: () => true, delay: delay.wait,
    recovering() {}, failed() {},
    refresh: () => { entered.resolve(); return allocated.promise },
  })
  original.exit(); await flush()
  delay.events[0]?.resume()
  await entered.promise
  stop()
  allocated.resolve(() => { launches++; return processFixture() })
  await flush()
  expect(launches).toBe(0)
})

test('shutdown cancels recovery and a registration denial is terminal', async () => {
  for (const cancel of [true, false]) {
    const original = processFixture(), delay = delays()
    const failures: string[] = []
    let registrations = 0
    const stop = superviseConnector({
      start: () => original, active: () => true, delay: delay.wait,
      recovering() {}, failed: reason => failures.push(reason),
      refresh: async () => { registrations++; throw Error('Remote disabled by administrator.') },
    })
    try {
      original.exit(); await flush()
      if (cancel) stop()
      else delay.events[0]?.resume()
      await flush()
      expect(registrations).toBe(cancel ? 0 : 1)
      expect(failures).toEqual(cancel ? [] : ['Remote disabled by administrator.'])
      expect(delay.events).toHaveLength(1)
    } finally { stop() }
  }
})
