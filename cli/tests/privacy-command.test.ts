import { describe, expect, test } from 'bun:test'

import { editSettings, renderStatus, runPrivacyCommand, USAGE, type PrivacyPort } from '../src/commands/privacy.js'
import { privacyStatus } from '../src/native/contracts/privacy.js'
import type { PrivacySettings, PrivacyStatus } from '../src/native/index.js'

const defaults: PrivacySettings = {
  schema_version: 1, enabled: true, secrets: true, personal: true,
  actions: {}, terms: [], terms_any_case: true, allow: [],
}

const kinds = [
  { kind: 'API_KEY', category: 'secret' as const }, { kind: 'PRIVATE_KEY', category: 'secret' as const },
  { kind: 'EMAIL', category: 'personal' as const }, { kind: 'IP', category: 'network' as const },
  { kind: 'TERM', category: 'custom' as const },
]
const packs = [
  { id: 'core', rules: 2 },
  { id: 'betterleaks', rules: 421, source: 'https://github.com/betterleaks/betterleaks', license: 'MIT' },
]

function status(settings: PrivacySettings = defaults): PrivacyStatus {
  return {
    settings,
    kinds,
    packs,
    summary: {
      days: 30, requests: 4, blocked: 1,
      by_target: { llm: { requests: 3, blocked: 1 }, sync: { requests: 1, blocked: 0 } },
      kinds: [{ kind: 'API_KEY', values: 2, verified: 1, masked: 3, warned: 0, blocked: 1 }],
      recent: [
        { time: '2026-01-02T10:11:12+08:00', target: 'egress', session: 'abcdef123456', tool: 'bash', blocked: true, kinds: ['SECRET_ENV'], reason: 'names $OPENAI_API_KEY and sends it off the machine' },
        { time: '2026-01-02T10:05:00+08:00', target: 'llm', session: 'abcdef123456', blocked: false, kinds: ['API_KEY', 'EMAIL'], reason: 'masked API_KEY ×1 · EMAIL ×2' },
        { time: '2026-01-01T09:00:00+08:00', target: 'llm', session: 'abcdef123456', blocked: true, kinds: ['API_KEY'], reason: 'contains API_KEY ×1' },
      ],
    },
  }
}

function port(initial = defaults): { port: PrivacyPort; saved: PrivacySettings[] } {
  const saved: PrivacySettings[] = []
  let current = initial
  return {
    saved,
    port: {
      status: async () => status(current),
      save: async (settings) => { saved.push(settings); current = settings; return settings },
    },
  }
}

describe('/privacy', () => {
  test('bare shows what just happened, masked and blocked alike, then what is on', async () => {
    // "Today" is the day of the first two events: they get a clock only.
    expect(renderStatus(status(), '2026-01-02')).toBe([
      '  Privacy on · last 30 days',
      '',
      '  3 requests masked · 1 call blocked',
      '',
      '  10:11        bash           ✗ names $OPENAI_API_KEY and sends it off the machine',
      '  10:05        model request  masked API_KEY ×1 · EMAIL ×2',
      '  01-01 09:00  model request  ✗ contains API_KEY ×1',
      '',
      '  model requests masked · tool calls keep secrets on this machine',
      '  /privacy trust HOST · /privacy term WORD',
    ].join('\n'))
    expect(await runPrivacyCommand(port().port, '')).toContain('  3 requests masked · 1 call blocked')
  })

  test('term adds a word of yours', async () => {
    const { port: p, saved } = port()
    const added = await runPrivacyCommand(p, 'term Project Nightjar')
    expect(saved.at(-1)?.terms).toEqual(['Project Nightjar'])
    expect(added).toContain('1 term of yours')
    expect(await runPrivacyCommand(p, 'term project nightjar')).toContain('already listed')
    await runPrivacyCommand(p, 'term rm Project Nightjar')
    expect(saved.at(-1)?.terms).toEqual([])
    expect(await runPrivacyCommand(p, 'term rm missing')).toContain('no such term')
    expect(await runPrivacyCommand(p, 'term')).toBe(USAGE)
  })

  test('trust names the hosts tool calls may send secrets to; never all of them', async () => {
    const { port: p, saved } = port()
    const added = await runPrivacyCommand(p, 'trust API.OpenAI.com')
    expect(saved.at(-1)?.egress_allow).toEqual(['api.openai.com'])
    expect(added).toContain('tool calls may send secrets to api.openai.com')
    await runPrivacyCommand(p, 'trust tool:slack_post')
    expect(saved.at(-1)?.egress_allow).toEqual(['api.openai.com', 'tool:slack_post'])
    expect(await runPrivacyCommand(p, 'trust api.openai.com')).toContain('already listed')
    const removed = await runPrivacyCommand(p, 'trust rm api.openai.com')
    expect(saved.at(-1)?.egress_allow).toEqual(['tool:slack_post'])
    expect(removed).toContain('trusted host removed')
    expect(await runPrivacyCommand(p, 'trust *')).toContain('would turn the check off')
    expect(saved.at(-1)?.egress_allow).toEqual(['tool:slack_post'])
    // Settings from before the guard have no list: nothing is trusted.
    expect(await runPrivacyCommand(port().port, '7')).toContain('tool calls keep secrets on this machine')
    expect(await runPrivacyCommand(p, 'trust')).toBe(USAGE)
  })

  test('nothing on the command line turns a check off', async () => {
    const { port: p, saved } = port()
    for (const line of ['off', 'secrets off', 'personal off', 'network on', 'PRIVATE_KEY warn', 'allow add x', 'egress add *', 'kinds']) {
      expect(await runPrivacyCommand(p, line)).toBe(USAGE)
    }
    expect(editSettings(defaults, 'on', [])).toBe(USAGE)
    expect(saved).toHaveLength(0)
  })

  test('empty summary says so', () => {
    const empty = { ...status(), summary: { ...status().summary, requests: 0, blocked: 0, recent: [] } }
    expect(renderStatus(empty)).toContain('Nothing sensitive was found.')
    expect(renderStatus(empty)).not.toMatch(/\d+ requests? masked/)
  })

  test('decodes the addon status contract', () => {
    const raw = status()
    expect(privacyStatus.read(JSON.parse(JSON.stringify(raw)), '$')).toEqual(raw)
    expect(() => privacyStatus.read({ settings: defaults }, '$')).toThrow()
    // Settings and stats written before network/verified existed still read.
    const legacy = JSON.parse(JSON.stringify(raw))
    delete legacy.summary.kinds[0].verified
    expect(privacyStatus.read(legacy, '$').summary.kinds[0]!.verified).toBeUndefined()
  })
})
