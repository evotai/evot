import { readFileSync } from 'fs'
import { join } from 'path'
import { stateRootDir } from './auth-watch.js'

/** Account identity, distinct from the auth/catalog content stamp. Token
 * rotation and model sync do not change who owns cached task data.
 * undefined means unreadable/invalid, not signed out. */
export function readAuthIdentity(root = stateRootDir()): string | null | undefined {
  let raw: string
  try {
    raw = readFileSync(join(root, 'auth.json'), 'utf8')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined
  }
  try {
    const auth = JSON.parse(raw)
    if (typeof auth?.user?.id !== 'string' || !auth.user.id.trim()
      || typeof auth.server_base_url !== 'string' || !auth.server_base_url.trim()) return undefined
    const url = new URL(auth.server_base_url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined
    url.hash = ''
    return JSON.stringify([url.href.replace(/\/+$/, ''), auth.user.id])
  } catch {
    return undefined
  }
}

/** Only real identity transitions invalidate account-scoped UI state. */
export class AuthIdentityTracker {
  #identity: string | null | undefined

  constructor(private readonly onChange: () => void, private readonly root = stateRootDir()) {
    this.#identity = readAuthIdentity(root)
  }

  refresh(): void {
    const next = readAuthIdentity(this.root)
    if (next === undefined || next === this.#identity) return
    this.#identity = next
    this.onChange()
  }
}
