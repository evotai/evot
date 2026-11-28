import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cloudflaredPath, ensureCloudflared } from '../../../src/features/remote/cloudflared.js'

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex')
let home: string, path: string | undefined
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'evot-cloudflared-'))
  path = process.env.PATH
  process.env.PATH = join(home, 'empty') + ':/usr/bin:/bin' // tar, but no cloudflared
})
afterEach(() => { process.env.PATH = path; rmSync(home, { recursive: true, force: true }) })

test('downloads the pinned connector once, verifies it, and installs it executable', async () => {
  const binary = '#!/bin/sh\necho cloudflared fixture\n'
  const urls: string[] = [], notes: [string, number | undefined][] = []
  const pins = { 'linux-x64': { asset: 'cloudflared-linux-amd64', binary: sha(binary) } }
  const download = async (url: string) => { urls.push(url); return new Response(binary) }
  const installed = await ensureCloudflared(home, (t, b) => notes.push([t, b?.done]), { platform: 'linux-x64', pins, download })
  expect(installed).toBe(cloudflaredPath(home))
  expect(readFileSync(installed, 'utf8')).toBe(binary)
  expect(statSync(installed).mode & 0o111).not.toBe(0)
  expect(urls).toEqual([expect.stringMatching(/^https:\/\/github\.com\/cloudflare\/cloudflared\/releases\/download\/[\d.]+\/cloudflared-linux-amd64$/)])
  // Phases for the status row: start, downloaded bytes, verification.
  expect(notes.map(([t]) => t.split(' ')[0])).toEqual(['Installing', 'Installing', 'Verifying'])
  expect(notes[1]![1]).toBe(binary.length)
  // Second /remote: the verified copy is reused without a download.
  await ensureCloudflared(home, (t, b) => notes.push([t, b?.done]), { platform: 'linux-x64', pins, download })
  expect(urls).toHaveLength(1)
  expect(notes).toHaveLength(3)
  expect(readdirSync(join(home, 'bin'))).toEqual(['cloudflared']) // no staging leftovers
})

test('macOS archives are checked before and after unpacking', async () => {
  const work = join(home, 'pack'); mkdirSync(work)
  writeFileSync(join(work, 'cloudflared'), 'mach-o fixture')
  Bun.spawnSync(['tar', '-czf', join(work, 'c.tgz'), '-C', work, 'cloudflared'])
  const archive = readFileSync(join(work, 'c.tgz'))
  const pins = { 'darwin-arm64': { asset: 'cloudflared-darwin-arm64.tgz', archive: sha(archive), binary: sha('mach-o fixture') } }
  const download = async () => new Response(archive)
  expect(readFileSync(await ensureCloudflared(home, () => {}, { platform: 'darwin-arm64', pins, download }), 'utf8')).toBe('mach-o fixture')
  const tampered = { 'darwin-arm64': { ...pins['darwin-arm64'], binary: sha('something else') } }
  rmSync(join(home, 'bin'), { recursive: true })
  await expect(ensureCloudflared(home, () => {}, { platform: 'darwin-arm64', pins: tampered, download })).rejects.toThrow('checksum')
  expect(existsSync(cloudflaredPath(home))).toBe(false)
})

test('a swapped download, a failed request or an unknown platform installs nothing', async () => {
  const pins = { 'linux-x64': { asset: 'cloudflared-linux-amd64', binary: sha('expected') } }
  await expect(ensureCloudflared(home, () => {}, { platform: 'linux-x64', pins, download: async () => new Response('evil') })).rejects.toThrow('pinned checksum')
  await expect(ensureCloudflared(home, () => {}, { platform: 'linux-x64', pins, download: async () => new Response('', { status: 404 }) })).rejects.toThrow('HTTP 404')
  await expect(ensureCloudflared(home, () => {}, { platform: 'win32-x64', pins })).rejects.toThrow('no build for win32-x64')
  expect(existsSync(cloudflaredPath(home))).toBe(false)
  // A previously installed copy that no longer matches the pin is replaced, not trusted.
  mkdirSync(join(home, 'bin')); writeFileSync(cloudflaredPath(home), 'old')
  await ensureCloudflared(home, () => {}, { platform: 'linux-x64', pins, download: async () => new Response('expected') })
  expect(readFileSync(cloudflaredPath(home), 'utf8')).toBe('expected')
})

test('a cloudflared already on PATH is used as is', async () => {
  mkdirSync(join(home, 'empty')); writeFileSync(join(home, 'empty', 'cloudflared'), '#!/bin/sh\n', { mode: 0o755 })
  expect(await ensureCloudflared(home, () => { throw Error('must not install') }, { download: async () => { throw Error('no') } })).toBe(join(home, 'empty', 'cloudflared'))
})
