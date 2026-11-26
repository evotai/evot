import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function platformIdentity() {
  if (process.platform === 'darwin') {
    const out = Bun.spawnSync(['/usr/sbin/ioreg', '-d2', '-c', 'IOPlatformExpertDevice'], {
      stdout: 'pipe', stderr: 'ignore', timeout: 2000,
    })
    const id = out.exitCode === 0 && out.stdout.toString().match(/"IOPlatformUUID"\s*=\s*"([0-9a-f-]{36})"/i)
    if (id) return `macos:${id[1]!.toLowerCase()}`
  } else if (process.platform === 'linux') {
    for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try {
        const id = readFileSync(path, 'utf8').trim()
        if (/^[0-9a-f]{32}$/.test(id) && id !== '0'.repeat(32)) return `linux:${id}`
      } catch { /* Some Linux distributions only have the D-Bus file. */ }
    }
  }
  throw Error('Cannot read a machine identity for Remote.')
}

// One install identity per OS user's home, not per evot profile/account.
// Installation copies are detected; platform identifiers are not attestation.
export function machineIdentity(home: string, create: boolean, identify = platformIdentity) {
  const id = identify()
  const dir = join(home, '.evotai', 'remote'), path = join(dir, 'machine.json')
  const digest = (key: string, purpose: string) => createHmac('sha256', Buffer.from(key, 'base64url'))
    .update(`evot-remote:${purpose}:${id}`).digest()
  const read = () => {
    const st = lstatSync(path)
    if (!st.isFile() || st.mode & 0o077 || st.uid !== process.getuid?.()) throw Error('Unsafe Remote machine identity.')
    const data = JSON.parse(readFileSync(path, 'utf8'))
    if (!data || data.schema_version !== 1 || typeof data.key !== 'string' || !/^[\w-]{43}$/.test(data.key)
        || typeof data.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(data.fingerprint))
      throw Error('Unsupported or invalid Remote machine identity.')
    if (!timingSafeEqual(digest(data.key, 'fingerprint'), Buffer.from(data.fingerprint, 'hex')))
      throw Error('This Remote identity belongs to another machine. Use a fresh installation identity on this computer.')
    const secret = digest(data.key, 'credential').toString('base64url')
    const environment = createHash('sha256').update('evot-machine:' + secret).digest('hex').slice(0, 32)
    return { environment, secret }
  }
  try { return read() } catch (e) {
    if (!create || (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const key = randomBytes(32).toString('base64url')
  const tmp = `${path}.${crypto.randomUUID()}`, fd = openSync(tmp, 'wx', 0o600)
  try {
    try {
      writeFileSync(fd, JSON.stringify({ schema_version: 1, key, fingerprint: digest(key, 'fingerprint').toString('hex') }))
      fsyncSync(fd)
    } finally { closeSync(fd) }
    // Another window may be creating the same identity. Never overwrite its key.
    try { linkSync(tmp, path) } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  } finally { unlinkSync(tmp) }
  return read()
}

export type MachineIdentity = ReturnType<typeof machineIdentity>