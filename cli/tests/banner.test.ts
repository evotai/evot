import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { renderBanner } from '../src/term/banner.js'
import { resetThemeCache } from '../src/render/theme/index.js'

beforeAll(() => {
  chalk.level = 3
})

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createFixture(skillCount: number) {
  const root = mkdtempSync(join(tmpdir(), 'evot-banner-'))
  roots.push(root)
  const cwd = join(root, 'project')
  const skillsDir = join(root, 'skills')
  mkdirSync(cwd)
  mkdirSync(skillsDir)
  writeFileSync(join(cwd, 'AGENTS.md'), '# Context\n')
  for (let index = 0; index < skillCount; index++) {
    const skill = join(skillsDir, `skill-${index.toString().padStart(2, '0')}`)
    mkdirSync(skill)
    writeFileSync(join(skill, 'SKILL.md'), '# Skill\n')
  }
  return { cwd, skillsDir }
}

/** Add a group directory holding `names`, the shape `lark/` has in practice. */
function addGroup(skillsDir: string, group: string, names: string[]): void {
  for (const name of names) {
    const dir = join(skillsDir, group, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '# Skill\n')
  }
}

describe('renderBanner', () => {
  test('renders Pi-style context and skill name sections without metadata or paths', () => {
    const { cwd, skillsDir } = createFixture(12)
    const banner = stripAnsi(renderBanner({
      version: 'test',
      model: 'model',
      cwd,
      configInfo: { provider: 'provider', hasApiKey: true },
      columns: 80,
      rows: 30,
      skillsDirs: [skillsDir],
    }))

    expect(banner).toContain('  evot vtest')
    expect(banner).not.toContain('███████╗')
    expect(banner).toContain('[Context]')
    expect(banner).toContain('AGENTS.md')
    expect(banner).toContain('[Skills]')
    expect(banner).toContain('    skill-00')
    expect(banner).toContain('    skill-11')
    expect(banner).not.toContain('○')
    expect(banner).not.toContain('Directory')
    expect(banner).not.toContain('Model')
    expect(banner).not.toContain('available')
    expect(banner).not.toContain('/skill list')
  })

  test('the running UI is announced as Dashboard', () => {
    const { cwd, skillsDir } = createFixture(1)
    const banner = stripAnsi(renderBanner({
      version: 'test',
      model: 'model',
      cwd,
      configInfo: { provider: 'provider', hasApiKey: true },
      columns: 80,
      rows: 40,
      skillsDirs: [skillsDir],
      serverState: { address: 'http://127.0.0.1:8082', pid: 1 },
    }))

    expect(banner).toContain('[Dashboard]')
    expect(banner).toContain('http://127.0.0.1:8082')
    expect(banner).not.toContain('[Server]')
  })

  test('logged-out banner points at the Models page of the running UI', () => {
    const { cwd, skillsDir } = createFixture(1)
    const banner = stripAnsi(renderBanner({
      version: 'test',
      model: 'model',
      cwd,
      configInfo: { provider: 'provider', hasApiKey: false },
      columns: 80,
      rows: 40,
      skillsDirs: [skillsDir],
      serverState: { address: 'http://127.0.0.1:8082', pid: 1 },
    }))

    expect(banner).toContain('Not logged in')
    expect(banner).toContain('http://127.0.0.1:8082/models')
  })

  test('hides skill paths in the listing', () => {
    const { cwd, skillsDir } = createFixture(1)
    const banner = stripAnsi(renderBanner({
      version: 'test',
      model: 'model',
      cwd,
      configInfo: { provider: 'provider', hasApiKey: true },
      columns: 80,
      rows: 40,
      skillsDirs: [skillsDir],
    }))
    expect(banner).not.toContain(join(skillsDir, 'skill-00'))
  })

  test('a skill group is one row carrying its member count', () => {
    // Spelling out every member is what made the old banner cost three wrapped
    // lines. The count is the part a glance can use.
    const { cwd, skillsDir } = createFixture(1)
    addGroup(skillsDir, 'lark', ['lark-im', 'lark-doc', 'lark-sheets'])

    const banner = stripAnsi(renderBanner({
      version: 'test',
      model: 'model',
      cwd,
      configInfo: { provider: 'provider', hasApiKey: true },
      columns: 80,
      rows: 40,
      skillsDirs: [skillsDir],
    }))

    expect(banner).toContain('    lark/')
    expect(banner).not.toContain('●')
    expect(banner).toMatch(/lark\/[\s\S]*\b3\b/)
    expect(banner).not.toContain('lark-im')
    // The label matches `/skill list`, so the trailing slash marks the group.
    expect(banner).not.toContain('lark 3')
  })

  test('the skills row stays within the terminal width when groups are many', () => {
    const { cwd, skillsDir } = createFixture(6)
    for (const group of ['alpha', 'beta', 'gamma']) {
      addGroup(skillsDir, group, [`${group}-one`, `${group}-two`])
    }
    const columns = 40
    const banner = renderBanner({
      version: 'test',
      model: 'model',
      cwd,
      configInfo: { provider: 'provider', hasApiKey: true },
      columns,
      rows: 40,
      skillsDirs: [skillsDir],
    })
    for (const line of banner.split('\n')) {
      expect(stringWidth(stripAnsi(line))).toBeLessThanOrEqual(columns)
    }
  })

  test('uses EVOT primary for logo blocks and gold accent for shadows and headings', () => {
    const { cwd, skillsDir } = createFixture(1)
    const previousTheme = process.env.EVOT_THEME
    try {
      for (const [scheme, brandHex, accentHex] of [
        ['dark', '#b5bcf9', '#f0c674'],
        ['light', '#5769f7', '#b8860b'],
      ] as const) {
        process.env.EVOT_THEME = scheme
        resetThemeCache()

        const full = renderBanner({
          version: 'test',
          model: 'model',
          cwd,
          configInfo: undefined,
          columns: 80,
          rows: 40,
          skillsDirs: [skillsDir],
        })
        expect(full).toContain(chalk.hex(brandHex).bold(' ███████'))
        expect(full).toContain(chalk.hex(accentHex).bold('╗'))
        expect(full).toContain(chalk.hex(accentHex).bold('╚══════╝'))
        expect(full).toContain(chalk.hex(accentHex)('  [Context]'))
        expect(full).toContain(chalk.hex(accentHex)('  [Skills]'))

        const compact = renderBanner({
          version: 'test',
          model: 'model',
          cwd,
          configInfo: undefined,
          columns: 40,
          rows: 20,
          skillsDirs: [skillsDir],
        })
        expect(compact).toContain(chalk.hex(brandHex).bold('evot'))
      }
    } finally {
      if (previousTheme === undefined) delete process.env.EVOT_THEME
      else process.env.EVOT_THEME = previousTheme
      resetThemeCache()
    }
  })

  test('falls back to a one-line brand when width or rendered height is constrained', () => {
    const { cwd, skillsDir } = createFixture(1)
    const cases = [
      { columns: 40, rows: 30 },
      { columns: 80, rows: 20 },
      { columns: 80, rows: 16 },
    ]
    for (const dimensions of cases) {
      const banner = stripAnsi(renderBanner({
        version: 'test',
        model: 'model',
        cwd,
        configInfo: undefined,
        ...dimensions,
        skillsDirs: [skillsDir],
      }))

      expect(banner).toContain('  evot vtest')
      expect(banner).not.toContain('███████╗')
      expect(banner).toContain('[Skills]')
      expect(banner).toContain('skill-00')
    }
  })

  test('wraps long skill lists and hides the large logo when they need the space', () => {
    const { cwd, skillsDir } = createFixture(40)
    const columns = 32
    const banner = renderBanner({
      version: 'test',
      model: 'a-very-long-model-name',
      cwd,
      configInfo: { provider: 'long-provider-name', hasApiKey: true },
      columns,
      rows: 20,
      skillsDirs: [skillsDir],
    })
    const plain = stripAnsi(banner)

    expect(plain).toContain('  evot vtest')
    expect(plain).not.toContain('███████╗')
    expect(plain).toContain('skill-00')
    expect(plain).toContain('skill-39')
    for (const line of banner.split('\n')) {
      expect(stringWidth(stripAnsi(line))).toBeLessThanOrEqual(columns)
    }
  })

  test('stays quiet when no update is available', () => {
    const { cwd, skillsDir } = createFixture(1)
    const banner = stripAnsi(renderBanner({
      version: '2026.4.13',
      model: 'model',
      cwd,
      configInfo: { provider: 'provider', hasApiKey: true },
      columns: 80,
      rows: 30,
      skillsDirs: [skillsDir],
      updateAvailable: null,
      installDrift: null,
    }))

    expect(banner).not.toContain('available')
    expect(banner).not.toContain('Install mismatch')
  })

  test('surfaces an install mismatch with a remedy', () => {
    const { cwd, skillsDir } = createFixture(1)
    const banner = stripAnsi(renderBanner({
      version: '2026.4.13',
      model: 'model',
      cwd,
      configInfo: { provider: 'provider', hasApiKey: true },
      columns: 80,
      rows: 30,
      skillsDirs: [skillsDir],
      installDrift: 'missing native binding lib/evot-napi.darwin-arm64.node',
    }))

    expect(banner).toContain('Install mismatch')
    expect(banner).toContain('lib/evot-napi.darwin-arm64.node')
    expect(banner).toContain('run /update to reinstall')
  })

  test('surfaces an ignored --model with a remedy instead of exiting', () => {
    const { cwd, skillsDir } = createFixture(1)
    const opts = {
      version: '2026.4.13',
      model: 'claude-opus',
      cwd,
      configInfo: { provider: 'provider', hasApiKey: true },
      columns: 80,
      rows: 30,
      skillsDirs: [skillsDir],
    }
    expect(stripAnsi(renderBanner({ ...opts, startupWarning: null }))).not.toContain('ignored')

    const banner = stripAnsi(renderBanner({
      ...opts,
      startupWarning: "--model 'evot-free' ignored (no provider with model 'evot-free'); using 'claude-opus'",
    }))
    expect(banner).toContain("--model 'evot-free' ignored")
    expect(banner).toContain('pick another with /model, or drop --model')
  })
})
