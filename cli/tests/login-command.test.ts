import { describe, expect, test } from 'bun:test'
import type { AuthPollResult, AuthRefreshResult, LoginCodeResponse } from '../src/native/index.js'
import { decideLoginGate, planAfterRevocation } from '../src/commands/login-flow.js'
import { handleLoginCommand, handleLogoutCommand, type ReplCommandContext } from '../src/term/repl-commands.js'

function createContext(): { ctx: ReplCommandContext; lines: { id: string; text: string }[] } {
  const lines: { id: string; text: string }[] = []
  return {
    lines,
    ctx: {
      agent: {} as ReplCommandContext['agent'],
      getSessionId: () => null,
      getCompactLines: () => [],
      getConfigInfo: () => null,
      commitSystem: (id, text) => { lines.push({ id, text }) },
      commitRevealed: (id, text) => { lines.push({ id, text }) },
      commitLines: () => {},
      replaceLine: () => false,
      columns: () => 80,
      requestRender: () => {},
    },
  }
}

function loginResponse(): LoginCodeResponse {
  return {
    code: 'CODE1',
    login_url: 'http://x/login?code=CODE1',
    expires_at: 111,
    expires_in_ms: 10_000,
    interval_ms: 1,
  }
}

const user = { id: 'u', name: 'bo', email: 'b@x.dev' }

function refresh(overrides: Partial<AuthRefreshResult>): AuthRefreshResult {
  return { status: 'recovered', user, ...overrides }
}

// `session_revoked` reports a dead *scoped LLM key*, not necessarily a dead
// login. A force sign-out bumps the account's auth epoch, invalidating keys
// minted before it, while the CLI token in auth.json keeps working — and the
// catalog mints a fresh scoped key on every read. So the common recovery is a
// silent re-sync, and only a refused CLI token justifies a browser flow.
describe('planAfterRevocation', () => {
  test('recovers silently when a fresh scoped key was minted', () => {
    expect(planAfterRevocation(refresh({ status: 'recovered' })))
      .toEqual({ kind: 'recovered', user })
  })

  test('requires a login only when the server refused the CLI token', () => {
    expect(planAfterRevocation(refresh({ status: 'login_required', user: null })))
      .toEqual({ kind: 'login-required' })
  })

  test('keeps the credential when the server is unreachable', () => {
    // An outage says nothing about the credential, so signing the user out here
    // would destroy a working login over a network blip.
    expect(planAfterRevocation(refresh({ status: 'unavailable', error: 'timed out' })))
      .toEqual({ kind: 'unavailable', user, error: 'timed out' })
  })

  test('treats a recovery without a user as needing a login', () => {
    expect(planAfterRevocation(refresh({ status: 'recovered', user: null })))
      .toEqual({ kind: 'login-required' })
  })
})

describe('decideLoginGate', () => {
  test('keeps the already-logged-in shortcut for a live credential', () => {
    expect(decideLoginGate(user, false)).toEqual({ kind: 'already-logged-in', user })
  })

  test('proceeds once the server has refused the stored token', () => {
    // This is the case behind the bug report: a leftover auth.json must never
    // answer "already logged in" after the server rejected the session.
    expect(decideLoginGate(user, true)).toEqual({ kind: 'proceed' })
  })

  test('proceeds when there is no local identity at all', () => {
    expect(decideLoginGate(null, false)).toEqual({ kind: 'proceed' })
  })
})

describe('handleLoginCommand', () => {
  test('opens the login url and reports success', async () => {
    const { ctx, lines } = createContext()
    const opened: string[] = []
    const polls: AuthPollResult[] = [
      { status: 'pending' },
      { status: 'success', state: { user: { id: 'u', name: 'bo', email: 'b@x.dev' } } },
    ]
    let pollIndex = 0

    const ok = await handleLoginCommand(ctx, {
      fingerprint: async () => 'fp',
      begin: async () => loginResponse(),
      poll: async () => polls[Math.min(pollIndex++, polls.length - 1)]!,
      openBrowser: (url) => opened.push(url),
      sleep: async () => {},
      now: () => 0,
    })

    expect(ok).toBe(true)
    expect(opened).toEqual(['http://x/login?code=CODE1'])
    expect(lines.map(line => line.id)).toEqual(['sys-login', 'sys-login-url', 'sys-login-ok'])
    expect(lines.at(-1)?.text).toContain('logged in as bo <b@x.dev>')
    expect(lines.at(-1)?.text).toContain('free models synced')
  })

  test('reports denial and timeout without claiming success', async () => {
    const denied = createContext()
    expect(await handleLoginCommand(denied.ctx, {
      fingerprint: async () => 'fp',
      begin: async () => loginResponse(),
      poll: async () => ({ status: 'denied' }),
      openBrowser: () => {},
      sleep: async () => {},
      now: () => 0,
    })).toBe(false)
    expect(denied.lines.at(-1)?.id).toBe('sys-login-err')
    expect(denied.lines.at(-1)?.text).toContain('login denied: server did not provide a reason; try again')

    const timedOut = createContext()
    expect(await handleLoginCommand(timedOut.ctx, {
      fingerprint: async () => 'fp',
      begin: async () => loginResponse(),
      poll: async () => ({ status: 'expired' }),
      openBrowser: () => {},
      sleep: async () => {},
      now: () => 0,
    })).toBe(false)
    expect(timedOut.lines.at(-1)?.text).toContain('timed out')
  })

  test('shows the server denial reason and diagnostic code in the TUI', async () => {
    const { ctx, lines } = createContext()
    const ok = await handleLoginCommand(ctx, {
      fingerprint: async () => 'fp',
      begin: async () => loginResponse(),
      poll: async () => ({
        status: 'denied',
        reason: 'This account has been disabled by an administrator.',
        reason_code: 'account_disabled',
      }),
      openBrowser: () => {},
      sleep: async () => {},
      now: () => 0,
    })
    expect(ok).toBe(false)
    expect(lines.at(-1)?.id).toBe('sys-login-err')
    expect(lines.at(-1)?.text).toContain('login denied: This account has been disabled by an administrator. [account_disabled]')
    expect(lines.map(line => line.id)).not.toContain('sys-login-ok')
  })

  test('surfaces begin failures in the TUI', async () => {
    const { ctx, lines } = createContext()
    const ok = await handleLoginCommand(ctx, {
      fingerprint: async () => 'fp',
      begin: async () => { throw new Error('offline') },
      poll: async () => ({ status: 'pending' }),
      openBrowser: () => {},
      sleep: async () => {},
      now: () => 0,
    })
    expect(ok).toBe(false)
    expect(lines.at(-1)?.id).toBe('sys-login-err')
    expect(lines.at(-1)?.text).toContain('offline')
  })
})

describe('handleLogoutCommand', () => {
  test('logs out the current user', async () => {
    const { ctx, lines } = createContext()
    let loggedOut = false
    const ok = await handleLogoutCommand(ctx, {
      whoami: async () => ({ id: 'u', name: 'bo', email: 'b@x.dev' }),
      logout: async () => { loggedOut = true },
    })
    expect(ok).toBe(true)
    expect(loggedOut).toBe(true)
    expect(lines).toEqual([
      { id: 'sys-logout-ok', text: '  ✓ logged out bo <b@x.dev>' },
    ])
  })

  test('does nothing when not logged in', async () => {
    const { ctx, lines } = createContext()
    let loggedOut = false
    const ok = await handleLogoutCommand(ctx, {
      whoami: async () => null,
      logout: async () => { loggedOut = true },
    })
    expect(ok).toBe(false)
    expect(loggedOut).toBe(false)
    expect(lines.at(-1)?.text).toContain('not logged in')
  })

  test('surfaces logout failures in the TUI', async () => {
    const { ctx, lines } = createContext()
    const ok = await handleLogoutCommand(ctx, {
      whoami: async () => ({ id: 'u', name: 'bo', email: 'b@x.dev' }),
      logout: async () => { throw new Error('disk full') },
    })
    expect(ok).toBe(false)
    expect(lines.at(-1)?.id).toBe('sys-logout-err')
    expect(lines.at(-1)?.text).toContain('disk full')
  })
})
