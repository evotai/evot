import { beforeEach, expect, test } from 'bun:test'

import { runShareCommand, type ShareContext } from '../../src/commands/share.js'
import type { CloudPushResult, SessionMeta } from '../../src/native/index.js'
import { parsePrivacyStop } from '../../src/render/privacy-notice.js'
import { classifyProviderFailure } from '../../src/render/provider-error.js'
import { buildEventCard, buildPrivacyCard, buildPrivacyNoticeCard, resetIdCounter, type OutputLine } from '../../src/render/output.js'
import { formatLlmCallCompleted } from '../../src/render/verbose.js'
import { CloudSessionSync } from '../../src/session/cloud-sessions.js'

// Exactly what src/app/src/privacy/notice.rs writes (pinned by
// notice_wording_is_the_cli_contract in src/app/tests/privacy_test.rs).
const BLOCKED_LLM = 'privacy blocked this request: it contains API_KEY, PRIVATE_KEY. Nothing was sent; run /privacy to review the rule.'
const BLOCKED_SYNC = 'privacy blocked this sync: it contains EMAIL. Nothing was sent; run /privacy to review the rule.'
const UNAVAILABLE = 'privacy masking is unavailable, so nothing was sent: privacy settings are invalid: x. Fix the settings or rule packs with /privacy (/privacy off lets model requests through unmasked; uploads always wait for masking)'

const texts = (lines: OutputLine[]) => lines.map(line => line.text)

beforeEach(() => resetIdCounter())

test('the notice shows the new authorization finding, not the old passwords in the request', () => {
  const card = buildPrivacyNoticeCard({
    target: 'llm',
    reason: 'masked PASSWORD ×22 · SECRET ×5 · TOKEN ×1',
    findings: [
      { tag: 'PASSWORD_old', kind: 'PASSWORD', action: 'mask', rule: 'contexts.url-password', at: 'read result', label: 'mask.rs', line: 307 },
      { tag: 'TOKEN_new', kind: 'TOKEN', action: 'mask', rule: 'contexts.authorization',
        preview: 'Authorization: Bearer ghp_[mask]', at: 'read result', path: 'scripts/deploy.sh', line: 42 },
    ],
  }, new Set(['TOKEN_new']), '/work/project')
  expect(texts(card)).toEqual([
    '⊘ privacy  masked',
    '  Authorization: Bearer ghp_[mask] · Authorization header · /work/project/scripts/deploy.sh:42',
  ])
  expect(card[0]!.toolCard).toEqual({ state: 'success', first: true, last: false, tone: 'notice' })
  expect(card.at(-1)!.toolCard).toEqual({ state: 'success', first: false, last: true, tone: 'notice' })
})

test('findings without previews do not invent details and warnings do not claim a mask', () => {
  const card = buildPrivacyNoticeCard({ target: 'llm', reason: 'warned (not masked) SECRET ×1', findings: [
    { tag: 'SECRET_new', kind: 'SECRET', action: 'warn', rule: 'custom.db-session', at: 'bash result', label: 'run {{SECRET_abcd2345}}' },
  ] }, new Set(['SECRET_new']), '/work/project')
  expect(texts(card)).toEqual([
    '⊘ privacy  warned (not masked)',
    '  [mask] · custom.db-session · bash result (run [mask])',
  ])
})

test('legacy notices do not attribute request-wide findings to the new value', () => {
  expect(texts(buildPrivacyNoticeCard({ target: 'llm', reason: 'masked PASSWORD ×22 · TOKEN ×1' }, new Set(['TOKEN_new']), '/work/project'))).toEqual([
    '⊘ privacy  model request',
    '  1 new value · request total: masked PASSWORD ×22 · TOKEN ×1 · match locations unavailable',
  ])
})

test('parses the native wording, wherever it sits in an error', () => {
  expect(parsePrivacyStop(`Invalid request: ${BLOCKED_LLM}`)).toEqual({ kind: 'blocked', target: 'request', kinds: ['API_KEY', 'PRIVATE_KEY'] })
  expect(parsePrivacyStop(`configuration error: ${BLOCKED_SYNC}`)).toEqual({ kind: 'blocked', target: 'sync', kinds: ['EMAIL'] })
  expect(parsePrivacyStop(UNAVAILABLE)).toEqual({ kind: 'unavailable', reason: 'privacy settings are invalid: x' })
  expect(parsePrivacyStop('Invalid request: the privacy policy forbids this')).toBeNull()
  expect(classifyProviderFailure(`Invalid request: ${BLOCKED_LLM}`)).toBe('privacy-blocked')
  expect(classifyProviderFailure(UNAVAILABLE)).toBe('privacy-unavailable')
})

test('a blocked LLM request is a privacy card, not "Invalid request"', () => {
  const event = formatLlmCallCompleted({ model: 'claude', turn: 2, duration_ms: 3, error: `Invalid request: ${BLOCKED_LLM}` })
  // Without the record (an older addon, or a block another process made):
  // the kinds the error named, nothing invented about where they sat.
  const card = buildEventCard(event.text)
  expect(texts(card)).toEqual([
    '⊘ privacy  blocked request',
    '  ✗ · nothing was sent · contains API_KEY · PRIVATE_KEY',
    '  Remove the value from its source before retrying.',
    '  In chat history? Start a new session with /new. · /privacy for the record',
  ])
  expect(card[0]!.toolCard).toEqual({ state: 'error', first: true, last: false, tone: 'notice' })
  expect(card.at(-1)!.toolCard?.last).toBe(true)
  expect(texts(card).join('\n')).not.toContain('Invalid request')
  expect(texts(card).join('\n')).not.toContain('mask')
})

test('with the record, the blocked card says which model, where the values sat and which rules found them', () => {
  const event = formatLlmCallCompleted({ model: 'claude', turn: 2, duration_ms: 3, error: `Invalid request: ${BLOCKED_LLM.replace('API_KEY, ', '')}` })
  const detail = {
    provider: 'evot-pro-anthropic', model: 'claude-opus-5.5', reason: 'contains PRIVATE_KEY ×1',
    rules: [{ rule: 'secrets.ssh-private-key', values: 1 }],
    origins: [{ at: 'Bash result', label: 'cat ~/.ssh/id_ed25519', n: 1 }],
  }
  expect(texts(buildEventCard(event.text, () => detail))).toEqual([
    '⊘ privacy  blocked request → claude-opus-5.5 · evot-pro-anthropic',
    '  ✗ · nothing was sent · contains PRIVATE_KEY ×1',
    '  SSH private key block',
    '  Request findings (not all blocked) in: Bash result "cat ~/.ssh/id_ed25519"',
    '  by rule: secrets.ssh-private-key',
    '  Remove the value from its source before retrying.',
    '  In chat history? Start a new session with /new. · /privacy for the record',
  ])
  // Several places and rules: counts, most first, the long tail folded.
  const many = {
    ...detail, reason: 'contains SECRET ×233',
    rules: [{ rule: 'core.file-assignment', values: 87 }, { rule: 'known', values: 9 }, { rule: 'secrets.bare-key-field', values: 1 }, { rule: 'x', values: 1 }],
    origins: [{ at: 'Bash result', label: "ssh db0-aws 'cat ~/perf/config.toml'", n: 224 }, { at: 'user', n: 9 }],
  }
  const rows = texts(buildEventCard(event.text, () => many))
  expect(rows[3]).toBe('  Request findings (not all blocked) in: Bash result "ssh db0-aws \'cat ~/perf/config.toml\'" ×224 · user ×9')
  expect(rows[4]).toBe('  by rule: core.file-assignment 87 · known 9 · secrets.bare-key-field · +1 more')
})

test('blocked password card describes the evidence and only the lines that blocked', () => {
  const card = buildPrivacyCard({ kind: 'blocked', target: 'request', kinds: ['PASSWORD'] }, {
    reason: 'contains PASSWORD ×3',
    origins: [
      { at: 'read result', label: 'config.toml', n: 4, lines: [8, 9, 14, 31], blocks: [
        { kind: 'PASSWORD', rule: 'contexts.url-password', n: 2, lines: [8, 9] },
        { kind: 'PASSWORD', rule: 'contexts.password-assignment', n: 1, lines: [14] },
      ] },
      { at: 'user', n: 1 },
    ],
  })
  expect(texts(card).slice(0, 4)).toEqual([
    '⊘ privacy  blocked request',
    '  ✗ · nothing was sent · contains PASSWORD ×3',
    '  Password embedded in a URL or connection string ×2 — read result "config.toml" (lines 8, 9)',
    '  Password in a variable, config entry, or command flag — read result "config.toml" (line 14)',
  ])
  expect(texts(card).join('\n')).not.toContain('31')
  expect(texts(card).join('\n')).not.toContain('user')
})

test('unavailable masking says nothing was sent and how to get out', () => {
  const card = texts(buildPrivacyCard({ kind: 'unavailable', reason: 'rule failed' }))
  expect(card[0]).toBe('⊘ privacy  unavailable')
  expect(card).toContain('  rule failed')
  expect(card.at(-1)).toContain('/privacy off')
  expect(card.at(-1)).toContain('only disables request masking after configuration loads')
  expect(card.at(-1)).toContain('settings.json or rules/*.json')
})

test('/share shows the card when privacy blocks the upload', async () => {
  const lines: OutputLine[] = []
  const output: string[] = []
  const ctx: ShareContext = {
    agent: {
      listSessions: async () => [] as SessionMeta[],
      cloudShareSession: async () => { throw new Error(`configuration error: ${BLOCKED_SYNC}`) },
      cloudUnshareSession: async () => {},
      cloudPushSession: async () => { throw new Error('unused') },
      cloudForkRemoteSession: async () => { throw new Error('unused') },
      importSharedSession: async () => { throw new Error('unused') },
    },
    openShareList: async () => {},
    getSessionId: () => 'session',
    commitSystem: (_, text) => output.push(text),
    commitLines: committed => lines.push(...committed),
    requestRender() {},
  }
  await runShareCommand(ctx, 'public')
  expect(lines[0]!.text).toBe('⊘ privacy  blocked share')
  expect(texts(lines).join('\n')).toContain('/privacy EMAIL mask, then /share again')
  expect(output.some(text => text.startsWith('Share failed'))).toBe(false)
})

test('background sync reports a privacy block once, not after every run', async () => {
  const stops: string[] = []
  const notices: string[] = []
  let blocked = true
  const synced: CloudPushResult = { kind: 'synced', pushed: 1, cloud: { visibility: 'private', synced_seq: 1, synced_at: 't' } }
  const sync = new CloudSessionSync({
    push: async () => { if (blocked) throw new Error(BLOCKED_SYNC); return synced },
    list: async () => [],
    notify: text => notices.push(text),
    privacyStopped: (sid, stop) => stops.push(`${sid}:${stop.kind === 'blocked' ? stop.kinds.join(',') : ''}`),
  }, 1)
  await sync.pushNow('a')
  await sync.pushNow('a')
  expect(stops).toEqual(['a:EMAIL'])
  expect(notices).toEqual([])
  blocked = false
  await sync.pushNow('a')
  blocked = true
  await sync.pushNow('a')
  expect(stops).toEqual(['a:EMAIL', 'a:EMAIL'])
  sync.dispose()
})

test('the new targets parse and get their own card', () => {
  for (const target of ['task', 'task report', 'delivery'] as const) {
    const text = `privacy blocked this ${target}: it contains API_KEY. Nothing was sent; run /privacy to review the rule.`
    expect(parsePrivacyStop(text)).toEqual({ kind: 'blocked', target, kinds: ['API_KEY'] })
  }
  const task = texts(buildPrivacyCard({ kind: 'blocked', target: 'task', kinds: ['API_KEY'] }))
  expect(task[0]).toBe('⊘ privacy  blocked task')
  expect(task.join('\n')).toContain("env file")
  expect(texts(buildPrivacyCard({ kind: 'blocked', target: 'delivery', kinds: ['EMAIL'] }))[0]).toBe('⊘ privacy  blocked delivery')
})
