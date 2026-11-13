import type { QueryStream } from '../../../native/index.js'
import { errorText } from '../../../ui/format.js'
import { PendingQueue, type PendingEntry, type QueueTarget } from './pending-queue.js'

export interface QueueLifecycleDeps {
  queue: PendingQueue
  getTarget(): QueueTarget
  getStream(): QueryStream | null
  busy(): boolean
  preparing(): boolean
  editing(): boolean
  getDispatch(): string | null
  setDispatch(id: string | null): void
  runQueued(entry: PendingEntry): Promise<void>
  consumed(entries: PendingEntry[]): void
  notify(message: string): void
  requestRender(): void
}

/** The only host-side owner of stream handoff and deferred dispatch. The
 * engine alone consumes attached prompts; UI code never schedules work. */
export function createQueueLifecycle(deps: QueueLifecycleDeps) {
  const queue = deps.queue
  function reconcile() {
    const stream = deps.getStream()
    if (!stream) return
    try { deps.consumed(queue.reconcile(stream)) }
    catch (err) { deps.notify(`Queue read failed: ${errorText(err)}`) }
  }
  function detach(stream: QueryStream): boolean {
    try { queue.detach(stream, deps.consumed); return true }
    catch (err) { deps.notify(`Queue ownership unresolved: ${errorText(err)}. Ctrl+G to retry.`); return false }
  }
  function recoverOwnership(): boolean {
    for (const stream of new Set(queue.state.entries.flatMap(entry => entry.native ? [entry.native.stream] : []))) {
      if (!detach(stream)) return false
    }
    return !queue.state.blocked
  }
  function pause(stream = deps.getStream()) {
    deps.setDispatch(null)
    queue.cancelReservation()
    if (stream) detach(stream)
    queue.settle(queue.state.chain, false)
    deps.requestRender()
  }
  function begin(target: QueueTarget): number {
    if (deps.getDispatch()) return queue.continueChain()
    return queue.begin(target)
  }
  function started(stream: QueryStream, sessionId?: string) {
    if (sessionId) queue.bindSession(sessionId)
    const initial = queue.state.entries.find(entry => entry.id === deps.getDispatch())
    if (initial) {
      queue.remove(initial, initial.version)
      deps.consumed([initial])
    }
    queue.attach(stream)
    deps.requestRender()
  }
  function settled(stream: QueryStream | null, chain: number, success: boolean) {
    if (chain !== queue.state.chain) return
    const detached = !stream || detach(stream)
    queue.settle(chain, success && detached)
    deps.requestRender()
  }
  function dispatchNext() {
    if (deps.busy() || deps.getDispatch() || queue.state.blocked) return
    const entry = queue.next(queue.state.chain)
    if (!entry || entry.target !== deps.getTarget()) return
    deps.setDispatch(entry.id)
    void deps.runQueued(entry).catch(err => {
      if (deps.getDispatch() === entry.id) { pause(); deps.notify(`Queued run failed: ${errorText(err)}`) }
    }).finally(() => {
      if (deps.getDispatch() !== entry.id) return
      if (queue.state.entries.includes(entry)) {
        queue.settle(entry.chain, false)
        deps.notify('Queued run did not start; pending work paused.')
      }
      deps.setDispatch(null)
      dispatchNext()
    })
  }
  function resumePaused() {
    if (deps.busy() || deps.getDispatch() || deps.preparing() || deps.editing()) { deps.notify('Wait for the current operation before resuming.'); return }
    if (queue.state.blocked && !recoverOwnership()) return
    queue.resume(deps.getTarget())
    dispatchNext()
  }
  return { reconcile, recoverOwnership, begin, started, settled, pause, dispatchNext, resumePaused }
}
export type QueueLifecycle = ReturnType<typeof createQueueLifecycle>
