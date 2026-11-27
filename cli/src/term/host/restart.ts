import type { Agent } from '../../native/index.js'
import { RESTART_WAIT_TEXT, type RestartReply, type RestartRequest, type RestartStatus, type RestartWait, type WindowControl } from '../../features/restart/protocol.js'
import { stateDir } from '../../update/paths.js'
import { errorText } from '../../ui/format.js'
import type { PendingImages } from '../app/composer/pending-images.js'
import { currentQueueTarget, type PendingQueue } from '../app/queue/pending-queue.js'
import type { QueueLifecycle } from '../app/queue/queue-lifecycle.js'
import { composerSnapshot, RESTART_CHECKPOINT_VERSION, savedDraft, type RestartCheckpoint } from '../app/restart/checkpoint.js'
import { RESTART_CHECKPOINT_ENV, writeRestartCheckpoint, type TakenCheckpoint } from '../app/restart/checkpoint-file.js'
import { restartWait, type RestartFacts } from '../app/restart/policy.js'
import { resolveRunInteraction } from '../app/run/run-interaction.js'
import type { ManualCompaction } from '../app/run/manual-compaction.js'
import { isEditorEmpty } from '../input/editor.js'
import type { TermRenderer } from '../screen/renderer.js'
import type { ComposerController } from './composer.js'
import type { RemoteController } from './remote.js'
import type { RunController } from './run.js'
import type { ScrollbackController } from './scrollback.js'
import type { ReplState } from './state.js'

export interface RestartDeps {
  readonly agent: Pick<Agent, 'pendingProcessWakeNotifications'>
  /** Which binary this process runs, relative to the installed one. */
  readonly installedBuild: { canRestartInPlace(): boolean; outdated(): boolean | null }
  readonly composer: Pick<ComposerController, 'snapshot' | 'restore'>
  readonly manualCompaction: Pick<ManualCompaction, 'active'>
  readonly pendingImages: Pick<PendingImages, 'awaiting'>
  readonly pendingQueue: PendingQueue
  readonly queueLifecycle: Pick<QueueLifecycle, 'dispatchNext'>
  readonly remoteCtl: Pick<RemoteController, 'handoff' | 'resume'>
  readonly renderer: Pick<TermRenderer, 'requestRender'>
  readonly runCtl: Pick<RunController, 'runInteractionInput'>
  readonly scrollback: Pick<ScrollbackController, 'commitSystem'>
  /** Tear down and exec the installed binary with `handoff` added to its environment. */
  readonly restartAfterCleanup: (handoff?: Record<string, string>) => void
}

export type RestartCommand = 'safe' | 'now' | 'cancel'
const POLL_MS = 500
// Long enough for a peer's HTTP reply to leave before cleanup closes the socket.
const HANDOVER_DELAY_MS = 100

/**
 * One restart capability per evot process. `/restart` in this terminal and a
 * request from another of this user's processes (`evot restart`) share it.
 * A safe restart waits until nothing that lives only in this process would be
 * lost, then carries the conversation, composer, queue and Remote role to the
 * installed binary. `/restart now` is the local escape hatch for a stuck session.
 */
export function createRestartController(st: ReplState, deps: RestartDeps) {
  const notice = (text: string) => {
    deps.scrollback.commitSystem('sys-restart', `  ${text}`)
    deps.renderer.requestRender()
  }

  function facts(): RestartFacts {
    const session = st.sessionId
    let undeliveredResults = 0
    try { undeliveredResults = session ? deps.agent.pendingProcessWakeNotifications(session) : 0 } catch { undeliveredResults = 1 }
    return {
      interaction: deps.manualCompaction.active ? 'compacting' : resolveRunInteraction(deps.runCtl.runInteractionInput()).kind,
      question: st.pendingAsk !== null || st.pendingTaskModel !== null,
      undeliveredResults,
      queueBusy: st.queueDispatchId !== null || st.pendingEnqueue !== null || deps.pendingImages.awaiting
        || st.queueEditState !== null || st.pendingQueue.blocked,
      local: st.logMode !== null || st.overlay.kind !== 'none' || st.foregroundCommand !== null || st.loginInFlight
        || st.revocationCleanup !== null || st.remoteOpening,
    }
  }
  const waitingFor = (): RestartWait | null => restartWait(facts())

  function status(): RestartStatus {
    const wait = st.restartPending && !st.restarting ? waitingFor() : null
    return {
      pid: process.pid, session: st.sessionId, terminal: st.terminalBus?.id ?? '', outdated: deps.installedBuild.outdated(),
      restart: st.restarting ? 'restarting' : st.restartPending ? 'pending' : 'none',
      ...(st.serviceHost?.controller.owner ? {hosting:true as const} : {}),
      ...(wait ? { waitingFor: wait } : {}),
    }
  }
  const reply = (accepted: boolean, message: string): RestartReply => ({ accepted, message, status: status() })

  function stopPoll() {
    if (st.restartPoll) clearInterval(st.restartPoll)
    st.restartPoll = null
  }
  function startPoll() {
    if (st.restartPoll) return
    st.restartPoll = setInterval(() => {
      if (st.restartPending && !st.restarting && waitingFor() === null) begin()
    }, POLL_MS)
    st.restartPoll.unref?.()
  }

  function capture(mode: 'safe' | 'now'): { checkpoint: RestartCheckpoint; carried: ReturnType<PendingQueue['visible']> } {
    // A log fork's queue belongs to the fork, which the next image does not reopen.
    const carried = st.logMode ? [] : deps.pendingQueue.visible(currentQueueTarget(st)).filter(entry => !entry.native)
    const composer = deps.composer.snapshot()
    return {
      carried,
      checkpoint: {
        version: RESTART_CHECKPOINT_VERSION,
        session: st.sessionId,
        remote: deps.remoteCtl.handoff(),
        draft: composer.text || composer.images.length ? savedDraft(composer) : null,
        queue: carried.map(entry => ({
          queue: entry.queue, text: entry.text, expandedText: entry.expandedText,
          // An immediate restart interrupts the run these were waiting on; hold them for the user.
          paused: entry.paused || mode === 'now', draft: savedDraft(entry.snapshot),
          ...(entry.contentJson !== undefined ? { contentJson: entry.contentJson } : {}),
          ...(entry.phoneDraftId !== undefined ? { phoneDraftId: entry.phoneDraftId } : {}),
        })),
      },
    }
  }

  function perform(mode: 'safe' | 'now') {
    if (st.destroyed || !st.restarting) return
    if (mode === 'safe' && waitingFor() !== null) {
      // Work started in the handover gap; wait for the next safe moment instead.
      st.restarting = false
      startPoll()
      return
    }
    stopPoll()
    const handoff: Record<string, string> = {}
    if (deps.installedBuild.canRestartInPlace()) {
      try {
        const { checkpoint, carried } = capture(mode)
        handoff[RESTART_CHECKPOINT_ENV] = writeRestartCheckpoint(stateDir(), checkpoint)
        // Saved for the next image; this one must not report them as discarded.
        for (const entry of carried) deps.pendingQueue.remove(entry, entry.version)
      } catch (error) {
        if (mode === 'safe') {
          st.restarting = st.restartPending = false
          notice(`Restart cancelled: could not save the composer and queue (${errorText(error)}).`)
          deps.queueLifecycle.dispatchNext()
          return
        }
      }
    }
    deps.restartAfterCleanup(handoff)
  }

  function begin() {
    if (st.restarting) return
    st.restarting = true
    setTimeout(() => perform('safe'), HANDOVER_DELAY_MS).unref?.()
  }

  function requestSafe(fromPeer: boolean): RestartReply {
    if (st.restarting) return reply(true, 'Already restarting.')
    if (!deps.installedBuild.canRestartInPlace()) return reply(false, 'This window did not start from an installed evot, so it cannot restart in place.')
    const wait = waitingFor()
    const scheduled = st.restartPending
    st.restartPending = true
    if (wait === null) {
      begin()
      return reply(true, 'Restarting now.')
    }
    startPoll()
    const message = `Restart scheduled after ${RESTART_WAIT_TEXT[wait]}.`
    if (!scheduled) notice(`${message}${fromPeer ? ' Requested with evot restart.' : ''} /restart cancel keeps this version.`)
    return reply(true, message)
  }

  function cancel(): RestartReply {
    if (!st.restartPending && !st.restarting) return reply(false, 'No restart is scheduled.')
    st.restartPending = st.restarting = false
    stopPoll()
    notice('Restart cancelled; this window stays on its current version.')
    deps.queueLifecycle.dispatchNext()
    return reply(true, 'Restart cancelled.')
  }

  function command(mode: RestartCommand) {
    if (mode === 'cancel') { cancel(); return }
    if (mode === 'now') {
      st.restartPending = st.restarting = true
      perform('now')
      return
    }
    const result = requestSafe(false)
    if (!result.accepted) notice(`${result.message} Use /restart now to exit and start it again.`)
  }

  /** While a safe restart is due, queued messages wait for the next image. */
  function holdsQueue(): boolean {
    return st.restarting || (st.restartPending && waitingFor() === null)
  }

  /** The first thing a restarted process does with what the old image handed over.
   * Remote identity is already registered; this restores the composer and queue
   * and brings the gateway back. */
  function restore({ checkpoint, error }: TakenCheckpoint) {
    if (error) notice(`Restart: ${error}`)
    if (!checkpoint) return
    const parts: string[] = []
    if (checkpoint.draft && isEditorEmpty(st.editor)) {
      deps.composer.restore(composerSnapshot(checkpoint.draft), true)
      parts.push('the draft')
    }
    // Only the same conversation continues on its own; anything else waits for the user.
    const same = checkpoint.session === st.sessionId
    const restored = deps.pendingQueue.restore(currentQueueTarget(st), checkpoint.queue.map(prompt => ({
      queue: prompt.queue, text: prompt.text, expandedText: prompt.expandedText, snapshot: composerSnapshot(prompt.draft),
      paused: prompt.paused || !same,
      ...(prompt.contentJson !== undefined ? { contentJson: prompt.contentJson } : {}),
      ...(prompt.phoneDraftId !== undefined ? { phoneDraftId: prompt.phoneDraftId } : {}),
    })))
    if (restored.length) parts.push(`${restored.length} queued message${restored.length === 1 ? '' : 's'}`)
    notice(`Restarted on the installed build${parts.length ? ` · restored ${parts.join(' and ')}` : ''}.`)
    void deps.remoteCtl.resume(checkpoint.remote)
    deps.queueLifecycle.dispatchNext()
  }

  const control: WindowControl = {
    status,
    request: (request: RestartRequest) => request.action === 'cancel' ? cancel() : requestSafe(true),
  }
  return { command, holdsQueue, restore, control, dispose: stopPoll }
}
export type RestartController = ReturnType<typeof createRestartController>
