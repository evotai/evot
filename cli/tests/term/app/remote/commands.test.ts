import { expect, test } from 'bun:test'
import { phoneCommandHints, phoneCommands, phoneSubmission } from '../../../../src/term/app/remote/commands.js'
import { commandChoices, phoneLocalCommand, phoneShortcut, sharedChoices } from '../../../../src/features/remote/phone-commands.js'
import { completeSlashCommand, getGhostHint } from '../../../../src/commands/completion.js'
import { promptInput } from '../../../../src/commands/skill/invocation.js'
import { argumentCompletion } from '../../../../src/term/app/composer/command-arguments.js'
import type { RemoteSlashHints } from '../../../../src/features/remote/protocol.js'
import legacy from '../../../fixtures/contracts/remote-commands-legacy.json'

const skills = [{ name: 'harden', dir: '/private/fixture', command: {
  description: 'Check the plan', usage: '/harden [changes | <target>]', arguments: ['changes', '<target>'],
} }, { name: 'unregistered', dir: '/private/other' }]
const commands = phoneCommands(skills)
const hints: RemoteSlashHints = {catalog: phoneCommandHints(skills), forked: false, inventory: {
  models: [{label:'Model Alpha',value:'local:model-a'}, {label:'Beta',value:'local:beta'}],
  sessions: [{label:'Previous work',value:'01234567-aabb-4ccc-9dde-0123456789ab'}],
}}

test('the new phone reads the historical runnable catalog, and the current writer preserves its exact shape', () => {
  expect(commandChoices('/', legacy).items.map(o => o.label)).toEqual(['/help', '/resume', '/sessions', '/new', '/model'])
  expect(phoneShortcut('/SE', legacy)).toEqual({kind:'sessions',args:''})
  expect(JSON.parse(JSON.stringify(phoneCommands([])))).toStrictEqual(legacy)
})

test('legacy menus use the selected host’s runnable catalog, never skill paths or local-only actions', () => {
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

test('Remote and TUI agree on hints and edits, including /share, hidden commands, and fork context', () => {
  for (const forked of [true, false]) {
    for (const text of ['/', '/s', '/SHA', '/share', '/share ', '/sha pu', '/share t', '/share pr', '/share o', '/share l',
      '/share x', '/share private abcd', '/env l', '/rest', '/remote dev', '/qui', '/ha', '/ha c', '/harden <t', '/opt/path']) {
      const result = sharedChoices(text, text.length, {...hints,forked})
      const tui = completeSlashCommand(text, skills)
      expect(result.hint, text).toBe(getGhostHint(text,text.length,{forked},skills))
      expect(result.replacement, text).toBe(tui?.replacement ?? null)
      if (tui) expect(result.start, text).toBe(tui.wordStart)
    }
    const bare = sharedChoices('/',1,{...hints,forked}).items.map(item => item.label)
    expect(bare.includes('/back')).toBe(forked)
    expect(bare).toContain('/share')
    expect(bare).not.toContain('/restart')
  }
  expect(sharedChoices('/share ',7,hints).items.map(item => item.label)).toEqual(['public','team','private','off','list'])
  expect(sharedChoices('/share pu abcd',9,hints)).toMatchObject({start:7,end:9,replacement:'public ',hint:''})
  expect(sharedChoices('/ha',3,{...hints,catalog:phoneCommandHints([])}).items).toEqual([])
  expect(JSON.stringify(hints.catalog)).not.toMatch(/\/private\/fixture|unregistered/)
})

test('model and session arguments use the same values, order and edit ranges as the TUI', () => {
  for (const text of ['/model', '/model ALP', '/model missing', '/sessions ', '/sessions 0123']) {
    const tui = argumentCompletion(text,text.length,hints.inventory)
    const phone = sharedChoices(text,text.length,hints)
    expect(tui).not.toBeNull()
    expect(phone.items.map(({label,value}) => [label,value])).toEqual(tui?.items.map(({label,value}) => [label,value]))
    expect([phone.start,phone.end]).toEqual([tui?.start,tui?.end])
    expect(phone.note).toBe(tui?.note)
    expect(phone.hint).toBe(getGhostHint(text,text.length,{forked:false},skills))
  }
  expect(sharedChoices('/sessions find last run',23,hints).items).toEqual([])
  expect(sharedChoices('/model local:model-a',20,hints).items.map(item => item.value)).toEqual(['local:model-a'])
})

test('legacy model argument completion uses only the observed inventory and keeps the full route', () => {
  const models = [{spec:'local:model-a',label:'Model Alpha'}, {spec:'local:beta',label:'Beta'}]
  expect(commandChoices('/m ALP',commands,models).items.map(i => i.value)).toEqual(['/model local:model-a '])
  expect(commandChoices('/model OLD',commands,models).items).toEqual([])
})

test('phone shortcuts open native surfaces, while prose and skills remain agent turns', () => {
  for (const [text, kind, args] of [['/H', 'help', ''], ['/m demo', 'model', 'demo'], ['/n', 'new', ''],
    ['/sessions', 'sessions', ''], ['/r "abc"', 'sessions', 'abc'], ['/resume --all', 'sessions', '']]) {
    expect(phoneShortcut(text!, commands)).toEqual({ kind, args })
    expect(phoneShortcut(text!, commands, hints)).toEqual({ kind, args })
  }
  for (const text of ['/resume find yesterday’s change', '/ha', '/remote approve 12345678', '/s', '/share public', '/rest', 'hi']) {
    expect(phoneShortcut(text, commands)).toBeNull()
    expect(phoneShortcut(text, commands, hints)).toBeNull()
  }
  expect(phoneShortcut('/new', undefined)).toBeNull()
})

test('host rechecks each submission using TUI expansion; unlisted actions cannot bypass admission', () => {
  for (const steer of [false, true]) for (const photos of [false, true]) {
    expect(phoneSubmission('/ha xx', skills, steer, photos)).toEqual({kind:'prompt',text:promptInput('/ha xx', skills)})
    expect(phoneSubmission('/opt/project', skills, steer, photos)).toEqual({kind:'prompt',text:'/opt/project'})
    for (const cmd of ['/remote approve 12345678', '/env get X --reveal', '/restart', '/s', '/unknown'])
      expect(() => phoneSubmission(cmd, skills, steer, photos)).toThrow()
  }
  expect(() => phoneSubmission('/harden xx', [], false, false)).toThrow('Unknown')
  expect(phoneSubmission('/r find my last test', skills, false, false)).toEqual({kind:'prompt',text:'/sessions find my last test'})
  expect(() => phoneSubmission('/sessions find it', skills, false, true)).toThrow('text only')
  expect(() => phoneSubmission('/r find it', skills, true, false)).toThrow('finish')
})

test('Remote accepts text-only share commands for the current session, never import or arbitrary targets', () => {
  for (const mode of ['team', 'private', 'off', 'public']) {
    const text = `/SHAR ${mode.toUpperCase()}`
    expect(phoneLocalCommand(text, hints)).toBe('/share')
    expect(phoneSubmission(text, skills, false, false)).toEqual({kind:'share',mode})
    expect(() => phoneSubmission(text, skills, true, false)).toThrow('finish')
    expect(() => phoneSubmission(text, skills, false, true)).toThrow('text only')
  }
  expect(phoneLocalCommand('/s', hints)).toBeNull()
  expect(phoneLocalCommand('/share project', undefined)).toBe('/share')
  for (const text of ['/share', '/share list']) {
    expect(phoneSubmission(text, skills, false, false)).toEqual({kind:'share',mode:'usage'})
  }
  for (const arg of ['team 01234567','public --all','cloud','links','https://example.test/team/abcdefghijklmnopqrstuv']) {
    expect(() => phoneSubmission(`/share ${arg}`, skills, false, false)).toThrow('Usage on Remote:')
  }
})

test('read-only /version has local output; arguments, photos, and queued execution are refused', () => {
  expect(phoneLocalCommand('/VERS', hints)).toBe('/version')
  expect(phoneSubmission('/version', skills, false, false)).toEqual({kind:'version'})
  expect(() => phoneSubmission('/version --anything', skills, false, false)).toThrow('Usage: /version')
  expect(() => phoneSubmission('/version', skills, false, true)).toThrow('text only')
  expect(() => phoneSubmission('/version', skills, true, false)).toThrow('finish')
  for (const text of ['/login','/logout','/update','/log shot','/privacy off','/skill install payload']) {
    expect(phoneLocalCommand(text, hints)).toBeNull()
    expect(() => phoneSubmission(text, skills, false, false)).toThrow('not available on Remote')
  }
})
