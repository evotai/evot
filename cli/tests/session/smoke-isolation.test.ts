import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { smokeEnvironment, seedSmokeHome } from '../helpers/smoke-home.js'

const historyModule = new URL('../../src/session/history.ts', import.meta.url).pathname

describe('smoke state isolation', () => {
  test('does not inherit developer credentials or state overrides', () => {
    const env = smokeEnvironment('/tmp/test-home', {
      HOME: '/private/home', EVOT_HOME: '/private/state',
      EVOT_LLM_PROVIDER: 'production', EVOT_LLM_PRODUCTION_API_KEY: 'private-key',
      BENDCLOUD_DSN: 'private-dsn', EVOT_STORAGE_FS_ROOT_DIR: '/private/sessions',
      PATH: '/usr/bin',
    })
    expect(env.HOME).toBe('/tmp/test-home')
    expect(env.EVOT_HOME).toBe('/tmp/test-home/.evotai')
    expect(env.EVOT_STORAGE_FS_ROOT_DIR).toBe(env.EVOT_HOME)
    expect(env.EVOT_LLM_PROVIDER).toBeUndefined()
    expect(env.EVOT_LLM_PRODUCTION_API_KEY).toBeUndefined()
    expect(env.BENDCLOUD_DSN).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
  })

  test('isolates both modern and legacy history writers in a child process', () => {
    const home = mkdtempSync(join(tmpdir(), 'evot-smoke-isolation-'))
    try {
      const state = seedSmokeHome(home)
      const result = spawnSync(process.execPath, ['--eval', `
        import { HistoryManager } from ${JSON.stringify(historyModule)};
        import { homedir } from 'node:os';
        import { join } from 'node:path';
        const current = new HistoryManager(process.cwd());
        current.append('echo smoke test');
        if (current.load()[0] !== 'echo smoke test') throw new Error('Missing history');
        const legacy = new HistoryManager(join(homedir(), '.evotai', 'legacy_history'), { explicitPath: true });
        legacy.append('legacy smoke');
      `], { cwd: home, env: smokeEnvironment(home), encoding: 'utf8' })
      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      const projects = join(state, 'projects')
      const slug = readdirSync(projects)[0]
      expect(slug).toBeDefined()
      expect(readFileSync(join(projects, slug ?? '', 'evot_history'), 'utf8')).toBe('echo smoke test\n')
      expect(readFileSync(join(state, 'legacy_history'), 'utf8')).toBe('legacy smoke\n')
      expect(readFileSync(join(state, 'evot.env'), 'utf8')).toContain('http://127.0.0.1:1/v1')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('history honors an explicit EVOT_HOME independently of HOME', () => {
    const home = mkdtempSync(join(tmpdir(), 'evot-history-root-'))
    try {
      const state = join(home, 'override')
      const result = spawnSync(process.execPath, ['--eval', `
        import { HistoryManager } from ${JSON.stringify(historyModule)};
        new HistoryManager().append('isolated');
      `], { env: { ...smokeEnvironment(home), EVOT_HOME: state }, encoding: 'utf8' })
      expect(result.status).toBe(0)
      expect(readFileSync(join(state, 'evot_history'), 'utf8')).toBe('isolated\n')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
