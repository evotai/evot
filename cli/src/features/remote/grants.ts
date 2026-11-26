import type { RequestListener } from 'node:http'
import { join } from 'node:path'
import { validTerminal } from './discovery.js'
import { DeviceStore } from './devices.js'
import { leasePath, tryGatewayLease } from './lease.js'
import type { DeviceAccess } from './pairing.js'

export const validDeviceId = (id: string) => /^[a-f0-9]{20}$/.test(id)
export const ALL_DEVICES = 'all'
const offline = 'Use /remote devices in the gateway TUI, or update that gateway to manage devices from this window.'

function describe(store: DeviceStore) {
  const rows = store.list()
  if (!rows.length) return 'No approved devices.'
  const when = (ms: number) => {
    const d = new Date(ms), p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }
  return ['Approved devices in this profile (a device idle for 30 days must be approved again):', ...rows.map(row =>
    `  /remote revoke ${row.id}   approved ${when(row.approvedAt)} · last connected ${when(row.lastSeenAt)}${row.lastSeenFrom ? ' from ' + row.lastSeenFrom : ''}${row.expired ? ' · expired' : ''}`),
    '  /remote revoke all'].join('\n')
}
const result = (removed: boolean) => removed ? 'Device revoked.' : 'Device not found. Use /remote devices to list current IDs.'
const cleared = (count: number) => count ? `Revoked ${count} device${count === 1 ? '' : 's'}. Every phone must be approved again.` : 'No approved devices.'

/** Only the private per-profile lease serves these device operations. The
 * public gateway cannot forward a decision or a general command here. */
export function grantHandler(owner: () => DeviceAccess | null, gatewayTerminal?: string): RequestListener {
  return (req, res) => {
    // Bun's node:http adapter uses absolute-form on Unix sockets; Node
    // normally uses origin-form. Accept the same exact local resource in both.
    const path = req.url?.replace(/^http:\/\/localhost\//, '/')
    const id = path?.match(/^\/devices\/([a-f0-9]{20}|all)$/)?.[1]
    const list = req.method === 'GET' && path === '/devices'
    const match = path?.match(/^\/pairing\/([^/]+)\/approve\/(\d{8})$/)
    const approval = req.method === 'POST' && match && validTerminal(match[1]) ? match : null
    if (req.headers.host !== 'localhost' || req.headers.origin !== undefined || (!approval && !list && !(id && req.method === 'DELETE'))) {
      res.writeHead(403).end(); return
    }
    try {
      const access = owner()
      if (!access) { res.writeHead(503).end(); return }
      if (approval) {
        const [, terminal, code] = approval
        const matched = access.approve(code!, terminal) ||
          (terminal === gatewayTerminal && access.approve(code!))
        res.writeHead(matched ? 204 : 404, { 'Cache-Control': 'no-store' }).end()
        return
      }
      const text = id === ALL_DEVICES ? cleared(access.revokeAll()) : id ? result(access.revoke(id)) : describe(access.store)
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end(text)
    } catch { res.writeHead(500).end() }
  }
}

export async function approvePairing(home: string, scope: string, terminal: string, code: string) {
  let response: Response
  try {
    response = await fetch(`http://localhost/pairing/${terminal}/approve/${code}`, {
      unix: leasePath(home, scope), headers: { host: 'localhost' }, method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2000),
    })
  } catch { throw Error('Could not confirm the approval with the Remote gateway in this profile.') }
  if (response.status === 204) return true
  if (response.status === 404) return false
  throw Error('Could not confirm the approval. If the gateway is on an older build, approve in its TUI.')
}

/** Never write beside a live gateway's cached grants. If no owner exists,
 * take its normal lease for the disk operation only (no tunnel or sharing). */
export async function manageGrants(home: string, scope: string, id: string | undefined, current: () => boolean) {
  if (id !== undefined && id !== ALL_DEVICES && !validDeviceId(id)) throw Error('Use /remote revoke DEVICE_ID with the full ID from /remote devices, or /remote revoke all.')
  const path = leasePath(home, scope)
  const release = await tryGatewayLease(path)
  try {
    if (!current()) throw Error('The active profile changed; run the command again.')
    if (release) {
      const store = new DeviceStore(join(home, 'remote', scope))
      return id === ALL_DEVICES ? cleared(store.clear()) : id ? result(store.remove(id)) : describe(store)
    }
    let response: Response
    try {
      response = await fetch('http://localhost/devices' + (id ? '/' + id : ''), {
        unix: path, headers: { host: 'localhost' }, method: id ? 'DELETE' : 'GET', redirect: 'error', signal: AbortSignal.timeout(2000),
      })
      if (response.ok) return await response.text()
    } catch {
      // Old gateways close their lease socket without reading a request. A
      // timeout after DELETE is ambiguous: never replay it against the file.
      throw Error(`Could not confirm the device operation. ${offline}`)
    }
    if (response.status === 503) throw Error('The device registry is busy. Retry /remote devices in a moment.')
    throw Error(`Device registry unavailable (${response.status}). ${offline}`)
  } finally { release?.() }
}
