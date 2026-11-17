import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { complete, getGhostHint } from '../../src/commands/completion.js'
import { commandInventory, resolveCommand } from '../../src/commands/index.js'
import { parseRequires, parseSkillCommand, parseSkillDescription } from '../../src/commands/skill/frontmatter.js'
import { getSkillEntries } from '../../src/commands/skill/scan.js'
import { promptInput } from '../../src/commands/skill/invocation.js'
import { createSkillSelectorState } from '../../src/term/app/selector/skill-window.js'

const legacy = readFileSync(new URL('../fixtures/contracts/skill-command-v0.md', import.meta.url), 'utf8')
const current = readFileSync(new URL('../fixtures/contracts/skill-command-v1.md', import.meta.url), 'utf8')
const metadata = {
  description: 'Stress-test the previous plan, current changes, or a target',
  usage: '/harden [changes | <target>]', arguments: ['changes', '<target>'],
}
const skills = [{ name: 'harden', dir: '/fixture/harden', command: metadata }]
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'evot-command-metadata-'))
  roots.push(path)
  return path
}
function install(path: string, text: string, name = 'harden'): void {
  mkdirSync(join(path, name), { recursive: true })
  writeFileSync(join(path, name, 'SKILL.md'), text)
}
function declaration(command: unknown): string {
  return `---\n${Bun.YAML.stringify({ name: 'harden', description: 'Test skill', metadata: { evot: { command } } }, null, 2)}\n---\n# Harden\n`
}

test('legacy skills remain discoverable without registering a slash command', () => {
  expect(parseSkillCommand(legacy)).toBeUndefined()
  const path = root()
  install(path, legacy)
  const entries = getSkillEntries([path])
  expect(entries).toEqual([{ name: 'harden', dir: join(path, 'harden') }])
  expect(commandInventory(entries).some(command => command.name === '/harden')).toBe(false)
  expect(resolveCommand('/harden', entries)).toEqual({ kind: 'unknown' })
  expect(promptInput('/harden changes', entries)).toBeNull()
  expect(getGhostHint('/', 1, { forked: false }, entries)).not.toContain('harden')
})

test('current metadata and unversioned v0 declarations load without changing legacy readers', () => {
  expect(parseSkillCommand(current)).toEqual(metadata)
  expect(parseSkillCommand(current.replace('      schema_version: 1\n', ''))).toEqual(metadata)
  expect(parseSkillCommand(declaration({}))).toEqual({})
  for (const text of [legacy, current]) {
    expect(parseSkillDescription(text)).toBe('Stress-test plans and changes')
    expect(parseRequires(text)).toEqual({ env: [], bins: ['git'], envHints: {} })
  }
  expect(parseSkillCommand(declaration({ schema_version: 1, future_hint: 'ignored' }))).toEqual({})
})

test('registered commands share name hints, fixed arguments, placeholders, and path completion', () => {
  expect(commandInventory(skills).find(command => command.name === '/harden')).toMatchObject(metadata)
  expect(getGhostHint('/', 1, { forked: false }, skills)).toContain('harden')
  expect(getGhostHint('/harden ', 8, { forked: false }, skills)).toBe(`  [changes  <target>]  ${metadata.description}`)
  expect(getGhostHint('/harden ch', 10, { forked: false }, skills)).toBe('anges')
  expect(complete('/harden ch', 10, skills)).toMatchObject({ replacement: 'changes ', wordStart: 8 })
  expect(complete('/harden CH', 10, skills)?.replacement).toBe('changes ')
  expect(getGhostHint('/harden CH', 10, { forked: false }, skills)).toBe('anges')
  expect(complete('/harden ', 8, skills)?.candidates).toEqual(['changes'])
  expect(complete('/harden <t', 10, skills)).toBeNull()
  expect(complete('/harden ./', 10, skills)?.candidates.length).toBeGreaterThan(0)
  expect(complete('/harden inspect retry behavior', 30, skills)).toBeNull()
  expect(complete('/harden ch', 10, [])).toBeNull()
})

test('skill command descriptions remain visible with argument hints before and after Tab', () => {
  for (const [input, suffix] of [['/har', 'den'], ['/harden', ''], ['/HARDEN', ''], ['/harden ', ''], ['/harden  ', '']] as const) {
    expect(getGhostHint(input, input.length, { forked: false }, skills)).toBe(`${suffix}  [changes  <target>]  ${metadata.description}`)
  }
  // Descriptions are presentation, not text to insert or append to a literal hint.
  expect(complete('/har', 4, skills)?.replacement).toBe('/harden ')
  expect(getGhostHint('/harden ch', 10, { forked: false }, skills)).toBe('anges')
  expect(getGhostHint('/harden inspect retries', 23, { forked: false }, skills)).toBe('')
  expect(getGhostHint('/harden ./', 10, { forked: false }, skills)).toBe('')
  expect(getGhostHint('/harden target', 4, { forked: false }, skills)).toBe('')
})

test('skill descriptions also survive empty arguments and default command metadata', () => {
  const entries = [{ name: 'harden', dir: '/fixture/harden', command: { description: '查找漏洞并给出修复建议' } }]
  for (const input of ['/harden', '/harden ']) {
    expect(getGhostHint(input, input.length, { forked: false }, entries)).toBe('  查找漏洞并给出修复建议')
  }
  expect(getGhostHint('/harden ', 8, { forked: false }, [{ ...entries[0]!, command: {} }])).toBe('  Use the harden skill')
})

test.each([null, true, [], 'harden', { schema_version: 2 }, { schema_version: '1' }, { schema_version: null },
  { description: '\u001b[31mUnsafe' }, { usage: 'multiple\nlines' }, { arguments: 'changes' },
  { arguments: ['two words'] }, { arguments: ['<incomplete'] }, { arguments: [42] },
].map(command => ({ command })))('malformed or unsupported declarations never register: %j', ({ command }) => {
  const text = declaration(command)
  expect(() => parseSkillCommand(text)).toThrow()
  const path = root()
  install(path, text)
  const entries = getSkillEntries([path])
  expect(entries[0]?.command).toBeUndefined()
  expect(entries[0]?.commandError).toBeTruthy()
  expect(resolveCommand('/harden', entries)).toEqual({ kind: 'unknown' })
  expect(createSkillSelectorState(entries).items[0]?.preview?.join('\n')).toContain('Command not registered:')
})

test('later skill directories can withdraw registration; grouped skills register normally', () => {
  const first = root(), second = root()
  install(first, current)
  install(second, legacy)
  expect(getSkillEntries([first])[0]?.command).toEqual(metadata)
  expect(getSkillEntries([first, second])[0]?.command).toBeUndefined()
  const group = join(root(), 'review')
  install(group, current)
  expect(getSkillEntries([join(group, '..')])[0]).toMatchObject({ name: 'harden', group: 'review', command: metadata })
  install(second, current.replace('/harden [changes | <target>]', '/different [request]'))
  expect(getSkillEntries([second])[0]?.commandError).toContain('must start with /harden')
})
