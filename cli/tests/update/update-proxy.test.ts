import { afterEach, describe, expect, test } from 'bun:test'
import {
  applyProxyToEnv,
  collectCandidates,
  envCandidates,
  envExemptsAll,
  parseProxyUrl,
  probeReachable,
  selectProxy,
  systemCandidates,
} from '../../src/update/proxy.js'
import type { ProxyEnv } from '../../src/update/proxy.js'

/** Probe stub: only the listed host:port pairs accept connections. */
function reachableOnly(...live: string[]) {
  const set = new Set(live)
  const asked: string[] = []
  const probe = async (host: string, port: number): Promise<boolean> => {
    asked.push(`${host}:${port}`)
    return set.has(`${host}:${port}`)
  }
  return { probe, asked }
}

/** selectProxy driven only by `env`, with system detection stubbed out. */
function select(env: ProxyEnv, probe: (host: string, port: number) => Promise<boolean>) {
  return selectProxy({ env, probe, system: async () => [] })
}

describe('parseProxyUrl', () => {
  test('parses a full url and keeps credentials', () => {
    expect(parseProxyUrl('http://user:pw@proxy.corp:3128', 'environment')).toEqual({
      url: 'http://user:pw@proxy.corp:3128',
      source: 'environment',
      scheme: 'http',
      host: 'proxy.corp',
      port: 3128,
    })
  })

  test('assumes http for a bare host:port, matching curl', () => {
    expect(parseProxyUrl('127.0.0.1:7890', 'EVOT_PROXY')).toMatchObject({
      url: 'http://127.0.0.1:7890',
      scheme: 'http',
      port: 7890,
    })
  })

  test('fills in the default port per scheme', () => {
    expect(parseProxyUrl('socks5://127.0.0.1', 'environment')?.port).toBe(1080)
    expect(parseProxyUrl('http://proxy.corp', 'environment')?.port).toBe(80)
  })

  test('treats disable keywords and blanks as no proxy', () => {
    for (const raw of ['', '   ', 'off', 'none', 'FALSE', '0']) {
      expect(parseProxyUrl(raw, 'EVOT_PROXY')).toBeNull()
    }
  })

  test('rejects unusable values', () => {
    expect(parseProxyUrl('ftp://proxy.corp:21', 'environment')).toBeNull()
    expect(parseProxyUrl('http://proxy.corp:0', 'environment')).toBeNull()
    expect(parseProxyUrl('http://proxy.corp:99999', 'environment')).toBeNull()
    expect(parseProxyUrl('not a url', 'environment')).toBeNull()
  })
})

/**
 * These cases assert the behaviour evot depends on from `proxy-from-env`, which
 * is what makes it safe to delegate rather than hand-roll the precedence rules.
 */
describe('envCandidates', () => {
  test('uses https_proxy for the https endpoints an update contacts', () => {
    const found = envCandidates({ https_proxy: 'http://proxy.corp:3128' })

    expect(found).not.toHaveLength(0)
    expect(found.every((c) => c.url === 'http://proxy.corp:3128')).toBe(true)
  })

  test('falls back to ALL_PROXY, which Bun fetch ignores on its own', () => {
    const found = envCandidates({ ALL_PROXY: 'socks5://127.0.0.1:7890' })

    expect(found[0]).toMatchObject({ url: 'socks5://127.0.0.1:7890', scheme: 'socks5' })
  })

  test('ignores an http-only proxy for https traffic', () => {
    expect(envCandidates({ http_proxy: 'http://proxy.corp:3128' })).toEqual([])
  })

  test('prefers the scheme-specific variable over the catch-all', () => {
    const found = envCandidates({
      https_proxy: 'http://specific:1',
      all_proxy: 'http://catchall:2',
    })

    expect(found[0]?.host).toBe('specific')
  })

  test('lowercase wins over uppercase, as curl does', () => {
    const found = envCandidates({
      https_proxy: 'http://lower:1',
      HTTPS_PROXY: 'http://upper:2',
    })

    expect(found[0]?.host).toBe('lower')
  })

  test('reports nothing when no variable is set', () => {
    expect(envCandidates({})).toEqual([])
  })

  test('does not leak a caller-supplied env into the real process', () => {
    const before = process.env.https_proxy
    envCandidates({ https_proxy: 'http://scoped:1' })
    expect(process.env.https_proxy).toBe(before)
  })
})

describe('envExemptsAll', () => {
  test('true when NO_PROXY covers every update endpoint', () => {
    expect(envExemptsAll({
      https_proxy: 'http://proxy.corp:3128',
      no_proxy: 'github.com,raw.githubusercontent.com',
    })).toBe(true)
  })

  test('true for a blanket wildcard', () => {
    expect(envExemptsAll({ https_proxy: 'http://proxy.corp:3128', no_proxy: '*' })).toBe(true)
  })

  test('false when the exemption misses some endpoints', () => {
    expect(envExemptsAll({
      https_proxy: 'http://proxy.corp:3128',
      no_proxy: 'api.github.com',
    })).toBe(false)
  })

  // "Nothing configured" and "deliberately exempted" both yield no candidates,
  // and only the second is a choice worth reporting back to the user.
  test('false when no proxy was configured at all', () => {
    expect(envExemptsAll({ no_proxy: '*' })).toBe(false)
  })

  /**
   * Regression: an `http_proxy` never applies to the https URLs an update
   * fetches, so no proxy resolves — but NO_PROXY is not the reason. Reporting an
   * exemption here would tell the user their NO_PROXY suppressed a proxy that
   * was never going to be used.
   */
  test('false when the proxy never applied to https in the first place', () => {
    expect(envExemptsAll({ http_proxy: 'http://proxy.corp:3128', no_proxy: 'example.com' }))
      .toBe(false)
  })

  test('false when no exemption list is set', () => {
    expect(envExemptsAll({ http_proxy: 'http://proxy.corp:3128' })).toBe(false)
  })
})

const SYSTEM_FULL = {
  HTTPEnable: '1' as const,
  HTTPPort: '7890',
  HTTPProxy: '127.0.0.1',
  HTTPSEnable: '1' as const,
  HTTPSPort: '7890',
  HTTPSProxy: '127.0.0.1',
  SOCKSEnable: '1' as const,
  SOCKSPort: '7891',
  SOCKSProxy: '127.0.0.1',
}

describe('systemCandidates', () => {
  const darwinOnly = process.platform === 'darwin' ? test : test.skip

  darwinOnly('reads enabled tiers in precedence order, https before socks', async () => {
    const found = await systemCandidates(async () => SYSTEM_FULL)

    expect(found.map((c) => [c.source, c.url])).toEqual([
      ['system:https', 'http://127.0.0.1:7890'],
      ['system:http', 'http://127.0.0.1:7890'],
      ['system:socks', 'socks5://127.0.0.1:7891'],
    ])
  })

  darwinOnly('ignores tiers that are configured but switched off', async () => {
    const found = await systemCandidates(async () => ({
      HTTPEnable: '0' as const,
      HTTPProxy: '127.0.0.1',
      HTTPPort: '7890',
      HTTPSEnable: '0' as const,
      SOCKSEnable: '0' as const,
    }))

    expect(found).toEqual([])
  })

  darwinOnly('treats an unavailable scutil as "no system proxy"', async () => {
    const found = await systemCandidates(async () => { throw new Error('scutil exited with 1') })

    expect(found).toEqual([])
  })

  test('returns nothing on platforms without a single source of truth', async () => {
    if (process.platform === 'darwin') return
    expect(await systemCandidates(async () => SYSTEM_FULL)).toEqual([])
  })
})

describe('collectCandidates', () => {
  test('environment values come before system settings', async () => {
    const found = await collectCandidates({
      env: { https_proxy: 'http://from-env:1' },
      system: async () => [{
        url: 'http://from-system:2',
        source: 'system:https',
        scheme: 'http',
        host: 'from-system',
        port: 2,
      }],
    })

    expect(found.map((c) => c.host)).toEqual(['from-env', 'from-system'])
  })

  test('EVOT_PROXY replaces every other source', async () => {
    const found = await collectCandidates({
      env: { EVOT_PROXY: 'http://chosen:1', https_proxy: 'http://ignored:2' },
      system: async () => { throw new Error('system detection must not run') },
    })

    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ host: 'chosen', source: 'EVOT_PROXY' })
  })

  test('EVOT_PROXY=off disables proxying instead of falling through', async () => {
    expect(await collectCandidates({
      env: { EVOT_PROXY: 'off', https_proxy: 'http://p:1' },
      system: async () => [],
    })).toEqual([])
  })

  test('falls back to the system proxy when no variable is exported', async () => {
    const found = await collectCandidates({
      env: {},
      system: async () => [{
        url: 'http://127.0.0.1:7890',
        source: 'system:https',
        scheme: 'http',
        host: '127.0.0.1',
        port: 7890,
      }],
    })

    expect(found[0]?.source).toBe('system:https')
  })

  test('the same proxy named twice is probed once, under the specific source', async () => {
    const found = await collectCandidates({
      env: { https_proxy: 'http://127.0.0.1:7890' },
      system: async () => [{
        url: 'http://127.0.0.1:7890',
        source: 'system:https',
        scheme: 'http',
        host: '127.0.0.1',
        port: 7890,
      }],
    })

    expect(found).toHaveLength(1)
    expect(found[0]?.source).toBe('environment')
  })
})

describe('selectProxy', () => {
  test('uses a reachable proxy for both fetch and the install script', async () => {
    const { probe } = reachableOnly('127.0.0.1:7890')

    const selection = await select({ https_proxy: 'http://127.0.0.1:7890' }, probe)

    expect(selection.fetchProxy?.url).toBe('http://127.0.0.1:7890')
    expect(selection.shellProxy?.url).toBe('http://127.0.0.1:7890')
    expect(selection.reason).toContain('using proxy http://127.0.0.1:7890')
  })

  /**
   * Fallthrough happens across sources, not within the environment: curl picks
   * one variable per request, and `proxy-from-env` reproduces that, so a dead
   * `https_proxy` is not silently replaced by `all_proxy`. The system proxy is
   * the next source, then a direct connection.
   */
  test('falls through a dead env proxy to the system proxy', async () => {
    const { probe, asked } = reachableOnly('from-system:2')

    const selection = await selectProxy({
      env: { https_proxy: 'http://dead:1' },
      probe,
      system: async () => [{
        url: 'http://from-system:2',
        source: 'system:https',
        scheme: 'http',
        host: 'from-system',
        port: 2,
      }],
    })

    expect(selection.shellProxy?.host).toBe('from-system')
    expect(asked).toEqual(['dead:1', 'from-system:2'])
    expect(selection.reason).toContain('skipped')
    expect(selection.reason).toContain('http://dead:1')
  })

  test('connects directly when every configured proxy is unreachable', async () => {
    const { probe } = reachableOnly()

    const selection = await select({ https_proxy: 'http://dead:1' }, probe)

    expect(selection.fetchProxy).toBeNull()
    expect(selection.shellProxy).toBeNull()
    expect(selection.reason).toContain('connecting directly')
    expect(selection.reason).toContain('unreachable')
  })

  test('connects directly when nothing is configured', async () => {
    const { probe, asked } = reachableOnly('127.0.0.1:7890')

    const selection = await select({}, probe)

    expect(selection.shellProxy).toBeNull()
    expect(selection.reason).toBe('no proxy configured; connecting directly')
    expect(asked).toEqual([])
  })

  /**
   * The motivating case: a socks-only setup. curl can use it, Bun's fetch
   * cannot, so the two halves diverge rather than failing the release check.
   */
  test('routes only the download through a socks proxy', async () => {
    const { probe } = reachableOnly('127.0.0.1:7890')

    const selection = await select({ all_proxy: 'socks5://127.0.0.1:7890' }, probe)

    expect(selection.fetchProxy).toBeNull()
    expect(selection.shellProxy?.scheme).toBe('socks5')
    expect(selection.reason).toContain('for the download only')
  })

  test('prefers an http proxy over a socks one so both halves agree', async () => {
    const { probe } = reachableOnly('127.0.0.1:7890', '127.0.0.1:7891')

    const selection = await select({
      https_proxy: 'http://127.0.0.1:7890',
      all_proxy: 'socks5://127.0.0.1:7891',
    }, probe)

    expect(selection.fetchProxy?.url).toBe('http://127.0.0.1:7890')
    expect(selection.shellProxy?.url).toBe('http://127.0.0.1:7890')
  })

  test('reports a NO_PROXY exemption instead of probing', async () => {
    const { probe, asked } = reachableOnly('127.0.0.1:7890')

    const selection = await select({
      https_proxy: 'http://127.0.0.1:7890',
      no_proxy: 'github.com,raw.githubusercontent.com',
    }, probe)

    expect(selection.fetchProxy).toBeNull()
    expect(selection.shellProxy).toBeNull()
    expect(selection.reason).toContain('NO_PROXY covers GitHub')
    expect(asked).toEqual([])
  })

  test('an explicit EVOT_PROXY wins over a reachable env proxy', async () => {
    const { probe } = reachableOnly('chosen:1', 'ignored:2')

    const selection = await select({
      EVOT_PROXY: 'http://chosen:1',
      https_proxy: 'http://ignored:2',
    }, probe)

    expect(selection.shellProxy?.host).toBe('chosen')
  })
})

describe('applyProxyToEnv', () => {
  test('replaces inherited proxy variables with the chosen one', async () => {
    const { probe } = reachableOnly('good:2')
    const selection = await selectProxy({
      env: { https_proxy: 'http://dead:1' },
      probe,
      system: async () => [{
        url: 'http://good:2',
        source: 'system:https',
        scheme: 'http',
        host: 'good',
        port: 2,
      }],
    })

    const env = applyProxyToEnv({
      PATH: '/usr/bin',
      https_proxy: 'http://dead:1',
      HTTPS_PROXY: 'http://dead:1',
      all_proxy: 'socks5://stale:9',
    }, selection)

    expect(env.https_proxy).toBe('http://good:2')
    expect(env.HTTPS_PROXY).toBe('http://good:2')
    expect(env.http_proxy).toBe('http://good:2')
    expect(env.HTTP_PROXY).toBe('http://good:2')
    // A stale catch-all would otherwise let curl's own precedence override the
    // decision made here.
    expect(env.all_proxy).toBeUndefined()
    expect(env.ALL_PROXY).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
  })

  test('clears every proxy variable when connecting directly', async () => {
    const { probe } = reachableOnly()
    const selection = await select({ https_proxy: 'http://dead:1' }, probe)

    const env = applyProxyToEnv({
      https_proxy: 'http://dead:1',
      ALL_PROXY: 'socks5://dead:1',
      http_proxy: 'http://dead:1',
    }, selection)

    expect(env.https_proxy).toBeUndefined()
    expect(env.ALL_PROXY).toBeUndefined()
    expect(env.http_proxy).toBeUndefined()
  })

  test('preserves a socks proxy for curl even though fetch skipped it', async () => {
    const { probe } = reachableOnly('127.0.0.1:7890')
    const selection = await select({ all_proxy: 'socks5://127.0.0.1:7890' }, probe)

    const env = applyProxyToEnv({}, selection)

    expect(env.https_proxy).toBe('socks5://127.0.0.1:7890')
  })

  test("keeps the user's NO_PROXY exemption list intact", async () => {
    const { probe } = reachableOnly('127.0.0.1:7890')
    const selection = await select({ https_proxy: 'http://127.0.0.1:7890' }, probe)

    const env = applyProxyToEnv({ no_proxy: 'internal.corp', NO_PROXY: 'internal.corp' }, selection)

    expect(env.no_proxy).toBe('internal.corp')
    expect(env.NO_PROXY).toBe('internal.corp')
  })
})

describe('probeReachable', () => {
  let server: ReturnType<typeof Bun.listen> | null = null

  afterEach(() => {
    server?.stop(true)
    server = null
  })

  test('accepts a listening port and rejects a closed one', async () => {
    server = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: { data() {}, open(socket) { socket.end() }, close() {}, error() {} },
    })

    expect(await probeReachable('127.0.0.1', server.port)).toBe(true)

    const closed = server.port
    server.stop(true)
    server = null
    expect(await probeReachable('127.0.0.1', closed)).toBe(false)
  })

  test('gives up on an unroutable address within its budget', async () => {
    const started = Date.now()
    expect(await probeReachable('10.255.255.1', 8080, 300)).toBe(false)
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})
