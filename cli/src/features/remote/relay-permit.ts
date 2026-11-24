import { randomUUID } from 'node:crypto'
import type { RequestListener } from 'node:http'

// Per-request, not a profile password. A peer checks the private gateway lease
// before inheriting access. A restarted gateway cannot confirm the old tickets.
export function relayPermits() {
  const pending = new Map<string, string>()
  return {
    issue(terminal: string, path: string) {
      const ticket = randomUUID()
      pending.set(ticket, terminal + path)
      return ticket
    },
    consume(ticket: string, target: string) {
      return pending.get(ticket) === target && pending.delete(ticket)
    },
    forget(ticket: string) { pending.delete(ticket) },
    clear() { pending.clear() },
  }
}

/** Private lease, never a device-facing route. Verify only; cannot mint a ticket. */
export function withRelayChecks(check: (ticket: string, target: string) => boolean, devices: RequestListener): RequestListener {
  return (req, res) => {
    const path = req.url?.replace(/^http:\/\/localhost\//, '/')
    const match = path?.match(/^\/relay\/([a-f0-9-]{36})\/([a-f0-9-]{36}\/(?:badge|state|action))$/)
    if (!match) { devices(req, res); return }
    const ok = req.method === 'GET' && req.headers.host === 'localhost' && !req.headers.origin && check(match[1]!, match[2]!)
    res.writeHead(ok ? 204 : 403, {'Cache-Control':'no-store', Connection:'close'}).end()
  }
}

export async function confirmRelay(lease: string, ticket: string, terminal: string, path: string) {
  try {
    const res = await fetch(`http://localhost/relay/${ticket}/${terminal}${path}`, {
      unix: lease, redirect: 'error', signal: AbortSignal.timeout(800),
    })
    await res.body?.cancel()
    return res.status === 204
  } catch { return false }
}
