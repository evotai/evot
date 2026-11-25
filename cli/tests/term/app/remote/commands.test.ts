import { expect, test } from 'bun:test'
import { phoneCommands, phonePrompt } from '../../../../src/term/app/remote/commands.js'
import { commandChoices, phoneShortcut } from '../../../../src/features/remote/phone-commands.js'
import { promptInput } from '../../../../src/commands/skill/invocation.js'

const skills = [{ name: 'harden', dir: '/private/fixture', command: {
  description: 'Check the plan', usage: '/harden [changes | <target>]', arguments: ['changes', '<target>'],
} }, { name: 'unregistered', dir: '/private/other' }]
const commands = phoneCommands(skills)

test('the mobile menu uses only the selected host’s registered commands, never skill paths or local-only actions', () => {
  expect(commandChoices('/', commands).items.map(o => o.label)).toEqual(['/help', '/resume', '/sessions', '/new', '/model', '/harden'])
  expect(JSON.stringify(commands)).not.toMatch(/private|unregistered|\/remote/)
  expect(commandChoices('/H', commands).items.map(o => o.value)).toEqual(['/help '])
  expect(commandChoices('/HA', commands).items).toEqual([{ label: '/harden', detail: 'Check the plan', value: '/harden ' }])
  expect(commandChoices('/ha ', commands)).toEqual({ hint: '/harden [changes | <target>]', items: [{ label: 'changes', value: '/harden changes ' }] })
  expect(commandChoices('/harden CH', commands).items[0]?.value).toBe('/harden changes ')
  for (const input of ['/harden <t', '/harden xx', '/tmp/file', 'fix /ha']) expect(commandChoices(input, commands).items).toEqual([])
  expect(commandChoices('/', undefined).items).toEqual([]) // older TUI
  expect(commandChoices('/ha', phoneCommands([])).items).toEqual([]) // different window
})

test('model argument completion uses only the observed inventory and keeps the full route', () => {
  const models = [{spec:'local:model-a',label:'Model Alpha'}, {spec:'local:beta',label:'Beta'}]
  expect(commandChoices('/m ALP',commands,models).items.map(i => i.value)).toEqual(['/model local:model-a '])
  expect(commandChoices('/model OLD',commands,models).items).toEqual([])
})

test('phone shortcuts open native surfaces, while prose and skills remain agent turns', () => {
  for (const [text, kind, args] of [['/H', 'help', ''], ['/m demo', 'model', 'demo'], ['/n', 'new', ''],
    ['/sessions', 'sessions', ''], ['/r "abc"', 'sessions', 'abc'], ['/resume --all', 'sessions', '']]) {
    expect(phoneShortcut(text!, commands)).toEqual({ kind, args })
  }
  for (const text of ['/resume find yesterday’s change', '/ha', '/remote approve 12345678', '/s', 'hi']) expect(phoneShortcut(text, commands)).toBeNull()
  expect(phoneShortcut('/new', undefined)).toBeNull()
})

test('host rechecks each submission using TUI expansion; unlisted actions cannot bypass admission', () => {
  for (const steer of [false, true]) for (const photos of [false, true]) {
    expect(phonePrompt('/ha xx', skills, steer, photos)).toBe(promptInput('/ha xx', skills))
    expect(phonePrompt('/opt/project', skills, steer, photos)).toBe('/opt/project')
    for (const cmd of ['/remote approve 12345678', '/env get X --reveal', '/s', '/unknown'])
      expect(() => phonePrompt(cmd, skills, steer, photos)).toThrow()
  }
  expect(() => phonePrompt('/harden xx', [], false, false)).toThrow('Unknown')
  expect(phonePrompt('/r find my last test', skills, false, false)).toBe('/sessions find my last test')
  expect(() => phonePrompt('/sessions find it', skills, false, true)).toThrow('text only')
  expect(() => phonePrompt('/r find it', skills, true, false)).toThrow('finish')
})
