import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { validKey } from './devices.js'

export interface CloudGate {
  origin: string
  unix: string
  admit: (key: unknown, ticket: unknown) => boolean
  login: (key: string) => string
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
function environmentId(uid: string, secret: string) {
  return createHash('sha256').update(uid + ':' + secret).digest('hex').slice(0, 32)
}
function connectInviteUrl(base: string, env: string) {
  return base === 'https://auto.evot.ai' ? `https://connect.evot.ai/${env}` : `${base}/connect?env=${env}`
}
export function terminalInvite(invite: string, terminal: string) {
  const url = new URL(invite)
  if (url.origin === 'https://connect.evot.ai') url.pathname += '/' + terminal
  else url.searchParams.set('terminal', terminal)
  return url.href
}
// A sibling TUI on the same profile can display the same public invite without
// registering again, obtaining a connector token or changing the live gateway.
export function sharedConnectInvite(home: string, scope: string, account: string) {
  const [base, uid] = JSON.parse(account) as [string, string]
  return connectInviteUrl(base, environmentId(uid, readSecret(join(home, 'remote', scope, 'host.key'))))
}
function readSecret(path: string) {
  const st = lstatSync(path)
  if (!st.isFile() || st.mode & 0o077 || st.uid !== process.getuid?.()) throw Error('Unsafe host.key.')
  const value = readFileSync(path, 'utf8')
  if (!/^[\w-]{43}$/.test(value)) throw Error('Invalid host identity.')
  return value
}

function installSecret(dir: string) {
  const path = join(dir, 'host.key')
  try {
    return readSecret(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  const tmp = path + '.' + crypto.randomUUID(),
    fd = openSync(tmp, 'wx', 0o600)
  try {
    try {
      writeFileSync(fd, randomBytes(32).toString('base64url'))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    try {
      linkSync(tmp, path)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  } finally {
    unlinkSync(tmp)
  }
  return readSecret(path)
}
export async function allocateCloud(dir: string, account: string) {
  const bin = Bun.which('cloudflared')
  if (!bin) throw Error('Install cloudflared on the Mac first (brew install cloudflared).')
  const [base, uid] = JSON.parse(account) as [string, string]
  if (new URL(base).protocol !== 'https:') throw Error('Connect requires an HTTPS account server.')
  const auth = JSON.parse(readFileSync(join(homedir(), '.evotai', 'auth.json'), 'utf8'))
  if (
    auth.user?.id !== uid ||
    new URL(auth.server_base_url).href.replace(/\/+$/, '') !== base ||
    typeof auth.cli_token !== 'string'
  )
    throw Error('Account changed. Run /remote again.')
  const secret = installSecret(dir),
    env = environmentId(uid, secret)
  const res = await fetch(base + '/v1/connect/host', {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(45000),
    headers: { authorization: 'Bearer ' + auth.cli_token, 'content-type': 'application/json' },
    body: JSON.stringify({ secret, label: hostname() }),
  })
  if (!res.ok)
    throw Error(
      res.status === 401
        ? 'Sign in again with /login.'
        : res.status === 503
        ? 'Managed Tunnel unavailable. Check server configuration or retry shortly.'
        : `Connect registration refused (${res.status}).`,
    )
  const data = (await res.json()) as Record<string, unknown>
  if (
    data.version !== 1 ||
    data.environment !== env ||
    typeof data.origin !== 'string' ||
    !/^https:\/\/[a-z0-9.-]+$/.test(data.origin) ||
    typeof data.connector !== 'string' ||
    !data.connector ||
    typeof data.ticket_key !== 'string' ||
    !/^[\w-]{43}$/.test(data.ticket_key)
  )
    throw Error('Invalid Connect allocation.')
  const socketDir = '/tmp/evot-connect-' + env
  mkdirSync(socketDir, { mode: 0o700, recursive: true })
  const st = lstatSync(socketDir)
  if (!st.isDirectory() || st.uid !== process.getuid?.() || st.mode & 0o077) throw Error('Unsafe connector directory.')
  const gate: CloudGate = {
    unix: join(socketDir, 'gateway.sock'),
    origin: data.origin,
    admit: ticketGate(env, data.ticket_key),
    login: (key) => base + '/connect?' + new URLSearchParams({ env, key }),
  }
  const credential = data.connector
  return {
    gate,
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
