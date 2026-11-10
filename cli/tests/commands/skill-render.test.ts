import { beforeAll, describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import stripAnsi from 'strip-ansi'

beforeAll(() => {
  // These renderers exist to emit colour, so the suite has to run at a level
  // where chalk actually does. Bun's runner has no TTY, where chalk.level is 0
  // and every hue assertion would pass against empty output.
  chalk.level = 3
})

import {
  renderNotice,
  renderOperation,
  renderProgress,
  renderRemoved,
  renderSkillInventoryLines,
  renderSkillList,
  type SkillListView,
  type UnitResult,
} from '../../src/commands/skill/render.js'

function lines(text: string): string[] {
  return stripAnsi(text).split('\n')
}

function unit(overrides: Partial<UnitResult> = {}): UnitResult {
  return { name: 'lark', skills: 27, outcome: 'new', detail: '', notes: [], ...overrides }
}

function view(overrides: Partial<SkillListView> = {}): SkillListView {
  return {
    total: 3,
    units: [
      { name: 'lark', label: 'lark/', origin: '@40b5130', members: ['lark-im', 'lark-doc'] },
      { name: 'zero-tech-debt', label: 'zero-tech-debt', origin: '~/.evotai/skills', members: [] },
    ],
    ...overrides,
  }
}

describe('renderSkillList', () => {
  test('heads with the skill and unit counts', () => {
    expect(lines(renderSkillList(view(), 80))[1]).toBe('  [Skills]  3 · 2 units')
  })

  test('singular unit count reads naturally', () => {
    const single = view({
      total: 1,
      units: [{ name: 'solo', label: 'solo', origin: '~/.evotai/skills', members: [] }],
    })
    expect(lines(renderSkillList(single, 80))[1]).toBe('  [Skills]  1 · 1 unit')
  })

  test('groups carry a filled marker and count without listing child skills', () => {
    const out = lines(renderSkillList(view(), 80))
    expect(out).toContain('  ● lark/           @40b5130  2')
    expect(out.join('\n')).not.toContain('lark-im')
    expect(out.join('\n')).not.toContain('im | doc')
  })

  test('the count column is sized from group origins, not long directory paths', () => {
    const long = view({
      units: [
        { name: 'lark', label: 'lark/', origin: '@40b5130', members: ['lark-im'] },
        { name: 'local', label: 'local', origin: '~/very/long/path/to/skills/dir', members: [] },
      ],
    })
    // The count follows its own origin by one gap; the lone skill's much wider
    // path does not push it right.
    expect(lines(renderSkillList(long, 80))).toContain('  ● lark/  @40b5130  1')
  })

  test('lone skills carry a hollow marker and no count column', () => {
    expect(lines(renderSkillList(view(), 80))).toContain('  ○ zero-tech-debt  ~/.evotai/skills')
  })

  test('label and origin columns are shared across groups and lone skills', () => {
    const out = lines(renderSkillList(view(), 80))
    const group = out.find((row) => row.includes('lark/'))!
    const lone = out.find((row) => row.includes('zero-tech-debt'))!
    expect(group.indexOf('@40b5130')).toBe(lone.indexOf('~/.evotai/skills'))
  })

  test('closes with the subcommand hint', () => {
    const out = lines(renderSkillList(view(), 80))
    expect(out.at(-1)).toBe(
      '  /skill install <source> · update [name] · remove <name>',
    )
  })

  test('official units share one compact section before custom units', () => {
    const official = view({
      total: 4,
      units: [
        { name: 'lark', label: 'lark/', origin: '@40b5130', official: true, members: ['lark-im'] },
        { name: 'humanize', label: 'humanize', origin: '@40b5130', official: true, members: [] },
        { name: 'local', label: 'local', origin: '~/.evotai/skills', members: [] },
      ],
    })
    const out = lines(renderSkillList(official, 120))
    const officialHeader = out.indexOf('  [Official]  auto-updated · https://github.com/evotai/evot-skills')
    const group = out.findIndex((line) => line.includes('● lark/') && line.includes('@40b5130'))
    const lone = out.findIndex((line) => line.includes('○ humanize') && line.includes('@40b5130'))
    const customHeader = out.indexOf('  [Custom]')
    const local = out.findIndex((line) => line.includes('○ local') && line.includes('~/.evotai/skills'))

    expect(officialHeader).toBeGreaterThan(-1)
    expect(officialHeader).toBeLessThan(group)
    expect(group).toBeLessThan(lone)
    expect(lone).toBeLessThan(customHeader)
    expect(customHeader).toBeLessThan(local)
    expect(out.join('\n')).not.toContain('[official]')
    expect(out).not.toContain('    Automatically installed and updated by evot.')
    expect(out).not.toContain('    No manual action needed.')
  })

  test('the shared inventory omits only the list management hint', () => {
    const inventory = renderSkillInventoryLines(view(), 80).map(stripAnsi)
    const listed = lines(renderSkillList(view(), 80))
    expect(listed.slice(1, -2)).toEqual(inventory)
    expect(inventory.join('\n')).not.toContain('/skill install')
  })

  test('an empty view says so in one line, styled like every other notice', () => {
    const out = renderSkillList({ units: [], total: 0 }, 80)
    expect(stripAnsi(out)).toBe('  no skills installed')
    expect(out).toBe(renderNotice('no skills installed'))
  })

  test('every row fits the terminal width', () => {
    const members = Array.from({ length: 27 }, (_, i) => `lark-member-${i}`)
    const wide = view({ total: 28, units: [{ name: 'lark', label: 'lark/', origin: '@40b5130', members }] })
    for (const row of lines(renderSkillList(wide, 60))) {
      expect(row.length).toBeLessThanOrEqual(60)
    }
  })
})

describe('renderOperation', () => {
  test('install names the resolved source and the closing count', () => {
    const out = lines(renderOperation({
      title: 'Installed',
      source: 'evotai/evot-skills@40b5130',
      units: [unit()],
      total: 28,
    }))
    expect(out[0]).toBe('  Installed  evotai/evot-skills@40b5130')
    expect(out).toContain('  ✓ lark/  27 skills')
    expect(out.at(-1)).toBe('  28 skills installed')
  })

  test('a lone skill shows no size column', () => {
    const out = lines(renderOperation({
      title: 'Installed',
      units: [unit({ name: 'databend-cloud', skills: 1 })],
    }))
    expect(out).toContain('  ✓ databend-cloud')
  })

  test('each outcome gets its own marker', () => {
    const out = lines(renderOperation({
      title: 'Updated',
      units: [
        unit({ name: 'lark', outcome: 'updated', detail: '3f9c2a1 → 40b5130' }),
        unit({ name: 'databend-cloud', skills: 1, outcome: 'unchanged', detail: '40b5130' }),
        unit({ name: 'zero-tech-debt', skills: 1, outcome: 'skipped', detail: 'local' }),
        unit({ name: 'broken', skills: 1, outcome: 'failed', detail: 'network down' }),
        unit({ name: 'humanize', skills: 1, outcome: 'removed', detail: 'withdrawn from catalog' }),
      ],
    }))
    expect(out).toContain('  ↑ lark/           27 skills  3f9c2a1 → 40b5130')
    expect(out).toContain('  = databend-cloud             40b5130')
    expect(out).toContain('  - zero-tech-debt             local')
    expect(out).toContain('  ✗ broken                     network down')
    expect(out).toContain('  ✕ humanize                   withdrawn from catalog')
  })

  test('warn notes hang under their unit with an actionable glyph', () => {
    const out = lines(renderOperation({
      title: 'Installed',
      units: [unit({ notes: [{ kind: 'warn', text: 'needs /env set LARK_APP_ID=<value>' }] })],
    }))
    expect(out).toContain('    ! needs /env set LARK_APP_ID=<value>')
  })

  test('info notes report what we did, not what the user must do', () => {
    const out = lines(renderOperation({
      title: 'Installed',
      units: [unit({ notes: [{ kind: 'info', text: 'replaced standalone lark-im' }] })],
    }))
    expect(out).toContain('    · replaced standalone lark-im')
  })

  test('a report with no units is just its heading', () => {
    expect(lines(renderOperation({ title: 'Updated', units: [] }))).toEqual(['  Updated'])
  })
})

describe('single-line renderers', () => {
  test('notices and removals are indented to match every other row', () => {
    expect(stripAnsi(renderNotice('skill not found: nope'))).toBe('  skill not found: nope')
    expect(stripAnsi(renderRemoved('removed skill: lark'))).toBe('  ✓ removed skill: lark')
    expect(stripAnsi(renderProgress('extracting archive...'))).toBe('  ⋯ skill  extracting archive...')
  })
})
