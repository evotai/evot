import type { TerminalBus } from '../../src/features/remote/discovery.js'
import { tryGatewayLease, leasePath } from '../../src/features/remote/lease.js'
import { withRelayChecks } from '../../src/features/remote/relay-permit.js'

export async function startFixtureRelay(home: string, scope: string, bus: TerminalBus) {
  const release = await tryGatewayLease(leasePath(home, scope), withRelayChecks(bus.consumeRelay, (_, res) => { res.writeHead(404).end() }))
  if (!release) throw Error('Fixture profile already in use')
  bus.route(scope)
  return () => { bus.route(null); release() }
}
