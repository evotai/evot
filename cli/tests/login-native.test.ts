import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { authPoll } from '../src/native/index.js'
import { object, oneOf } from '../src/native/contracts/schema.js'
import deniedLegacy from '../../src/app/tests/fixtures/schema/auth-poll-denied-v0.json'
import deniedCurrent from '../../src/app/tests/fixtures/schema/auth-poll-denied-v1.json'

test('native login polling forwards denial diagnostics without breaking legacy readers', async () => {
  const legacyReader = object({ status: oneOf('denied') })
  for (const response of [
    deniedLegacy,
    deniedCurrent,
    { status: 'denied', reason_code: 'future_server_reason' },
    { status: 'denied', reason: 'Sign-in refused' },
  ]) {
    const requests: URL[] = []
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      requests.push(new URL(request.url))
      return Response.json(response)
    } })
    try {
      const result = await authPoll(server.url.origin, 'CODE', 42)
      expect(result.status).toBe('denied')
      if (result.status !== 'denied') throw new Error('expected denial')
      expect(result.reason ?? null).toBe('reason' in response ? response.reason : null)
      expect(result.reason_code ?? null).toBe('reason_code' in response ? response.reason_code : null)
      expect(legacyReader.read(result, '$')).toBe(result)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.pathname).toBe('/v1/auth/cli/status')
      expect(requests[0]?.searchParams.get('code')).toBe('CODE')
      expect(requests[0]?.searchParams.get('expires_at')).toBe('42')
    } finally {
      server.stop(true)
    }
  }
})

test('standalone evot login reports the denial details or an explicit legacy fallback', async () => {
  for (const [response, message] of [
    [deniedCurrent, 'login denied: This account has been disabled by an administrator. [account_disabled]'],
    [deniedLegacy, 'login denied: server did not provide a reason; try again'],
  ] as const) {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      if (new URL(request.url).pathname === '/v1/auth/cli/code') {
        return Response.json({ code: 'CODE', login_url: '', expires_at: 42, expires_in_ms: 10_000, interval_ms: 1 })
      }
      return Response.json(response)
    } })
    try {
      const child = Bun.spawn([
        process.execPath, '-e',
        "import { runLogin } from './src/commands/login.ts'; process.exit(await runLogin() ? 0 : 1)",
      ], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, EVOT_SERVER_URL: server.url.origin },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      expect(exitCode).toBe(1)
      expect(stderr).toContain(message)
      expect(stderr).not.toContain('cannot reach')
      expect(stdout).not.toContain('logged in as')
    } finally {
      server.stop(true)
    }
  }
})
