import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tryGatewayLease } from './lease.js'
import { privateSocketDirectory } from './socket-directory.js'

// One opt-in per installation, not per conversation or window. The selected
// scope pins the account and configuration that may acquire the machine address.
const file = (home: string) => join(home, 'remote', 'gateway.json')
const validScope = (scope: unknown): scope is string => typeof scope === 'string' && /^[0-9a-f]{24}$/.test(scope)

/** Undefined is an installation predating the opt-in file; null is explicitly off. */
export function gatewayPolicy(home: string): string | null | undefined {
  try {
    const path = file(home)
    const st = lstatSync(path)
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) || st.size > 256)
      throw Error('Unsafe Remote gateway settings.')
    const doc = JSON.parse(readFileSync(path, 'utf8'))
    const version = doc?.schema_version === undefined ? 0 : doc.schema_version
    if (version !== 0 && version !== 1) throw Error('Unsupported Remote gateway settings version.')
    if (doc?.scope !== null && !validScope(doc?.scope)) throw Error('Invalid Remote gateway settings.')
    return doc.scope
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
}

export async function updateGatewayPolicy(home: string, scope: string, change: 'enable' | 'disable' | 'adopt', currentProfile: () => boolean) {
  if (!validScope(scope)) throw Error('Invalid Remote profile.')
  const release = await tryGatewayLease(join(privateSocketDirectory(home), 'remote-gateway-policy.lock'))
  if (!release) throw Error('Remote settings are being updated. Retry the command.')
  try {
    if (!currentProfile()) throw Error('The active profile changed; run the command again.')
    const current = gatewayPolicy(home)
    if (change === 'adopt' && current !== undefined) return current === scope
    if (current && current !== scope) throw Error('Remote is enabled for a different profile. Run /remote off from that profile first.')
    const next = change === 'disable' ? null : scope
    if (next === current) return next === scope
    const path = file(home), dir = join(home, 'remote')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = `${path}.${crypto.randomUUID()}.tmp`, fd = openSync(tmp, 'wx', 0o600)
    try {
      try {
        writeFileSync(fd, JSON.stringify({ schema_version: 1, scope: next }) + '\n')
        fsyncSync(fd)
      } finally { closeSync(fd) }
      renameSync(tmp, path)
      const parent = openSync(dir, 'r')
      try { fsyncSync(parent) } finally { closeSync(parent) }
    } finally { rmSync(tmp, { force: true }) }
    return next === scope
  } finally { release() }
}
