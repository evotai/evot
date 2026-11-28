import { homedir } from 'node:os'
import { join } from 'node:path'
import { ConnectDenied, allocateCloud, machineSocketDirectory } from './cloud-connect.js'
import { updateGatewayPolicy } from './gateway-policy.js'
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
  connectorChanged?: () => void
  /** Phase text while starting (and bytes while downloading the connector); later, reconnect notices. */
  progress?: InstallProgress
}, retryDelay?: Parameters<typeof superviseConnector>[0]['delay']) {
  const { account, home, scope, workspace, host, pending } = input
  let closed = false, denied = false
  const active = () => !closed && !denied && input.active()
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
    const register = async (binding?: string) => {
      if (!account || !identity) throw Error('Missing Remote account or machine identity.')
      try { return await allocateCloud(identity, account, connector, binding) }
      catch (error) {
        if (error instanceof ConnectDenied && active()) {
          denied = true // Refuse requests before releasing any lease or listener.
          // Otherwise the next election could retry a rejected binding as a
          // fresh, unbound registration. Re-enabling must be explicit.
          await updateGatewayPolicy(join(homedir(), '.evotai'), scope, 'disable', () => !closed && input.active())
        }
        throw error
      }
    }
    const allocation = account && identity ? await register() : null
    if (allocation && !(await reapDeadSocket(allocation.gate.unix)))
      throw Error('Environment socket is already active.')
    if (!active()) throw Error('Sharing request cancelled.')
    const access = new DeviceAccess(
      store,
      (code, device, terminal) => terminal ? workspace.bus.notifyPairing(terminal, code, device) : pending(code, device),
      { presenceChanged: input.presenceChanged },
    )
    const gateway = listenRemote(host, access, { port: gatewayPort(scope), cloud: allocation?.gate, active, workspace })
    let stopConnector: (() => void) | undefined
    let reconnecting = false
    try {
      if (allocation && account && identity) {
        progress('Starting the tunnel connector…')
        stopConnector = superviseConnector({
          start: allocation.start, delay: retryDelay,
          refresh: async () => {
            const next = await register(allocation.binding)
            if (next.gate.origin !== allocation.gate.origin || next.gate.unix !== allocation.gate.unix)
              throw Error('Connect returned a different address; refusing to move this gateway.')
            return next.start
          },
          // Deliver the terminal failure even when writing the denial has
          // already turned off the profile; explicit close still aborts it.
          active: () => denied || input.active(),
          recovering: () => {
            reconnecting = true
            input.connectorChanged?.()
            progress('Connector stopped; retrying on the same address…')
          },
          restarted: () => { reconnecting = false; input.connectorChanged?.() },
          failed: reason => { if (!closed) input.exited(reason) },
        })
        // Ownership means the private socket is bound and the supervised
        // connector is started, not that a public edge probe returned 200.
      }
    } catch (e) {
      stopConnector?.()
      gateway.close()
      throw e
    }
    grants = access
    return {
      ...gateway,
      scope,
      get reconnecting() { return reconnecting },
      url: allocation?.url ?? gateway.address,
      cloud: !!allocation,
      active,
      close() {
        if (closed) return
        closed = true
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
