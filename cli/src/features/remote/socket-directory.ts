import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync } from 'node:fs'
import { lstat, unlink } from 'node:fs/promises'
import { connect } from 'node:net'
import { join, resolve } from 'node:path'

export function profileKey(home: string) {
  return createHash('sha256').update(resolve(home)).digest('hex').slice(0, 20)
}

// Bun fetch reports FailedToOpenSocket for both dead and inaccessible peers.
// Reap only a refused/missing endpoint on the same inode. Bun on macOS
// reports ENOENT through node:net for a stale AF_UNIX socket.
export async function reapDeadSocket(path: string): Promise<boolean> {
  try {
    const before = await lstat(path)
    const refused = await new Promise<boolean>((resolve) => {
      const probe = connect({ path })
      const finish = (dead: boolean) => {
        probe.destroy()
        resolve(dead)
      }
      probe
        .once('connect', () => finish(false))
        .once('error', (err) => finish(['ECONNREFUSED', 'ENOENT'].includes((err as NodeJS.ErrnoException).code || '')))
        .setTimeout(500, () => finish(false))
    })
    if (!refused || (await lstat(path)).ino !== before.ino) return false
    await unlink(path)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

export function privateSocketDirectory(home: string) {
  const uid = process.getuid?.()
  if (uid === undefined) throw Error('Private Unix sockets are unavailable.')
  const dir = `/tmp/evot-remote-${uid}-${profileKey(home)}`
  mkdirSync(dir, { mode: 0o700, recursive: true })
  const stat = lstatSync(dir)
  if (!stat.isDirectory() || stat.uid !== uid || stat.mode & 0o077)
    throw Error('Unsafe remote discovery directory permissions.')
  return dir
}

export function gatewaySocket(dir: string, scope: string) {
  if (!/^[0-9a-f]{24}$/.test(scope)) throw Error('Invalid remote profile.')
  return join(dir, `gateway-${scope}.lock`)
}
