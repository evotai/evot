import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'
import { builtinSkillsRoot } from '../../src/commands/skill/paths.js'
import { createSkillSelectorState } from '../../src/term/app/selector/skill-window.js'
import { handleSelectorControl } from '../../src/term/app/selector/selector-control.js'
import { parseSkillDescription } from '../../src/commands/skill/frontmatter.js'
import { selectorFocusOn, selectorType, selectorDown, selectorClearQuery } from '../../src/ui/selector.js'
import { buildSelectorRegionLines } from '../../src/term/viewmodel/selector.js'
import { CURSOR_MARKER } from '../../src/term/screen/render-frame.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'evot-skill-selector-'))
  roots.push(root)
  const entries = [
    { name: 'lark-im', group: 'lark', dir: join(root, 'lark', 'lark-im') },
    { name: 'opencli', dir: join(root, 'opencli') },
    { name: 'local', dir: join(root, 'local') },
    ...Array.from({ length: 20 }, (_, i) => ({ name: `lark-member-${i}`, group: 'lark', dir: join(root, 'lark', `lark-member-${i}`) })),
  ]
  for (const entry of entries) {
    mkdirSync(entry.dir, { recursive: true })
    writeFileSync(join(entry.dir, 'SKILL.md'), `---\nname: ${entry.name}\ndescription: ${entry.name === 'lark-im' ? 'Search messages and manage chats' : 'A useful skill'}\n---\n`)
  }
  writeFileSync(join(root, 'lark', '.evot-source.json'), JSON.stringify({ version: 1, repo: 'evotai/evot-skills', path: 'skills/lark' }))
  writeFileSync(join(root, 'opencli', '.evot-source.json'), JSON.stringify({ version: 1, repo: 'evotai/evot-skills', path: 'skills/opencli' }))
  writeFileSync(join(root, 'opencli', '.display.json'), JSON.stringify({ schema_version: 1, summary: 'Browse, research, and automate the web', example: "opencli: What's new on my Twitter timeline?" }))
  return { root, entries, state: createSkillSelectorState(entries) }
}

function render(state: ReturnType<typeof createSkillSelectorState>, columns = 100, rows = 32) {
  return buildSelectorRegionLines(state, columns, rows).map(stripAnsi)
}

describe('skill browser', () => {
  test('collapses packages by default, labels official sources, and hides builtins', () => {
    const { state, entries } = fixture()
    expect(state.items.map(item => item.label)).toEqual(['opencli', 'lark/', 'local'])
    expect(state.items[0]?.badge).toBe('official')
    expect(state.items[1]?.badge).toBe('official')
    expect(state.items[2]?.badge).toBeUndefined()
    const hidden = createSkillSelectorState([...entries,
      { name: 'memory', dir: join(builtinSkillsRoot(), 'memory') },
      { name: 'harden', dir: join(builtinSkillsRoot(), 'harden') },
    ])
    expect(hidden.items.some(item => item.id === 'memory' || item.id === 'harden')).toBe(false)
    expect(selectorType(hidden, 'memory').items).toEqual([])
    const next = selectorDown(selectorFocusOn(state, item => item.id === 'opencli'))
    expect(next.items[next.focusIndex]?.id).toBe('group:lark')
    const opened = handleSelectorControl(next, { type: 'enter' })
    expect(opened.kind).toBe('update')
    if (opened.kind !== 'update') throw new Error('Expected group expansion')
    expect(opened.state.items).toHaveLength(24)
    const member = selectorDown(opened.state)
    expect(member.items[member.focusIndex]?.id).toBe('lark-im')
    expect(handleSelectorControl(member, { type: 'enter' })).toEqual({ kind: 'none' })
    const collapsed = handleSelectorControl(opened.state, { type: 'enter' })
    expect(collapsed.kind).toBe('update')
    if (collapsed.kind !== 'update') throw new Error('Expected group collapse')
    expect(collapsed.state.items).toHaveLength(3)
    expect(collapsed.state.items[collapsed.state.focusIndex]?.id).toBe('group:lark')
    const searched = selectorType(collapsed.state, 'messages')
    expect(searched.items.map(item => item.label)).toEqual(['lark/', 'im'])
    expect(selectorClearQuery(searched).items).toHaveLength(3)
    expect(handleSelectorControl(next, { type: 'delete' })).toEqual({ kind: 'none' })
  })

  test('uses official sidecar copy and searches descriptions and examples across groups', () => {
    const { state } = fixture()
    const twitter = selectorType(state, 'Twitter timeline')
    expect(twitter.items.map(item => item.id)).toEqual(['opencli'])
    const messages = selectorType(state, 'messages')
    expect(messages.items.map(item => item.label)).toEqual(['lark/', 'im'])
    expect(messages.items[1]?.preview).toContain('Search messages and manage chats')
    expect(selectorType(state, 'lark-im').items.map(item => item.label)).toEqual(['lark/', 'im'])
  })

  test('wide layout groups sources on the left and places details on the right', () => {
    const { state } = fixture()
    const focused = selectorFocusOn(state, item => item.id === 'opencli')
    const text = render(focused).join('\n')
    expect(text).toContain('│')
    expect(text.indexOf('Official')).toBeLessThan(text.indexOf('Custom'))
    const lines = render(focused)
    const detailLine = lines.find(row => row.includes('Browse, research'))
    expect(detailLine?.split('│')[1]).toContain('Browse, research')
    // The shared split: one aligned divider, the list on the larger side.
    const dividers = new Set(lines.filter(row => row.includes('│')).map(row => row.indexOf('│')))
    expect(dividers.size).toBe(1)
    expect([...dividers][0]!).toBeGreaterThan(50)
    expect(text).not.toContain('[official]')
    expect(text).toContain('Browse, research, and automate the web')
    // The example wraps inside the pane; read it back as one sentence.
    const details = lines.map(row => row.split('│')[1]?.trim() ?? '').filter(Boolean).join(' ')
    expect(details).toContain("opencli: What's new on my Twitter timeline?")
    expect(text).not.toContain('installed')
    expect(text).not.toContain('transcript')
    expect(text).not.toContain('in lark/')
    expect(text).not.toContain('Enter')
    expect(render(focused).length).toBeLessThanOrEqual(24)
  })

  test('search results indent members under their package', () => {
    const { state } = fixture()
    const focused = selectorFocusOn(selectorType(state, 'member-9'), item => item.id === 'lark-member-9')
    const text = render(focused).join('\n')
    expect(text).toContain('lark/')
    expect(text).toContain('·     member-9')
    expect(text).toContain('Official')
    expect(text).not.toContain('[official]')
    expect(text).toContain('lark-member-9')
  })

  test('narrow layout retains description and example and every line fits', () => {
    const { state } = fixture()
    const focused = selectorFocusOn(state, item => item.id === 'opencli')
    const text = render(focused, 60).join('\n')
    expect(text).not.toContain('│')
    expect(text).toContain('Official')
    expect(text).toContain('Custom')
    expect(text).not.toContain('[official]')
    expect(text).toContain('Browse, research, and automate the web')
    expect(text).toContain("opencli: What's new on my Twitter timeline?")
    for (const width of [1, 10, 30, 60, 76, 100]) {
      for (const row of render(focused, width)) expect(stringWidth(row.replaceAll(CURSOR_MARKER, ''))).toBeLessThanOrEqual(width)
    }
  })

  test('cursor ownership and empty search stay explicit', () => {
    const { state } = fixture()
    expect(buildSelectorRegionLines(state, 100, 32, false).join('')).not.toContain(CURSOR_MARKER)
    expect(buildSelectorRegionLines(state, 100, 32, true).join('')).toContain(CURSOR_MARKER)
    expect(buildSelectorRegionLines({ ...state, listFocused: true }, 100, 32, true).join('')).not.toContain(CURSOR_MARKER)
    expect(render(selectorType(state, 'nonexistent')).join('\n')).toContain('No matching skills')
    expect(render(createSkillSelectorState([])).join('\n')).toContain('No skills installed')
  })

  test('metadata is a snapshot, and missing or unsafe descriptions degrade safely', () => {
    const { root, entries, state } = fixture()
    rmSync(root, { recursive: true, force: true })
    expect(render(selectorFocusOn(state, item => item.id === 'opencli')).join('\n')).toContain('Twitter')
    expect(createSkillSelectorState(entries).items[0]?.preview).toContain('No description available.')
    mkdirSync(entries[0]!.dir, { recursive: true })
    writeFileSync(join(entries[0]!.dir, 'SKILL.md'), '---\ndescription: "\x1b[31mUnsafe\x07 text"\n---')
    const item = createSkillSelectorState([entries[0]!]).allItems[1]
    expect(item?.preview?.[2]).toBe('Unsafe text')
  })
})

describe('skill description frontmatter', () => {
  test('supports quoted descriptions, block scalars, CRLF and missing fields', () => {
    expect(parseSkillDescription('---\ndescription: "Read docs"\n---')).toBe('Read docs')
    expect(parseSkillDescription('---\ndescription: >-\n  Read docs\n  and messages\nname: lark\n---')).toBe('Read docs and messages')
    expect(parseSkillDescription('\uFEFF---\r\ndescription: |\r\n  Read docs\r\n---')).toBe('Read docs')
    expect(parseSkillDescription('# No frontmatter')).toBeUndefined()
    expect(parseSkillDescription('---\nname: skill\n---')).toBeUndefined()
  })
})
