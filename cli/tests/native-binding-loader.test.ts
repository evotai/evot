import { describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { smokeEnvironment } from './helpers/smoke-home.js'
import { loadNativeBinding } from '../src/native/binding-loader.js'

const filename = 'evot-napi.darwin-arm64.node'
const local = `/checkout/cli/${filename}`
const paired = `/install/lib/${filename}`
const fallback = `/home/.evotai/lib/${filename}`
const valid = { NapiAgent: { create() {} }, version() { return 'test' } }
const defaults = {
  platform: 'darwin', arch: 'arm64', moduleDir: '/checkout/cli/src/native',
  execPath: '/install/bin/evot', evotHome: '/home/.evotai',
  exists: () => true, load: () => valid,
}

describe('native binding loader', () => {
  test('local build wins over installed fallback', () => {
    const loaded: string[] = []
    expect(loadNativeBinding({ ...defaults, load: (path: string) => { loaded.push(path); return valid } })).toBe(valid)
    expect(loaded).toEqual([local])
  })

  test('compiled binary uses paired lib before EVOT_HOME', () => {
    const loaded: string[] = []
    loadNativeBinding({ ...defaults, moduleDir: '/$bunfs/root', exists: (p: string) => p === paired || p === fallback,
      load: (path: string) => { loaded.push(path); return valid } })
    expect(loaded).toEqual([paired])
  })

  test('preserves dlopen error and path without silently loading an older addon', () => {
    const cause = new Error('mis-aligned LINKEDIT string pool')
    const loaded: string[] = []
    let failure: unknown
    try {
      loadNativeBinding({ ...defaults, load: (path: string) => { loaded.push(path); throw cause } })
    } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain(local)
    expect((failure as Error).message).toContain(cause.message)
    expect((failure as Error).cause).toBe(cause)
    expect(loaded).toEqual([local])
  })

  test('rejects missing exports immediately', () => {
    for (const binding of [undefined, {}, { version() {} }, { NapiAgent: {}, version() {} }]) {
      expect(() => loadNativeBinding({ ...defaults, load: () => binding })).toThrow('Missing required exports')
    }
  })

  test('reports missing and unsupported addons clearly', () => {
    expect(() => loadNativeBinding({ ...defaults, exists: () => false })).toThrow(`Cannot find ${filename}`)
    expect(() => loadNativeBinding({ ...defaults, platform: 'unknown' })).toThrow('Unsupported platform: unknown-arm64')
  })

  test('native initialization is outside startup bookkeeping catches', () => {
    const entry = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(entry.indexOf("await import('./native/index.js')")).toBeLessThan(entry.indexOf('try {'))
  })

  test('build keeps runtime loader and checks addon before compiling CLI', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(pkg.scripts['build:napi']).toContain('--no-js')
    expect(pkg.scripts['build:napi']).not.toContain('--js src/native/binding.js')
    expect(pkg.scripts['build:napi']).toContain('&& bun scripts/check-native.ts')
    const makefile = readFileSync(new URL('../../Makefile', import.meta.url), 'utf8')
    expect(makefile).toContain('bun run build:napi')
    expect(makefile).toContain('export DEVELOPER_DIR ?= /Library/Developer/CommandLineTools')
  })
})

const integration = process.env.EVOT_TEST_NATIVE_CONTRACT === '1' ? test : test.skip
integration('compiled startup preserves a broken addon error rather than undefined NapiAgent', async () => {
  const home = mkdtempSync(join(tmpdir(), 'evot-broken-addon-'))
  try {
    const bin = join(home, 'bin')
    const lib = join(home, 'lib')
    mkdirSync(bin)
    mkdirSync(lib)
    copyFileSync(new URL('../dist/evot', import.meta.url), join(bin, 'evot'))
    const addon = `evot-napi.${process.platform}-${process.arch}${process.platform === 'linux' ? '-gnu' : ''}.node`
    writeFileSync(join(lib, addon), 'invalid native addon')
    const child = Bun.spawn([join(bin, 'evot'), '-c'], {
      env: smokeEnvironment(home), stdout: 'pipe', stderr: 'pipe',
    })
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(code).not.toBe(0)
    expect(stderr).toContain('Cannot load native addon')
    expect(stderr).toContain(join(lib, addon))
    expect(stderr).not.toContain('undefined is not an object')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
