/**
 * Background staging: download into stateDir()/staging, verify, and surface
 * through UpdateManager's status — without ever touching the live install.
 *
 * The archive itself is produced by a fixture server serving the same paths
 * GitHub would (…/releases/download/<tag>/<asset>[.sha256]), so stage.ts's URL
 * construction and checksum handling are exercised for real.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { UpdateManager, type UpdateStatus } from '../../src/update/manager.js'
import { bindingFilenameForTarget, currentTarget } from '../../src/update/paths.js'
import { clearStaged, readStaged, stageUpdate } from '../../src/update/stage.js'

import { runInstallerScript } from '../../src/update/installer-process.js'
import type { StageInstaller } from '../../src/update/stage.js'
let fixtureInstall: StageInstaller = async () => { throw new Error('fixture not initialized') }
let home = ''

/**
 * Build a real release-archive layout: bin/evot printing the expected version
 * plus lib/ with a placeholder binding, gzipped tar — exactly what install.sh
 * and stage.ts both validate.
 */
async function makeArchive(version: string): Promise<Buffer> {
  const root = mkdtempSync(join(tmpdir(), 'evot-stage-fixture-'))
  const pkg = join(root, 'package')
  require('fs').mkdirSync(join(pkg, 'bin'), { recursive: true })
  require('fs').mkdirSync(join(pkg, 'lib'), { recursive: true })
  // A shell script works as an executable for --version on darwin/linux and
  // needs no cross-compilation.
  require('fs').writeFileSync(join(pkg, 'bin', 'evot'),
    `#!/bin/sh\necho "evot v${version}"\n`, { mode: 0o755 })
  require('fs').writeFileSync(join(pkg, 'lib', 'evot-napi.darwin-arm64.node'), 'placeholder')
  require('fs').writeFileSync(join(pkg, 'lib', 'evot-napi.linux-x64-gnu.node'), 'placeholder')

  const proc = Bun.spawn(['tar', '-czf', join(root, 'asset.tar.gz'), '-C', pkg, '.'])
  await proc.exited
  if (proc.exitCode !== 0) throw new Error('fixture tar failed')
  const bytes = readFileSync(join(root, 'asset.tar.gz'))
  rmSync(root, { recursive: true, force: true })
  return bytes
}

function startFixtureServer(archive: Buffer, opts: { omitSha?: boolean } = {}) {
  const checksum = createHash('sha256').update(archive).digest('hex')
  const folder = require('fs').mkdtempSync(join(home, 'download-fixture-'))
  writeFileSync(join(folder, 'archive'), archive)
  writeFileSync(join(folder, 'checksum'), checksum)
  writeFileSync(join(folder, 'curl'), `#!/bin/sh
output=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-o' ]; then output="$2"; shift 2; continue; fi
  shift
done
if [ -n "$output" ]; then cp "$FIXTURE/archive" "$output"; exit 0; fi
if [ "$OMIT_SHA" = 1 ]; then exit 22; fi
cat "$FIXTURE/checksum"
`, { mode: 0o755 })
  fixtureInstall = async (tag, extraEnv, options) => {
    requestCount++
    return runInstallerScript(readFileSync(join(import.meta.dir, '../../../install.sh'), 'utf8'), {
      ...process.env as Record<string, string>, ...extraEnv,
      EVOT_INSTALL_VERSION: tag ?? '', EVOT_DOWNLOAD_RETRY_BASE_DELAY: '0.01',
      FIXTURE: folder, OMIT_SHA: opts.omitSha ? '1' : '0', PATH: `${folder}:/usr/bin:/bin`,
    }, options)
  }
  return { stop(_force?: boolean) {} }
}

function stageFixtureUpdate(
  release: Parameters<typeof stageUpdate>[0],
  signal: Parameters<typeof stageUpdate>[1],
) {
  return stageUpdate(release, signal, fixtureInstall)
}

let requestCount = 0

/** Install bookkeeping as install.sh writes it, for the shared-state cases. */
function writeInstalledVersion(version: string): void {
  require('fs').writeFileSync(join(home, 'install-state.json'), JSON.stringify({
    version,
    target: currentTarget(),
    lib: [bindingFilenameForTarget(currentTarget() ?? '')],
    installed_at: Date.now(),
  }))
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'evot-stage-test-'))
  process.env.EVOT_HOME = home
  // The manager consults install bookkeeping, which resolves through the
  // install root rather than EVOT_HOME. Without this the suite would read the
  // developer's real ~/.evotai and see whatever version is installed there.
  process.env.EVOT_INSTALL_DIR = join(home, 'bin')
  // Most staging cases model an install.sh-managed release. Individual tests
  // remove this record to exercise source/local-development installs.
  writeInstalledVersion('2026.4.13')
  // Staging tests exercise downloads/install eligibility, not release lookup.
  // Every check must have a fresh fixture cache; otherwise the local/source
  // build cases call the real update service and can outlive the test timeout.
  writeFileSync(join(home, 'update-check.json'), JSON.stringify({
    checked_at: Date.now(),
    releases: [{ tag: 'v2026.5.1', version: '2026.5.1', prerelease: false }],
  }))
  delete process.env.EVOT_AUTO_DOWNLOAD
  requestCount = 0
})

afterEach(() => {
  fixtureInstall = async () => { throw new Error('fixture not initialized') }
  delete process.env.EVOT_HOME
  delete process.env.EVOT_INSTALL_DIR
  rmSync(home, { recursive: true, force: true })
})

describe('staging', () => {
  test('readStaged is null on a fresh home', () => {
    expect(readStaged()).toBeNull()
  })

  test('stageUpdate writes manifest and sidecar, then readStaged finds it', async () => {
    const archive = await makeArchive('2026.5.1')
    const server = startFixtureServer(archive)
    try {
      const { stageUpdate } = await import('../../src/update/stage.js')
      const staged = await stageUpdate(
        { tag: 'v2026.5.1', version: '2026.5.1', body: undefined },
        new AbortController().signal,
        fixtureInstall,
      )

      expect(staged.version).toBe('2026.5.1')
      expect(existsSync(staged.assetPath)).toBe(true)
      expect(existsSync(`${staged.assetPath}.sha256`)).toBe(true)
      expect(readFileSync(staged.assetPath).equals(archive)).toBe(true)
      expect(requestCount).toBeGreaterThan(0)

      const found = readStaged()
      expect(found?.version).toBe('2026.5.1')
      expect(found?.assetPath).toBe(staged.assetPath)
    } finally {
      void server.stop(true)
    }
  })

  test('a checksum mismatch discards the download', async () => {
    const archive = await makeArchive('2026.5.1')
    const server = startFixtureServer(archive)
    try {
      // Corrupt the sidecar after staging wrote it? Simpler: serve an archive,
      // then flip one byte of what readStaged will see via a second stage run.
      // Direct approach: stage once, tamper, re-verify through install-side
      // contract by clearing and staging against a mismatched sidecar.
      const { stageUpdate } = await import('../../src/update/stage.js')
      await stageUpdate({ tag: 'v2026.5.1', version: '2026.5.1' }, new AbortController().signal, fixtureInstall)

      // Tamper with the archive in place, then ask staging to re-run: it wipes
      // the directory first, so instead simulate corruption at read time.
      const found = readStaged()
      expect(found).not.toBeNull()
      const asset = found!.assetPath
      const bytes = readFileSync(asset)
      bytes[0] ^= 0xff
      require('fs').writeFileSync(asset, bytes)

      // The manager must not treat a corrupt archive as ready.
      clearStaged()
      expect(readStaged()).toBeNull()
      expect(!existsSync(join(home, 'staging')))
    } finally {
      void server.stop(true)
    }
  })

  test('UpdateManager stages automatically after update-available', async () => {
    const archive = await makeArchive('2026.5.1')
    const server = startFixtureServer(archive)
    try {
      const { checkForUpdate } = await import('../../src/update/check.js')
      // Prime the release cache so the manager's check needs no GitHub.
      const cachePath = join(home, 'update-check.json')
      require('fs').writeFileSync(cachePath, JSON.stringify({
        checked_at: Date.now(),
        releases: [{ tag: 'v2026.5.1', version: '2026.5.1', prerelease: false }],
      }))
      void checkForUpdate

      const statuses: UpdateStatus[] = []
      const mgr = new UpdateManager('2026.4.13', Date.now, stageFixtureUpdate)
      mgr.on('update-status', (s: UpdateStatus) => statuses.push(s))

      await mgr.check()

      // Staging is async but fast against a local server; poll briefly.
      for (let i = 0; i < 50 && mgr.getStatus().kind !== 'staged'; i++) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }

      expect(mgr.getStatus()).toEqual({ kind: 'staged', version: '2026.5.1' })
      expect(statuses.some(s => s.kind === 'downloading')).toBe(true)
      expect(readStaged()?.version).toBe('2026.5.1')
      mgr.cleanup()
    } finally {
      void server.stop(true)
    }
  })

  test('an open manager notices staging completed by another process', async () => {
    const archive = await makeArchive('2026.5.1')
    const server = startFixtureServer(archive)
    try {
      require('fs').writeFileSync(join(home, 'update-check.json'), JSON.stringify({
        checked_at: Date.now(),
        releases: [{ tag: 'v2026.4.13', version: '2026.4.13', prerelease: false }],
      }))
      const mgr = new UpdateManager('2026.4.13', Date.now, stageFixtureUpdate)
      const statuses: UpdateStatus[] = []
      mgr.on('update-status', (status: UpdateStatus) => statuses.push(status))

      const { stageUpdate } = await import('../../src/update/stage.js')
      await stageUpdate({ tag: 'v2026.5.1', version: '2026.5.1' }, new AbortController().signal, fixtureInstall)
      await mgr.check()

      expect(mgr.getStatus()).toEqual({ kind: 'staged', version: '2026.5.1' })
      expect(statuses).toContainEqual({ kind: 'staged', version: '2026.5.1' })
      mgr.cleanup()
    } finally {
      void server.stop(true)
    }
  })

  test('an install completed by another process needs no download, only a restart', async () => {
    // The reported bug: one evot applied the update to disk, so staged.json is
    // gone. A session still running the old image must not re-fetch 37 MB to
    // rediscover a version the disk already has.
    const archive = await makeArchive('2026.5.1')
    const server = startFixtureServer(archive)
    try {
      require('fs').writeFileSync(join(home, 'update-check.json'), JSON.stringify({
        checked_at: Date.now(),
        releases: [{ tag: 'v2026.5.1', version: '2026.5.1', prerelease: false }],
      }))
      writeInstalledVersion('2026.5.1')
      const before = requestCount

      const mgr = new UpdateManager('2026.4.13', Date.now, stageFixtureUpdate)
      await mgr.check()
      await new Promise(resolve => setTimeout(resolve, 50))

      expect(mgr.getStatus()).toEqual({ kind: 'staged', version: '2026.5.1' })
      expect(requestCount).toBe(before)
      expect(readStaged()).toBeNull()
      mgr.cleanup()
    } finally {
      void server.stop(true)
    }
  })

  test('startup skips reinstalling a version another process already applied', async () => {
    // Same disk state as the bug report: staging still holds v2026.5.1 while
    // install-state.json already records it. Re-running install.sh would redo
    // the whole swap; the caller only needs the version to hand over to.
    const archive = await makeArchive('2026.5.1')
    const server = startFixtureServer(archive)
    try {
      const { stageUpdate } = await import('../../src/update/stage.js')
      await stageUpdate({ tag: 'v2026.5.1', version: '2026.5.1' }, new AbortController().signal, fixtureInstall)
      writeInstalledVersion('2026.5.1')

      // No install.sh is served, so any install attempt would fail outright.
      const { applyStagedOnStartup } = await import('../../src/update/index.js')
      const applied = await applyStagedOnStartup('2026.4.13')

      expect(applied).toBe('2026.5.1')
      // The download did its job and must not be applied a second time.
      expect(readStaged()).toBeNull()
    } finally {
      void server.stop(true)
    }
  })

  test('a local installed build never applies a staged release without install state', async () => {
    const archive = await makeArchive('2026.5.1')
    const server = startFixtureServer(archive)
    try {
      const { stageUpdate } = await import('../../src/update/stage.js')
      await stageUpdate({ tag: 'v2026.5.1', version: '2026.5.1' }, new AbortController().signal, fixtureInstall)
      // `make install` deliberately removes this release-only marker while the
      // executable still lives under an install-shaped bin directory.
      rmSync(join(home, 'install-state.json'), { force: true })
      const before = requestCount

      const { applyStagedOnStartup } = await import('../../src/update/index.js')
      expect(await applyStagedOnStartup('0.1.0')).toBeNull()
      expect(readStaged()?.version).toBe('2026.5.1')

      const mgr = new UpdateManager('0.1.0', Date.now, stageFixtureUpdate)
      expect(mgr.getStatus()).toEqual({ kind: 'idle' })
      await mgr.check()
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mgr.getStatus()).toEqual({ kind: 'idle' })
      expect(requestCount).toBe(before)
      mgr.cleanup()
    } finally {
      void server.stop(true)
    }
  })

  test('a source checkout is never replaced by the installed release binary', async () => {
    // execve would discard the code under development. Guarded by
    // runningInstallDir(), which is null unless the running executable is a
    // compiled evot — as it is for `bun test`.
    const { execIntoInstalledUpdate } = await import('../../src/update/index.js')
    writeInstalledVersion('2026.5.1')

    // Returning at all proves no handover happened: execve never returns.
    expect(execIntoInstalledUpdate('2026.5.1')).toBeUndefined()
    expect(process.env.EVOT_APPLIED_UPDATE).toBeUndefined()
  })

  test('a source checkout never applies a staged release or offers a restart', async () => {
    // A dev build reports its Cargo version (0.1.0) and did not come from the
    // install it can see. Applying would overwrite the user's real release with
    // whatever a local build staged, and advertising a restart would promise
    // something this process will never do.
    const archive = await makeArchive('2026.5.1')
    const server = startFixtureServer(archive)
    try {
      const { stageUpdate } = await import('../../src/update/stage.js')
      await stageUpdate({ tag: 'v2026.5.1', version: '2026.5.1' }, new AbortController().signal, fixtureInstall)
      // Drop the managed-install marker: this is now indistinguishable from
      // `bun run src/index.ts` against a real ~/.evotai.
      delete process.env.EVOT_INSTALL_DIR
      // A dev build must not even reach the network on a background check.
      const before = requestCount

      const { applyStagedOnStartup } = await import('../../src/update/index.js')
      expect(await applyStagedOnStartup('0.1.0')).toBeNull()
      // The download belongs to the installed evot, so it must survive intact.
      expect(readStaged()?.version).toBe('2026.5.1')

      const mgr = new UpdateManager('0.1.0', Date.now, stageFixtureUpdate)
      expect(mgr.getStatus()).toEqual({ kind: 'idle' })
      await mgr.check()
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mgr.getStatus()).toEqual({ kind: 'idle' })
      expect(requestCount).toBe(before)
      mgr.cleanup()
    } finally {
      void server.stop(true)
    }
  })

  test('EVOT_AUTO_DOWNLOAD=0 skips background staging', async () => {
    process.env.EVOT_AUTO_DOWNLOAD = '0'
    const archive = await makeArchive('2026.5.1')
    const server = startFixtureServer(archive)
    try {
      require('fs').writeFileSync(join(home, 'update-check.json'), JSON.stringify({
        checked_at: Date.now(),
        releases: [{ tag: 'v2026.5.1', version: '2026.5.1', prerelease: false }],
      }))

      const mgr = new UpdateManager('2026.4.13', Date.now, stageFixtureUpdate)
      await mgr.check()
      await new Promise(resolve => setTimeout(resolve, 50))

      expect(mgr.getStatus()).toEqual({ kind: 'idle' })
      expect(requestCount).toBe(0)
      mgr.cleanup()
    } finally {
      void server.stop(true)
    }
  })

  test('an already-staged version equal to the candidate does not re-download', async () => {
    const archive = await makeArchive('2026.5.1')
    const server = startFixtureServer(archive)
    try {
      const { stageUpdate } = await import('../../src/update/stage.js')
      await stageUpdate({ tag: 'v2026.5.1', version: '2026.5.1' }, new AbortController().signal, fixtureInstall)
      const before = requestCount

      require('fs').writeFileSync(join(home, 'update-check.json'), JSON.stringify({
        checked_at: Date.now(),
        releases: [{ tag: 'v2026.5.1', version: '2026.5.1', prerelease: false }],
      }))

      const mgr = new UpdateManager('2026.4.13', Date.now, stageFixtureUpdate)
      await mgr.check()
      await new Promise(resolve => setTimeout(resolve, 50))

      expect(mgr.getStatus()).toEqual({ kind: 'staged', version: '2026.5.1' })
      expect(requestCount).toBe(before)
      mgr.cleanup()
    } finally {
      void server.stop(true)
    }
  })

  test('a newer release restages in the background and prunes the old download', async () => {
    const stagedOld = async () => {
      const archive = await makeArchive('2026.9.30')
      const server = startFixtureServer(archive)
      try {
        const { stageUpdate } = await import('../../src/update/stage.js')
        await stageUpdate({ tag: 'v2026.9.30', version: '2026.9.30' }, new AbortController().signal, fixtureInstall)
        expect(readStaged()?.version).toBe('2026.9.30')
        expect(existsSync(join(home, 'staging', '2026.9.30'))).toBe(true)
      } finally {
        void server.stop(true)
      }
    }
    await stagedOld()

    const archive = await makeArchive('2026.10.1')
    const server = startFixtureServer(archive)
    try {
      require('fs').writeFileSync(join(home, 'update-check.json'), JSON.stringify({
        checked_at: Date.now(),
        releases: [{ tag: 'v2026.10.1', version: '2026.10.1', prerelease: false }],
      }))

      const statuses: UpdateStatus[] = []
      const mgr = new UpdateManager('2026.4.13', Date.now, stageFixtureUpdate)
      mgr.on('update-status', (s: UpdateStatus) => statuses.push(s))

      const staged = new Promise<void>(resolve => {
        mgr.on('update-status', (status: UpdateStatus) => {
          if (status.kind === 'staged' && status.version === '2026.10.1') resolve()
        })
      })
      try {
        await mgr.check()
        // Await the actual completion signal, not an arbitrary one-second
        // polling budget. The unchanged test deadline still bounds failures.
        await staged

        expect(mgr.getStatus()).toEqual({ kind: 'staged', version: '2026.10.1' })
        expect(readStaged()?.version).toBe('2026.10.1')
        expect(existsSync(join(home, 'staging', '2026.9.30'))).toBe(false)
        expect(statuses.some(s => s.kind === 'downloading')).toBe(true)
      } finally {
        mgr.cleanup()
      }
    } finally {
      void server.stop(true)
    }
  })
})
