import { setTimeout as wait } from 'node:timers/promises'
import { ConnectRetryable } from './cloud-connect.js'

interface ConnectorProcess {
  readonly exited: Promise<unknown>
  kill(): void
}
type Start = () => ConnectorProcess

/** The gateway and device store stay open when the connector loses its route. */
export function superviseConnector(input: {
  start: Start
  refresh(): Promise<Start>
  active(): boolean
  recovering(): void
  failed(reason: string): void
  delay?: (ms: number, signal: AbortSignal) => Promise<unknown>
}) {
  const stop = new AbortController()
  const delay = input.delay ?? ((ms, signal) => wait(ms, undefined, { signal, ref: false }))
  const active = () => !stop.signal.aborted && input.active()
  let proc = input.start(), failures = 0, started = Date.now()

  async function supervise() {
    while (active()) {
      await proc.exited
      if (!active()) return
      if (Date.now() - started > 10 * 60_000) failures = 0
      input.recovering()
      while (active()) {
        await delay(Math.min(120_000, 12_000 * 2 ** Math.min(failures++, 4)), stop.signal)
        if (!active()) return
        let start: Start
        try { start = await input.refresh() }
        catch (error) {
          if (error instanceof ConnectRetryable) continue
          throw error
        }
        if (!active()) return
        proc = start()
        started = Date.now()
        break
      }
    }
  }
  void supervise().catch(error => {
    if (active()) input.failed(error instanceof Error ? error.message : 'Tunnel connector unavailable.')
  })
  return () => { stop.abort(); proc.kill() }
}
