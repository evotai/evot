import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { renderUnicodeCompact } from 'uqr'
import { REMOTE_USAGE } from '../../commands/index.js'
import { runSessionShare, type SessionShareContext, type SessionShareMode } from '../../commands/share.js'
import { getThemeScheme } from '../../ui/theme/index.js'
import { remoteHome, sharingScope } from '../../features/remote/transport.js'
import { approvePairing, manageGrants } from '../../features/remote/grants.js'
import { terminalInvite } from '../../features/remote/cloud-connect.js'
import { GatewayOccupied, openEnvironment } from '../../features/remote/environment.js'
import { gatewayPolicy, updateGatewayPolicy } from '../../features/remote/gateway-policy.js'
import { machineIdentity } from '../../features/remote/machine-identity.js'
import { worktreeReview } from '../../features/remote/worktree-review.js'
import { sessionLineTitle, shortenSessionCwd } from '../../session/resume.js'
import { profileKey, registerTerminal, validTerminal, type SessionBadge } from '../../features/remote/discovery.js'
import { phoneWorkspace } from '../../features/remote/workspace.js'
import { machineName } from '../../features/remote/machine-name.js'
import type { Agent } from '../../native/index.js'
import type { PromptSuggestion } from '../app/suggestion/controller.js'
import type { CloudSessionSync } from '../../session/cloud-sessions.js'
import type { ResumeSessionCache } from '../app/session/resume-cache.js'
import { currentQueueTarget, pendingEntryState, type PendingQueue } from '../app/queue/pending-queue.js'
import type { QueueLifecycle } from '../app/queue/queue-lifecycle.js'
import { PHONE_SHARE_USAGE, phoneCommandHints, phoneCommands, phoneSubmission } from '../app/remote/commands.js'
import { RECENT_SESSION_LIMIT } from '../../features/composer/command-arguments.js'
import { resolveRunInteraction } from '../app/run/run-interaction.js'
import type { SuggestController } from './suggest.js'
import { insertText, isEditorEmpty } from '../input/editor.js'
import { RemoteConflict, type RemoteAction, type RemoteSnapshot } from '../../features/remote/protocol.js'
import { errorText, formatElapsed, renderBar } from '../../ui/format.js'
import { layoutCommandNotice } from '../../ui/notice-layout.js'
import { createCommandOutput, type CommandOutputPort } from '../widgets/command-output.js'
import type { ActivityController } from './activity.js'
import { suggestionStatusText } from '../viewmodel/suggestion.js'
import { createSpinnerState, setSpinnerPhase, spinnerDescription } from '../widgets/spinner.js'
import { remoteModels } from '../app/remote/models.js'
import { assistantRow } from '../app/remote/conversation.js'
import { PARKED_CHECK_MS, canParkWindow, tmuxAttached, type ParkReason } from '../app/remote/parked-exit.js'
import type { BackgroundTerminals } from '../app/background/background-terminals.js'
import type { ComposerController } from './composer.js'
import type { PendingImages } from '../app/composer/pending-images.js'
import type { RunOwnership } from '../app/run/run-ownership.js'
import type { RendererTrace } from '../diagnostics/renderer-trace.js'
import type { ModelSelectionController } from './model-selection.js'
import type { AskController } from './ask.js'
import type { RunController } from './run.js'
import type { ScrollbackController } from './scrollback.js'
import type { ReplState } from './state.js'
import type { SubmitController } from './submit.js'
import type { RemoteHandoff } from '../app/restart/checkpoint.js'
import { handleVersionCommand, shareCommandOutput } from '../command-handlers.js'
import type { WindowControl } from '../../features/restart/protocol.js'

export interface RemoteDeps {
  readonly readAuthIdentity: () => string | null | undefined
  readonly outdatedBuild?: () => boolean | null
  /** A tmux window may be detached and unseen; it never takes the gateway on its own. */
  readonly insideTmux?: () => boolean
  /** Present when the paired service election controls starts. */
  readonly coordinatedHost?: boolean
  readonly backgroundTerminals: BackgroundTerminals
  readonly composer: ComposerController
  readonly activity: ActivityController
  readonly agent: Agent
  readonly suggestions: Pick<PromptSuggestion, 'text' | 'feedback' | 'completing' | 'replacing' | 'next' | 'complete'>
  readonly suggest: Pick<SuggestController, 'suggestionInputReady' | 'suggestionInventory'>
  readonly gitInfo: { getBranch(): string | null }
  readonly cloudSessions: Pick<CloudSessionSync, 'remoteFor' | 'forget'>
  readonly resumeCache: Pick<ResumeSessionCache, 'remove'>
  readonly modelSelection: ModelSelectionController
  readonly asks: AskController
  readonly pendingImages: PendingImages
  readonly pendingQueue: PendingQueue
  readonly queueLifecycle: QueueLifecycle
  readonly rendererTrace: RendererTrace
  readonly runCtl: RunController
  readonly runOwnership: RunOwnership
  readonly scrollback: ScrollbackController
  readonly submit: SubmitController
  /** Terminal rendering plus the share lifecycle used by both surfaces. */
  readonly replCommands: CommandOutputPort & Pick<SessionShareContext, 'flushShareNotices' | 'withShareChange' | 'cloudAcknowledged' | 'cloudForgotten'>
  readonly exitAfterCleanup: (code: number) => void
  /** Restart requests from this user's other evot processes, on the window's private socket. */
  readonly windowControl: WindowControl
}

/** `⋯ Remote  Installing cloudflared … ███░░  6.1 / 19.0 MB · 32% · 4s`, rewritten in place. */
export function remoteStatus(port: CommandOutputPort) {
  const line = createCommandOutput(port, 'remote').progress()
  const started = Date.now(), mb = (n: number) => (n / 1048576).toFixed(1)
  let text = '', bytes: { done: number; total: number } | undefined, finished = false
  const paint = () => {
    if (finished) return
    const ms = Date.now() - started
    const size = !bytes ? '' : bytes.total > 0
      ? `  ${renderBar(bytes.done, bytes.total, 20)}  ${mb(bytes.done)} / ${mb(bytes.total)} MB · ${Math.min(100, Math.floor(bytes.done / bytes.total * 100))}%`
      : ` · ${mb(bytes.done)} MB`
    line.update(layoutCommandNotice({ state: 'progress', label: 'Remote', message: `${text}${size}${ms >= 1000 ? ` · ${formatElapsed(ms)}` : ''}` }))
  }
  const timer = setInterval(paint, 1000)
  timer.unref?.()
  let lastBytesPaint = 0
  return {
    get active() { return !finished },
    phase(next: string, progress?: { done: number; total: number }) {
      if (finished) return
      const now = Date.now()
      text = next; bytes = progress
      // Download chunks arrive far faster than a terminal needs them.
      if (progress && progress.done < progress.total && now - lastBytesPaint < 100) return
      lastBytesPaint = now
      paint()
    },
    finish(state: 'success' | 'error' | 'info', message: string) {
      if (finished) return
      finished = true
      clearInterval(timer)
      line.finish(layoutCommandNotice({ state, label: 'Remote', message }))
    },
  }
}

const targetRevision = (target: string) => createHash('sha256').update(target).digest('hex')

export function createRemoteController(st: ReplState, deps: RemoteDeps) {
  // Before the first save, use the opening prompt pinned independently of the moving tail.
  // Saved/renamed titles take precedence; read this session only, single-flight, off the hot path.
  function sessionTitle(): string {
    const session = st.sessionId
    if (!session) { st.remoteTitle = null; return st.conversationTail.openingTitle || 'New conversation' }
    if (st.remoteTitle?.session !== session) {
      const meta = st.lastLineage.find(m => m.session_id === session) ?? st.preloadedSessions.find(m => m.session_id === session)
      st.remoteTitle = { session, title: meta ? sessionLineTitle(meta, '') : '', refreshAfter: 0 }
    }
    const entry = st.remoteTitle
    if (Date.now() >= entry.refreshAfter) {
      entry.refreshAfter = Infinity
      void deps.agent.findSession(session).then(meta => {
        if (meta?.session_id === session) entry.title = sessionLineTitle(meta, '')
      }).catch(() => { /* keep the last known title if storage is busy */ })
        .finally(() => { entry.refreshAfter = Date.now() + 3000 })
    }
    return entry.title || st.conversationTail.openingTitle || `Session ${session.slice(-8)}`
  }
  function snapshot(backgroundView?: string): RemoteSnapshot {
    if (st.logMode || st.destroyed) throw new RemoteConflict('Session no longer shared.')
    st.remoteWatchedAt = Date.now()
    const running = st.isLoading && !!st.streamMachine
    const q = st.overlay.kind === 'ask-user' ? st.overlay.state : null
    const ask = running && st.pendingAsk && q?.requestId ? { id: q.requestId, questions: q.questions } : null
    const local =
      st.overlay.kind !== 'none' ||
      st.foregroundCommand ||
      st.loginInFlight ||
      st.queueEditState ||
      st.pendingEnqueue ||
      deps.pendingImages.awaiting ||
      st.pendingQueue.blocked ||
      st.revocationCleanup ||
      st.cloudLoginRequired
    const input = local ? null : running ? 'steer' : !st.isLoading ? 'send' : null
    const activity = deps.activity.current()
    const interaction = activity?.kind === 'spinner' ? activity.options.interaction : resolveRunInteraction(deps.runCtl.runInteractionInput())
    const stopTarget = input === 'send' && interaction.interruptTarget === 'background' ? deps.backgroundTerminals.stopTarget() : null
    const description =
      activity?.kind === 'spinner'
        ? spinnerDescription(activity.state, Date.now(), activity.stats, activity.options)
        : null
    const status = ask
      ? 'Waiting for your answer'
      : description?.label ??
        (activity?.kind === 'loop'
          ? `Loop · wakes in ${activity.wait.label}`
          : !input
          ? 'Busy on the computer'
          : st.conversationTail.outcome ?? 'Ready')
    const live =
      st.streamMachine &&
      assistantRow(
        st.streamMachine.pendingSwitch?.content ?? st.streamMachine.appState.currentAssistantContent,
        st.expanded,
      )
    const canSuggest = !!input && isEditorEmpty(st.editor) && deps.suggest.suggestionInputReady()
    const shareSuggestion = canSuggest && !deps.suggestions.completing() && !deps.suggestions.replacing()
    const suggestionStatus = shareSuggestion ? deps.suggestions.feedback() : undefined
    const models = remoteModels(st.configInfo, st.appState.model, st.pendingModelHandoff)
    const entries = deps.pendingQueue.visible(currentQueueTarget(st))
    const pending = entries.filter(e => e.version === 1 && e.phoneDraftId)
    return {
      sessionId: st.sessionId,
      title: sessionTitle(),
      commands: input ? phoneCommands(st.skillEntries) : undefined,
      slashHints: input ? { catalog: phoneCommandHints(st.skillEntries), forked: st.lastLineage.length > 1,
        inventory: deps.suggest.suggestionInventory(RECENT_SESSION_LIMIT) } : undefined,
      // Only a next-prompt suggestion; a completion of the TUI's own half-typed draft stays local.
      suggestion: shareSuggestion ? deps.suggestions.text() || undefined : undefined,
      suggestionHint: suggestionStatus === 'quiet' ? 'no suggestion' : suggestionStatusText({ suggestionStatus }).trim() || undefined,
      place: { name: basename(deps.agent.cwd) || '/', path: shortenSessionCwd(deps.agent.cwd), host: machineName(), branch: deps.gitInfo.getBranch() },
      generation: deps.runOwnership.owner + st.remoteEpoch,
      status,
      models,
      composerKeys: {
        queue: input === 'steer',
        cycleEffort: !!input && !models.pending && !!models.options.find(o => o.spec === models.active)?.levels.length,
        suggest: canSuggest,
      },
      messageOffset: st.conversationTail.offset,
      messages: st.conversationTail.view(st.expanded),
      live: live?.text ?? '',
      liveBlocks: live?.blocks,
      active: !!activity || !!ask,
      statusDetail: description?.detail,
      expanded: st.expanded,
      background: deps.backgroundTerminals.presentation(backgroundView),
      promptQueue: entries.map(e => ({ state: pendingEntryState(e), ...(e.version === 1 && e.phoneDraftId ? {draftId:e.phoneDraftId} : {}) })),
      pendingDrafts: pending.map(e => e.phoneDraftId!),
      pendingSteers: pending.filter(e => e.queue === 'steering').map(e => e.phoneDraftId!),
      stopBackgroundTarget: stopTarget ? targetRevision(stopTarget) : undefined,
      input,
      canStop: running && (!local || !!ask),
      ask,
    }
  }

  async function shareCurrentSession(sid: string, mode: SessionShareMode, scope: string) {
    const epoch = ++st.remoteEpoch // A retry of the same admitted action must not apply again.
    st.foregroundCommand = 'share'
    st.isLoading = true
    st.spinnerState = setSpinnerPhase(createSpinnerState(), 'executing', 'session_share')
    const owner = deps.runOwnership.owner
    const inSession = () => !st.destroyed && !st.logMode && st.sessionId === sid && st.remoteEpoch === epoch && deps.runOwnership.owns(owner)
    const canReport = () => inSession() && currentScope() === scope
    try {
      deps.runCtl.startSpinner()
      deps.replCommands.requestRender()
      await runSessionShare({
        ...shareCommandOutput(deps.scrollback.commandOutput(deps.replCommands.requestRender, canReport)),
        agent: deps.agent,
        flushShareNotices: async () => {
          await deps.replCommands.flushShareNotices?.()
          if (!canReport()) throw new RemoteConflict('The session or account changed. Check and try again.')
        },
        withShareChange: deps.replCommands.withShareChange,
        cloudAcknowledged: deps.replCommands.cloudAcknowledged,
        cloudForgotten: deps.replCommands.cloudForgotten,
        requestRender: deps.replCommands.requestRender,
      }, sid, mode)
    } finally {
      if (st.foregroundCommand === 'share') st.foregroundCommand = null
      if (!st.destroyed && deps.runOwnership.owns(owner)) {
        st.isLoading = false
        deps.runCtl.stopSpinner()
        deps.replCommands.requestRender()
      }
      if (!st.destroyed) deps.queueLifecycle.dispatchNext()
    }
  }

  function act(action: RemoteAction): void {
    st.remoteWatchedAt = Date.now()
    const s = snapshot()
    if (s.generation !== action.generation) throw new RemoteConflict('The run changed. Refresh and try again.')
    if (action.kind === 'tool-view') {
      if (st.expanded !== action.expanded) deps.composer.toggleExpanded()
      return
    }
    if (action.kind === 'select-model' && (s.input || s.ask)) {
      const option = s.models.options.find((o) => o.spec === action.spec)
      if (
        !option ||
        s.models.revision !== action.revision ||
        (action.effort !== undefined && !option.levels.includes(action.effort))
      ) {
        throw new RemoteConflict('Model selection changed. Pick again from the current list.')
      }
      if (!deps.modelSelection.select(action.spec, action.effort))
        throw new RemoteConflict('Model switch failed. See the computer for details.')
      return
    }
    if (action.kind === 'answer' && s.ask?.id === action.id && deps.asks.answerRequest(action.id, action.answers))
      return
    if (action.kind === 'cancel-ask' && s.ask?.id === action.id) {
      deps.asks.handleAskKey({ type: 'escape' })
      return
    }
    if (action.kind === 'cycle-effort' && s.composerKeys?.cycleEffort && s.models.revision === action.revision) {
      if (!deps.composer.cycleThinkingLevel()) throw new RemoteConflict('Thinking level is no longer selectable.')
      return
    }
    if (action.kind === 'suggest' && s.composerKeys?.suggest) {
      if (!deps.suggestions.next()) deps.suggestions.complete('')
      return
    }
    if ((action.kind === 'pull-steer' || action.kind === 'pull-draft') && s.input &&
        (action.kind === 'pull-steer' ? s.pendingSteers?.at(-1) : s.promptQueue?.at(-1)?.draftId) === action.draftId) {
      const entry = deps.pendingQueue.visible(currentQueueTarget(st)).find(e => e.phoneDraftId === action.draftId)
      if (!entry) throw new RemoteConflict('Message is no longer pending.')
      try { deps.pendingQueue.remove(entry, 1) } // native compare-and-remove can still lose to consumption
      catch { deps.queueLifecycle.reconcile(); throw new RemoteConflict('Message changed or was already sent.') }
      deps.replCommands.requestRender()
      return
    }
    if (action.kind === 'stop-background' && action.target === s.stopBackgroundTarget) {
      // As for the TUI's confirmed Esc: reread before stopping, never include a replacement task.
      deps.backgroundTerminals.refresh(false)
      const target = deps.backgroundTerminals.stopTarget()
      if (!target || targetRevision(target) !== action.target) throw new RemoteConflict('The background tasks changed. Check again.')
      deps.backgroundTerminals.stopAll(target)
      return
    }
    if (s.canStop && ((action.kind === 'interrupt-ask' && s.ask?.id === action.id) ||
        (action.kind === 'stop' && (action.askId === undefined || action.askId === s.ask?.id)))) {
      if (s.ask) {
        st.overlay = { kind: 'none' }
        deps.runCtl.interruptStream('sys-ask-cancel', '  ⏺ Cancelled.')
      } else deps.runCtl.interruptStream('sys-remote-stop', '  Interrupted from phone.')
      return
    }
    if (((action.kind === 'send' || action.kind === 'steer') && action.kind === s.input) || (action.kind === 'queue' && s.composerKeys?.queue)) {
      if (action.kind !== 'send' && action.draftId && st.pendingQueue.entries.some(e => e.phoneDraftId === action.draftId))
        throw new RemoteConflict('This message is already pending.')
      const submission = phoneSubmission(action.text, st.skillEntries, action.kind !== 'send', !!action.images?.length)
      if (submission.kind === 'version') {
        handleVersionCommand(deps.scrollback.commandOutput(deps.replCommands.requestRender))
        return
      }
      if (submission.kind === 'share') {
        if (submission.mode === 'usage') {
          const port = deps.scrollback.commandOutput(deps.replCommands.requestRender)
          createCommandOutput(port, 'share').commit('sys-share-usage', layoutCommandNotice({ message: PHONE_SHARE_USAGE }))
          return
        }
        if (!s.sessionId) throw new RemoteConflict('No active session to share.')
        if (st.queueDispatchId || st.restarting) throw new RemoteConflict('The window is busy. Wait and try again.')
        const scope = currentScope()
        if (!scope) throw new RemoteConflict('Cannot verify the profile for this session.')
        void shareCurrentSession(s.sessionId, submission.mode, scope)
        return
      }
      deps.submit.submitConversationText(action.text, action.kind, action.images, submission.text, action.draftId)
      return
    }
    throw new RemoteConflict('This action is no longer available.')
  }

  function profile() {
    if (!st.configInfo) throw Error('Cannot verify the current profile.')
    const home = remoteHome(), account = deps.readAuthIdentity()
    if (account === undefined) throw Error('Cannot verify local account identity.')
    return { home, account, scope: sharingScope(home, st.configInfo.envPath || home, account ?? 'local') }
  }
  function gatewayProfile() {
    const selected = profile()
    if (!selected.account && process.env.EVOT_REMOTE_LOCAL_TEST !== '1')
      throw Error('Sign in with /login before enabling Remote access.')
    // Production uses the same machine-wide root as the Connect identity.
    return { ...selected, policyHome: selected.account ? join(homedir(), '.evotai') : selected.home }
  }
  function allowed(policyHome: string, scope: string) {
    try { return gatewayPolicy(policyHome) === scope } catch { return false }
  }
  function currentScope(): string | null {
    if (st.destroyed || st.logMode || deps.rendererTrace.isEnabled) return null
    try { return profile().scope } catch { return null }
  }
  function windowStatus(): Pick<SessionBadge, 'phase' | 'runState'> {
    if ((st.pendingAsk && st.overlay.kind === 'ask-user') || st.pendingTaskModel) return { phase: 'input' }
    // Use the TUI's own run classification, without loading a transcript, spinner
    // label, task title or tool arguments for any of the windows in the list.
    const { kind } = resolveRunInteraction(deps.runCtl.runInteractionInput())
    switch (kind) {
      case 'active': return { phase: 'working' }
      case 'local-operation': return { phase: 'busy' }
      case 'idle': return { phase: st.overlay.kind !== 'none' || st.loginInFlight || st.cloudLoginRequired || st.revocationCleanup ? 'busy' : 'idle' }
      default: return { phase: 'working', runState: kind }
    }
  }
  const remoteHost = { snapshot, act, changes: () => worktreeReview(deps.agent.cwd) }
  function register(handoff: RemoteHandoff | null = null) {
    if (st.terminalBus) return
    // A restart hands over the window's identity; otherwise a phone launch names it.
    const id = handoff ? handoff.terminal : process.env.EVOT_PHONE_TERMINAL,
      scope = handoff ? handoff.phoneScope ?? undefined : process.env.EVOT_PHONE_SCOPE
    st.remoteChild ||= handoff ? handoff.phoneScope !== null : id !== undefined || scope !== undefined
    if (st.remoteChild && scope && /^[0-9a-f]{24}$/.test(scope)) st.remotePhoneScope = scope
    delete process.env.EVOT_PHONE_TERMINAL
    delete process.env.EVOT_PHONE_SCOPE
    try {
      st.terminalBus = registerTerminal(
        remoteHome(),
        remoteHost,
        () => ({
          phoneCreated: st.remoteChild,
          ...(st.remoteChild || deps.insideTmux?.() ? { tmux: true as const } : {}),
          workspace: basename(deps.agent.cwd) || 'Terminal',
          project: profileKey(deps.agent.cwd),
          session: st.sessionId ?? '',
          title: sessionTitle(),
          ...windowStatus(),
          updatedAt: st.conversationTail.updatedAt,
          hasConversation: st.conversationTail.hasConversation,
          finishedRound: st.conversationTail.finishedRound,
          ...(st.conversationTail.outcome === 'Completed' ? { completed: true } : {}),
        }),
        validTerminal(id) ? id : undefined,
        {
          session: () => st.sessionId ?? '',
          currentScope() {
            const current = currentScope()
            return st.remoteChild && (!validTerminal(id) || current !== scope) ? null : current
          },
          ...(st.remoteChild ? { parkIfIdle: () => tryPark('capacity') } : { pairing: announcePairing }),
        },
        deps.windowControl,
      )
      if (validTerminal(id) && scope && /^[0-9a-f]{24}$/.test(scope)) { st.terminalBus.share(scope); parkWhenUnwatched() }
      if (handoff?.share === 'off') st.terminalBus.share(null)
      else if (handoff && handoff.share !== 'inherit') st.terminalBus.share(handoff.share)
      st.remoteEpoch = Math.floor(Math.random() * 0x100000000) * 65536
    } catch {
      /* Restricted or non-Unix hosts can still use the ordinary TUI. */
    }
  }
  // Only a window the phone launched: the user never sees it on the computer, so
  // nothing else would ever close it. The tmux probe runs only once the timeout is due.
  function parkWhenUnwatched() {
    if (st.remoteParkTimer) return
    st.remoteWatchedAt = Date.now()
    st.remoteParkTimer = setInterval(() => tryPark('timeout'), PARKED_CHECK_MS)
    st.remoteParkTimer.unref?.()
  }
  /** The idle timer and a full gateway both ask here; the window decides from its own state. */
  function tryPark(reason: ParkReason): boolean {
    if (!st.remoteChild || !st.remoteParkTimer || st.destroyed || st.restarting || st.restartPending) return false
    const now = Date.now()
    const idle = windowStatus().phase === 'idle' && !st.foregroundCommand && !st.logMode && !st.pendingAsk && !st.pendingTaskModel
      && !st.pendingQueue.entries.length && !st.pendingQueue.blocked && !st.queueDispatchId && !st.pendingEnqueue && !st.queueEditState
      && !deps.pendingImages.awaiting && !deps.pendingImages.size && !st.pendingModelHandoff
    if (!idle) { st.remoteWatchedAt = now; return false }
    if (!canParkWindow({ lastWatched: st.remoteWatchedAt, idle, draft: !isEditorEmpty(st.editor), attached: false }, now, reason)) return false
    // Do not trust only the badge's cached shell count when deciding to exit.
    if (st.sessionId) {
      try {
        if (deps.agent.backgroundProcesses(st.sessionId).some(task => task.status === 'running') || deps.agent.pendingProcessWakeNotifications(st.sessionId)) return false
      } catch { return false }
    }
    if (tmuxAttached()) { st.remoteWatchedAt = now; return false }
    deps.exitAfterCleanup(0)
    return true
  }
  function close(hide = true) {
    st.remoteAttempt++
    st.remoteOpening = false
    st.remoteEpoch++
    const gateway = st.remoteListener
    st.remoteListener = null
    gateway?.close()
    st.terminalBus?.route(null)
    if (hide) st.terminalBus?.share(null)
    else st.terminalBus?.endInvite()
    if (gateway && !st.destroyed) deps.replCommands.requestRender()
  }
  function dispose() {
    if (st.remoteParkTimer) clearInterval(st.remoteParkTimer)
    st.remoteParkTimer = null
    close()
    st.terminalBus?.close()
    st.terminalBus = null
  }
  const notice = (text: string) => deps.scrollback.commitLocalNotice('sys-remote', `  ${text}`)
  // The fragment chooses the approval window; the phone still picks its session from the list.
  const showInvite = ({ url, address, windowApproval }: { url: string; address: string; windowApproval?: true }, terminal: string) => {
    const link = windowApproval ? terminalInvite(address, terminal) : url
    const qr = renderUnicodeCompact(link, { border: 2, invert: getThemeScheme() === 'light' })
    notice(`Remote is on for this profile, including new windows. Scan to connect your phone:\n${qr}\n  ${link}\n  Bookmark this computer: ${address}\n  Run /remote off to turn it off. Approve new devices in ${windowApproval ? 'this' : 'the gateway’s'} TUI.`)
  }
  function announcePairing(code: string, id: string) {
    const command = `/remote approve ${code}`
    const prefill = isEditorEmpty(st.editor) && st.overlay.kind === 'none'
    notice(`Device ${id} requests history, tool output and control for this profile, including future windows. Match ${code} on your device, then ${prefill ? 'press Enter to approve' : `run ${command}`}. If you didn’t request this, let it expire (2 min).`)
    // Leave any existing draft alone. Approval is never submitted automatically.
    if (prefill) deps.composer.mutateEditor(editor => insertText(editor, command))
  }
  async function command(args: string) {
    if (args === 'hide') {
      // The gateway can serve history and future windows even when its own
      // TUI is hidden and no other window is open yet.
      register(); st.terminalBus?.share(null)
      notice('This window is hidden. Run /remote on here to show it again.')
      return
    }
    if (st.remoteChild) {
      notice('Manage device access in the original TUI.')
      return
    }
    if (st.logMode) {
      notice('Leave log mode before sharing a conversation.')
      return
    }
    if (deps.rendererTrace.isEnabled) {
      notice('Disable EVOT_TUI_TRACE before managing device access.')
      return
    }
    try {
      if (!args || args === 'on' || args === 'off') {
        const p = gatewayProfile(), current = () => currentScope() === p.scope
        if (args === 'off') {
          const mayHaveLegacyGateway = !st.remoteListener && gatewayPolicy(p.policyHome) === undefined
          await updateGatewayPolicy(p.policyHome, p.scope, 'disable', current)
          if (current()) {
            close(false)
            notice(mayHaveLegacyGateway
              ? 'Automatic takeover is off. If an older gateway is still online, stop it from the window running it.'
              : 'Remote off. Run /remote on to turn it back on.')
          }
        } else {
          // Save the identity first: a subsequent owner must reuse it, never mint a new address.
          if (p.account) machineIdentity(homedir(), true)
          await updateGatewayPolicy(p.policyHome, p.scope, 'enable', current)
          if (current()) {
            st.remoteRetryAt = 0
            const services = st.serviceHost?.controller
            if (deps.coordinatedHost && services) {
              if (services.invite()) await services.tick()
              else {
                // The owning window observes the policy change on its maintenance tick.
                const status = remoteStatus(deps.replCommands), until = Date.now() + 60_000
                status.phase('Waiting for the service host…')
                try {
                  while (current() && allowed(p.policyHome,p.scope) && Date.now() < until) {
                    if ((await st.terminalBus?.inventory(p.scope))?.gateway) break
                    await Bun.sleep(500)
                  }
                } finally { status.finish('info', 'Checked service host.') }
              }
            }
            if (current()) await enable(p, true)
          }
        }
        return
      }
      const { home, scope } = profile()
      if (args === 'devices' || args === 'revoke' || args.startsWith('revoke ')) {
        const current = () => !st.destroyed && !st.remoteChild && profile().scope === scope
        // Bare revoke is a read-only list, never an implicit choice of device.
        const message = await manageGrants(home, scope, args.split(' ').slice(1).join(' ') || undefined, current)
        if (current()) notice(message)
        return
      }
      const approval = /^approve (\d{8})$/.exec(args)
      if (!approval) throw Error(`Usage: ${REMOTE_USAGE}. Run /remote devices to manage approvals.`)
      const terminal = st.terminalBus?.id
      if (!terminal) throw Error('Run this in the TUI displaying the matching approval code.')
      const matched = await approvePairing(home, scope, terminal, approval[1]!)
      notice(matched ? 'Device approved.' : 'No matching pending request in this window. Check the code on your phone.')
    } catch (err) {
      notice(`Remote: ${errorText(err)}`)
    }
  }

  /** Start or join the gateway. Only an explicit invite shares this window for QR approval. */
  async function enable({ home, account, scope, policyHome }: ReturnType<typeof gatewayProfile>, invite: boolean, current?: () => boolean) {
    let status: ReturnType<typeof remoteStatus> | undefined
    try {
      register()
      if (!st.terminalBus) throw Error('Private terminal socket unavailable.')
      if (!allowed(policyHome, scope) || currentScope() !== scope) return
      if (st.remoteListener && !st.remoteListener.active()) close(false)
      if (!st.remoteListener) {
        if (st.remoteOpening) {
          notice('Connecting…')
          return
        }
        const attempt = ++st.remoteAttempt
        let installed = false
        const active = () => attempt === st.remoteAttempt && (installed || !current || current()) && currentScope() === scope && allowed(policyHome, scope)
        st.remoteOpening = true
        if (invite) status = remoteStatus(deps.replCommands)
        try {
          if (invite) {
            status?.phase('Checking for a gateway in this profile…')
            st.terminalBus.share(scope)
            const rows = await st.terminalBus.inventory(scope)
            if (!active()) { status?.finish('info', 'Cancelled.'); return }
            if (rows.gateway) {
              if (!rows.profileGateway) throw Error('An older window owns the gateway. Stop the gateway from that window, then run /remote in an updated TUI.')
              if (!st.terminalBus.shared) { status?.finish('info', 'This window stays hidden.'); return } // hidden while discovery was in flight
              status?.finish('success', 'Joined the gateway running in another window.')
              if (rows.gatewayInvite) showInvite(rows.gatewayInvite, st.terminalBus.id)
              else notice('Shared with the active gateway. Open /remote in its TUI to see the address.')
              return
            }
          }
          if (deps.coordinatedHost && !current) {
            status?.finish('info', 'Remote enabled. Waiting for the service host; run /remote again for the QR code.')
            return
          }
          status?.phase(account ? 'Connecting to evot Connect…' : 'Starting device approval…')
          const gateway = await openEnvironment({
            account,
            home,
            scope,
            active,
            host: remoteHost,
            workspace: phoneWorkspace(st.terminalBus, {
              listSessions: limit => deps.agent.listSessions(limit),
              listSessionsWithText: limit => deps.agent.listSessionsWithText(limit),
              // Mirror the picker's `d`: cloud copy, local copy, then every cached list this TUI shows.
              async deleteSession(id) {
                const remote = deps.cloudSessions.remoteFor(id)
                if (remote) { await deps.agent.cloudUnshareSession(id); deps.cloudSessions.forget(id) }
                const deleted = (await deps.agent.deleteSession(id)) || !!remote
                if (deleted) {
                  st.preloadedSessions = st.preloadedSessions.filter(s => s.session_id !== id)
                  deps.resumeCache.remove(id, st.preloadedSessions)
                }
                return deleted
              },
            }, home, deps.agent.cwd, scope, st.configInfo?.envPath),
            pending: announcePairing,
            presenceChanged: () => {
              if (attempt === st.remoteAttempt && st.remoteListener) deps.replCommands.requestRender()
            },
            exited: reason => {
              if (attempt === st.remoteAttempt) {
                close(false)
                notice(`Connector stopped: ${reason} Run /remote to reconnect.`)
              }
            },
            // While starting: the status row. Afterwards (connector restarts): plain notices.
            progress: (text, bytes) => {
              if (attempt !== st.remoteAttempt) return
              if (status?.active) status.phase(text, bytes)
              else if (st.remoteListener) notice(text)
            },
          })
          if (!active()) {
            gateway.close()
            status?.finish('info', 'Cancelled.')
            return
          }
          installed = true
          st.remoteListener = gateway
          st.terminalBus.route(scope, { url: gateway.url, address: gateway.address, windowApproval: true })
          deps.replCommands.requestRender()
          if (!gateway.cloud) status?.finish('success', 'Local approval gateway is on.')
          else if (gateway.online) status?.finish('success', `Online at ${new URL(gateway.address).host}.`)
          else status?.finish('info', `Started, but ${new URL(gateway.address).host} is not answering yet. The QR code works once Cloudflare connects.`)
        } catch (e) {
          const stillActive = active()
          if (invite && stillActive && !(e instanceof GatewayOccupied)) st.terminalBus?.share(null)
          if (invite) status?.finish(stillActive ? 'error' : 'info', stillActive ? errorText(e) : 'Cancelled.')
          if (current) throw e
          // Contention is expected when a sibling is starting or already owns the lease.
          if (stillActive && !(e instanceof GatewayOccupied)) st.remoteRetryAt = Date.now() + 15_000
          return
        } finally {
          if (attempt === st.remoteAttempt) st.remoteOpening = false
        }
      } else if (invite) st.terminalBus.share(scope)
      if (!invite) return
      if (!st.terminalBus.shared) { notice('Profile gateway is on. This window remains hidden.'); return }
      const g = st.remoteListener
      showInvite({ url: g.url, address: g.address, windowApproval: true }, st.terminalBus.id)
    } catch (err) {
      if (current) throw err
      if (invite) notice(`Remote: ${errorText(err)}`)
    }
  }

  /** How this window takes part in Remote, for the next image after a restart. */
  function handoff(): RemoteHandoff | null {
    const bus = st.terminalBus
    if (!bus) return null
    return { terminal: bus.id, phoneScope: st.remoteChild ? st.remotePhoneScope : null, share: bus.sharing,
      gateway: !!st.remoteListener?.active() }
  }

  async function ensureHosted(current: () => boolean) {
    if (st.remoteListener && !st.remoteListener.active()) close(false)
    const p = profile()
    const policyHome = p.account ? join(homedir(), '.evotai') : p.home
    if (gatewayPolicy(policyHome) !== p.scope) return false
    if (currentScope() !== p.scope || st.remoteChild || (!st.remoteListener && deps.outdatedBuild?.() === true))
      throw Error('This window cannot serve the enabled Remote profile.')
    if (!st.remoteListener) await enable(gatewayProfile(), false, current)
    if (!st.remoteListener?.online) throw Error('Remote gateway did not become ready.')
    return true
  }

  async function maintain() { await takeOver(false) }

  /** Automatic takeover. Only a window the user can see on the computer may
   * adopt the gateway and its approval prompts; `/remote on` anywhere still
   * starts one. A restart keeps a gateway the previous image already ran. */
  async function takeOver(restarted: boolean) {
    if (st.remoteListener) {
      if (!st.remoteListener.active()) close(false)
      return
    }
    if (!st.terminalBus || st.destroyed || st.restarting || st.restartPending || st.remoteChild || st.remoteOpening ||
        (!restarted && deps.insideTmux?.()) || Date.now() < st.remoteRetryAt) return
    let p: ReturnType<typeof gatewayProfile>
    try { p = gatewayProfile() } catch { return }
    if (allowed(p.policyHome, p.scope) && deps.outdatedBuild?.() !== true) await enable(p, false)
  }

  /** Migrate an older gateway only when its explicit share pins the same
   * profile. A hidden legacy owner without a pinned scope must opt in again. */
  async function resume(previous: RemoteHandoff | null) {
    if (!previous?.gateway || !currentScope()) return
    try {
      const p = gatewayProfile()
      if (gatewayPolicy(p.policyHome) === undefined) {
        if (previous.share !== p.scope) {
          notice('Remote was enabled on an older build. Run /remote once in a window in this profile to enable automatic takeover.')
          return
        }
        await updateGatewayPolicy(p.policyHome, p.scope, 'adopt', () => currentScope() === p.scope)
      }
      if (!deps.coordinatedHost) await takeOver(true)
    } catch (err) { notice(`Remote: ${errorText(err)}`) }
  }
  return {
    command,
    identityChanged: () => close(),
    sessionChanged: () => {
      st.remoteEpoch++
    },
    register,
    handoff,
    maintain,
    ensureHosted,
    hostScope: () => profile().scope,
    idleForHost: () => windowStatus().phase === 'idle' && !st.remoteChild && !st.restarting && !st.restartPending && !st.logMode,
    releaseHost: () => { if (st.remoteListener || st.remoteOpening) close(false) },
    resume,
    dispose,
    snapshot,
    act,
  }
}
export type RemoteController = ReturnType<typeof createRemoteController>
