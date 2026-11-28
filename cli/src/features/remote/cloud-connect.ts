import { createHmac, timingSafeEqual } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { validKey } from './devices.js'
import { machineName } from './machine-name.js'
import type { MachineIdentity } from './machine-identity.js'

export interface CloudGate {
  origin: string
  unix: string
  renewal?: { endpoint: string; env: string }
  admit: (key: unknown, ticket: unknown) => boolean
  login: (key: string, terminal?: string) => string
}
export function ticketGate(env: string, secret: string) {
  const used = new Map<string, number>()
  return (key: unknown, ticket: unknown) => {
    if (!validKey(key) || typeof ticket !== 'string' || ticket.length > 2048) return false
    const [msg, mac, extra] = ticket.split('.')
    if (!msg || !mac || extra !== undefined || !/^[\w-]{43}$/.test(mac)) return false
    const sum = createHmac('sha256', Buffer.from(secret, 'base64url')).update(msg).digest()
    if (!timingSafeEqual(sum, Buffer.from(mac, 'base64url'))) return false
    const now = Math.floor(Date.now() / 1000)
    for (const [nonce, exp] of used) if (exp <= now) used.delete(nonce)
    try {
      const c = JSON.parse(Buffer.from(msg, 'base64url').toString())
      if (
        c.env !== env ||
        c.key !== key ||
        !Number.isInteger(c.exp) ||
        c.exp <= now ||
        c.exp > now + 120 ||
        typeof c.nonce !== 'string' ||
        used.has(c.nonce) ||
        used.size >= 512
      )
        return false
      used.set(c.nonce, c.exp)
      return true
    } catch {
      return false
    }
  }
}
export function connectInviteUrl(base: string, env: string) {
  return base === 'https://auto.evot.ai' ? `https://connect.evot.ai/${env}` : `${base}/connect?env=${env}`
}

export function terminalInvite(address: string, terminal: string) {
  const url = new URL(address)
  url.hash = new URLSearchParams({ terminal }).toString()
  return url.href
}

export function machineSocketDirectory(env: string) {
  const dir = '/tmp/evot-connect-' + env
  mkdirSync(dir, { mode: 0o700, recursive: true })
  const st = lstatSync(dir)
  if (!st.isDirectory() || st.uid !== process.getuid?.() || st.mode & 0o077) throw Error('Unsafe connector directory.')
  return dir
}
function signedIn(account: string) {
  const [base, uid] = JSON.parse(account) as [string, string]
  if (new URL(base).protocol !== 'https:') throw Error('Connect requires an HTTPS account server.')
  const auth = JSON.parse(readFileSync(join(homedir(), '.evotai', 'auth.json'), 'utf8'))
  if (
    auth.user?.id !== uid ||
    new URL(auth.server_base_url).href.replace(/\/+$/, '') !== base ||
    typeof auth.cli_token !== 'string'
  )
    throw Error('Account changed. Run /remote again.')
  return { base, token: auth.cli_token as string }
}

export class ConnectRetryable extends Error {}
export class ConnectDenied extends Error {}

export async function allocateCloud(identity: MachineIdentity, account: string, connector: () => Promise<string>, binding?: string) {
  const bin = await connector()
  const { base, token: cliToken } = signedIn(account)
  const { secret, environment: env } = identity
  const res = await fetch(base + '/v2/connect/host', {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(45000),
    headers: { authorization: 'Bearer ' + cliToken, 'content-type': 'application/json' },
    body: JSON.stringify({ secret, label: machineName(), binding }),
  }).catch(() => { throw new ConnectRetryable('Could not reach evot Connect.') })
  if (!res.ok) {
    if (res.status === 401) throw new ConnectDenied('Sign in again with /login.')
    if (res.status === 403) throw new ConnectDenied('The account cannot enable Remote.')
    if (res.status === 409) throw new ConnectDenied('Remote account binding changed. Run /remote to start a new gateway.')
    if (res.status === 404) throw Error('The account server must be upgraded to support machine addresses.')
    if (res.status >= 500 || res.status === 429) {
      const body = await res.json().catch(() => null) as { error?: unknown } | null
      const message = typeof body?.error === 'string' ? body.error : 'evot Connect is unavailable.'
      throw new ConnectRetryable(message)
    }
    throw Error(`Connect registration refused (${res.status}).`)
  }
  // A process can drain after sending headers but before the complete body.
  // Retry transport/read failures; a complete but invalid allocation is rejected.
  const body = await res.text().catch(() => { throw new ConnectRetryable('Connect registration response was interrupted.') })
  const data = JSON.parse(body) as Record<string, unknown>
  if (
    data.version !== 2 ||
    typeof data.binding !== 'string' || !/^[0-9a-f]{32}$/.test(data.binding) ||
    (binding !== undefined && binding !== data.binding) ||
    data.environment !== env ||
    typeof data.origin !== 'string' ||
    !/^https:\/\/[a-z0-9.-]+$/.test(data.origin) ||
    typeof data.connector !== 'string' ||
    !data.connector ||
    typeof data.ticket_key !== 'string' ||
    !/^[\w-]{43}$/.test(data.ticket_key)
  )
    throw Error('Invalid Connect allocation.')
  const gate: CloudGate = {
    unix: join(machineSocketDirectory(env), 'gateway.sock'),
    origin: data.origin,
    renewal: data.browser_renew === true ? { endpoint: base + '/connect/renew', env } : undefined,
    admit: ticketGate(env, data.ticket_key),
    login: (key, terminal) => base + '/connect?' + new URLSearchParams({ env, key, ...(terminal ? { terminal } : {}) }),
  }
  const credential = data.connector
  return {
    gate,
    binding: data.binding,
    url: connectInviteUrl(base, env),
    start: () =>
      Bun.spawn([bin, 'tunnel', '--no-autoupdate', 'run'], {
        env: { PATH: process.env.PATH, HOME: homedir(), TUNNEL_TOKEN: credential },
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      }),
  }
}
