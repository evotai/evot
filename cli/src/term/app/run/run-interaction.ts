import type { SpinnerPhase } from '../../widgets/spinner.js'
import { InterruptConfirmation } from './interrupt-confirmation.js'

/** Runtime facts, not a second copy of engine or process state. */
export interface RunInteractionInput {
  active: boolean
  owner: unknown
  phase?: SpinnerPhase
  localOperation?: boolean
  compacting?: boolean
  foregroundTasks?: number
  blockingWaits?: number
  backgroundTasks?: number
  backgroundOwner?: string | null
  backgroundStopping?: boolean
  /**
   * A loop is parked between wakeups with no turn running. Esc then stops the
   * loop, behind the same two-press confirmation as every other interrupt: a
   * stray Esc must not silently end hours of scheduled work.
   */
  loopParked?: boolean
  /** Identity of the parked loop, so a restarted loop starts a fresh window. */
  loopOwner?: unknown
}

export interface RunInteractionState {
  kind: 'idle' | 'active' | 'waiting-task' | 'waiting-background' | 'waiting-loop' | 'retrying' | 'local-operation' | 'compacting'
  interruptTarget: 'agent' | 'compaction' | 'background' | 'loop' | null
  backgroundAction: 'background-shell' | 'release-wait' | null
  interruptPending: boolean
  backgroundTasks?: number
  backgroundStopping?: boolean
  showUsage: boolean
  allowSlowWarning: boolean
}

/** One capability policy shared by key routing and status presentation. */
export function resolveRunInteraction(input: RunInteractionInput): RunInteractionState {
  // A parked loop outranks a background task on the idle side: the loop's
  // badge already owns the Esc hint, and stopping the loop is the gesture it
  // advertises. Background tasks keep their ctrl+b / panel routes.
  const kind: RunInteractionState['kind'] = !input.active
    ? input.loopParked ? 'waiting-loop'
    : (input.backgroundTasks ?? 0) > 0 ? 'waiting-background' : 'idle'
    : input.compacting ? 'compacting'
    : input.localOperation ? 'local-operation'
    : (input.foregroundTasks ?? 0) === 0 && (input.blockingWaits ?? 0) > 0 ? 'waiting-task'
    : ['retrying', 'quota_waiting', 'outage_waiting'].includes(input.phase ?? '') ? 'retrying'
    : 'active'
  const owned = input.owner !== null && input.owner !== undefined
  const interruptTarget = kind === 'waiting-loop' ? 'loop'
    : kind === 'waiting-background'
    ? input.backgroundStopping ? null : 'background'
    : !owned || kind === 'idle' || kind === 'local-operation'
      ? null : kind === 'compacting' ? 'compaction' : 'agent'
  return {
    kind,
    interruptTarget,
    backgroundAction: interruptTarget !== 'agent' ? null
      : (input.foregroundTasks ?? 0) > 0 ? 'background-shell'
      : (input.blockingWaits ?? 0) > 0 ? 'release-wait' : null,
    interruptPending: false,
    backgroundTasks: input.backgroundTasks ?? 0,
    backgroundStopping: input.backgroundStopping ?? false,
    showUsage: kind === 'active',
    allowSlowWarning: kind === 'active' || kind === 'local-operation' || kind === 'compacting',
  }
}

/** Owns only the operation-scoped confirmation; side effects remain with the host. */
export class RunInteraction {
  private readonly confirmation: InterruptConfirmation
  private target: RunInteractionState['interruptTarget'] = null
  private owner: unknown = null
  constructor(now = Date.now) { this.confirmation = new InterruptConfirmation(now) }

  snapshot(input: RunInteractionInput): RunInteractionState {
    const state = resolveRunInteraction(input)
    const owner = state.interruptTarget === 'background' ? input.backgroundOwner
      : state.interruptTarget === 'loop' ? input.loopOwner
      : input.owner
    if (this.target !== state.interruptTarget || this.owner !== owner) this.confirmation.clear()
    this.target = state.interruptTarget
    this.owner = owner
    return { ...state, interruptPending: state.interruptTarget !== null && this.confirmation.pending(owner) }
  }

  requestInterrupt(input: RunInteractionInput): 'unavailable' | 'confirm' | 'interrupt' {
    if (this.snapshot(input).interruptTarget === null || this.owner == null) return 'unavailable'
    return this.confirmation.press(this.owner) ? 'interrupt' : 'confirm'
  }

  clear(): void { this.confirmation.clear() }
}
