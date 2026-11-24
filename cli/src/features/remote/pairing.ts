import { createPublicKey, randomBytes, randomInt, verify } from 'node:crypto'
import { DeviceStore, deviceId, validKey } from './devices.js'

export const REQUEST_TTL = 120_000
const SESSION_TTL = 15 * 60_000
const secret = () => randomBytes(32).toString('base64url')
type Entry = { key: string; expires: number }
type Pending = Entry & { code: string; approved: boolean; from?: string }

/** Short-lived proof challenges, pending approvals and sessions are process-local.
 * Only a successful local decision writes devices.json. No HTTP approval API. */
export class DeviceAccess {
  private challenges = new Map<string, Entry>()
  private requests = new Map<string, Pending>()
  private sessions = new Map<string, Entry>()
  constructor(
    readonly store: DeviceStore,
    private notify: (code: string, id: string) => void,
    private now = Date.now,
  ) {}
  private prune() {
    for (const map of [this.challenges, this.requests, this.sessions])
      for (const [id, row] of map) if (row.expires <= this.now()) map.delete(id)
  }
  challenge(key: unknown) {
    this.prune()
    if (!validKey(key) || this.challenges.size >= 128) return null
    const nonce = secret()
    this.challenges.set(nonce, { key, expires: this.now() + REQUEST_TTL })
    return { nonce }
  }
  prove(nonce: unknown, signature: unknown, from?: string) {
    this.prune()
    if (typeof nonce !== 'string' || typeof signature !== 'string' || !/^[\w-]{86}$/.test(signature)) return null
    const row = this.challenges.get(nonce)
    this.challenges.delete(nonce)
    if (!row) return null
    const { key } = row,
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
    // A reload or a second tab proving the same device key must not create
    // another code or another TUI notification while the first is pending.
    if (this.requests.size >= 8) return null
    for (const request of this.requests.values()) {
      if (request.key !== key || request.approved) continue
      const receipt = secret()
      this.requests.set(receipt, request)
      return { code: request.code, receipt, remainingMs: request.expires - this.now() }
    }
    let code: string
    do {
      code = String(randomInt(100_000_000)).padStart(8, '0')
    } while ([...this.requests.values()].some((r) => r.code === code))
    const receipt = secret()
    this.requests.set(receipt, { key, code, approved: false, expires: this.now() + REQUEST_TTL, from })
    this.notify(code, deviceId(key))
    return { code, receipt, remainingMs: REQUEST_TTL }
  }
  decide(code: string, approve: boolean) {
    this.prune()
    for (const r of this.requests.values())
      if (!r.approved && r.code === code) {
        if (approve) {
          this.store.approve(r.key, this.now(), r.from)
          r.approved = true
        } else {
          for (const [id, sibling] of this.requests) if (sibling === r) this.requests.delete(id)
        }
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
  authorized(header: string | null) {
    if (!header?.startsWith('Bearer ')) return false
    const session = this.sessions.get(header.slice(7))
    return !!session && session.expires > this.now() && this.store.has(session.key, this.now())
  }
  revoke(id: string) {
    if (!this.store.remove(id)) return false
    for (const map of [this.sessions, this.requests, this.challenges])
      for (const [k, r] of map) if (deviceId(r.key) === id) map.delete(k)
    return true
  }
  /** Forget every device: approved grants, live phone sessions and pending codes. */
  revokeAll() {
    const count = this.store.clear()
    this.sessions.clear()
    this.requests.clear()
    this.challenges.clear()
    return count
  }
  close() {
    this.sessions.clear()
    this.requests.clear()
    this.challenges.clear()
  }
}
