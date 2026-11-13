import type { ComputeSession } from '../../features/compute/session.js'
import { HOST_TOOL_SPECS_JSON, type HostToolExtension, composeExtensions, dispatchHostToolCall } from '../../features/host-tools.js'
import type { LoopSession } from '../../features/loop/session.js'
import type { TaskSession } from '../../features/task/session.js'
import { isHostToolEvent } from '../../native/contracts/query-event.js'
import type { Agent, QueryStream } from '../../native/index.js'
import type { RunThinking } from '../../render/run-thinking.js'
import type { CloudSessionSync } from '../../session/cloud-sessions.js'
import type { SessionHook } from '../../session/hook.js'
import type { ShareNotices } from '../../session/share-notices.js'
import type { BackgroundTerminals } from '../app/background/background-terminals.js'
import type { PrivacyFeed } from '../app/privacy-feed.js'
import type { ManualCompaction } from '../app/run/manual-compaction.js'
import type { RunInteraction, RunInteractionInput } from '../app/run/run-interaction.js'
import type { RunOwnership } from '../app/run/run-ownership.js'
import { createStreamMachineState, flushStreaming, reduceRunEvent } from '../app/run/stream.js'
import type { SuggestionContext } from '../app/suggestion/context.js'
import type { PromptSuggestion, TaskWaitSuggestion } from '../app/suggestion/index.js'
import type { RendererTrace } from '../diagnostics/renderer-trace.js'
import type { ScreenLog } from '../diagnostics/screen-log.js'
import type { GitInfoProvider } from '../git-info.js'
import type { AskController } from './ask.js'
import type { CloudController } from './cloud.js'
import type { IdleController } from './idle.js'
import type { ScrollbackController } from './scrollback.js'
import type { SessionController } from './session.js'
import type { ReplState } from './state.js'
import type { SuggestController } from './suggest.js'
import { SPINNER_INTERVAL_MS, TITLE_INTERVAL_FRAMES } from './timing.js'
import type { Committer } from '../screen/committer.js'
import type { TermRenderer } from '../screen/renderer.js'
import { triggerAdSlot } from '../viewmodel/ad-slot.js'
import { blocksToLines, buildOutputBlocks } from '../viewmodel/index.js'
import { advanceSpinner, createSpinnerState } from '../widgets/spinner.js'
import { errorText } from '../../ui/format.js'

/** What this controller needs from the host. Looked up lazily on every use. */
export interface RunDeps {
  readonly agent: Agent
  readonly asks: AskController
  readonly backgroundTerminals: BackgroundTerminals
  readonly cloudCtl: CloudController
  readonly cloudSessions: CloudSessionSync
  readonly committer: Committer
  readonly computeSession: ComputeSession
  readonly gitInfo: GitInfoProvider
  readonly idle: IdleController
  readonly loopSession: LoopSession
  readonly manualCompaction: ManualCompaction
  readonly privacyFeed: PrivacyFeed
  readonly queueLifecycle: import('../app/queue/queue-lifecycle.js').QueueLifecycle
  readonly renderer: TermRenderer
  readonly rendererTrace: RendererTrace
  readonly runInteraction: RunInteraction
  readonly runOwnership: RunOwnership
  readonly runThinking: RunThinking
  readonly screenLog: ScreenLog
  readonly scrollback: ScrollbackController
  readonly sessionCtl: SessionController
  readonly sessionHook: SessionHook
  readonly setTerminalTitle: (suffix?: string | undefined, force?: boolean) => void
  readonly shareNotices: ShareNotices
  readonly suggest: SuggestController
  readonly suggestionContext: SuggestionContext
  readonly suggestions: PromptSuggestion
  readonly suggestionTaskWait: TaskWaitSuggestion
  readonly taskSession: TaskSession
}

export interface RunController {
  abandonRun(): void
  readonly beginRun: () => number
  interruptStream(id: string, text: string): void
  readonly ownsRun: (generation: number) => boolean
  runInteractionInput(): RunInteractionInput
  readonly runQuery: (text: string, contentJson?: string | undefined, prebuiltStream?: QueryStream | undefined, hostToolExtension?: HostToolExtension | undefined) => Promise<void>
  startSpinner(): void
  stopSpinner(): void
}

/** One agent run from submit to footer: ownership, the query stream, the spinner and interrupts. */
export function createRunController(st: ReplState, deps: RunDeps): RunController {
  function runInteractionInput(): RunInteractionInput {
    return {
      active: st.isLoading,
      owner: deps.manualCompaction.active ? deps.manualCompaction : st.isLoading ? deps.runOwnership.owner : null,
      phase: st.spinnerState.phase,
      compacting: deps.manualCompaction.active,
      localOperation: st.foregroundCommand !== null,
      foregroundTasks: deps.backgroundTerminals.foregroundCount(),
      blockingWaits: deps.backgroundTerminals.blockingWaitCount(),
      backgroundTasks: deps.backgroundTerminals.runningCount(),
      backgroundOwner: deps.backgroundTerminals.stopTarget(),
      backgroundStopping: deps.backgroundTerminals.isStopping(),
      loopParked: !st.isLoading && deps.loopSession.waiting,
      // The start timestamp identifies one loop: `/loop` again, or a stop and
      // restart, must not inherit an armed confirmation from the previous one.
      loopOwner: deps.loopSession.snapshot?.startedAt ?? null,
    }
  }
  const beginRun = (): number => {
    deps.suggestionContext.begin()
    deps.suggestions.cancelAutomatic()
    return deps.runOwnership.begin()
  }
  const ownsRun = (generation: number): boolean => deps.runOwnership.owns(generation)
  const revokeRun = (): void => {
    deps.suggestions.cancelAutomatic()
    deps.runOwnership.revoke()
    deps.taskSession.cancelSetup()
  }

  function startSpinner() {
    if (st.spinnerTimer) return
    st.titleFrame = 0
    st.spinnerTimer = setInterval(() => {
      st.spinnerState = advanceSpinner(st.spinnerState)
      if (deps.manualCompaction.active) {
        st.manualCompactionPhase = deps.manualCompaction.phase
        st.manualCompactionActivity = deps.manualCompaction.activity
      }
      if (st.streamMachine) {
        st.streamMachine = { ...st.streamMachine, spinnerState: st.spinnerState }
      }
      deps.renderer.requestRender()
      // Terminal title animation — update at ~960ms like Claude Code.
      if (st.spinnerState.frame % TITLE_INTERVAL_FRAMES === 0) {
        const glyphs = ['⠂', '⠐']
        const idx = st.titleFrame % glyphs.length
        st.titleFrame++
        deps.setTerminalTitle(glyphs[idx])
      }
    }, SPINNER_INTERVAL_MS)
  }

  function stopSpinner() {
    deps.runInteraction.clear()
    if (st.spinnerTimer) {
      clearInterval(st.spinnerTimer)
      st.spinnerTimer = null
    }
    // Always replace the final animated glyph. An ask overlay can keep the
    // title frozen while the run settles; normal title writes are correctly
    // blocked then, but the completed state must not remain stuck on ·/⠂/⠐.
    deps.setTerminalTitle(deps.idle.idleWaitTitle(), true)
  }

  async function runQuery(
    text: string,
    contentJson?: string,
    prebuiltStream?: QueryStream,
    hostToolExtension?: HostToolExtension,
  ) {
    if (deps.cloudCtl.queryBlockedByCloudLogin()) return
    if (st.pendingQueue.blocked) {
      prebuiltStream?.abort()
      deps.scrollback.commitSystem('sys-queue-blocked', '  Queue ownership unresolved; Ctrl+G to reconcile before starting work.')
      return
    }
    const startupTarget = st.sessionId ?? st.queueStartupTarget
    const queueChain = deps.queueLifecycle.begin(startupTarget)
    // Only a turn the loop itself launched is a loop run. A message the user
    // types while the loop is parked runs as an ordinary turn: the wakeup
    // timer keeps counting and the loop's reschedule contract does not apply.
    // The tool is still offered, so "make it hourly" or "stop the loop" said
    // in plain words takes effect now instead of at the next wakeup.
    const loopRun = deps.loopSession.runInFlight
    if (deps.loopSession.active) hostToolExtension = composeExtensions(hostToolExtension, deps.loopSession.extension)
    // Notification-only wakeups continue the same user task; don't hide its
    // newly completed background work when the engine reads the result.
    if (text || contentJson || prebuiltStream) deps.backgroundTerminals.beginRun()
    st.composerRevision++
    const generation = beginRun()
    st.runStartedAt = Date.now()
    st.runTurnCount = 0
    deps.runThinking.reset()
    st.liveContentMaxHeight = 0
    st.isLoading = true
    st.spinnerState = createSpinnerState()
    st.streamMachine = createStreamMachineState(st.appState, st.spinnerState)
    startSpinner()
    deps.renderer.requestRender()

    let completed = false
    let terminalError = false
    let finished = false
    try {
      const stream = prebuiltStream
        ?? await deps.agent.query(text, st.sessionId ?? undefined, 'interactive', contentJson, hostToolExtension?.specsJson ?? HOST_TOOL_SPECS_JSON)
      if (!ownsRun(generation)) {
        stream.abort()
        return
      }
      st.streamRef = stream
      st.sessionId = stream.sessionId ?? st.sessionId
      deps.queueLifecycle.started(stream, st.sessionId ?? undefined)
      if (st.pendingEnqueue?.target === startupTarget && st.pendingEnqueue.chain === queueChain) st.pendingEnqueue.target = st.sessionId
      if (st.sessionId) {
        deps.taskSession.bindFlowSession(st.sessionId, hostToolExtension)
        deps.computeSession.bindFlowSession(st.sessionId, hostToolExtension)
        deps.sessionHook.startSession(st.sessionId, deps.agent.cwd)
        // The query may have just persisted a formerly unbound first session,
        // and every run can change its title, turn count, and recency.
        deps.sessionCtl.invalidateResumeSessionCache()
      }
      st.appState = { ...st.appState, sessionId: st.sessionId }
      deps.screenLog.bind(stream.sessionId)
      deps.rendererTrace.bind(stream.sessionId)

      for await (const event of stream) {
        if (st.destroyed || !ownsRun(generation)) break
        if (!st.streamMachine) break

        if (isHostToolEvent(event)) {
          deps.suggestions.cancelAutomatic()
          const response = await dispatchHostToolCall(
            event.payload,
            deps.asks.collectAskUserAnswers,
            hostToolExtension,
          )
          // A cancelled ask_user aborts an in-progress edit. Do not route the
          // next ordinary prompt back into a flow the user dismissed.
          if (hostToolExtension && /^(ask_user|AskUser)$/i.test(event.payload.tool_name)
              && response.content.some(part =>
            (response.is_error && part.text === 'User cancelled the question.')
            || /→ Cancel(?:\n|$)/.test(part.text))) {
            deps.taskSession.cancelFlow()
            deps.computeSession.cancelFlow()
          }
          if (ownsRun(generation)) await stream.respondHostTool(JSON.stringify(response))
          continue
        }

        if (event.kind === 'run_started') {
          deps.sessionHook.startSession(event.session_id, deps.agent.cwd)
          deps.sessionHook.runStarted(event.run_id)
        } else if (event.kind === 'run_finished') {
          finished = true
          deps.sessionHook.runFinished(event.run_id)
        } else if (event.kind === 'error') {
          terminalError = true
          deps.sessionHook.runFailed(event.run_id, String(event.payload?.message ?? ''))
        }

        deps.runThinking.observe(event)
        const update = reduceRunEvent(st.streamMachine!, event, {
          termRows: deps.renderer.termRows,
          cloudProvider: deps.cloudCtl.activeProviderIsCloud(),
          privacyDetail: () => deps.privacyFeed.lastBlocked(st.sessionId),
        })

        st.streamMachine = update.state
        st.appState = update.state.appState
        deps.suggestionContext.observe(event)
        st.spinnerState = update.state.spinnerState
        if (['turn_started', 'error', 'llm_call_retry', 'quota_waiting', 'outage_waiting', 'context_compaction_started'].includes(event.kind)) deps.suggestions.cancelAutomatic()
        if (update.sessionRevoked) deps.cloudCtl.handleCloudSessionRevoked()
        deps.shareNotices.record(st.sessionId, update.noticeLines)

        // Git commands run inside tool subprocesses. Refresh synchronously when
        // any tool settles instead of waiting for the debounced HEAD watcher;
        // otherwise the completed answer can still render the previous branch.
        if (event.kind === 'tool_finished') deps.gitInfo.refresh()

        // Request re-render on each delta so streaming text appears
        if (event.kind === 'assistant_delta') {
          deps.renderer.requestRender()
        }

        if (update.commitLines.length > 0) {
          if (update.expandedCommitLines) {
            // Dual-commit: compact in compactLines, expanded in expandedLines
            const compact = update.commitLines
            const exp = update.expandedCommitLines
            deps.committer.commitDual(compact, exp)
          } else {
            deps.committer.commitDual(update.commitLines, update.commitLines)
          }
        }
        // After this step's own lines, so a masked request's card follows the
        // text it produced rather than splitting it.
        if (['llm_call_completed', 'tool_finished', 'run_finished', 'error'].includes(event.kind)) deps.scrollback.commitPrivacyHappenings()

        // Reconcile against the native queue instead of draining the visible
        // copy wholesale: OneAtATime mode may consume only the first of several
        // queued prompts at this boundary.
        if (event.kind === 'turn_started') {
          st.runTurnCount++
          deps.queueLifecycle.reconcile()
        }

        // writeLines are log-only: LLM/COMPACT/SPILL stats that don't render in
        // the TUI. Run them through the same formatting pipeline so screen.log
        // still captures the observability detail for post-hoc debug.
        if (update.writeLines.length > 0) {
          const blocks = buildOutputBlocks(update.writeLines, { columns: deps.renderer.termCols })
          const rendered = blocksToLines(blocks)
          deps.screenLog.logLines(rendered)
        }

        if (update.rerenderStatus) deps.renderer.requestRender()
      }

      if (!ownsRun(generation)) return
      if (st.streamMachine) {
        const final = flushStreaming(st.streamMachine)
        st.streamMachine = final.state
        st.appState = final.state.appState
        deps.scrollback.commitFlushResult(final)
      }
      // Safety net: commit only prompts the engine actually consumed. A prompt
      // queued during the final poll can still be pending when the run settles.
      deps.queueLifecycle.reconcile()
      completed = finished && !terminalError
    } catch (err) {
      // An interrupted run is expected to reject after its ownership has been
      // revoked. Its interruption notice was already committed synchronously;
      // touching shared state here could flush or clear a newer run.
      if (!ownsRun(generation)) return
      if (st.streamMachine) {
        const final = flushStreaming(st.streamMachine)
        st.streamMachine = final.state
        deps.scrollback.commitFlushResult(final)
      }
      const message = errorText(err)
      deps.suggestionContext.fail()
      deps.scrollback.commitSystem('sys-err', message, 'error')
      deps.sessionHook.runFailed(undefined, message)
      deps.queueLifecycle.reconcile()
    } finally {
      if (ownsRun(generation)) {
        // Safety net for a run that ended without run_finished/error (e.g. the
        // stream just stopped). No-op when the run already settled above.
        deps.sessionHook.settleRun()
        deps.idle.unfreezeTerminalTitle()
        deps.queueLifecycle.settled(st.streamRef, queueChain, completed)
        st.streamRef = null
        st.isLoading = false
        st.streamMachine = null
        stopSpinner()
        // The run no longer holds a wait; do not leave its suggestion until the next poll.
        deps.suggestionTaskWait.sync(false)
        if (!completed) deps.suggestions.cancelAutomatic()
        if (loopRun) deps.loopSession.endRun(completed ? 'ok' : 'error')
        else if (completed && deps.suggestionContext.hasAnswer) deps.suggest.requestProductSuggestion('answer')
        deps.scrollback.commitRunFooter()
        if (deps.taskSession.unfinishedFlow(hostToolExtension)) {
          deps.scrollback.commitSystem('sys-task-incomplete', '  Task change not saved yet · reply to continue editing, or /task cancel')
        }
        if (deps.computeSession.unfinishedFlow(hostToolExtension)) {
          deps.scrollback.commitSystem('sys-compute-incomplete', '  Compute change not saved yet · reply to continue, or /compute cancel')
        }
        // Fresh ads/models belong in the background: awaiting the catalog here
        // stalled the prompt for the whole HTTP round-trip after every turn.
        void deps.cloudCtl.syncCloudNow(true)
        if (st.sessionId) deps.cloudSessions.schedulePush(st.sessionId)
        triggerAdSlot(st.adSlot, Date.now())
        deps.renderer.requestRender()
        deps.queueLifecycle.dispatchNext()
      }
    }

    if (!ownsRun(generation) || !completed) return

    // Final metadata is saved as the stream settles. Force the next /resume to
    // observe those values even if some background consumer repopulated a
    // snapshot while the run was active.
    deps.sessionCtl.invalidateResumeSessionCache()
  }

  /** Stop the current run before leaving its session (`/new`, `/clear`).
   *  A run may still be waiting for `agent.query` to return its stream, e.g.
   *  a background-task wake on a long session. Revoking it is what keeps that
   *  stream, once it arrives, from rebinding the old session and writing its
   *  snapshot of the old state (title, share badge) back over the new one. */
  function abandonRun() {
    st.pendingEnqueue = null
    if (!st.isLoading) return
    revokeRun()
    deps.manualCompaction.abort()
    const interruptedStream = st.streamRef
    interruptedStream?.abort()
    deps.queueLifecycle.pause(interruptedStream)
    st.streamRef = null
    st.isLoading = false
    flushStreamContent()
    st.streamMachine = null
    stopSpinner()
    st.runStartedAt = null
  }

  /** Flush any in-progress streaming content to committed output.
   *  Call before clearing streaming state on any abort/cancel path. */
  function flushStreamContent() {
    // Flush anything the stream machine accumulated
    if (!st.streamMachine) return
    const flushed = flushStreaming(st.streamMachine)
    st.streamMachine = flushed.state
    deps.scrollback.commitFlushResult(flushed)
  }

  function interruptStream(id: string, text: string) {
    deps.suggestionContext.interrupt()
    deps.idle.unfreezeTerminalTitle()
    // Revoke ownership before aborting: native abort settles asynchronously,
    // and its rejected Promise must not later emit a second Interrupted/error
    // or clear a newer query that the user starts immediately afterward.
    revokeRun()
    // Esc cancels this turn, not the recurring task. Only an explicit loop
    // stop (or confirmed Esc while parked) should cancel future wakeups.
    deps.loopSession.endRun('interrupted')
    if (deps.loopSession.active) text += ' Loop remains active; /loop stop to stop.'
    // If an interactive host-tool overlay is awaiting, resolve it as cancelled
    // so the suspended dispatch in runQuery unblocks instead of hanging the
    // run loop forever.
    deps.asks.resolvePendingAsk()
    deps.asks.resolvePendingTaskModel()
    const interruptedStream = st.streamRef
    interruptedStream?.abort()
    deps.queueLifecycle.pause(interruptedStream)
    st.streamRef = null
    st.isLoading = false
    flushStreamContent()
    st.streamMachine = null
    stopSpinner()
    // Unconsumed work stays paused and individually recoverable with Shift+Up.
    // The transcript has no record of a user-side interrupt, so this line is
    // captured as a client notice and survives into a shared session.
    deps.committer.commitNotice([{ id, kind: 'cancelled', text }])
    deps.scrollback.commitRunFooter()
    deps.backgroundTerminals.parkUntilBackground()
    deps.sessionHook.settleRun()
  }

  return { abandonRun, beginRun, interruptStream, ownsRun, runInteractionInput, runQuery, startSpinner, stopSpinner }
}
