import { randomUUID } from 'node:crypto'
import { REMOTE_IMAGE_LIMITS, type RemoteImage } from './protocol.js'

/** Sent with status 412: the phone resends the same photos inline. */
export const PHOTO_EXPIRED = 'Photo upload expired. Sending it with the message.'
const TTL_MS = 10 * 60_000
const PER_DEVICE = REMOTE_IMAGE_LIMITS.count * 2 // room to swap a photo before sending

/** Photos a phone uploads while the message is still being written, so Send
 * carries only their ids. Memory only, bound to the device credential that
 * uploaded them, and gone after use, ten minutes, or when the gateway stops.
 * Windows behind the gateway still receive ordinary inline images. */
export class PhotoStash {
  #photos = new Map<string, { owner: string; image: RemoteImage; expires: number }>()
  constructor(private now = Date.now) {}

  put(owner: string, image: RemoteImage): string {
    this.#prune()
    const mine = [...this.#photos].filter(([, p]) => p.owner === owner) // oldest first
    let count = mine.length + 1, bytes = mine.reduce((sum, [, p]) => sum + p.image.data.length, image.data.length)
    for (const [id, p] of mine) {
      if (count <= PER_DEVICE && bytes <= REMOTE_IMAGE_LIMITS.base64Total) break
      this.#photos.delete(id); count--; bytes -= p.image.data.length
    }
    const id = randomUUID()
    this.#photos.set(id, { owner, image, expires: this.now() + TTL_MS })
    return id
  }

  /** Replace `{ ref }` images in an action body with their bytes, plus the ids to
   * release once the action succeeds. `null`: an id is unknown, expired or another device's. */
  resolve(owner: string, body: unknown): { body: unknown; refs: string[] } | null {
    const images = body && typeof body === 'object' ? (body as { images?: unknown }).images : undefined
    if (!Array.isArray(images) || !images.some(isRef)) return { body, refs: [] }
    this.#prune()
    const refs: string[] = [], resolved: unknown[] = []
    for (const item of images) {
      if (!isRef(item)) { resolved.push(item); continue }
      const photo = this.#photos.get(item.ref)
      if (!photo || photo.owner !== owner) return null
      refs.push(item.ref); resolved.push(photo.image)
    }
    return { body: { ...(body as object), images: resolved }, refs }
  }

  release(refs: string[]) { for (const id of refs) this.#photos.delete(id) }
  clear() { this.#photos.clear() }
  get size() { return this.#photos.size }

  #prune() {
    const now = this.now()
    for (const [id, p] of this.#photos) if (p.expires <= now) this.#photos.delete(id)
  }
}

const isRef = (item: unknown): item is { ref: string } =>
  !!item && typeof item === 'object' && typeof (item as { ref?: unknown }).ref === 'string'
