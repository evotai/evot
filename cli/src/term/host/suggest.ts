import type { LoopSession } from '../../features/loop/session.js'
import { formatModelOptionLabel, modelOptions } from '../../features/models/options.js'
import type { Agent } from '../../native/index.js'
import type { BackgroundTerminals } from '../app/background/background-terminals.js'
import { type ComposerGuidance, type SuggestionTrigger, resolveComposerGuidance } from '../app/composer/composer-guidance.js'
import type { PendingImages } from '../app/composer/pending-images.js'
import type { RunInteraction, RunInteractionInput } from '../app/run/run-interaction.js'
import type { ResumeSessionCache } from '../app/session/resume-cache.js'
import { activeWork } from '../app/suggestion/activities.js'
import type { CommandInventory } from '../app/suggestion/arguments.js'
import type { WorkflowRuntime } from '../app/suggestion/context.js'
import type { PromptSuggestion } from '../app/suggestion/index.js'
import type { ReplState } from './state.js'

/** What this controller needs from the host. Looked up lazily on every use. */
export interface SuggestDeps {
  readonly agent: Agent
  readonly backgroundTerminals: BackgroundTerminals
  readonly loopSession: LoopSession
  readonly pendingImages: PendingImages
  readonly resumeCache: ResumeSessionCache
  readonly runInteraction: RunInteraction
  readonly runInteractionInput: () => RunInteractionInput
  readonly suggestions: PromptSuggestion
}

export interface SuggestController {
  automaticSuggestionEligible(): boolean
  composerPolicy(): ComposerGuidance
  liveWorkflowRuntime(): WorkflowRuntime
  requestProductSuggestion(trigger: SuggestionTrigger): void
  suggestionInputReady(): boolean
  suggestionInventory(): CommandInventory
}

/** Policy inputs for inline suggestions: composer guidance, eligibility, command inventory, live workflow facts. */
export function createSuggestController(st: ReplState, deps: SuggestDeps): SuggestController {
  function composerPolicy() {
    const interaction = deps.runInteraction.snapshot(deps.runInteractionInput())
    return resolveComposerGuidance({ interaction,
      mode: st.logMode ? 'log' : 'normal',
      queuedCount: st.queuedUserMessages.length + st.queuedCompactionSubmissions.length })
  }
  // Explicit Tab can wait for referenced image bytes without blocking input.
  // A submit already parked on an image load still owns the composer.
  function suggestionInputReady(): boolean {
    return st.suggestionsReady && !st.destroyed && st.overlay.kind === 'none' && !st.commandWindowPreview
      && !st.editor.completion && !deps.pendingImages.awaiting
  }
  function automaticSuggestionEligible(): boolean {
    // Run interaction distinguishes active work from a blocking tool wait;
    // isLoading alone cannot, since both still own the same agent turn.
    // A loop between its timer and its run is neither parked nor waiting.
    return (st.isLoading || !deps.loopSession.active || deps.loopSession.waiting) && composerPolicy().allowSuggestion
  }
  function suggestionInventory(): CommandInventory {
    return {
      models: modelOptions(st.configInfo, deps.agent.model).map(model => ({ value: model.spec, label: formatModelOptionLabel(model) })),
      sessions: (deps.resumeCache.metadata ?? []).filter(session => session.session_id !== st.sessionId)
        .map(session => ({ value: session.session_id, label: session.title || session.session_id })),
    }
  }
  function requestProductSuggestion(trigger: SuggestionTrigger): void {
    if (!st.suggestionsReady) { st.startupSuggestion = trigger; return }
    deps.suggestions.start(trigger)
  }

  /** Runtime facts as the suggestion layer sees them; also recorded as the
   * stage a user acted from, so the trajectory carries real transitions. */
  function liveWorkflowRuntime(): WorkflowRuntime {
    const background = deps.backgroundTerminals.runningProcesses()
    const loop = deps.loopSession.snapshot
    const toolWait = st.isLoading && deps.runInteraction.snapshot(deps.runInteractionInput()).kind === 'waiting-task'
    return {
      toolWait,
      execution: st.isLoading ? (toolWait ? 'waiting'
        : ['retrying', 'quota_waiting', 'outage_waiting'].includes(st.spinnerState.phase) ? 'retrying' : 'running')
        : loop?.active || background.length > 0 ? 'waiting' : 'idle',
      mode: st.logMode ? 'log' : 'normal',
      queued: st.queuedUserMessages.length + st.queuedCompactionSubmissions.length,
      background: background.length,
      activities: activeWork(background, loop, deps.loopSession.runInFlight),
    }
  }

  return { automaticSuggestionEligible, composerPolicy, liveWorkflowRuntime, requestProductSuggestion, suggestionInputReady, suggestionInventory }
}
