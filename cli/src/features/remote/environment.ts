import { join } from 'node:path'
import { allocateCloud } from './cloud-connect.js'
import { ensureCloudflared, type InstallProgress } from './cloudflared.js'
import { leasePath, tryGatewayLease } from './lease.js'
import { withRelayChecks } from './relay-permit.js'
import { grantHandler } from './grants.js'
import { DeviceStore } from './devices.js'
import { reapDeadSocket } from './discovery.js'
import { DeviceAccess } from './pairing.js'
import type { RemoteHost } from './protocol.js'
import { listenRemote } from './server.js'
import { gatewayPort } from './transport.js'
import type { PhoneWorkspace } from './workspace.js'

/** Poll our own page through Cloudflare until it answers, for up to `timeoutMs`. */
export async function reachable(origin: string, cancelled: () => boolean, timeoutMs = 45_000, probe = fetch) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end && !cancelled()) {
    try {
      const res = await probe(origin + '/', { redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(5000) })
      await res.body?.cancel()
      if (res.ok) return true
    } catch { /* DNS or the edge not ready yet */ }
    await Bun.sleep(1000)
  }
  return false
}

/** The origin socket and child connector have the same owner/lifetime. A crashed
 * or failed gateway never forwards to another service on a recycled TCP port. */
export async function openEnvironment(input: {
  account: string | null
  home: string
  scope: string
  active: () => boolean
  workspace: PhoneWorkspace
  host: RemoteHost
  pending: (code: string, id: string) => void
  exited: () => void
  /** Phase text while starting (and bytes while downloading the connector); later, reconnect notices. */
  progress?: InstallProgress
}) {
  const { account, home, scope, active, workspace, host, pending } = input
  if (!account && process.env.EVOT_REMOTE_LOCAL_TEST !== '1')
    throw Error('Sign in with /login before enabling remote access.')
  const dir = join(home, 'remote', scope)
  let grants: DeviceAccess | null = null
  const handle = withRelayChecks(
    (ticket, target) => !!grants && active() && workspace.bus.consumeRelay(ticket, target),
    grantHandler(() => active() ? grants : null),
  )
  const release = await tryGatewayLease(leasePath(home, scope), handle)
  if (!release) throw Error('Another gateway is starting or active. Retry /remote.')
  try {
    const store = new DeviceStore(dir)
    const progress: InstallProgress = (text, bytes) => input.progress?.(text, bytes)
    const connector = async () => {
      const bin = await ensureCloudflared(home, progress)
      progress('Registering this computer with evot Connect…')
      return bin
    }
    const allocation = account ? await allocateCloud(dir, account, connector) : null
    if (allocation && !(await reapDeadSocket(allocation.gate.unix)))
      throw Error('Environment socket is already active.')
    if (!active()) throw Error('Sharing request cancelled.')
    const access = new DeviceAccess(store, pending)
    const gateway = listenRemote(host, access, { port: gatewayPort(scope), cloud: allocation?.gate, active, workspace })
    let closed = false, restarts = 0,
      proc: ReturnType<NonNullable<typeof allocation>['start']> | undefined
    // cloudflared rides out network loss by itself. It exits when its token stops
    // working, e.g. after the server released a long-offline tunnel: register again
    // (same hostname) and resume, a few times, before reporting the gateway down.
    const launch = (start: NonNullable<typeof allocation>['start']) => {
      const began = Date.now()
      proc = start()
      void proc.exited.then(async () => {
        if (closed) return
        if (Date.now() - began > 10 * 60_000) restarts = 0
        if (!account || ++restarts > 3) { input.exited(); return }
        input.progress?.('Connector stopped; reconnecting to evot Connect…')
        await Bun.sleep(12_000 * restarts) // the server throttles re-registration to once per 10 s
        if (closed) return
        try {
          const next = await allocateCloud(dir, account, connector)
          if (!closed) { launch(next.start); input.progress?.('Reconnected to evot Connect.') }
        } catch {
          if (!closed) input.exited()
        }
      })
    }
    try {
      if (allocation) {
        progress('Starting the tunnel connector…')
        launch(allocation.start)
      }
    } catch (e) {
      gateway.close()
      throw e
    }
    // The invite is only useful once Cloudflare routes the hostname to this socket.
    let online = true
    if (allocation) {
      progress(`Waiting for ${new URL(allocation.gate.origin).host} to come online…`)
      online = await reachable(allocation.gate.origin, () => closed || !active())
    }
    grants = access
    return {
      ...gateway,
      online,
      scope,
      url: allocation?.url ?? gateway.address,
      cloud: !!allocation,
      active,
      close() {
        closed = true
        grants = null
        proc?.kill()
        gateway.close()
        release()
      },
    }
  } catch (error) {
    release()
    throw error
  }
}
export type SharedEnvironment = Awaited<ReturnType<typeof openEnvironment>>
