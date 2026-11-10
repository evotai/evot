import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { checkInstallHealth, isManagedInstall, readInstallState } from '../../src/update/state.js'
import {
  bindingFilenameForTarget,
  currentTarget,
  installBinDir,
  installRoot,
  runningInstallDir,
  stateDir,
} from '../../src/update/paths.js'

let root = ''
let env: Record<string, string | undefined> = {}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'evot-state-test-'))
  // EVOT_INSTALL_DIR is the only knob that redirects the install root, matching
  // install.sh. EVOT_HOME moves user state but never the installed files.
  env = { EVOT_HOME: root, EVOT_INSTALL_DIR: join(root, 'bin') }
  mkdirSync(join(root, 'lib'), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function statePath(): string {
  return join(root, 'install-state.json')
}

function localTarget(): string {
  return currentTarget() ?? 'unsupported-test-target'
}

function localBinding(): string {
  return bindingFilenameForTarget(localTarget()) ?? 'evot-napi.unsupported.node'
}

/** Fixture matching the metadata format written by install.sh. */
function writeInstallerState(
  overrides: Partial<{
    version: string
    target: string
    lib: string[]
    installed_at: number
  }> = {},
): void {
  writeFileSync(
    statePath(),
    JSON.stringify({
      version: '2026.4.20',
      target: localTarget(),
      lib: [localBinding()],
      installed_at: 1_750_000_000_000,
      ...overrides,
    }),
  )
}

describe('paths', () => {
  test('a bin-suffixed install dir resolves to its parent, matching install.sh', () => {
    expect(installRoot({ EVOT_INSTALL_DIR: '/opt/evot/bin' })).toBe('/opt/evot')
    expect(installBinDir({ EVOT_INSTALL_DIR: '/opt/evot/bin' })).toBe('/opt/evot/bin')
  })

  test('a non-bin install dir is used as the root', () => {
    expect(installRoot({ EVOT_INSTALL_DIR: '/opt/evot' })).toBe('/opt/evot')
    expect(installBinDir({ EVOT_INSTALL_DIR: '/opt/evot' })).toBe('/opt/evot')
  })

  test('infers a custom install from the running compiled evot', () => {
    const executable = '/opt/custom-evot/bin/evot'
    expect(runningInstallDir(executable)).toBe('/opt/custom-evot/bin')
    expect(installBinDir({}, executable)).toBe('/opt/custom-evot/bin')
    expect(installRoot({}, executable)).toBe('/opt/custom-evot')
  })

  test('resolves an evot symlink to the real install directory', () => {
    const realBin = join(root, 'real', 'bin')
    const shimBin = join(root, 'shim')
    mkdirSync(realBin, { recursive: true })
    mkdirSync(shimBin, { recursive: true })
    writeFileSync(join(realBin, 'evot'), '')
    symlinkSync(join(realBin, 'evot'), join(shimBin, 'evot'))

    expect(runningInstallDir(join(shimBin, 'evot'))).toBe(realpathSync(realBin))
    expect(installRoot({}, join(shimBin, 'evot'))).toBe(realpathSync(join(root, 'real')))
  })

  test('an explicit install dir wins over the running executable', () => {
    const executable = '/opt/custom-evot/bin/evot'
    const explicit = { EVOT_INSTALL_DIR: '/srv/evot/bin' }
    expect(installBinDir(explicit, executable)).toBe('/srv/evot/bin')
    expect(installRoot(explicit, executable)).toBe('/srv/evot')
  })

  test('install root and state dir diverge for an out-of-tree install', () => {
    const outOfTree = { EVOT_HOME: '/home/u/.evotai', EVOT_INSTALL_DIR: '/usr/local/bin' }
    expect(stateDir(outOfTree)).toBe('/home/u/.evotai')
    expect(installRoot(outOfTree)).toBe('/usr/local')
  })

  test('EVOT_HOME moves user state but never the install root', () => {
    // install.sh installs to $HOME/.evotai/bin regardless of EVOT_HOME, so
    // reading bookkeeping from EVOT_HOME would look at a path it never writes.
    const homeOnly = { EVOT_HOME: '/tmp/custom-state' }
    expect(stateDir(homeOnly)).toBe('/tmp/custom-state')
    expect(installRoot(homeOnly)).not.toBe('/tmp/custom-state')
    expect(installRoot(homeOnly)).toBe(installRoot({}))
  })

  test('resolves a release target for supported platforms', () => {
    expect(currentTarget()).toMatch(/-(apple-darwin|unknown-linux-gnu)$/)
  })
})

describe('managed install detection', () => {
  test('requires install.sh bookkeeping, not only an install-shaped path', () => {
    expect(isManagedInstall(env)).toBe(false)

    writeInstallerState()
    expect(isManagedInstall(env)).toBe(true)
  })
})

describe('readInstallState', () => {
  test('reads the metadata format written by install.sh', () => {
    writeInstallerState({ installed_at: 1_760_000_000_000 })

    expect(readInstallState(env)).toEqual({
      version: '2026.4.20',
      target: localTarget(),
      lib: [localBinding()],
      installed_at: 1_760_000_000_000,
    })
  })

  test('returns null for missing, corrupt, or incomplete records', () => {
    expect(readInstallState(env)).toBeNull()

    writeFileSync(statePath(), 'not json')
    expect(readInstallState(env)).toBeNull()

    writeFileSync(statePath(), JSON.stringify({ target: localTarget() }))
    expect(readInstallState(env)).toBeNull()

    writeFileSync(
      statePath(),
      JSON.stringify({ version: '2026.4.20', target: localTarget() }),
    )
    expect(readInstallState(env)).toBeNull()
  })
})

describe('checkInstallHealth', () => {
  test('a matching installer record is healthy', () => {
    writeFileSync(join(root, 'lib', localBinding()), 'x')
    writeInstallerState()

    expect(checkInstallHealth('2026.4.20', env)).toEqual({ kind: 'ok' })
  })

  test('no record is unknown, never a warning', () => {
    // Users who installed before this bookkeeping existed must not be nagged.
    expect(checkInstallHealth('2026.4.20', env)).toEqual({ kind: 'unknown' })
  })

  test('a newer install than the running image asks for a restart, not a repair', () => {
    // Exactly the multi-process case: one evot applied v2026.4.20 to disk while
    // this session keeps running the image it started with. Nothing is broken,
    // so telling the user to reinstall would be wrong.
    writeFileSync(join(root, 'lib', localBinding()), 'x')
    writeInstallerState()

    const health = checkInstallHealth('2026.4.13', env)

    expect(health).toEqual({ kind: 'restart_required', installedVersion: '2026.4.20' })
  })

  test('detects a binary newer than the recorded install', () => {
    // The other direction is real drift: bookkeeping describes an install the
    // running binary is ahead of, so the record and the files disagree. The
    // binding is present so the version mismatch is what surfaces.
    writeFileSync(join(root, 'lib', localBinding()), 'x')
    writeInstallerState({ version: '2026.4.13' })

    const health = checkInstallHealth('2026.4.20', env)

    expect(health.kind).toBe('drift')
    if (health.kind === 'drift') {
      expect(health.reason).toContain('recorded v2026.4.13')
      expect(health.reason).toContain('running v2026.4.20')
    }
  })

  test('a newer record with a broken binding needs a reinstall, not a restart', () => {
    // Integrity outranks version: restarting would reload the same broken pair,
    // so this must stay drift even though the record names a newer release.
    writeInstallerState({ version: '2026.9.9' })

    const health = checkInstallHealth('2026.4.20', env)

    expect(health.kind).toBe('drift')
    if (health.kind === 'drift') expect(health.reason).toContain(`lib/${localBinding()}`)
  })

  test('a source checkout is never compared against an installed release', () => {
    // `bun run src/index.ts` reports 0.1.0 while the record describes a real
    // install. That is not this process, so there is nothing to restart into.
    writeFileSync(join(root, 'lib', localBinding()), 'x')
    writeInstallerState()

    expect(checkInstallHealth('0.1.0', { EVOT_HOME: root })).toEqual({ kind: 'unknown' })
  })

  test('detects a record from a different platform target', () => {
    writeInstallerState({ target: 'sparc-unknown-void' })

    const health = checkInstallHealth('2026.4.20', env)

    expect(health.kind).toBe('drift')
    if (health.kind === 'drift') expect(health.reason).toContain('sparc-unknown-void')
  })

  test('detects metadata that names the wrong native binding', () => {
    writeInstallerState({ lib: ['evot-napi.wrong.node'] })

    const health = checkInstallHealth('2026.4.20', env)

    expect(health.kind).toBe('drift')
    if (health.kind === 'drift') expect(health.reason).toContain(`lib/${localBinding()}`)
  })

  test('detects a native binding that disappeared after install', () => {
    writeFileSync(join(root, 'lib', localBinding()), 'x')
    writeInstallerState()
    rmSync(join(root, 'lib', localBinding()))

    const health = checkInstallHealth('2026.4.20', env)

    expect(health.kind).toBe('drift')
    if (health.kind === 'drift') expect(health.reason).toContain(`lib/${localBinding()}`)
  })

  test('equivalent version spellings are not drift', () => {
    writeFileSync(join(root, 'lib', localBinding()), 'x')
    writeInstallerState()
    expect(checkInstallHealth('2026.4.20.0', env)).toEqual({ kind: 'ok' })
  })
})
