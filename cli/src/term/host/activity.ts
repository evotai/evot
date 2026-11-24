import type { LoopSession } from '../../features/loop/session.js'
import type { UIToolCall } from '../../render/message-types.js'
import { assistantToolCalls } from '../app/run/assistant-content.js'
import type { ManualCompaction } from '../app/run/manual-compaction.js'
import type { RunInteraction, RunInteractionInput } from '../app/run/run-interaction.js'
import type { AwaitedTasks } from '../viewmodel/run-status.js'
import { compactionToolName, spinnerStatsFromLastUsage } from '../widgets/spinner.js'
import type { ReplState } from './state.js'

export interface ActivityDeps {
  readonly awaitedTaskSummary: (calls: UIToolCall[]) => AwaitedTasks | undefined
  readonly loopSession: LoopSession
  readonly manualCompaction: ManualCompaction
  readonly runInteraction: RunInteraction
  readonly runInteractionInput: () => RunInteractionInput
}

/** One source for both status bars. Gating editing, stopping or answering is a
 * different concern: a selector on the Mac must not turn Thinking into Busy. */
export function createActivityController(st: ReplState, deps: ActivityDeps) {
  function current() {
    if (st.overlay.kind === 'ask-user') return null
    const interaction = () => deps.runInteraction.snapshot(deps.runInteractionInput())
    if (st.isLoading) {
      const calls = assistantToolCalls(st.streamMachine?.appState.currentAssistantContent ?? [])
      const usagePending = st.streamMachine?.activeLlmCall ?? false
      const state = deps.manualCompaction.active ? {...st.spinnerState, toolName:compactionToolName(st.manualCompactionPhase,st.manualCompactionActivity)} : st.spinnerState
      const stats = deps.manualCompaction.active || st.foregroundCommand ? undefined : spinnerStatsFromLastUsage(st.appState.currentRunStats.lastLlmUsage,
        usagePending && !calls.length ? state.tokenCount : 0, usagePending)
      return {kind:'spinner' as const,state,stats, options:{interaction:interaction(),awaitedTasks:deps.awaitedTaskSummary(calls)}}
    }
    if (deps.loopSession.waiting) {
      const wait = deps.loopSession.waitRemaining()
      return wait ? {kind:'loop' as const,wait:{...wait,stopPending:interaction().interruptPending}} : null
    }
    if (st.backgroundWaitSince !== null) return {kind:'spinner' as const, state:{...st.backgroundWaitSpinner,phaseStartedAt:st.backgroundWaitSince}, stats:undefined, options:{interaction:interaction(),hideInteractionHint:true}}
    return null
  }
  return { current }
}
export type ActivityController = ReturnType<typeof createActivityController>
