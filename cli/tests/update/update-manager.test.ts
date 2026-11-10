import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { UpdateManager } from '../../src/update/manager.js'

const originalFetch = globalThis.fetch
let home = ''
let requestCount = 0

/** Force the next unforced check back onto the network. */
function expireCache(): void {
  const path = join(home, 'update-check.json')
  if (!existsSync(path)) return
  const cached = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  cached.checked_at = 0
  writeFileSync(path, JSON.stringify(cached))
}

interface GhRelease {
  draft: boolean
  prerelease: boolean
  name: string
  tag_name: string
  body: string | null
}

function release(tag: string): GhRelease {
  return {
    draft: false,
    prerelease: tag.includes('-beta.'),
    name: `evot ${tag.replace(/^v/, '')}`,
    tag_name: tag,
    body: null,
  }
}

function stubOk(releases: GhRelease[]) {
  globalThis.fetch = (async () => {
    requestCount++
    return new Response(releases[0]?.tag_name ?? '', { status: 200 })
  }) as typeof globalThis.fetch
}

function stubFailure() {
  globalThis.fetch = (async () => {
    requestCount++
    return new Response('rate limited', { status: 403 })
  }) as typeof globalThis.fetch
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'evot-manager-test-'))
  process.env.EVOT_HOME = home
  // These tests cover check scheduling only. Staging downloads through the
  // same global fetch and would pollute every request count here.
  process.env.EVOT_AUTO_DOWNLOAD = '0'
  requestCount = 0
})

afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.EVOT_HOME
  delete process.env.EVOT_AUTO_DOWNLOAD
  rmSync(home, { recursive: true, force: true })
})

describe('UpdateManager', () => {
  test('emits update-available once per version', async () => {
    stubOk([release('v2026.4.20')])
    const mgr = new UpdateManager('2026.4.13')
    const seen: string[] = []
    mgr.on('update-available', (info: { version: string }) => seen.push(info.version))

    await mgr.check({ force: true })
    await mgr.check({ force: true })

    expect(seen).toEqual(['2026.4.20'])
    mgr.cleanup()
  })

  test('background checks reuse the disk cache instead of the network', async () => {
    stubOk([release('v2026.4.20')])
    const mgr = new UpdateManager('2026.4.13')

    await mgr.check()
    await mgr.check()
    await mgr.check()

    expect(requestCount).toBe(1)
    mgr.cleanup()
  })

  test('pauses routine checks after repeated failures', async () => {
    stubFailure()
    const mgr = new UpdateManager('2026.4.13')

    // Ten attempts, but the scheduler pauses after MAX_CONSECUTIVE_FAILURES.
    for (let i = 0; i < 10; i++) await mgr.check()

    expect(mgr.failureCount).toBe(5)
    expect(mgr.backedOff).toBe(true)
    expect(requestCount).toBe(5)
    mgr.cleanup()
  })

  test('probes again after an hour and recovers on success', async () => {
    let now = 1_000
    stubFailure()
    const mgr = new UpdateManager('2026.4.13', () => now)
    for (let i = 0; i < 5; i++) await mgr.check()
    expect(requestCount).toBe(5)
    expect(mgr.backedOff).toBe(true)

    // Still in the pause window: no request.
    now += 60 * 60 * 1000 - 1
    await mgr.check()
    expect(requestCount).toBe(5)

    // At the boundary, a network probe is allowed and success resets backoff.
    now += 1
    stubOk([release('v2026.4.20')])
    await mgr.check()
    expect(requestCount).toBe(6)
    expect(mgr.failureCount).toBe(0)
    expect(mgr.backedOff).toBe(false)
    mgr.cleanup()
  })

  test('a failed recovery probe starts a new one-hour pause', async () => {
    let now = 1_000
    stubFailure()
    const mgr = new UpdateManager('2026.4.13', () => now)
    for (let i = 0; i < 5; i++) await mgr.check()

    now += 60 * 60 * 1000
    await mgr.check()
    expect(requestCount).toBe(6)
    expect(mgr.failureCount).toBe(6)
    expect(mgr.backedOff).toBe(true)

    await mgr.check()
    expect(requestCount).toBe(6)
    mgr.cleanup()
  })

  test('an explicit force still runs while the scheduler is paused', async () => {
    stubFailure()
    const mgr = new UpdateManager('2026.4.13')
    for (let i = 0; i < 6; i++) await mgr.check()
    expect(requestCount).toBe(5)

    await mgr.check({ force: true })

    expect(requestCount).toBe(6)
    mgr.cleanup()
  })

  test('a success resets the failure budget', async () => {
    stubFailure()
    const mgr = new UpdateManager('2026.4.13')

    for (let i = 0; i < 3; i++) await mgr.check()
    expect(mgr.failureCount).toBe(3)

    stubOk([release('v2026.4.20')])
    await mgr.check({ force: true })
    expect(mgr.failureCount).toBe(0)
    expect(mgr.backedOff).toBe(false)

    // The success wrote a fresh cache, so unforced checks would answer from
    // disk. Expire it to put the network back on the path.
    stubFailure()
    expireCache()
    for (let i = 0; i < 2; i++) await mgr.check()

    // Counting restarted from zero rather than continuing at 4.
    expect(mgr.failureCount).toBe(2)
    mgr.cleanup()
  })

  test('counts a cached-but-stale answer as a failure so backoff still happens', async () => {
    // Seed a cache, then make every later request fail. The user keeps getting a
    // usable answer from disk, which must not read as success to the scheduler.
    stubOk([release('v2026.4.20')])
    const mgr = new UpdateManager('2026.4.13')
    await mgr.check({ force: true })
    expect(mgr.failureCount).toBe(0)

    stubFailure()
    for (let i = 0; i < 10; i++) await mgr.check({ force: true })

    expect(mgr.backedOff).toBe(true)
    mgr.cleanup()
  })

  test('overlapping checks do not stack network calls', async () => {
    let release_: (() => void) | null = null
    const gate = new Promise<void>((resolve) => { release_ = resolve })
    globalThis.fetch = (async () => {
      requestCount++
      await gate
      return new Response(JSON.stringify([release('v2026.4.20')]), { status: 200 })
    }) as typeof globalThis.fetch

    const mgr = new UpdateManager('2026.4.13')
    const first = mgr.check({ force: true })
    const second = mgr.check({ force: true })
    release_?.()
    await Promise.all([first, second])

    expect(requestCount).toBe(1)
    mgr.cleanup()
  })

  test('cleanup stops further checks', async () => {
    stubOk([release('v2026.4.20')])
    const mgr = new UpdateManager('2026.4.13')
    mgr.cleanup()

    await mgr.check({ force: true })

    expect(requestCount).toBe(0)
  })

  test('start schedules without checking immediately', async () => {
    stubOk([release('v2026.4.20')])
    const mgr = new UpdateManager('2026.4.13')
    mgr.start()

    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(requestCount).toBe(0)
    mgr.cleanup()
  })
})
