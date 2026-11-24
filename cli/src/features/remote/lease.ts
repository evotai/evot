import { createServer, type RequestListener } from 'node:http'
import { gatewaySocket, privateSocketDirectory, reapDeadSocket } from './socket-directory.js'

export function leasePath(home: string, scope: string) {
  return gatewaySocket(privateSocketDirectory(home), scope)
}

/** The kernel owns exclusion even while the gateway is still starting. The
 * listener is private to this uid; never mount it on the public ingress. */
export async function tryGatewayLease(path: string, handle?: RequestListener) {
  let closed = false
  const server = createServer((req, res) => {
    res.setHeader('Connection', 'close')
    if (closed || !handle) { res.writeHead(503).end(); return }
    handle(req, res)
  })
  const bind = () => new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => { server.off('error', reject); resolve() })
  })
  for (let attempt = 0; ; attempt++) {
    try { await bind(); break } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e
      if (attempt || !(await reapDeadSocket(path))) return null
    }
  }
  return () => { closed = true; server.close() }
}
