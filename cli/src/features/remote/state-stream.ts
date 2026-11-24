import type { RemoteSnapshot } from './protocol.js'

// A pull-driven SSE stream: at most one local snapshot in flight, no queue of
// intermediate frames for a slow phone. A reconnect always starts with a complete view.
export function stateStream(
  snapshot: () => Promise<RemoteSnapshot>,
  status: () => number,
  signal: AbortSignal,
  release: () => void,
) {
  const encoder = new TextEncoder(), fields = new Map<string, string>()
  let first = true, stopped = false, lastWrite = 0
  function stop() {
    if (!stopped) { stopped = true; release() }
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!stopped && !signal.aborted) {
          let code = status()
          const view = code === 200 ? await snapshot() : null
          if (stopped || signal.aborted) break
          // Session expiry, unsharing or device revocation during an IPC read.
          code = status()
          if (code !== 200 || !view) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: code })}\n\n`))
            break
          }
          const patch: Record<string, unknown> = {}
          const keys = new Set([...fields.keys(), ...Object.keys(view)])
          for (const key of keys) {
            const v = view[key as keyof RemoteSnapshot] ?? null
            const serialized = JSON.stringify(v)
            if (fields.get(key) !== serialized) { patch[key] = v; fields.set(key, serialized) }
          }
          const now = Date.now()
          if (Object.keys(patch).length || now - lastWrite >= 4000) {
            const frame = Object.keys(patch).length ? 'data: ' + JSON.stringify(first ? { view } : { patch }) : ': alive'
            controller.enqueue(encoder.encode(frame + '\n\n'))
            first = false; lastWrite = now
            // Leave backpressure and cadence to the next pull, including for a constantly changing view.
            await Bun.sleep(200)
            return
          }
          await Bun.sleep(200)
        }
      } catch {
        if (!stopped && !signal.aborted) controller.enqueue(encoder.encode('data: {"status":409}\n\n'))
      } finally {
        if (signal.aborted) stop()
      }
      if (!stopped) { stop(); controller.close() }
    },
    cancel: stop,
  })
}
