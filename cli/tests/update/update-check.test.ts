import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { checkForUpdate, fetchReleaseNotesFor, selectRelease } from '../../src/update/check.js'

const originalFetch = globalThis.fetch
let home = ''

/** Records every request so cache behaviour is observable. */
function stubLatest(tag: string, opts: { status?: number } = {}) {
  const calls: Array<{ url: string }> = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push({ url })
    return new Response(tag, { status: opts.status ?? 200 })
  }) as typeof globalThis.fetch
  return calls
}

function cachePath(): string {
  return join(home, 'update-check.json')
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'evot-check-test-'))
  process.env.EVOT_HOME = home
})

afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.EVOT_HOME
  rmSync(home, { recursive: true, force: true })
})

describe('selectRelease', () => {
  const releases = [
    { tag: 'v2026.4.13', version: '2026.4.13', prerelease: false },
    { tag: 'v2026.4.20-beta.1', version: '2026.4.20-beta.1', prerelease: true },
  ]

  test('stable channel ignores prereleases', () => {
    expect(selectRelease(releases, { includePrerelease: false })?.version).toBe('2026.4.13')
  })

  test('prerelease channel sees the newest of either kind', () => {
    expect(selectRelease(releases, { includePrerelease: true })?.version).toBe('2026.4.20-beta.1')
  })

  test('picks the newest by version, not by list order', () => {
    const unordered = [
      { tag: 'v2026.4.13', version: '2026.4.13', prerelease: false },
      { tag: 'v2026.10.1', version: '2026.10.1', prerelease: false },
      { tag: 'v2026.5.9', version: '2026.5.9', prerelease: false },
    ]
    expect(selectRelease(unordered, { includePrerelease: false })?.version).toBe('2026.10.1')
  })

  test('returns null when nothing is eligible', () => {
    expect(selectRelease([], { includePrerelease: true })).toBeNull()
    expect(selectRelease(releases.slice(1), { includePrerelease: false })).toBeNull()
  })
})

describe('checkForUpdate', () => {
  test('reports an available stable update', async () => {
    const calls = stubLatest('v2026.4.20')

    const result = await checkForUpdate('2026.4.13')

    expect(result.kind).toBe('available')
    if (result.kind === 'available') expect(result.latest.version).toBe('2026.4.20')
    expect(calls[0]?.url).toContain('auto.evot.ai/install/latest')
  })

  test('moves a beta install onto a newer stable release', async () => {
    stubLatest('v2026.4.20')

    const result = await checkForUpdate('2026.4.13-beta.1')

    expect(result.kind).toBe('available')
    if (result.kind === 'available') expect(result.latest.version).toBe('2026.4.20')
  })

  test('serves a fresh cache without a network call', async () => {
    const calls = stubLatest('v2026.4.20')

    await checkForUpdate('2026.4.13')
    expect(calls).toHaveLength(1)

    const second = await checkForUpdate('2026.4.13')
    expect(calls).toHaveLength(1)
    expect(second.kind).toBe('available')
  })

  test('force bypasses the TTL', async () => {
    const calls = stubLatest('v2026.4.20')

    await checkForUpdate('2026.4.13')
    await checkForUpdate('2026.4.13', { force: true })

    expect(calls).toHaveLength(2)
  })

  test('refreshes a cache older than ten minutes', async () => {
    stubLatest('v2026.4.20')
    await checkForUpdate('2026.4.13')

    const cached = JSON.parse(readFileSync(cachePath(), 'utf8')) as Record<string, unknown>
    cached.checked_at = Date.now() - 11 * 60 * 1000
    writeFileSync(cachePath(), JSON.stringify(cached))
    const calls = stubLatest('v2026.4.21')

    const result = await checkForUpdate('2026.4.13')

    expect(calls).toHaveLength(1)
    expect(result.kind).toBe('available')
    if (result.kind === 'available') expect(result.latest.version).toBe('2026.4.21')
  })

  test('falls back to a stale cache when the network fails', async () => {
    stubLatest('v2026.4.20')
    await checkForUpdate('2026.4.13')

    const cached = JSON.parse(readFileSync(cachePath(), 'utf8')) as Record<string, unknown>
    cached.checked_at = 0
    writeFileSync(cachePath(), JSON.stringify(cached))
    globalThis.fetch = (async () => { throw new Error('offline') }) as typeof globalThis.fetch

    const result = await checkForUpdate('2026.4.13')

    expect(result.kind).toBe('available')
    if (result.kind === 'available') {
      expect(result.latest.version).toBe('2026.4.20')
      expect(result.stale).toBe(true)
    }
  })

  test('marks a rate-limited fallback stale too', async () => {
    stubLatest('v2026.4.20')
    await checkForUpdate('2026.4.13')

    globalThis.fetch = (async () => new Response('rate limited', { status: 403 })) as typeof globalThis.fetch
    const result = await checkForUpdate('2026.4.13', { force: true })

    expect(result.kind).toBe('available')
    if (result.kind === 'available') expect(result.stale).toBe(true)
  })

  test('a fresh answer is never marked stale', async () => {
    stubLatest('v2026.4.20')

    const network = await checkForUpdate('2026.4.13')
    const fromCache = await checkForUpdate('2026.4.13')

    expect(network.kind === 'available' && network.stale).toBeUndefined()
    expect(fromCache.kind === 'available' && fromCache.stale).toBeUndefined()
  })

  test('reports an error when there is no cache to fall back on', async () => {
    globalThis.fetch = (async () => { throw new Error('offline') }) as typeof globalThis.fetch

    const result = await checkForUpdate('2026.4.13')

    expect(result).toEqual({ kind: 'error', message: 'offline' })
  })

  test('ignores a corrupt cache file instead of throwing', async () => {
    mkdirSync(home, { recursive: true })
    writeFileSync(cachePath(), 'not json')
    stubLatest('v2026.4.20')

    const result = await checkForUpdate('2026.4.13')

    expect(result.kind).toBe('available')
    expect(existsSync(cachePath())).toBe(true)
  })

  test('writes cache under EVOT_HOME, not the real home directory', async () => {
    stubLatest('v2026.4.20')

    await checkForUpdate('2026.4.13')

    expect(existsSync(cachePath())).toBe(true)
  })
})

describe('fetchReleaseNotesFor', () => {
  test('returns the cached latest when the version matches', async () => {
    stubLatest('v2026.4.13')
    await checkForUpdate('2026.4.13')

    const info = await fetchReleaseNotesFor('2026.4.13')
    expect(info?.version).toBe('2026.4.13')
  })

  test('tolerates a leading v in the requested version', async () => {
    stubLatest('v2026.4.13')
    await checkForUpdate('2026.4.13')

    expect((await fetchReleaseNotesFor('v2026.4.13'))?.version).toBe('2026.4.13')
  })

  test('returns null when the version is unknown', async () => {
    stubLatest('v2026.4.20')
    await checkForUpdate('2026.4.13')

    expect(await fetchReleaseNotesFor('2019.1.1')).toBeNull()
  })

  test('returns null instead of throwing when offline with no cache', async () => {
    globalThis.fetch = (async () => { throw new Error('offline') }) as typeof globalThis.fetch

    expect(await fetchReleaseNotesFor('2026.4.13').catch(() => 'threw')).toBeNull()
  })
})
