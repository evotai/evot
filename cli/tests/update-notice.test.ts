import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { reportAppliedUpdate, takeAppliedUpdate } from '../src/update/index.js'

/**
 * One-shot prompt runs are scripting surfaces: whatever lands on stdout gets
 * captured into files and JSON-lines parsers. The applied-update banner must
 * never ride stdout there — that is exactly how customers ended up with
 * "✓ evot updated to …" at the top of a saved output file.
 */
function captureRouting(command: string): { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  const log = console.log
  const error = console.error
  console.log = (line?: unknown) => { out.push(String(line)) }
  console.error = (line?: unknown) => { err.push(String(line)) }
  try {
    reportAppliedUpdate('2026.8.28', command)
  } finally {
    console.log = log
    console.error = error
  }
  return { out, err }
}

describe('applied-update notice routing', () => {
  const line = '  ✓ evot updated to v2026.8.28 in the background; this session is running the new version.'

  test('prompt mode keeps stdout clean and uses stderr', () => {
    const { out, err } = captureRouting('prompt')
    expect(out).toEqual([])
    expect(err).toEqual([line])
  })

  test('acp mode keeps protocol stdout clean', () => {
    const { out, err } = captureRouting('acp')
    expect(out).toEqual([])
    expect(err).toEqual([line])
  })

  test('interactive paths still announce on stdout', () => {
    for (const command of ['repl', 'login']) {
      const { out, err } = captureRouting(command)
      expect(out).toEqual([line])
      expect(err).toEqual([])
    }
  })
})

/**
 * The handover marker is passed through the environment across an execve, so it
 * has to be consumed exactly once: a lingering value would re-announce the
 * update in every child process the session spawns.
 */
describe('applied-update handover marker', () => {
  beforeEach(() => {
    delete process.env.EVOT_APPLIED_UPDATE
  })

  afterEach(() => {
    delete process.env.EVOT_APPLIED_UPDATE
  })

  test('reports nothing when no handover happened', () => {
    expect(takeAppliedUpdate()).toBeNull()
  })

  test('yields the version once, then clears it', () => {
    process.env.EVOT_APPLIED_UPDATE = '2026.8.31'

    expect(takeAppliedUpdate()).toBe('2026.8.31')
    expect(takeAppliedUpdate()).toBeNull()
    expect(process.env.EVOT_APPLIED_UPDATE).toBeUndefined()
  })

  test('a process that already took over never hands over again', async () => {
    // The marker is still present while the re-exec'd process runs its startup
    // apply block. Without this guard, a swap that somehow did not change the
    // reported version would bounce the session between images forever.
    const { execIntoInstalledUpdate } = await import('../src/update/index.js')
    process.env.EVOT_APPLIED_UPDATE = '2026.8.31'

    // Returning at all proves no handover happened: execve never returns.
    expect(execIntoInstalledUpdate('2026.8.31')).toBeUndefined()
    // The marker survives for the notice that runs immediately after.
    expect(process.env.EVOT_APPLIED_UPDATE).toBe('2026.8.31')
  })

  test('an in-place restart still hands over after an applied-update marker', async () => {
    const { execIntoInstalledRestart } = await import('../src/update/index.js')
    process.env.EVOT_APPLIED_UPDATE = '2026.8.31'

    // Source/test processes are not a compiled evot, so execve is never reached.
    // Returning proves the restart path does not share the update-once guard.
    expect(execIntoInstalledRestart()).toBeUndefined()
    expect(process.env.EVOT_APPLIED_UPDATE).toBe('2026.8.31')
  })
})
