import { createPublicKey, randomBytes, randomInt, verify } from 'node:crypto'
import { DeviceStore, deviceId, validKey } from './devices.js'
import { DevicePresence, PRESENCE_TTL_MS, type RemoteDeviceKind } from './presence.js'

export const REQUEST_TTL = 120_000
const SESSION_TTL = 15 * 60_000
const secret = () => randomBytes(32).toString('base64url')
type Entry = { key: string; expires: number }
type Challenge = Entry & { terminal?: string }
type Pending = Challenge & { code: string; approved: boolean; from?: string; delivered: Promise<boolean> }

/** Short-lived proof challenges, pending approvals and sessions are process-local.
 * Only explicit local approval writes a new grant to devices.json. No public approval API. */
export class DeviceAccess {
  private challenges = new Map<string, Challenge>()
  private requests = new Map<string, Pending>()
  private sessions = new Map<string, Entry>()
  private presence: DevicePresence
  private now: () => number
  constructor(
    readonly store: DeviceStore,
    private notify: (code: string, id: string, terminal?: string) => void | Promise<boolean>,
    { now = Date.now, presenceChanged = () => {} }: { now?: () => number; presenceChanged?: () => void } = {},
  ) {
    this.now = now
    this.presence = new DevicePresence(presenceChanged, now)
  }
  get onlineDevices() { return this.presence.counts }
  private prune() {
    for (const map of [this.challenges, this.requests, this.sessions])
      for (const [id, row] of map) if (row.expires <= this.now()) map.delete(id)
  }
  challenge(key: unknown, terminal?: string) {
    this.prune()
    if (!validKey(key) || this.challenges.size >= 128) return null
    const nonce = secret()
    this.challenges.set(nonce, { key, terminal, expires: this.now() + REQUEST_TTL })
    return { nonce }
  }
  async prove(nonce: unknown, signature: unknown, from?: string) {
    this.prune()
    if (typeof nonce !== 'string' || typeof signature !== 'string' || !/^[\w-]{86}$/.test(signature)) return null
    const row = this.challenges.get(nonce)
    this.challenges.delete(nonce)
    if (!row) return null
    const { key, terminal } = row,
      point = Buffer.from(key, 'base64url')
    try {
      const pub = createPublicKey({
        format: 'jwk',
        key: {
          kty: 'EC',
          crv: 'P-256',
          x: point.subarray(1, 33).toString('base64url'),
          y: point.subarray(33).toString('base64url'),
        },
      })
      if (
        !verify(
          'sha256',
          Buffer.from('evot-device-v1:' + nonce),
          { key: pub, dsaEncoding: 'ieee-p1363' },
          Buffer.from(signature, 'base64url'),
        )
      )
        return null
    } catch {
      return null
    }
    if (this.store.has(key, this.now())) return this.issue(key, from)
    // Two tabs for the same invite share a prompt; scanning another window's
    // QR must not reuse a code that was shown in the first window.
    if (this.requests.size >= 8) return null
    const requests = [...this.requests.values()]
    let request = requests.find(r => r.key === key && r.terminal === terminal && !r.approved)
    if (!request) {
      let code: string
      do {
        code = String(randomInt(100_000_000)).padStart(8, '0')
      } while (requests.some(r => r.code === code))
      const delivered = Promise.resolve().then(async () => (await this.notify(code, deviceId(key), terminal)) !== false)
        .catch(() => false)
      request = { key, terminal, code, approved: false, expires: this.now() + REQUEST_TTL, from, delivered }
    }
    const receipt = secret()
    this.requests.set(receipt, request)
    if (!await request.delivered) {
      this.requests.delete(receipt)
      return { unavailable: true } as const
    }
    const remainingMs = request.expires - this.now()
    if (!this.requests.has(receipt) || remainingMs <= 0) return null
    return { code: request.code, receipt, remainingMs }
  }
  approve(code: string, terminal?: string) {
    this.prune()
    for (const r of this.requests.values())
      if (!r.approved && r.code === code && r.terminal === terminal) {
        this.store.approve(r.key, this.now(), r.from)
        r.approved = true
        return true
      }
    return false
  }
  poll(receipt: unknown) {
    this.prune()
    if (typeof receipt !== 'string') return null
    const row = this.requests.get(receipt)
    if (!row) return null
    if (!row.approved) return { pending: true }
    this.requests.delete(receipt)
    return this.store.has(row.key, this.now()) ? this.issue(row.key) : null
  }
  private issue(key: string, from?: string) {
    if (this.sessions.size >= 128) return null
    this.store.touch(key, this.now(), from)
    const token = secret()
    this.sessions.set(token, { key, expires: this.now() + SESSION_TTL })
    return { token }
  }
  private authorizedSession(header: string | null, now: number) {
    if (!header?.startsWith('Bearer ')) return null
    const session = this.sessions.get(header.slice(7))
    return session && session.expires > now && this.store.has(session.key, now) ? session : null
  }
  authorized(header: string | null) {
    return this.authorizedSession(header, this.now()) !== null
  }
  observe(header: string | null, kind: RemoteDeviceKind) {
    const now = this.now(), session = this.authorizedSession(header, now)
    if (session) this.presence.touch(deviceId(session.key), kind, Math.min(session.expires, now + PRESENCE_TTL_MS))
  }
  revoke(id: string) {
    if (!this.store.remove(id)) return false
    for (const map of [this.sessions, this.requests, this.challenges])
      for (const [k, r] of map) if (deviceId(r.key) === id) map.delete(k)
    this.presence.remove(id)
    return true
  }
  /** Forget every device: approved grants, live phone sessions and pending codes. */
  revokeAll() {
    const count = this.store.clear()
    this.sessions.clear()
    this.requests.clear()
    this.challenges.clear()
    this.presence.clear()
    return count
  }
  close() {
    this.sessions.clear()
    this.requests.clear()
    this.challenges.clear()
    this.presence.clear()
  }
}
