import { join } from 'node:path'
import { allocateCloud } from './cloud-connect.js'
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
    const allocation = account ? await allocateCloud(dir, account) : null
    if (allocation && !(await reapDeadSocket(allocation.gate.unix)))
      throw Error('Environment socket is already active.')
    if (!active()) throw Error('Sharing request cancelled.')
    const access = new DeviceAccess(store, pending)
    const gateway = listenRemote(host, access, { port: gatewayPort(scope), cloud: allocation?.gate, active, workspace })
    let closed = false,
      proc: ReturnType<NonNullable<typeof allocation>['start']> | undefined
    try {
      proc = allocation?.start()
    } catch (e) {
      gateway.close()
      throw e
    }
    if (proc)
      void proc.exited.then(() => {
        if (!closed) input.exited()
      })
    grants = access
    return {
      ...gateway,
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
