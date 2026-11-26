import { homedir } from 'node:os'
import { join } from 'node:path'
import { allocateCloud, machineSocketDirectory } from './cloud-connect.js'
import { machineIdentity } from './machine-identity.js'
import { ensureCloudflared, type InstallProgress } from './cloudflared.js'
import { superviseConnector } from './connector.js'
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

export class GatewayOccupied extends Error {}

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
  exited: (reason: string) => void
  presenceChanged: () => void
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
    grantHandler(() => active() ? grants : null, workspace.bus.id),
  )
  const release = await tryGatewayLease(leasePath(home, scope), handle)
  if (!release) throw new GatewayOccupied('Another gateway is starting or active. Retry /remote.')
  let releaseMachine: (() => void) | null = null
  try {
    if (!active()) throw Error('Sharing request cancelled.')
    const identity = account ? machineIdentity(homedir(), false) : null
    if (identity) {
      releaseMachine = await tryGatewayLease(join(machineSocketDirectory(identity.environment), 'owner.lock'))
      if (!releaseMachine) throw new GatewayOccupied('Another Remote gateway is active on this computer. Shut it down before changing profiles.')
      if (!active()) throw Error('Sharing request cancelled.')
    }
    const store = new DeviceStore(dir)
    const progress: InstallProgress = (text, bytes) => input.progress?.(text, bytes)
    const connector = async () => {
      const bin = await ensureCloudflared(home, progress)
      progress('Registering this computer with evot Connect…')
      return bin
    }
    const allocation = account && identity ? await allocateCloud(identity, account, connector) : null
    if (allocation && !(await reapDeadSocket(allocation.gate.unix)))
      throw Error('Environment socket is already active.')
    if (!active()) throw Error('Sharing request cancelled.')
    const access = new DeviceAccess(
      store,
      (code, device, terminal) => terminal ? workspace.bus.notifyPairing(terminal, code, device) : pending(code, device),
      { presenceChanged: input.presenceChanged },
    )
    const gateway = listenRemote(host, access, { port: gatewayPort(scope), cloud: allocation?.gate, active, workspace })
    let stopConnector: (() => void) | undefined, failure: string | undefined
    let online = true, ready = false
    try {
      if (allocation && account && identity) {
        progress('Starting the tunnel connector…')
        stopConnector = superviseConnector({
          start: allocation.start,
          refresh: async () => {
            const next = await allocateCloud(identity, account, connector, allocation.binding)
            if (next.gate.origin !== allocation.gate.origin || next.gate.unix !== allocation.gate.unix)
              throw Error('Connect returned a different address; refusing to move this gateway.')
            return next.start
          },
          active,
          recovering: () => progress('Connector stopped; retrying on the same address…'),
          failed: reason => { failure = reason; if (ready) input.exited(reason) },
        })
        progress(`Waiting for ${new URL(allocation.gate.origin).host} to come online…`)
        online = await reachable(allocation.gate.origin, () => !!failure || !active())
        if (failure) throw Error(failure)
        if (!active()) throw Error('Sharing request cancelled.')
      }
    } catch (e) {
      stopConnector?.()
      gateway.close()
      throw e
    }
    ready = true
    grants = access
    return {
      ...gateway,
      online,
      scope,
      url: allocation?.url ?? gateway.address,
      cloud: !!allocation,
      active,
      close() {
        grants = null
        stopConnector?.()
        gateway.close()
        releaseMachine?.()
        release()
      },
    }
  } catch (error) {
    releaseMachine?.()
    release()
    throw error
  }
}
export type SharedEnvironment = Awaited<ReturnType<typeof openEnvironment>>
