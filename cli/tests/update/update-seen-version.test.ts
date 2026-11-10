import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  markReleaseNotesSeen,
  releaseNotesPending,
} from '../../src/update/seen-version.js'

let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'evot-seen-version-test-'))
  process.env.EVOT_HOME = home
})

afterEach(() => {
  delete process.env.EVOT_HOME
  rmSync(home, { recursive: true, force: true })
})

function statePath(): string {
  return join(home, 'last-seen-version.json')
}

function recordedVersion(): string {
  return JSON.parse(readFileSync(statePath(), 'utf8')).version as string
}

describe('release note state', () => {
  test('first startup establishes a baseline without showing historical notes', () => {
    expect(releaseNotesPending('2026.7.18')).toBe(false)
    expect(recordedVersion()).toBe('2026.7.18')
  })

  test('an upgrade remains pending until its metadata is handled', () => {
    expect(releaseNotesPending('2026.7.18')).toBe(false)

    expect(releaseNotesPending('2026.7.19')).toBe(true)
    expect(releaseNotesPending('2026.7.19')).toBe(true)
    expect(recordedVersion()).toBe('2026.7.18')

    markReleaseNotesSeen('2026.7.19')
    expect(releaseNotesPending('2026.7.19')).toBe(false)
    expect(recordedVersion()).toBe('2026.7.19')
  })

  test('acknowledging an older process cannot move the record backwards', () => {
    writeFileSync(statePath(), JSON.stringify({ version: '2026.7.20' }))

    markReleaseNotesSeen('2026.7.19')

    expect(recordedVersion()).toBe('2026.7.20')
    expect(releaseNotesPending('2026.7.19')).toBe(false)
  })

  test('a corrupt record is replaced with a quiet first-run baseline', () => {
    writeFileSync(statePath(), 'not json')

    expect(releaseNotesPending('2026.7.19')).toBe(false)
    expect(recordedVersion()).toBe('2026.7.19')
  })
})
