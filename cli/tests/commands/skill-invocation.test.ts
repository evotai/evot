import { expect, test } from 'bun:test'
import { complete, getGhostHint } from '../../src/commands/completion.js'
import { commandInventory, resolveCommand } from '../../src/commands/index.js'
import { promptInput } from '../../src/commands/skill/invocation.js'
import { parseCommandPrompt } from '../../src/session/command-envelope.js'
import { applyCompletion, createEditorState, getEditorText, insertText } from '../../src/term/input/editor.js'

const skills = [{ name: 'x-review', dir: '/fixture/skills/x-review', command: {} }, { name: 'x-tests', dir: '/fixture/skills/x-tests', command: {} }]

test('installed skills share command resolution, completion and descriptions', () => {
  expect(complete('/x-r', 4, skills)?.replacement).toBe('/x-review ')
  expect(getGhostHint('/x-r', 4, { forked: false }, skills)).toContain('Use the x-review skill')
  const resolved = resolveCommand('/x-r check  these\nchanges', skills)
  expect(resolved).toMatchObject({ kind: 'skill', name: '/x-review', dir: skills[0]?.dir })
  const editor = applyCompletion(insertText(createEditorState(), '/x-'), skills).state
  expect(editor.completion?.items.map(item => item.value)).toEqual(['/x-review ', '/x-tests '])
  expect(getEditorText(editor)).toBe('/x-')
})

test('ambiguous skill completion menus show each registered command description without inserting it', () => {
  const entries = skills.map((skill, index) => ({ ...skill, command: { description: `Short skill description ${index}` } }))
  const menu = applyCompletion(insertText(createEditorState(), '/x-'), entries).state.completion
  expect(menu?.items).toEqual([
    { label: '/x-review', value: '/x-review ', description: 'Short skill description 0' },
    { label: '/x-tests', value: '/x-tests ', description: 'Short skill description 1' },
  ])
})

test('skill expansion preserves user text and references the selected SKILL.md without reading it early', () => {
  const expanded = promptInput('/x-r check  these\nchanges', skills)
  expect(expanded).not.toBeNull()
  const command = parseCommandPrompt(expanded!)
  expect(command?.input).toBe('/x-r check  these\nchanges')
  expect(command?.text).toBe('check  these\nchanges')
  expect(command?.instructions).toContain('/fixture/skills/x-review/SKILL.md')
  expect(promptInput('/compact', skills)).toBeNull()
  expect(promptInput('/unknown-skill', skills)).toBeNull()
  expect(promptInput('ordinary text', skills)).toBe('ordinary text')
})

test.each(['/harden', '/harden changes', '/HARDEN CHANGES', '/harden src/app/src/session', '/ha retry rollout'])(
  'migrated harden uses the ordinary skill envelope: %s', input => {
    const installed = [{ name: 'harden', dir: '/fixture/skills/harden', command: { description: 'Stress-test plans and changes', usage: '/harden [changes | <target>]', arguments: ['changes', '<target>'] } }]
    expect(resolveCommand(input, installed)).toMatchObject({ kind: 'skill', name: '/harden' })
    const expanded = promptInput(input, installed)
    expect(expanded).not.toBeNull()
    const command = parseCommandPrompt(expanded!)
    expect(command?.name).toBe('skill')
    expect(command?.input).toBe(input)
    expect(command?.text).toBe(input.replace(/^\S+\s*/, '') || undefined)
    expect(command?.instructions).toContain('/fixture/skills/harden/SKILL.md')
    expect(promptInput(input, [])).toBeNull()
    expect(commandInventory(installed).filter(command => command.name === '/harden')).toMatchObject([{ handler: 'skill' }])
    expect(getGhostHint('/ha', 3, { forked: false }, installed)).toContain('[changes  <target>]')
    expect(getGhostHint('/harden ', 8, { forked: false }, installed)).toBe('  [changes  <target>]  Stress-test plans and changes')
  },
)

test('builtin names and aliases cannot be shadowed by installed skills', () => {
  const shadow = [...skills, { name: 'help', dir: '/evil/help', command: {} }, { name: 'quit', dir: '/evil/quit', command: {} }]
  expect(resolveCommand('/help', shadow)).toMatchObject({ kind: 'resolved', name: '/help' })
  expect(resolveCommand('/quit', shadow)).toMatchObject({ kind: 'resolved', name: '/exit' })
  expect(commandInventory(shadow).filter(command => command.handler === 'skill')).toHaveLength(2)
  expect(resolveCommand('/x-', skills)).toEqual({ kind: 'ambiguous', candidates: ['/x-review', '/x-tests'] })
})

test('installing skills never changes what a builtin prefix means', () => {
  const crowded = ['memory', 'tla-model', 'rea', 'databend-cloud', 'diagram-design', 'geo-sleuth'].map(name => ({ name, dir: `/fixture/${name}`, command: {} }))
  for (const draft of ['/m', '/t', '/r', '/d', '/mod', '/res', '/he', '/lo', '/s', '/c', '/q', '/model x']) {
    expect(resolveCommand(draft, crowded)).toEqual(resolveCommand(draft))
    expect(complete(draft, draft.length, crowded)).toEqual(complete(draft, draft.length))
    expect(getGhostHint(draft, draft.length, { forked: false }, crowded)).toBe(getGhostHint(draft, draft.length))
    expect(promptInput(draft, crowded)).toBeNull()
  }
  // Skills are reachable by any prefix no builtin owns, and by exact name.
  expect(resolveCommand('/geo where', crowded)).toMatchObject({ kind: 'skill', name: '/geo-sleuth' })
  expect(resolveCommand('/memory', crowded)).toMatchObject({ kind: 'skill', name: '/memory' })
  expect(complete('/mem', 4, crowded)?.replacement).toBe('/memory ')
  expect(resolveCommand('/dat', crowded)).toMatchObject({ kind: 'skill', name: '/databend-cloud' })
})

test('numeric, dotted and mixed-case skill names resolve without broadening the published path boundary', () => {
  const names = ['3d-scene', 'foo.bar', 'Mixed-Case']
  const entries = names.map(name => ({ name, dir: `/fixture/${name}`, command: {} }))
  for (const name of names) {
    expect(resolveCommand(`/${name.toLowerCase()} inspect`, entries)).toMatchObject({ kind: 'skill', name: `/${name}` })
    expect(promptInput(`/${name} inspect`, entries)).toContain(`/fixture/${name}/SKILL.md`)
    expect(complete(`/${name.toLowerCase()}`, name.length + 1, entries)?.replacement).toBe(`/${name} `)
    expect(getGhostHint(`/${name.toLowerCase()}`, name.length + 1, { forked: false }, entries)).toBeTruthy()
  }
})

test('absolute paths remain paths, and deleting a skill removes its completion and invocation together', () => {
  expect(promptInput('/tmp/file.txt', skills)).toBe('/tmp/file.txt')
  expect(resolveCommand('/x-review', []).kind).toBe('unknown')
  expect(complete('/x-r', 4, [])?.candidates ?? []).not.toContain('/x-review')
})
