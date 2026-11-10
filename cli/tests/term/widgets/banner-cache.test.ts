import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import stripAnsi from 'strip-ansi'
import { BannerCache } from '../../../src/term/widgets/banner-cache.js'
import { loadBannerData, renderBanner, type BannerOptions } from '../../../src/term/widgets/banner.js'
import { resetThemeCache } from '../../../src/ui/theme/index.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'evot-banner-cache-'))
  roots.push(cwd)
  const skills = join(cwd, 'skills')
  mkdirSync(skills)
  const opts: BannerOptions = {
    version: 'test', model: 'test', cwd, columns: 80, rows: 40,
    configInfo: undefined, skillsDirs: [skills],
  }
  let loads = 0
  let paints = 0
  const cache = new BannerCache(cwd, [skills], (...args) => {
    loads++
    return loadBannerData(...args)
  }, (...args) => {
    paints++
    return renderBanner(...args)
  })
  return { cwd, skills, opts, cache, counts: () => ({ loads, paints }) }
}

describe('banner cache', () => {
  test('idle/spinner frames reuse text; resize reflows without disk discovery', () => {
    const f = fixture()
    const initial = f.cache.render(f.opts)
    for (let i = 0; i < 100; i++) {
      expect(f.cache.render({ ...f.opts, skillsDirs: [...(f.opts.skillsDirs ?? [])] })).toBe(initial)
    }
    expect(f.counts()).toEqual({ loads: 1, paints: 1 })
    f.cache.render({ ...f.opts, columns: 50 })
    f.cache.render({ ...f.opts, columns: 50, rows: 10 })
    expect(f.counts()).toEqual({ loads: 1, paints: 3 })
  })

  test('file changes appear on refresh, never via a frame-time scan', () => {
    const f = fixture()
    const initial = f.cache.render(f.opts)
    mkdirSync(join(f.skills, 'new-skill'))
    writeFileSync(join(f.skills, 'new-skill', 'SKILL.md'), '# Skill')
    writeFileSync(join(f.cwd, 'AGENTS.md'), '# Context')
    expect(f.cache.render(f.opts)).toBe(initial)
    expect(f.cache.refresh(f.cwd, [f.skills])).toBe(true)
    const updated = stripAnsi(f.cache.render(f.opts))
    expect(updated).toContain('new-skill')
    expect(updated).toContain('AGENTS.md')
    expect(f.cache.refresh(f.cwd, [f.skills])).toBe(false)
    f.cache.render(f.opts)
    expect(f.counts()).toEqual({ loads: 3, paints: 2 })
    rmSync(join(f.skills, 'new-skill'), { recursive: true })
    rmSync(join(f.cwd, 'AGENTS.md'))
    expect(f.cache.refresh(f.cwd, [f.skills])).toBe(true)
    expect(stripAnsi(f.cache.render(f.opts))).not.toContain('new-skill')
    expect(stripAnsi(f.cache.render(f.opts))).not.toContain('AGENTS.md')
  })

  test('auth, server, release notes, drift and theme invalidate only the painted frame', () => {
    const f = fixture()
    f.cache.render(f.opts)
    // Banner only consumes hasApiKey, not the rest of ConfigInfo.
    const configInfo = { hasApiKey: false } as NonNullable<BannerOptions['configInfo']>
    const opts = { ...f.opts, configInfo }
    expect(stripAnsi(f.cache.render(opts))).toContain('Not logged in')
    configInfo.hasApiKey = true
    expect(stripAnsi(f.cache.render(opts))).not.toContain('Not logged in')
    const releaseNotes = ['First note']
    const changed = {
      ...opts, releaseNotes, installDrift: 'drift reason',
      serverState: { port: 8080, address: 'http://localhost:8080', channels: [] },
    }
    const text = stripAnsi(f.cache.render(changed))
    expect(text).toContain('First note')
    expect(text).toContain('drift reason')
    expect(text).toContain('http://localhost:8080')
    releaseNotes.push('Second note')
    expect(stripAnsi(f.cache.render(changed))).toContain('Second note')
    const before = f.counts().paints
    resetThemeCache()
    f.cache.render(changed)
    expect(f.counts()).toEqual({ loads: 1, paints: before + 1 })
  })

  test('switching discovery roots replaces the snapshot', () => {
    const f = fixture()
    const other = fixture()
    mkdirSync(join(other.skills, 'other-skill'))
    writeFileSync(join(other.skills, 'other-skill', 'SKILL.md'), '# Skill')
    f.cache.render(f.opts)
    expect(f.cache.refresh(other.cwd, [other.skills])).toBe(true)
    expect(stripAnsi(f.cache.render(other.opts))).toContain('other-skill')
  })
})
