import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export type Device = { key: string; approvedAt: number; lastSeenAt?: number; lastSeenFrom?: string }
/** A network address as the ingress reported it; nothing else from the request. */
export const validAddress = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-fA-F.:]{3,45}$/.test(v)
/** A grant nobody has used for this long needs a fresh code on the Mac. */
export const GRANT_IDLE_TTL = 30 * 86_400_000
export function deviceId(key: string) {
  return createHash('sha256').update(key).digest('hex').slice(0, 20)
}
export function validKey(key: unknown): key is string {
  return (
    typeof key === 'string' &&
    /^[A-Za-z0-9_-]{87}$/.test(key) &&
    Buffer.from(key, 'base64url')[0] === 4 &&
    Buffer.from(key, 'base64url').toString('base64url') === key
  )
}

/** One writer per environment: mutations require ownership of the profile's gateway lease. */
export class DeviceStore {
  private rows: Device[]
  private file: string
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stat = lstatSync(dir)
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
      throw Error('Unsafe device directory.')
    this.file = join(dir, 'devices.json')
    this.rows = []
    try {
      const file = lstatSync(this.file)
      if (!file.isFile() || file.uid !== stat.uid || file.mode & 0o077 || file.size > 32768)
        throw Error('Unsafe devices.json.')
      const doc = JSON.parse(readFileSync(this.file, 'utf8'))
      if (![0, 1].includes(doc.schema_version ?? 0)) throw Error('Unsupported devices.json schema.')
      if (
        !Array.isArray(doc.devices) ||
        doc.devices.length > 64 ||
        !doc.devices.every((r: Device) => r && validKey(r.key) && Number.isSafeInteger(r.approvedAt)
          && (r.lastSeenAt === undefined || Number.isSafeInteger(r.lastSeenAt))
          && (r.lastSeenFrom === undefined || validAddress(r.lastSeenFrom)))
      )
        throw Error('Invalid devices.json.')
      this.rows = doc.devices
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
  list(now = Date.now()) {
    return this.rows.map((r) => ({ id: deviceId(r.key), approvedAt: r.approvedAt, lastSeenAt: r.lastSeenAt ?? r.approvedAt,
      lastSeenFrom: r.lastSeenFrom, expired: !this.current(r, now) }))
  }
  private current(row: Device, now: number) {
    return now - (row.lastSeenAt ?? row.approvedAt) < GRANT_IDLE_TTL
  }
  /** Approved and used within the idle window. Grants older than that read as
   * unknown devices: the Mac must approve a new code, exactly as for a new phone. */
  has(key: string, now = Date.now()) {
    const row = this.rows.find((r) => r.key === key)
    return !!row && this.current(row, now)
  }
  /** (Re)approving an idle grant replaces it, so the new approval time is the record. */
  approve(key: string, now = Date.now(), from?: string) {
    if (this.has(key, now)) return
    if (!validKey(key)) throw Error('Invalid device key.')
    const others = this.rows.filter((r) => r.key !== key)
    if (others.length >= 64) throw Error('Device limit reached.')
    this.replace([...others, { key, approvedAt: now, lastSeenAt: now, ...(validAddress(from) ? { lastSeenFrom: from } : {}) }])
  }
  /** Called when the device proves possession. Writes when the address changes, else at most hourly. */
  touch(key: string, now = Date.now(), from?: string) {
    const row = this.rows.find((r) => r.key === key)
    if (!row || !this.current(row, now)) return
    const address = validAddress(from) ? from : row.lastSeenFrom
    if (address === row.lastSeenFrom && now - (row.lastSeenAt ?? row.approvedAt) < 3_600_000) return
    this.replace(this.rows.map((r) => (r === row ? { ...r, lastSeenAt: now, ...(address ? { lastSeenFrom: address } : {}) } : r)))
  }
  remove(id: string) {
    const keep = this.rows.filter((r) => deviceId(r.key) !== id)
    if (keep.length === this.rows.length) return false
    this.replace(keep)
    return true
  }
  /** Every grant, including expired ones. Returns how many were removed. */
  clear() {
    const count = this.rows.length
    if (count) this.replace([])
    return count
  }
  private replace(rows: Device[]) {
    const tmp = this.file + '.' + randomUUID() + '.tmp'
    const fd = openSync(tmp, 'wx', 0o600)
    try {
      try {
        writeFileSync(fd, JSON.stringify({ schema_version: 1, devices: rows }) + '\n')
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, this.file)
      this.rows = rows
      const parent = openSync(this.dir, 'r')
      try {
        fsyncSync(parent)
      } finally {
        closeSync(parent)
      }
    } finally {
      rmSync(tmp, { force: true })
    }
  }
}
