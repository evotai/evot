import { HostElection, windowGone } from '../../features/remote/host-election.js'
import { ServiceHost } from '../../features/remote/service-host.js'
import { privateSocketDirectory } from '../../features/remote/socket-directory.js'
import { remoteHome } from '../../features/remote/transport.js'
import { consolePort } from '../../native/index.js'
import { discoverDashboard, drainOwnedServer, tryStartServer, type ServerState } from '../app/server.js'
import type { ReplState } from './state.js'
import type { RemoteController } from './remote.js'

export interface ServiceDeps {
  remote: RemoteController
  port?: number
  insideTmux(): boolean
  outdated(): boolean | null
  notice(text: string): void
  publish(state: ServerState | null): void
}

export function createServiceController(st: ReplState, d: ServiceDeps, request: boolean) {
  let discoverAfter = 0
  async function tick() {
    const bus = st.terminalBus, env = st.configInfo?.envPath
    if (st.destroyed) return
    if (!bus || !env) {
      if (request) { d.notice('Host takeover unavailable: private window socket or profile missing.'); request = false }
      // On systems without private Unix sockets Remote cannot run; retain the standalone Console.
      if (!bus && process.platform === 'win32') d.publish(await tryStartServer(d.port,env))
      return
    }
    const scope = d.remote.hostScope()
    if (st.serviceHost && st.serviceHost.scope !== scope) {
      await st.serviceHost.controller.dispose(false)
      st.serviceHost = null
      if (st.destroyed) return
    }
    if (!st.serviceHost) {
      const dir = privateSocketDirectory(remoteHome()), port = consolePort(d.port,env)
      const election = new HostElection(dir,scope,bus.id,port)
      const valid = () => !st.destroyed && d.remote.hostScope() === scope
      const controller = new ServiceHost(election, {
        // An installed update alone must not strand an opted-in profile with
        // only older windows. This is vacancy recovery, never preemption.
        eligible: () => !d.insideTmux() && d.remote.idleForHost() && (!d.outdated() || d.remote.remoteOptedIn()),
        gone: id => windowGone(dir,id),
        preflight: async () => {
          if (st.remoteChild || d.outdated()) throw Error('Use an up-to-date local TUI window.')
          const rows = await bus.inventory(scope), b = election.ballot()
          if (rows.unavailable) throw Error('Could not verify all local windows. Retry the takeover.')
          if (rows.gatewayTerminal && ![b.target,b.previous].includes(rows.gatewayTerminal))
            throw Error('Remote belongs to an unmanaged window. Stop it there first.')
          if (!valid()) throw Error('Profile changed during host preflight.')
        },
        start: async current => {
          if (!valid() || !current()) throw Error('Host request changed.')
          const state = await tryStartServer(port,env)
          if (!state?.owned) throw Error(`Console port ${port} is occupied; standalone servers and older windows cannot hand off.`)
          if (!valid() || !current()) throw Error('Host request changed.')
          const remote = await d.remote.ensureHosted(() => current() && valid())
          if (current() && valid()) d.publish(state)
          if (remote === 'reconnecting') return 'Console (Remote registration is retrying)'
          return remote ? 'Console and Remote' : 'Console (Remote is off)'
        },
        stop: async () => {
          await drainOwnedServer() // Refusal leaves Remote and the old Console in place.
          d.remote.releaseHost(); d.publish(null)
        }, notice: d.notice,
      }, request)
      st.serviceHost = {scope,port,controller}; request = false
    }
    const {controller,port} = st.serviceHost
    await controller.tick()
    if (!st.destroyed && !controller.owner && Date.now() >= discoverAfter) {
      discoverAfter = Date.now() + 5000
      d.publish(await discoverDashboard(port,env))
    }
  }
  return {tick}
}
