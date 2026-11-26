export type RemoteDeviceKind = 'phone' | 'tablet' | 'desktop' | 'unknown'
export type RemotePresence = Readonly<Record<RemoteDeviceKind, number>>
export const PRESENCE_TTL_MS = 10_000

/** A display hint only. Do not retain the underlying browser headers. */
export function remoteDeviceKind(headers: Headers): RemoteDeviceKind {
  const agent = headers.get('user-agent') ?? ''
  if (/iPad|Tablet|Kindle|Silk\//i.test(agent) ||
      (/Macintosh/i.test(agent) && headers.get('x-evot-touch-mac') === '1')) return 'tablet'
  if (headers.get('sec-ch-ua-mobile') === '?1' || /\b(?:Mobile|iPhone|iPod|Windows Phone)\b/i.test(agent)) return 'phone'
  if (/Android/i.test(agent)) return 'tablet'
  if (/Macintosh|Windows NT|X11|CrOS/i.test(agent)) return 'desktop'
  return 'unknown'
}

/** One row per approved browser key, independent of tokens, tabs and chats. */
export class DevicePresence {
  #devices = new Map<string, { kind: RemoteDeviceKind; expires: number }>()
  #counts: RemotePresence = { phone: 0, tablet: 0, desktop: 0, unknown: 0 }
  #timer: ReturnType<typeof setTimeout> | undefined
  constructor(private changed: () => void, private now = Date.now) {}

  get counts() { return this.#counts }

  touch(device: string, kind: RemoteDeviceKind, expires: number) {
    const previous = this.#devices.get(device)
    this.#devices.set(device, { kind, expires: Math.max(previous?.expires ?? 0, expires) })
    this.#publish()
  }
  remove(device: string) {
    if (this.#devices.delete(device)) this.#publish()
  }
  clear() {
    this.#devices.clear()
    this.#publish()
  }
  #publish() {
    clearTimeout(this.#timer)
    this.#timer = undefined
    const now = this.now(), counts = { phone: 0, tablet: 0, desktop: 0, unknown: 0 }
    let next = Infinity
    for (const [device, { kind, expires }] of this.#devices) {
      if (expires <= now) this.#devices.delete(device)
      else { counts[kind]++; next = Math.min(next, expires) }
    }
    if (Number.isFinite(next)) this.#timer = setTimeout(() => this.#publish(), next - now).unref()
    if (counts.phone === this.#counts.phone && counts.tablet === this.#counts.tablet &&
        counts.desktop === this.#counts.desktop && counts.unknown === this.#counts.unknown) return
    this.#counts = counts
    this.changed()
  }
}
