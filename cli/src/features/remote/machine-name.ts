import { hostname } from 'node:os'

let cached: string | undefined

/** What the user calls this computer. macOS often reports `localhost` from
 * hostname() on DHCP networks; its Sharing name ("Bohu's MacBook Pro") is the one
 * people recognize. Read once per process; never shown to anyone but the owner. */
export function machineName(): string {
  if (cached !== undefined) return cached
  let name = ''
  if (process.platform === 'darwin') {
    for (const key of ['ComputerName', 'LocalHostName']) {
      const out = Bun.spawnSync(['/usr/sbin/scutil', '--get', key], { stdout: 'pipe', stderr: 'ignore', timeout: 2000 })
      name = out.exitCode === 0 ? out.stdout.toString().trim() : ''
      if (name) break
    }
  }
  if (!name) name = hostname().replace(/\.local$/, '')
  cached = name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64) || 'Computer'
  return cached
}
