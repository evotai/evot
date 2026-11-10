import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runUpdate } from '../../src/update/index.js'

const originalFetch = globalThis.fetch
let home = ''

function latest(tag: string) {
  return new Response(tag, { status: 200 })
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'evot-run-test-'))
  process.env.EVOT_HOME = home
  // Point installs at a scratch dir so nothing can touch a real install.
  process.env.EVOT_INSTALL_DIR = join(home, 'bin')
})

afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.EVOT_HOME
  delete process.env.EVOT_INSTALL_DIR
  rmSync(home, { recursive: true, force: true })
})

describe('runUpdate', () => {
  test('reports up to date without attempting an install', async () => {
    globalThis.fetch = (async () =>
      latest('v2026.4.13')) as typeof globalThis.fetch

    expect(await runUpdate('2026.4.13')).toEqual({ kind: 'up_to_date' })
    expect(existsSync(join(home, 'bin', 'evot'))).toBe(false)
  })

  test('flags an up-to-date answer that came from a stale cache', async () => {
    globalThis.fetch = (async () =>
      latest('v2026.4.13')) as typeof globalThis.fetch
    await runUpdate('2026.4.13')

    globalThis.fetch = (async () => { throw new Error('offline') }) as typeof globalThis.fetch
    const result = await runUpdate('2026.4.13')

    // "Up to date" is only as good as the last successful check; say why.
    expect(result).toMatchObject({ kind: 'up_to_date', staleReason: 'offline' })
    // The route is chosen automatically, so a stale answer has to name it.
    expect(typeof (result as { proxy?: string }).proxy).toBe('string')
  })

  test('reports the reason a rate-limited check fell back to cache', async () => {
    globalThis.fetch = (async () =>
      latest('v2026.4.13')) as typeof globalThis.fetch
    await runUpdate('2026.4.13')

    globalThis.fetch = (async () =>
      new Response('rate limited', { status: 403 })) as typeof globalThis.fetch
    const result = await runUpdate('2026.4.13')

    expect(result.kind).toBe('up_to_date')
    if (result.kind === 'up_to_date') {
      expect(result.staleReason).toContain('HTTP 403')
    }
  })

  test('a confirmed up-to-date answer carries no stale reason', async () => {
    globalThis.fetch = (async () =>
      latest('v2026.4.13')) as typeof globalThis.fetch

    const result = await runUpdate('2026.4.13')

    expect(result).toEqual({ kind: 'up_to_date' })
  })

  test('a later success clears the recorded failure', async () => {
    const { lastCheckError } = await import('../../src/update/check.js')
    globalThis.fetch = (async () =>
      latest('v2026.4.13')) as typeof globalThis.fetch
    await runUpdate('2026.4.13')

    globalThis.fetch = (async () => { throw new Error('offline') }) as typeof globalThis.fetch
    await runUpdate('2026.4.13')
    expect(lastCheckError()?.message).toBe('offline')

    globalThis.fetch = (async () =>
      latest('v2026.4.13')) as typeof globalThis.fetch
    await runUpdate('2026.4.13')

    expect(lastCheckError()).toBeNull()
  })

  test('surfaces a check error when there is nothing cached', async () => {
    globalThis.fetch = (async () => { throw new Error('offline') }) as typeof globalThis.fetch

    const result = await runUpdate('2026.4.13')

    expect(result).toMatchObject({ kind: 'error', message: 'offline' })
    // A network failure must name the route it took, since it was auto-selected.
    expect(typeof (result as { proxy?: string }).proxy).toBe('string')
  })

  test('installs an available release', async () => {
    const script = `#!/bin/sh
set -e
mkdir -p "$EVOT_INSTALL_DIR"
printf '%s\\n' '#!/bin/sh' 'printf "evot v2026.4.20\\n"' > "$EVOT_INSTALL_DIR/evot"
chmod +x "$EVOT_INSTALL_DIR/evot"
`
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('install.sh')) return new Response(script)
      return latest('v2026.4.20')
    }) as typeof globalThis.fetch

    const result = await runUpdate('2026.4.13')

    expect(result).toEqual({
      kind: 'updated',
      from: '2026.4.13',
      to: '2026.4.20',
      notes: [],
    })
    expect(readFileSync(join(home, 'bin', 'evot'), 'utf8')).toContain('2026.4.20')
  })

  test('preserves install state written by the installer for later drift checks', async () => {
    const script = `#!/bin/sh
set -e
mkdir -p "$EVOT_INSTALL_DIR"
printf '%s\\n' '#!/bin/sh' 'printf "evot v2026.4.20\\n"' > "$EVOT_INSTALL_DIR/evot"
chmod +x "$EVOT_INSTALL_DIR/evot"
cat > "$(dirname "$EVOT_INSTALL_DIR")/install-state.json" <<'EOF'
{
  "version": "2026.4.20",
  "target": "test-target",
  "lib": [],
  "installed_at": 1750000000000
}
EOF
`
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('install.sh')) return new Response(script)
      return latest('v2026.4.20')
    }) as typeof globalThis.fetch

    await runUpdate('2026.4.13')

    const state = JSON.parse(readFileSync(join(home, 'install-state.json'), 'utf8'))
    expect(state).toMatchObject({ version: '2026.4.20', target: 'test-target' })
  })

  test('reports an install failure instead of claiming success', async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('install.sh')) {
        // A script that exits non-zero without installing anything.
        return new Response('#!/bin/sh\necho "disk full" >&2\nexit 1\n')
      }
      return latest('v2026.4.20')
    }) as typeof globalThis.fetch

    const result = await runUpdate('2026.4.13')

    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.message).toContain('disk full')
    expect(existsSync(join(home, 'install-state.json'))).toBe(false)
  })

  test('does not record state when the installed binary is the wrong version', async () => {
    const script = `#!/bin/sh
set -e
mkdir -p "$EVOT_INSTALL_DIR"
printf '%s\\n' '#!/bin/sh' 'printf "evot v2026.1.1\\n"' > "$EVOT_INSTALL_DIR/evot"
chmod +x "$EVOT_INSTALL_DIR/evot"
`
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('install.sh')) return new Response(script)
      return latest('v2026.4.20')
    }) as typeof globalThis.fetch

    const result = await runUpdate('2026.4.13')

    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.message).toContain('version mismatch')
    expect(existsSync(join(home, 'install-state.json'))).toBe(false)
  })
})
