import type { AuthPollResult, AuthRefreshResult, CloudUser, LoginCodeResponse } from '../native/index.js'

export interface LoginDeps {
  begin: (serverUrl: string, fingerprint: string) => Promise<LoginCodeResponse>
  poll: (serverUrl: string, code: string, expiresAt: number) => Promise<AuthPollResult>
  sleep: (ms: number) => Promise<void>
  now: () => number
}

export type LoginOutcome =
  | { status: 'success'; user: { name: string; email: string }; syncError?: string }
  | { status: 'timeout' }
  | { status: 'denied'; reason?: string | null; reasonCode?: string | null }

/** Keep the server's explanation and stable diagnostic code visible together. */
export function loginDeniedMessage(outcome: Extract<LoginOutcome, { status: 'denied' }>): string {
  const reason = outcome.reason?.trim()
  const code = outcome.reasonCode?.trim()
  if (!reason && !code) return 'login denied: server did not provide a reason; try again'
  return 'login denied' + (reason ? `: ${reason}` : '') + (code ? ` [${code}]` : '')
}

export const DEFAULT_SERVER = process.env.EVOT_SERVER_URL ?? 'https://auto.evot.ai'

/** What the REPL should do after the gateway reported `session_revoked`. */
export type RevocationPlan =
  | { kind: 'recovered'; user: CloudUser }
  | { kind: 'login-required' }
  | { kind: 'unavailable'; user: CloudUser | null; error?: string | null }

/**
 * Turn a session-refresh result into the REPL's next move. A dead scoped key is
 * re-minted silently; only a refused CLI token needs the browser flow.
 */
export function planAfterRevocation(result: AuthRefreshResult): RevocationPlan {
  if (result.status === 'recovered' && result.user) {
    return { kind: 'recovered', user: result.user }
  }
  if (result.status === 'unavailable') {
    return { kind: 'unavailable', user: result.user ?? null, error: result.error ?? null }
  }
  return { kind: 'login-required' }
}

/** What `/login` should do about an existing local credential. */
export type LoginGate =
  | { kind: 'proceed' }
  | { kind: 'already-logged-in'; user: CloudUser }

/**
 * Decide whether `/login` may start a device flow. `loginRequired` is set only
 * after the server refused the stored CLI token.
 */
export function decideLoginGate(user: CloudUser | null, loginRequired: boolean): LoginGate {
  if (loginRequired || !user) return { kind: 'proceed' }
  return { kind: 'already-logged-in', user }
}

export const defaultDeps: LoginDeps = {
  begin: async () => {
    throw new Error('default deps must not be called')
  },
  poll: async () => {
    throw new Error('default deps must not be called')
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
}

/**
 * Poll until approved/expired/denied. Deadline is computed from `deps.now()`,
 * so tests can advance a fake clock instead of really sleeping.
 */
export async function runLoginPolling(
  deps: LoginDeps,
  serverUrl: string,
  fingerprint: string,
  started?: LoginCodeResponse,
): Promise<{ outcome: LoginOutcome; begin?: LoginCodeResponse }> {
  const begin = started ?? await deps.begin(serverUrl, fingerprint)
  const deadline = deps.now() + begin.expires_in_ms

  for (;;) {
    if (deps.now() >= deadline) return { outcome: { status: 'timeout' }, begin }
    await deps.sleep(begin.interval_ms ?? 2000)
    const result = await deps.poll(serverUrl, begin.code, begin.expires_at)
    switch (result.status) {
      case 'success':
        return {
          outcome: {
            status: 'success',
            user: result.state.user,
            syncError: result.sync_error,
          },
          begin,
        }
      case 'denied':
        return {
          outcome: { status: 'denied', reason: result.reason, reasonCode: result.reason_code },
          begin,
        }
      case 'expired':
        return { outcome: { status: 'timeout' }, begin }
    }
    if (deps.now() >= deadline) return { outcome: { status: 'timeout' }, begin }
  }
}

/**
 * Start the device-code flow, surface the login URL, then poll until the
 * server answers. `begin` is invoked once so the URL and the polling code
 * stay on the same login attempt.
 */
export async function runDeviceLogin(
  deps: LoginDeps,
  serverUrl: string,
  fingerprint: string,
  onUrl: (url: string) => void,
): Promise<{ outcome: LoginOutcome; begin: LoginCodeResponse }> {
  const begin = await deps.begin(serverUrl, fingerprint)
  if (begin.login_url) onUrl(begin.login_url)
  const { outcome } = await runLoginPolling(deps, serverUrl, fingerprint, begin)
  return { outcome, begin }
}
