import { beforeEach, expect, test } from 'bun:test'

import { runShareCommand, type ShareContext } from '../src/commands/share.js'
import type { CloudPushResult, SessionMeta } from '../src/native/index.js'
import { parsePrivacyStop } from '../src/privacy/notice.js'
import { classifyProviderFailure } from '../src/provider/error-presentation.js'
import { buildEventCard, buildPrivacyCard, resetIdCounter, type OutputLine } from '../src/render/output.js'
import { formatLlmCallCompleted } from '../src/render/verbose.js'
import { CloudSessionSync } from '../src/session/cloud-sessions.js'

// Exactly what src/app/src/privacy/notice.rs writes (pinned by
// notice_wording_is_the_cli_contract in src/app/tests/privacy_test.rs).
const BLOCKED_LLM = 'privacy blocked this request: it contains API_KEY, PRIVATE_KEY. Nothing was sent; run /privacy to review the rule.'
const BLOCKED_SYNC = 'privacy blocked this sync: it contains EMAIL. Nothing was sent; run /privacy to review the rule.'
const UNAVAILABLE = 'privacy masking is unavailable, so nothing was sent: privacy settings are invalid: x. Fix the settings or rule packs with /privacy (/privacy off lets model requests through unmasked; uploads always wait for masking)'

const texts = (lines: OutputLine[]) => lines.map(line => line.text)

beforeEach(() => resetIdCounter())

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
  const card = buildEventCard(event.text)
  expect(texts(card)).toEqual([
    '⊘ privacy  blocked request',
    '  ✗ · nothing was sent to the model · API_KEY, PRIVATE_KEY',
    "  Set to block, and still in this session's history: the next request stops here too.",
    '  Mask them instead: /privacy API_KEY mask · /privacy PRIVATE_KEY mask · or go on without them: /new',
    '  /privacy shows what was blocked and when',
  ])
  expect(card[0]!.toolCard).toEqual({ state: 'error', first: true, last: false, tone: 'notice' })
  expect(card.at(-1)!.toolCard?.last).toBe(true)
  expect(texts(card).join('\n')).not.toContain('Invalid request')
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
