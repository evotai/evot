import { describe, test, expect } from 'bun:test'

import { loginDeniedMessage, runDeviceLogin, runLoginPolling, type LoginDeps } from '../src/commands/login-flow'
import deniedLegacy from '../../src/app/tests/fixtures/schema/auth-poll-denied-v0.json'
import deniedCurrent from '../../src/app/tests/fixtures/schema/auth-poll-denied-v1.json'
import { authPoll } from '../src/native/contracts/results.js'
import type { AuthPollResult, LoginCodeResponse } from '../src/native/index.js'

function createFakeDeps(pollResults: AuthPollResult[]): {
  deps: LoginDeps
  calls: { polls: number; begins: number; slept: number[] }
} {
  let now = 0
  const state = { polls: 0, begins: 0, slept: [] as number[] }
  const deps: LoginDeps = {
    begin: async () => {
      state.begins += 1
      const response: LoginCodeResponse = {
        code: 'CODE1',
        login_url: 'http://x/login?code=CODE1',
        expires_at: 111,
        expires_in_ms: 10_000,
        interval_ms: 2000,
      }
      return response
    },
    poll: async (_url, code, expiresAt) => {
      expect(code).toBe('CODE1')
      expect(expiresAt).toBe(111)
      state.polls += 1
      return pollResults[Math.min(state.polls - 1, pollResults.length - 1)]
    },
    sleep: async (ms) => {
      state.slept.push(ms)
      now += ms
    },
    now: () => now,
  }
  return { deps, calls: state }
}

describe('runLoginPolling', () => {
  test('succeeds after pending polls', async () => {
    const { deps, calls } = createFakeDeps([
      { status: 'pending' },
      { status: 'pending' },
      { status: 'success', state: { user: { id: 'u', name: 'bo', email: 'b@x.dev' } } },
    ])
    const { outcome } = await runLoginPolling(deps, 'http://x', 'fp')
    expect(outcome.status).toBe('success')
    if (outcome.status === 'success') {
      expect(outcome.user.email).toBe('b@x.dev')
      expect(outcome.syncError).toBeUndefined()
    }
    expect(calls.begins).toBe(1)
    expect(calls.polls).toBe(3)
  })

  test('reports sync_error when model sync failed server-side', async () => {
    const { deps } = createFakeDeps([
      { status: 'success', state: { user: { id: 'u', name: 'bo', email: 'b@x.dev' } }, sync_error: 'offline' },
    ])
    const { outcome } = await runLoginPolling(deps, 'http://x', 'fp')
    expect(outcome.status).toBe('success')
    if (outcome.status === 'success') expect(outcome.syncError).toBe('offline')
  })

  test('times out when deadline passes with only pending responses', async () => {
    const { deps } = createFakeDeps([{ status: 'pending' }])
    const { outcome } = await runLoginPolling(deps, 'http://x', 'fp')
    expect(outcome.status).toBe('timeout')
  })

  test('keeps denial diagnostics from the poll response', async () => {
    for (const response of [deniedLegacy, deniedCurrent]) {
      const result = authPoll.read(response, '$')
      const { deps, calls } = createFakeDeps([{ status: 'pending' }, result])
      const { outcome } = await runLoginPolling(deps, 'http://x', 'fp')
      expect(outcome).toEqual({
        status: 'denied',
        reason: result.status === 'denied' ? result.reason : undefined,
        reasonCode: result.status === 'denied' ? result.reason_code : undefined,
      })
      expect(calls.polls).toBe(2)
    }
  })

  test('maps expired to timeout and denied to denied', async () => {
    const expired = createFakeDeps([{ status: 'expired' }])
    const expiredOutcome = (await runLoginPolling(expired.deps, 'http://x', 'fp')).outcome
    expect(expiredOutcome.status).toBe('timeout')

    const denied = createFakeDeps([{ status: 'denied' }])
    const deniedOutcome = (await runLoginPolling(denied.deps, 'http://x', 'fp')).outcome
    expect(deniedOutcome.status).toBe('denied')
  })
})

describe('loginDeniedMessage', () => {
  test('shows explanations, stable codes, and an honest legacy fallback', () => {
    for (const [details, expected] of [
      [{}, 'login denied: server did not provide a reason; try again'],
      [{ reason: null, reasonCode: null }, 'login denied: server did not provide a reason; try again'],
      [{ reason: '  ', reasonCode: '\t' }, 'login denied: server did not provide a reason; try again'],
      [{ reason: 'Approval refused' }, 'login denied: Approval refused'],
      [{ reasonCode: 'future_server_reason' }, 'login denied [future_server_reason]'],
      [{ reason: '  Approval refused  ', reasonCode: ' code_denied ' }, 'login denied: Approval refused [code_denied]'],
    ] as const) {
      expect(loginDeniedMessage({ status: 'denied', ...details })).toBe(expected)
    }
  })
})

describe('runDeviceLogin', () => {
  test('surfaces the login url before polling', async () => {
    const { deps, calls } = createFakeDeps([
      { status: 'success', state: { user: { id: 'u', name: 'bo', email: 'b@x.dev' } } },
    ])
    const urls: string[] = []
    const { outcome, begin } = await runDeviceLogin(deps, 'http://x', 'fp', (url) => urls.push(url))
    expect(urls).toEqual(['http://x/login?code=CODE1'])
    expect(begin.code).toBe('CODE1')
    expect(outcome.status).toBe('success')
    expect(calls.begins).toBe(1)
    expect(calls.polls).toBe(1)
  })
})
