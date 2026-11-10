import type { CompactionActivity, CompactionPhase, ManualCompactionOutcome } from '../../../native/contracts/results.js'

export interface ManualCompactionTask {
  readonly phase: CompactionPhase
  readonly activity?: CompactionActivity | null
  result(): Promise<ManualCompactionOutcome>
  abort(): void
}

/** Own one manual compaction independently of editor/render state. Start,
 * phase reads and result decoding can all fail; none may strand ownership. */
export class ManualCompaction {
  private task: ManualCompactionTask | null = null

  get active(): boolean { return this.task !== null }
  get phase(): CompactionPhase | null { return this.task?.phase ?? null }
  get activity(): CompactionActivity | null { return this.task?.activity ?? null }

  abort(): void { this.task?.abort() }

  async run(start: () => ManualCompactionTask, onStarted: () => void, onResult: (outcome: ManualCompactionOutcome) => Promise<void>): Promise<void> {
    if (this.task) throw new Error('Manual compaction is already running')
    const task = start()
    this.task = task
    try {
      onStarted()
      await onResult(await task.result())
    } catch (error) {
      try { task.abort() } catch { /* Preserve the operation's original error. */ }
      throw error
    } finally {
      this.task = null
    }
  }
}
