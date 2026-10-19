import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { UpdateManager } from '../src/update/manager.js'
import { currentTarget } from '../src/update/paths.js'
import type { stageUpdate, StagedUpdate } from '../src/update/stage.js'

const envKeys = ['EVOT_HOME', 'EVOT_INSTALL_DIR', 'EVOT_AUTO_DOWNLOAD'] as const
let savedEnv: Array<string | undefined>
let home = ''
let manager: UpdateManager | undefined

function publish(version: string): void {
  writeFileSync(join(home, 'update-check.json'), JSON.stringify({
    checked_at: Date.now(),
    releases: [{ tag: `v${version}`, version, prerelease: false }],
  }))
}

function staged(version: string): StagedUpdate {
  return { tag: `v${version}`, version, target: currentTarget() ?? '', assetPath: '', stagedAt: Date.now() }
}

function deferred() {
  let resolve: (value: StagedUpdate) => void = () => {}
  let reject: (reason: Error) => void = () => {}
  const promise = new Promise<StagedUpdate>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// Flush the background promise chain, including its finally, without sleeps.
const settle = () => new Promise<void>(resolve => setImmediate(resolve))

function createManager(stage: typeof stageUpdate): UpdateManager {
  manager = new UpdateManager('2026.10.14', Date.now, stage)
  return manager
}

beforeEach(() => {
  savedEnv = envKeys.map(key => process.env[key])
  home = mkdtempSync(join(tmpdir(), 'evot-stage-recovery-'))
  process.env.EVOT_HOME = home
  process.env.EVOT_INSTALL_DIR = join(home, 'bin')
  delete process.env.EVOT_AUTO_DOWNLOAD
  writeFileSync(join(home, 'install-state.json'), JSON.stringify({
    version: '2026.10.14', target: currentTarget(), lib: [],
  }))
  publish('2026.10.16')
})

afterEach(() => {
  manager?.cleanup()
  manager = undefined
  envKeys.forEach((key, index) => {
    const value = savedEnv[index]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  })
  rmSync(home, { recursive: true, force: true })
})

describe('background update recovery', () => {
  test('retries a failed download on the next check without repeating the notification', async () => {
    let attempts = 0
    const mgr = createManager(async release => {
      attempts++
      if (attempts === 1) throw new Error('temporary download failure')
      return staged(release.version)
    })
    const notices: string[] = []
    mgr.on('update-available', release => notices.push(release.version))

    await mgr.check()
    await settle()
    expect(attempts).toBe(1)
    expect(mgr.getStatus()).toEqual({ kind: 'idle' })

    await mgr.check()
    await settle()
    expect(attempts).toBe(2)
    expect(mgr.getStatus()).toEqual({ kind: 'staged', version: '2026.10.16' })
    expect(notices).toEqual(['2026.10.16'])

    await mgr.check()
    await settle()
    expect(attempts).toBe(2)
  })

  test('repeated failures wait for another check rather than spinning in a retry loop', async () => {
    let attempts = 0
    const mgr = createManager(async () => {
      attempts++
      throw new Error('still offline')
    })
    await mgr.check()
    await settle()
    await settle()
    expect(attempts).toBe(1)
    await mgr.check()
    await settle()
    expect(attempts).toBe(2)
  })

  test('finishing a download immediately stages the newest discovered version, without parallel downloads', async () => {
    const first = deferred()
    const next = deferred()
    const attempts: string[] = []
    const mgr = createManager(async release => {
      attempts.push(release.version)
      return attempts.length === 1 ? first.promise : next.promise
    })
    await mgr.check()
    publish('2026.10.17')
    await mgr.check()
    publish('2026.10.18')
    await mgr.check()
    await mgr.check()
    // A stale answer must not replace the newest pending target.
    publish('2026.10.17')
    await mgr.check()
    expect(attempts).toEqual(['2026.10.16'])

    first.resolve(staged('2026.10.16'))
    await settle()
    expect(attempts).toEqual(['2026.10.16', '2026.10.18'])
    expect(mgr.getStatus()).toEqual({ kind: 'downloading', version: '2026.10.18' })

    await mgr.check()
    next.resolve(staged('2026.10.18'))
    await settle()
    expect(mgr.getStatus()).toEqual({ kind: 'staged', version: '2026.10.18' })
    expect(attempts).toEqual(['2026.10.16', '2026.10.18'])
  })

  test('a failed older download also hands over to the newer discovered version', async () => {
    const first = deferred()
    const attempts: string[] = []
    const mgr = createManager(async release => {
      attempts.push(release.version)
      return attempts.length === 1 ? first.promise : staged(release.version)
    })
    await mgr.check()
    publish('2026.10.18')
    await mgr.check()
    first.reject(new Error('old download failed'))
    await settle()
    expect(attempts).toEqual(['2026.10.16', '2026.10.18'])
    expect(mgr.getStatus()).toEqual({ kind: 'staged', version: '2026.10.18' })
  })

  test('the newer handover download is retried on the next check if it fails', async () => {
    const first = deferred()
    const attempts: string[] = []
    const mgr = createManager(async release => {
      attempts.push(release.version)
      if (attempts.length === 1) return first.promise
      if (attempts.length === 2) throw new Error('new download failed')
      return staged(release.version)
    })
    await mgr.check()
    publish('2026.10.18')
    await mgr.check()
    first.resolve(staged('2026.10.16'))
    await settle()
    expect(attempts).toEqual(['2026.10.16', '2026.10.18'])

    await mgr.check()
    await settle()
    expect(attempts).toEqual(['2026.10.16', '2026.10.18', '2026.10.18'])
    expect(mgr.getStatus()).toEqual({ kind: 'staged', version: '2026.10.18' })
  })

  test('cleanup aborts the active download and does not start the pending version', async () => {
    const first = deferred()
    const attempts: string[] = []
    let signal: AbortSignal | undefined
    const mgr = createManager(async (release, abortSignal) => {
      attempts.push(release.version)
      signal = abortSignal
      return first.promise
    })
    await mgr.check()
    publish('2026.10.18')
    await mgr.check()
    mgr.cleanup()
    expect(signal?.aborted).toBe(true)
    first.resolve(staged('2026.10.16'))
    await settle()
    expect(attempts).toEqual(['2026.10.16'])
    expect(mgr.getStatus()).toEqual({ kind: 'downloading', version: '2026.10.16' })
  })
})
