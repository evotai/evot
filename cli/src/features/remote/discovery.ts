import { randomUUID } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { confirmRelay, relayPermits } from './relay-permit.js'
import { gatewaySocket, privateSocketDirectory, reapDeadSocket } from './socket-directory.js'
import { parseRemoteAction, RemoteConflict, REMOTE_IMAGE_LIMITS, type RemoteHost } from './protocol.js'
import { parseRestartRequest, type WindowControl } from '../restart/protocol.js'
export { profileKey, privateSocketDirectory, reapDeadSocket } from './socket-directory.js'

export type Phase = 'working' | 'input' | 'idle' | 'busy'
/** More specific TUI states for live windows; older peers only send phase. */
export type RunBadge = 'waiting-task' | 'waiting-background' | 'waiting-loop' | 'retrying' | 'compacting'
export interface SessionBadge {
  workspace: string
  /** Opaque cwd identity; only an accessible window's badge carries this. */
  project?: string
  session: string
  gateway?: boolean
  phoneCreated?: boolean
  updatedAt?: number
  phase: Phase
  runState?: RunBadge
  /** Last non-interrupted agent round to settle. Older terminals omit this. */
  finishedRound?: number | null
  /** Latest agent round completed successfully. Absence does not imply completion. */
  completed?: true
  title: string
}
export type WindowPresence = { phase: Phase; updatedAt: number }
export interface OnlineTerminal extends SessionBadge {
  terminal: string
}
export const validTerminal = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)

/** Private sockets record occupancy so a history click cannot resume a session
 * over a hidden live TUI. The 0700 Unix directory is the local trust boundary.
 * Only a running profile gateway requests inherited access; device credentials
 * stay at its ingress. Older gateways can only follow explicitly shared windows. */
export function registerTerminal(home: string, host: RemoteHost, badge: () => SessionBadge, id: string = randomUUID(),
  membership?: { session(): string; currentScope(): string | null; pairing?(code: string, device: string): void }, control?: WindowControl) {
  if (!validTerminal(id)) throw new Error('Cannot register this terminal.')
  const dir = privateSocketDirectory(home)
  const socket = (terminal: string) => join(dir, terminal + '.sock')
  // Pin the profile that owns the window. A login/config switch must not
  // implicitly publish its old conversation to a different profile.
  const inheritedScope = membership?.currentScope() ?? null, permits = relayPermits()
  let scope: string | null | undefined // undefined: inherit; null: hidden; string: explicit invite
  let routerScope: string | null = null, closed = false
  let invitation: { url: string; address: string; windowApproval?: true } | undefined
  const matches = (requested: string | null, inherit: boolean) => !closed && !!requested &&
    requested === (scope === undefined && inherit ? inheritedScope : scope) &&
    (!membership || membership.currentScope() === requested)
  const server = Bun.serve({
    unix: socket(id),
    development: false,
    maxRequestBodySize: REMOTE_IMAGE_LIMITS.base64Total + 64 * 1024, // a relayed /action can carry photos
    async fetch(req) {
      const path = new URL(req.url).pathname, requested = req.headers.get('x-evot-scope')
      // Window control is for this user's own processes; the 0700 directory is
      // its boundary. The gateway's relay cannot name this path.
      if (path === '/restart') {
        if (!control) return new Response(null, { status: 404 })
        if (req.method === 'GET') return Response.json(control.status())
        if (req.method !== 'POST') return new Response(null, { status: 405 })
        const request = parseRestartRequest(await req.json().catch(() => null))
        return request ? Response.json(control.request(request)) : new Response(null, { status: 400 })
      }
      const ticket = req.headers.get('x-evot-relay')
      if (path === '/pairing') {
        if (req.method !== 'POST' || !membership?.pairing || !requested || !validTerminal(ticket) || req.headers.has('origin'))
          return new Response(null, { status: 403 })
        const { code, device } = await req.json().catch(() => ({})) ?? {}
        if (typeof code !== 'string' || !/^\d{8}$/.test(code) || typeof device !== 'string' || !/^[a-f0-9]{20}$/.test(device))
          return new Response(null, { status: 400 })
        // Only a window explicitly shared by /remote can receive a QR prompt.
        if (!matches(requested, false) || !await confirmRelay(gatewaySocket(dir, requested), ticket, id, path) || !matches(requested, false))
          return new Response(null, { status: 403 })
        membership.pairing(code, device)
        return new Response(null, { status: 204 })
      }
      if (path !== '/badge' && path !== '/state' && path !== '/action') return new Response(null, { status: 404 })
      const inherited = scope === undefined && requested && validTerminal(ticket) && matches(requested, true)
        && await confirmRelay(gatewaySocket(dir, requested), ticket, id, path)
      const allowed = () => matches(requested, !!inherited)
      if (req.method === 'GET' && path === '/badge') {
        const gateway = !!routerScope && requested === routerScope
        // Even a hidden gateway must be discoverable, without revealing its row.
        const row = allowed() ? badge() : { session: membership ? membership.session() : badge().session }
        return Response.json({ ...row, gateway, profileGateway: gateway, invitation: gateway ? invitation : undefined })
      }
      if (!allowed()) return new Response(null, { status: 403 })
      if (req.method === 'GET' && path === '/state')
        return Response.json(host.snapshot(req.headers.get('x-evot-background') ?? undefined))
      if (req.method === 'POST' && path === '/action') {
        const action = parseRemoteAction(await req.json())
        if (!action) return new Response(null, { status: 400 })
        if (!allowed()) return new Response(null, { status: 403 })
        host.act(action)
        return new Response(null, { status: 204 })
      }
      return new Response(null, { status: 404 })
    },
    error: (e) =>
      new Response(e instanceof RemoteConflict ? e.message : 'Terminal unavailable.', {
        status: e instanceof RemoteConflict ? 409 : 503,
      }),
  })
  async function request(terminal: string, path: '/badge' | '/state' | '/action', body?: unknown, background?: string) {
    return requestInScope(terminal, path, routerScope || scope || '', body, background)
  }
  async function requestInScope(terminal: string, path: '/badge' | '/state' | '/action' | '/pairing', requestedScope: string, body?: unknown, background?: string) {
    if (!validTerminal(terminal)) throw new RemoteConflict('Invalid terminal.')
    const ticket = routerScope ? permits.issue(terminal, path) : null
    try {
      return await fetch('http://localhost' + path, {
        unix: socket(terminal),
        headers: {
          'x-evot-scope': requestedScope,
          ...(ticket ? { 'x-evot-relay': ticket } : {}),
          ...(background ? { 'x-evot-background': background } : {}),
        },
        method: body ? 'POST' : 'GET',
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(1800),
      })
    } catch {
      throw new RemoteConflict('Terminal is no longer available. Select a session again.')
    } finally { if (ticket) permits.forget(ticket) }
  }
  async function inventory(profileScope = routerScope || scope || '') {
    const files = await readdir(dir, { withFileTypes: true }),
      online: OnlineTerminal[] = [],
      privateWindows: WindowPresence[] = [], occupied = new Set<string>()
    let unavailable = false, gateway = false, profileGateway = false
    let gatewayInvite: typeof invitation
    await Promise.all(
      files.map(async (f) => {
        const terminal = f.name.replace(/\.sock$/, '')
        if (!validTerminal(terminal) || !f.isSocket()) return
        try {
          const r = await requestInScope(terminal, '/badge', profileScope)
          if (!r.ok) {
            unavailable = true
            return
          }
          const { invitation: invite, ...row } = (await r.json()) as Partial<SessionBadge> & {
            session: string; presence?: WindowPresence; profileGateway?: boolean; invitation?: typeof invitation
          }
          if (row.gateway) {
            gateway = true
            if (row.profileGateway) { profileGateway = true; gatewayInvite = invite }
          }
          if (row.session) occupied.add(row.session)
          if (row.phase && row.workspace && typeof row.title === 'string')
            online.push({ ...(row as SessionBadge), terminal })
          else if (row.presence && ['input', 'working', 'busy', 'idle'].includes(row.presence.phase) && Number.isSafeInteger(row.presence.updatedAt))
            privateWindows.push({ phase: row.presence.phase, updatedAt: row.presence.updatedAt })
        } catch {
          if (!(await reapDeadSocket(socket(terminal)))) unavailable = true
        }
      }),
    )
    online.sort((a, b) => a.terminal.localeCompare(b.terminal))
    return { online, occupied, unavailable, gateway, profileGateway, gatewayInvite, privateWindows }
  }
  return {
    id,
    inventory,
    request,
    async notifyPairing(terminal: string, code: string, device: string) {
      if (!routerScope) return false
      try { return (await requestInScope(terminal, '/pairing', routerScope, { code, device })).status === 204 }
      catch { return false }
    },
    get shared() {
      return matches(routerScope ?? scope ?? null, true)
    },
    /** How this window was last shared: inherited from the profile, hidden, or an explicit scope. */
    get sharing(): 'inherit' | 'off' | string {
      return scope === undefined ? 'inherit' : scope === null ? 'off' : scope
    },
    consumeRelay: permits.consume,
    route(value: string | null, invite?: typeof invitation) {
      permits.clear()
      routerScope = value
      invitation = value ? invite : undefined
    },
    share(value: string | null) {
      scope = value
    },
    endInvite() {
      if (scope !== null) scope = undefined // stop the gateway without unhiding this window
    },
    close() {
      closed = true
      permits.clear()
      routerScope = null
      scope = null
      void server.stop(true)
      // Synchronous: a restart execs right after cleanup, and the next image
      // binds this same path for the same window.
      try { unlinkSync(socket(id)) } catch { /* already gone */ }
    },
  }
}
export type TerminalBus = ReturnType<typeof registerTerminal>
