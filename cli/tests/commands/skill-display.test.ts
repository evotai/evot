import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'

import { parseSkillDisplay, readSkillDisplay } from '../../src/commands/skill/display.js'
import { skillListView } from '../../src/commands/skill/list.js'
import { skillInstall, syncOfficialSkills } from '../../src/commands/skill/manage.js'
import { renderSkillInventoryLines, renderSkillStartupLines, type SkillListView } from '../../src/commands/skill/render.js'
import { renderBanner } from '../../src/term/widgets/banner.js'

const metadata = {
  schema_version: 1,
  summary: 'Work with Feishu messages, docs, and calendars',
  example: "lark: What's new in my alerts group?",
}
const roots: string[] = []
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'evot-display-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function writeSkill(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Test skill\n---\n`)
}

function displayView(): SkillListView {
  return {
    total: 32,
    units: [
      {
        name: 'databend-cloud', label: 'databend-cloud', official: true, origin: '@abcdef0', members: [],
        display: { summary: 'Query and diagnose Databend', example: 'databend-cloud: Find slow queries and explain why' },
      },
      { name: 'lark', label: 'lark/', official: true, origin: '@abcdef0', members: ['lark-im'], display: metadata },
      { name: 'local', label: 'local', origin: '~/.evotai/skills', members: [] },
    ],
  }
}

function plain(view: SkillListView, width = 100): string[] {
  return renderSkillStartupLines(view, width).map(stripAnsi)
}

describe('official display metadata', () => {
  test('reads the single v1 format and tolerates additive fields', () => {
    const expected = { display: { summary: metadata.summary, example: metadata.example } }
    expect(parseSkillDisplay(JSON.stringify(metadata), 'lark')).toEqual(expected)
    expect(parseSkillDisplay(JSON.stringify({ ...metadata, extra: true }), 'lark')).toEqual(expected)
  })

  test('rejects absent, malformed, and unsupported versions explicitly', () => {
    for (const schema_version of [undefined, null, 0, 2, '1', true]) {
      const result = parseSkillDisplay(JSON.stringify({ ...metadata, schema_version }), 'lark')
      expect(result.display).toBeUndefined()
      expect(result.warning).toContain('Unsupported')
    }
  })

  test('rejects invalid text, wrong prefixes, and oversized files', () => {
    for (const text of ['{', 'null', '[]', '42', 'x'.repeat(4097)]) {
      expect(parseSkillDisplay(text, 'lark').warning).toBeDefined()
    }
    for (const [field, maximum] of [['summary', 60], ['example', 96]] as const) {
      for (const value of ['', ' padded ', 'line\nbreak', '\x1b[31mred', '中文', 'x'.repeat(maximum + 1), 1]) {
        expect(parseSkillDisplay(JSON.stringify({ ...metadata, [field]: value }), 'lark').warning).toBeDefined()
      }
    }
    for (const example of ['Show alerts', 'opencli: Show alerts', 'lark: ']) {
      expect(parseSkillDisplay(JSON.stringify({ ...metadata, example }), 'lark').warning).toBeDefined()
    }
  })

  test('missing files are quiet; invalid files, directories, and symlinks are safe', () => {
    const root = workspace()
    const file = join(root, '.display.json')
    expect(readSkillDisplay(root, 'lark')).toEqual({})
    writeFileSync(file, JSON.stringify(metadata))
    expect(readSkillDisplay(root, 'lark').display?.example).toBe(metadata.example)
    writeFileSync(file, 'x'.repeat(4097))
    expect(readSkillDisplay(root, 'lark').warning).toBeDefined()
    rmSync(file)
    mkdirSync(file)
    expect(readSkillDisplay(root, 'lark').warning).toBeDefined()
    rmSync(file, { recursive: true })
    symlinkSync(join(root, 'missing'), file)
    expect(readSkillDisplay(root, 'lark').warning).toBeDefined()
  })

  test('installs and refreshes metadata for single skills and groups, ignores Custom', async () => {
    const root = workspace()
    const fetchCatalog = async (commit: string) => {
      const repo = workspace()
      writeSkill(join(repo, 'skills', 'lark', 'lark-im'), 'lark-im')
      writeSkill(join(repo, 'skills', 'solo'), 'solo')
      writeFileSync(join(repo, 'skills', 'lark', '.display.json'), JSON.stringify({ ...metadata, summary: commit }))
      writeFileSync(join(repo, 'skills', 'solo', '.display.json'), JSON.stringify({ ...metadata, example: 'solo: Do something' }))
      return { dir: repo, commit }
    }
    await skillInstall(undefined, { root, env: {}, fetch: () => fetchCatalog('first') })
    writeSkill(join(root, 'custom'), 'custom')
    writeFileSync(join(root, 'custom', '.display.json'), '{')
    let units = skillListView([root], {}).units
    expect(units.find(unit => unit.name === 'lark')?.display?.summary).toBe('first')
    expect(units.find(unit => unit.name === 'solo')?.display?.example).toBe('solo: Do something')
    expect(units.find(unit => unit.name === 'custom')?.warning).toBeUndefined()
    expect(units.find(unit => unit.name === 'custom')?.display).toBeUndefined()
    // Older readers/installers ignore the new sidecar; the source contract is unchanged.
    expect(JSON.parse(readFileSync(join(root, 'lark', '.evot-source.json'), 'utf8')).version).toBe(1)
    await syncOfficialSkills({ root, env: {}, fetch: () => fetchCatalog('second') })
    units = skillListView([root], {}).units
    expect(units.find(unit => unit.name === 'lark')?.display?.summary).toBe('second')
  })
})

describe('startup skill guide', () => {
  test('shows aligned descriptions and examples without counts or official origins', () => {
    const lines = plain(displayView())
    expect(lines[0]).toBe('  [Skills]')
    expect(lines).toContain('  Official · auto-updated')
    expect(lines).toContain('    lark/           Work with Feishu messages, docs, and calendars')
    expect(lines).toContain(`                    "${metadata.example}"`)
    expect(lines.join('\n')).not.toContain('@abcdef0')
    expect(lines.join('\n')).not.toContain('32')
    expect(lines.join('\n')).not.toContain('https://')
    expect(lines.join('\n')).not.toContain('lark-im')
  })

  test('Custom startup rows omit markers but retain inventory alignment and origins', () => {
    const view = displayView()
    const custom = (lines: string[]) => lines.slice(lines.indexOf('  [Custom]'))
    expect(custom(plain(view))).toEqual(custom(renderSkillInventoryLines(view, 100).map(stripAnsi)).map(row => row.replace(/^  [○●] /, '    ')))
    expect(custom(plain(view)).join('\n')).not.toMatch(/[○●]/)
    const detailed = renderSkillInventoryLines(view, 100).map(stripAnsi).join('\n')
    expect(detailed).toContain('32 · 3 units')
    expect(detailed).toContain('@abcdef0')
  })

  test('stacks on narrow terminals, wraps hanging text, and handles tiny widths', () => {
    const view = displayView()
    const narrow = plain(view, 50)
    expect(narrow).toContain('    lark/')
    expect(narrow).toContain('      Work with Feishu messages, docs, and')
    expect(narrow).toContain('      calendars')
    for (const width of [2, 10, 30, 50, 80, 120]) {
      for (const line of plain(view, width)) expect(stringWidth(line)).toBeLessThanOrEqual(width)
    }
  })

  test('no metadata falls back to the name; warnings do not stop rendering', () => {
    const view = displayView()
    delete view.units[0]!.display
    view.units[0]!.warning = 'Unsupported .display.json schema version'
    const text = plain(view).join('\n')
    expect(text).toContain('    databend-cloud\n')
    expect(text).toContain('Unsupported .display.json schema version')
    expect(text).toContain(metadata.example)
    expect(plain({ units: [], total: 0 })).toEqual([])
  })

  test('banner uses the guide, hides large logo when height constrained, and renders server', () => {
    const banner = stripAnsi(renderBanner({
      version: 'test', model: 'test', cwd: '.', configInfo: undefined, columns: 100, rows: 24,
      serverState: { port: 8082, address: 'http://127.0.0.1:8082', channels: [] },
    }, { contextFiles: ['AGENTS.md'], skills: displayView() }))
    expect(banner).toContain('evot vtest')
    expect(banner).toContain(metadata.example)
    expect(banner).not.toContain('32 ·')
    expect(banner).toContain('http://127.0.0.1:8082')
    expect(banner).toContain('Ctrl+D exit')
  })
})
